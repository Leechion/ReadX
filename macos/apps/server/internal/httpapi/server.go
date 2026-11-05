// Package httpapi 提供 v2 server 的 HTTP 层：回环校验、bearer token 鉴权、
// 健康检查、文档列表与静态前端托管。
package httpapi

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"cbctv2/server/internal/appstate"
	"cbctv2/server/internal/booksources"
	"cbctv2/server/internal/config"
	"cbctv2/server/internal/db"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/tasks"
)

const appVersion = "0.0.0-s0"

// staticCSP 由服务端下发而非写死在 index.html：dev 模式由 Vite 直接提供页面并注入
// inline 的 HMR 脚本，若把 CSP 塞进 HTML 会让开发态立刻白屏，而生产态才是需要加固的那一份。
const staticCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https://www.gutenberg.org; font-src 'self' data:; worker-src 'self' blob:; " +
	"connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; " +
	"object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

type Server struct {
	bookSourcesOnce     sync.Once
	bookSources         *booksources.Registry
	zLibrary            *booksources.ZLibrary
	downloadPublication func(context.Context, string, int64, func(int64, int64)) ([]byte, string, error)
	settingsMu          sync.Mutex
	processingMu        sync.Mutex
	processingEpoch     context.Context
	processingCancel    context.CancelFunc
	processingTickets   map[string]processingTicket
	scholarMu           sync.Mutex
	nextEutils          time.Time
	zoteroWriteMu       sync.Mutex
	zoteroMigrationMu   sync.Mutex
	zoteroWriteKey      string
	zoteroWriteRemember bool
	zoteroWriteServer   string
	zoteroTestURL       string
	scholarFetch        func(context.Context, string, int64) ([]byte, string, error)
	syncMu              sync.Mutex
	realtimeMu          sync.Mutex
	realtimeSessions    map[string]*latexRealtimeSession
	workBuddyLoginMu    sync.Mutex
	workBuddyLogin      workBuddyLoginStatus
	// Paper memory and visual preparation are shared across five concurrent
	// section requests. Keyed locks prevent duplicate preparation per document.
	paperMemoryLocks keyedLockTable
	paperVisualLocks keyedLockTable
	// comparisonJobs 统一走 tasks.Registry：并发槽/超时/容量/TTL 清理/取消。
	// （原先这里是 mu + map 手写状态机：无取消、条目从不清理、零测试。）
	comparisonJobs *tasks.Registry
	// appStateStore 是 app_state 表的每 key 锁入口（internal/appstate）。
	// 原先的 appStateMu/graphMu 全局锁已随各业务文件迁移删除。
	appStateStore *appstate.Store
	// Coordinate document restoration/metadata changes with permanent deletion.
	// Per-key app_state locks alone do not protect the gap before deleting rows/files.
	documentLifecycleMu sync.Mutex
	// jobsMu 保护导入任务表：任务更新频繁（逐页翻译/渲染），但临界区只有内存改字段，
	// 落盘在锁外做，不能把 SQLite 写入拖进热点。
	jobsMu          sync.Mutex
	jobPersistLocks keyedLockTable
	importJobs      map[string]*jobRuntime
	cfg             config.Config
	handle          *sql.DB
	startedAt       time.Time
}

func New(cfg config.Config, handle *sql.DB) *Server {
	return &Server{
		cfg:            cfg,
		handle:         handle,
		startedAt:      time.Now().UTC(),
		importJobs:     map[string]*jobRuntime{},
		comparisonJobs: newComparisonJobRegistry(),
		appStateStore:  appstate.New(sqlAppStateKV{handle: handle}),
	}
}

// Handler 组装完整路由，可直接交给 http.Server 或 httptest。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.handleHealth)

	withAuth := func(h http.HandlerFunc) http.Handler { return s.requireBearer(s.enforceProcessing(h)) }
	mux.Handle("GET /v1/processing/policy", withAuth(s.handleProcessingPolicy))
	mux.Handle("GET /v1/processing/audit", withAuth(s.handleProcessingAudit))
	mux.Handle("PATCH /v1/processing/policy", withAuth(s.handleProcessingPolicy))
	mux.Handle("POST /v1/processing/approve", withAuth(s.handleProcessingApproval))
	mux.Handle("POST /v1/scholar/search", withAuth(s.handleScholarSearch))
	mux.Handle("GET /v1/scholar/history", withAuth(s.handleScholarHistory))
	mux.Handle("GET /v1/scholar/sessions", withAuth(s.handleScholarSessions))
	mux.Handle("GET /v1/scholar/sessions/{id}", withAuth(s.handleScholarSessions))
	mux.Handle("GET /v1/scholar/records/{id}", withAuth(s.handleScholarRecord))
	mux.Handle("GET /v1/scholar/queue", withAuth(s.handleScholarQueue))
	mux.Handle("POST /v1/scholar/queue", withAuth(s.handleScholarQueue))
	mux.Handle("POST /v1/scholar/snowball", withAuth(s.handleScholarSnowball))
	mux.Handle("POST /v1/shares/readonly", withAuth(s.handleReadonlyShare))
	mux.Handle("GET /v1/capture/inbox", withAuth(s.handleCaptureInbox))
	mux.Handle("POST /v1/capture/inbox", withAuth(s.handleCaptureInbox))
	mux.Handle("POST /v1/zotero/authorize", withAuth(s.handleZoteroAuthorize))
	mux.Handle("GET /v1/zotero/snapshot", withAuth(s.handleZoteroSnapshot))
	mux.Handle("POST /v1/zotero/snapshot", withAuth(s.handleZoteroSnapshot))
	mux.Handle("GET /v1/zotero/note", withAuth(s.handleZoteroNote))
	mux.Handle("POST /v1/zotero/note", withAuth(s.handleZoteroNote))
	mux.Handle("GET /v1/zotero/draft", withAuth(s.handleZoteroDraft))
	mux.Handle("GET /v1/zotero/migrations", withAuth(s.handleZoteroMigration))
	mux.Handle("POST /v1/zotero/migrations", withAuth(s.handleZoteroMigration))
	mux.Handle("GET /v1/zotero/migrations/{id}/archive", withAuth(s.handleZoteroArchive))
	mux.Handle("PATCH /v1/zotero/mirror", withAuth(s.handleZoteroMirrorEdit))
	mux.Handle("POST /v1/zotero/reconcile", withAuth(s.handleZoteroReconcile))
	mux.Handle("POST /v1/zotero/reconcile/apply", withAuth(s.handleZoteroReconcileApply))
	mux.Handle("/v1/meta", withAuth(s.handleMeta))
	mux.Handle("/v1/sync/settings", withAuth(s.handleSyncSettings))
	mux.Handle("/v1/sync", withAuth(s.handleSyncNow))
	mux.Handle("GET /v1/books/search", withAuth(s.handleSlackBookSearch))
	mux.Handle("GET /v1/books/download", withAuth(s.handleSlackBookDownload))
	mux.Handle("GET /v1/books/fetch-web", withAuth(s.handleSlackWebSourceFetch))
	mux.Handle("GET /v1/book-sources", withAuth(s.handleBookSources))
	mux.Handle("GET /v1/book-sources/zlibrary/connection", withAuth(s.handleZLibraryConnection))
	mux.Handle("PUT /v1/book-sources/zlibrary/connection", withAuth(s.handleZLibraryConnection))
	mux.Handle("POST /v1/book-sources/zlibrary/connection", withAuth(s.handleZLibraryConnection))
	mux.Handle("DELETE /v1/book-sources/zlibrary/connection", withAuth(s.handleZLibraryConnection))
	mux.Handle("POST /v1/book-sources/zlibrary/probe", withAuth(s.handleZLibraryProbe))
	mux.Handle("GET /v1/book-sources/zlibrary/books/{id}/cover", withAuth(s.handleZLibraryCover))
	mux.Handle("GET /v1/book-sources/{provider}/search", withAuth(s.handleSourceSearch))
	mux.Handle("GET /v1/book-sources/{provider}/books/{id}", withAuth(s.handleSourceDetail))
	mux.Handle("POST /v1/book-sources/{provider}/books/{id}/downloads", withAuth(s.handleSourceDownload))
	mux.Handle("GET /v1/book-downloads/{task}", withAuth(s.handleBookDownloadTask))
	mux.Handle("DELETE /v1/book-downloads/{task}", withAuth(s.handleBookDownloadTask))
	mux.Handle("GET /v1/book-downloads/{task}/file", withAuth(s.handleBookDownloadFile))
	mux.Handle("GET /v1/documents", withAuth(s.handleDocuments))
	mux.Handle("GET /v1/document-jobs", withAuth(s.handleDocumentJobs))
	mux.Handle("POST /v1/import", withAuth(s.handleImport))
	mux.Handle("POST /v1/import/files", withAuth(s.handlePublicationUpload))
	mux.Handle("POST /v1/import/url", withAuth(s.handlePublicationURL))
	mux.Handle("GET /v1/import/search", withAuth(s.handleImportSearch))
	mux.Handle("GET /v1/import/zotero/collections", withAuth(s.handleZoteroCollections))
	mux.Handle("GET /v1/import/zotero/items", withAuth(s.handleZoteroItems))
	mux.Handle("GET /v1/import/zotero/attachments/{key}/file", withAuth(s.handleZoteroFile))
	mux.Handle("GET /v1/discovery/daily", withAuth(s.handleDailyRecommendations))
	mux.Handle("GET /v1/discovery/feed", withAuth(s.handleResearchFeed))
	mux.Handle("POST /v1/discovery/translate-title", withAuth(s.handleResearchTitleTranslation))
	mux.Handle("POST /v1/documents/{key}/arxiv-pdf", withAuth(s.handleDocumentArxivPDF))
	mux.Handle("GET /v1/documents/{key}/file", withAuth(s.handlePublicationFile))
	// 旧客户端（以及 pdf.js 的调试脚本）仍按 /pdf 取原文件；路径别名保留，行为与 /file 一致。
	mux.Handle("GET /v1/documents/{key}/pdf", withAuth(s.handlePublicationFile))
	mux.Handle("GET /v1/documents/{key}/sections/{page}", withAuth(s.handleSection))
	mux.Handle("GET /v1/documents/{key}/resource", withAuth(s.handleEPUBResource))
	mux.Handle("GET /v1/documents/{key}/location", withAuth(s.handleLocation))
	mux.Handle("PUT /v1/documents/{key}/location", withAuth(s.handleLocation))
	mux.Handle("GET /v1/documents/{key}", withAuth(s.handleDocument))
	mux.Handle("PATCH /v1/documents/{key}/status", withAuth(s.handleStatusPatch))
	mux.Handle("GET /v1/documents/{key}/pages", withAuth(s.handlePageList))
	mux.Handle("GET /v1/documents/{key}/pages/{page}", withAuth(s.handlePageGet))
	mux.Handle("PUT /v1/documents/{key}/pages/{page}", withAuth(s.handlePagePut))
	mux.Handle("POST /v1/documents/{key}/pages/{page}/translated-page", withAuth(s.handleTranslatedPage))
	mux.Handle("GET /v1/documents/{key}/layout", withAuth(s.handleLayoutStatus))
	mux.Handle("GET /v1/documents/{key}/pages/{page}/paragraphs", withAuth(s.handleDocumentParagraphs))
	mux.Handle("GET /v1/documents/{key}/pages/{page}/translation-preview", withAuth(s.handleTranslationPreview))
	mux.Handle("GET /v1/documents/{key}/pages/{page}/translated-render", withAuth(s.handleTranslatedPageRender))
	mux.Handle("GET /v1/documents/{key}/translation-qa", withAuth(s.handleTranslationQA))
	mux.Handle("GET /v1/documents/{key}/job", withAuth(s.handleDocumentJob))
	mux.Handle("POST /v1/documents/{key}/retranslate", withAuth(s.handleRetranslate))
	mux.Handle("POST /v1/documents/{key}/job/cancel", withAuth(s.handleCancelDocumentJob))

	// LaTeX Studio：独立命名空间，与阅读/翻译/PPT 的接口语义完全分开。
	// 路径参数只接受项目编号；文件路径一律走 query，服务端再按「项目内相对路径」校验。
	mux.Handle("GET /v1/latex/projects", withAuth(s.handleLatexProjects))
	mux.Handle("POST /v1/latex/projects", withAuth(s.handleLatexProjects))
	mux.Handle("GET /v1/latex/projects/{id}", withAuth(s.handleLatexProject))
	mux.Handle("PATCH /v1/latex/projects/{id}", withAuth(s.handleLatexProject))
	mux.Handle("DELETE /v1/latex/projects/{id}", withAuth(s.handleLatexProject))
	mux.Handle("POST /v1/latex/projects/{id}/duplicate", withAuth(s.handleLatexProjectDuplicate))
	mux.Handle("GET /v1/latex/projects/{id}/tree", withAuth(s.handleLatexTree))
	mux.Handle("GET /v1/latex/projects/{id}/index", withAuth(s.handleLatexIndex))
	mux.Handle("GET /v1/latex/projects/{id}/file", withAuth(s.handleLatexFile))
	mux.Handle("PUT /v1/latex/projects/{id}/file", withAuth(s.handleLatexFile))
	mux.Handle("DELETE /v1/latex/projects/{id}/file", withAuth(s.handleLatexFile))
	mux.Handle("GET /v1/latex/projects/{id}/asset", withAuth(s.handleLatexAsset))
	mux.Handle("POST /v1/latex/projects/{id}/asset", withAuth(s.handleLatexAsset))
	mux.Handle("POST /v1/latex/projects/{id}/file-ops", withAuth(s.handleLatexFileOps))
	mux.Handle("POST /v1/latex/projects/{id}/import-zip", withAuth(s.handleLatexImportZip))
	mux.Handle("GET /v1/latex/projects/{id}/export-zip", withAuth(s.handleLatexExportZip))
	mux.Handle("GET /v1/latex/toolchains", withAuth(s.handleLatexToolchains))
	mux.Handle("GET /v1/latex/realtime/runtime", withAuth(s.handleLatexRealtimeRuntime))
	mux.Handle("POST /v1/latex/realtime/runtime", withAuth(s.handleLatexRealtimeRuntime))
	mux.Handle("POST /v1/latex/projects/{id}/realtime", withAuth(s.handleLatexRealtime))
	mux.Handle("POST /v1/latex/projects/{id}/realtime/edit", withAuth(s.handleLatexRealtimeEdit))
	mux.Handle("GET /v1/latex/projects/{id}/builds", withAuth(s.handleLatexBuilds))
	mux.Handle("POST /v1/latex/projects/{id}/builds", withAuth(s.handleLatexBuilds))
	mux.Handle("GET /v1/latex/builds/{id}", withAuth(s.handleLatexBuild))
	mux.Handle("GET /v1/latex/builds/{id}/{action}", withAuth(s.handleLatexBuild))
	mux.Handle("POST /v1/latex/builds/{id}/{action}", withAuth(s.handleLatexBuild))
	// 源码快照：AI 直接写盘前会自动留一份，用户也可以手动打快照与回滚。
	mux.Handle("GET /v1/latex/projects/{id}/snapshots", withAuth(s.handleLatexSnapshots))
	mux.Handle("POST /v1/latex/projects/{id}/snapshots", withAuth(s.handleLatexSnapshots))
	mux.Handle("GET /v1/latex/snapshots/{id}", withAuth(s.handleLatexSnapshot))
	mux.Handle("POST /v1/latex/snapshots/{id}", withAuth(s.handleLatexSnapshot))
	mux.Handle("DELETE /v1/latex/snapshots/{id}", withAuth(s.handleLatexSnapshot))
	mux.Handle("GET /v1/ai/status", withAuth(s.handleAIStatus))
	mux.Handle("GET /v1/ai/settings", withAuth(s.handleAISettings))
	mux.Handle("PUT /v1/ai/settings", withAuth(s.handleAISettings))
	mux.Handle("POST /v1/ai/test", withAuth(s.handleAIProbe))
	mux.Handle("POST /v1/ai/models", withAuth(s.handleAIModels))
	mux.Handle("POST /v1/ai/workbuddy/login", withAuth(s.handleWorkBuddyLogin))
	mux.Handle("GET /v1/ai/workbuddy/login", withAuth(s.handleWorkBuddyLoginStatus))
	mux.Handle("DELETE /v1/ai/workbuddy/login", withAuth(s.handleWorkBuddyLogout))
	mux.Handle("POST /v1/ai/chat", withAuth(s.handleAIChat))
	mux.Handle("POST /v1/ai/latex-chat", withAuth(s.handleLatexAIChat))
	mux.Handle("POST /v1/ai/latex-edit", withAuth(s.handleLatexAIEdit))
	mux.Handle("POST /v1/ai/latex-fix", withAuth(s.handleLatexAIFix))
	// 直接写盘：与 latex-fix 分开，因为它的副作用完全不同（会改源码），
	// 需要项目显式开启开关，并且走「快照 → 写入 → 强制编译验证 → 未改善回滚」。
	mux.Handle("POST /v1/ai/latex-autofix", withAuth(s.handleLatexAutoFix))
	// LaTeX 工作区可以单独指定模型渠道，不影响全局阅读/翻译用的渠道。
	mux.Handle("GET /v1/ai/latex-settings", withAuth(s.handleLatexAISettings))
	mux.Handle("PUT /v1/ai/latex-settings", withAuth(s.handleLatexAISettings))
	mux.Handle("POST /v1/ai/presentation-theme", withAuth(s.handleAIPresentationTheme))
	mux.Handle("POST /v1/ai/presentation-plan", withAuth(s.handleAIPresentationPlan))
	mux.Handle("POST /v1/ai/generate", withAuth(s.handleAIGenerate))
	mux.Handle("GET /v1/documents/{key}/comparison-experiment-job", withAuth(s.handleComparisonExperimentJob))
	mux.Handle("POST /v1/documents/{key}/comparison-experiment-job", withAuth(s.handleComparisonExperimentJob))
	mux.Handle("DELETE /v1/documents/{key}/comparison-experiment-job", withAuth(s.handleComparisonExperimentJob))
	mux.Handle("POST /v1/ai/paper-page", withAuth(s.handlePaperPage))
	mux.Handle("GET /v1/readings/{key}", withAuth(s.handleReadingGet))
	mux.Handle("PUT /v1/readings/{key}/{kind}", withAuth(s.handleReadingPut))
	mux.Handle("GET /v1/calendar", withAuth(s.handleCalendar))
	mux.Handle("GET /v1/annotations/{key}", withAuth(s.handleAnnotationList))
	mux.Handle("POST /v1/annotations/{key}", withAuth(s.handleAnnotationCreate))
	mux.Handle("GET /v1/annotations/{key}/export", withAuth(s.handleAnnotationExport))
	mux.Handle("PATCH /v1/annotation/{id}", withAuth(s.handleAnnotationPatch))
	mux.Handle("DELETE /v1/annotation/{id}", withAuth(s.handleAnnotationDelete))
	mux.Handle("POST /v1/documents/{key}/translated-pdf", withAuth(s.handleTranslatedPDF))
	mux.Handle("GET /v1/documents/{key}/translated-pdf", withAuth(s.handleTranslatedPDF))
	mux.Handle("GET /v1/render/status", withAuth(s.handleRenderStatus))
	mux.Handle("GET /v1/ocr/settings", withAuth(s.handleOCRSettings))
	mux.Handle("PUT /v1/ocr/settings", withAuth(s.handleOCRSettings))
	mux.Handle("GET /v1/documents-meta", withAuth(s.handleDocumentMetaList))
	mux.Handle("PATCH /v1/documents/{key}/meta", withAuth(s.handleDocumentMetaPatch))
	mux.Handle("POST /v1/trash/empty", withAuth(s.handleTrashEmpty))
	mux.Handle("GET /v1/tags", withAuth(s.handleTagList))
	mux.Handle("GET /v1/categories", withAuth(s.handleCategoryList))
	mux.Handle("POST /v1/categories", withAuth(s.handleCategoryUpsert))
	mux.Handle("DELETE /v1/category/{name}", withAuth(s.handleCategoryDelete))
	mux.Handle("GET /v1/trends", withAuth(s.handleTrends))
	mux.Handle("GET /v1/reproduction/{key}", withAuth(s.handleReproductionGet))
	mux.Handle("POST /v1/reproduction/{key}/analyze", withAuth(s.handleReproductionAnalyze))
	mux.Handle("PATCH /v1/reproduction/{key}/task", withAuth(s.handleReproductionTask))
	mux.Handle("POST /v1/reproduction/repo-checks", withAuth(s.handleRepoChecks))
	mux.Handle("GET /v1/ideas", withAuth(s.handleIdeaList))
	mux.Handle("POST /v1/ideas", withAuth(s.handleIdeaCreate))
	mux.Handle("PATCH /v1/idea/{id}", withAuth(s.handleIdeaPatch))
	mux.Handle("DELETE /v1/idea/{id}", withAuth(s.handleIdeaDelete))
	mux.Handle("GET /v1/duplicates", withAuth(s.handleDuplicates))
	mux.Handle("GET /v1/citations", withAuth(s.handleCitations))
	mux.Handle("GET /v1/citations/preview", withAuth(s.handleCitationPreview))
	mux.Handle("GET /v1/search", withAuth(s.handleSearch))
	mux.Handle("GET /v1/stats", withAuth(s.handleStats))
	mux.Handle("GET /v1/documents/{key}/citations", withAuth(s.handleCitationNetwork))
	mux.Handle("GET /v1/graph", withAuth(s.handleGraphList))
	mux.Handle("POST /v1/graph/extract", withAuth(s.handleGraphExtract))
	mux.Handle("DELETE /v1/graph/{key}", withAuth(s.handleGraphDelete))

	if s.cfg.StaticDir != "" {
		mux.HandleFunc("/", s.handleStatic)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusNotFound, "未知路径")
		})
	}

	return s.withCommonHeaders(s.requireLoopbackHost(mux))
}

// ---- 中间件 ----

// requireLoopbackHost 挡 DNS rebinding：即便本机某个页面把域名指到 127.0.0.1，
// Host 不是回环名也直接拒绝。
func (s *Server) requireLoopbackHost(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedHost(r.Host, s.cfg.Host) {
			writeError(w, http.StatusForbidden, "拒绝非回环 Host")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowedHost(hostHeader string, boundHost string) bool {
	name := hostHeader
	if stripped, _, err := net.SplitHostPort(hostHeader); err == nil {
		name = stripped
	}
	name = strings.Trim(name, "[]")
	if ip := net.ParseIP(name); ip != nil {
		return ip.IsLoopback()
	}
	switch strings.ToLower(strings.TrimSuffix(name, ".")) {
	case "localhost":
		return true
	case "::1":
		return boundHost == "::1"
	}
	return false
}

// requireBearer 校验 Authorization: Bearer <token>。token 每次启动随机生成，只由父进程
// （Electron 主进程）经 preload 交给渲染进程，因此同机其他进程无法调用 /v1。
func (s *Server) requireBearer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided := bearerToken(r.Header.Get("Authorization"))
		if provided == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(s.cfg.Token)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "缺少或错误的本地 token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

func (s *Server) withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("X-Frame-Options", "DENY")
		header.Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/v1/") || r.URL.Path == "/healthz" {
			header.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// ---- 处理函数 ----

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	// 健康检查必须永远能快速回答：单连接被导入事务占用时，没有超时会一直挂着。
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	version, err := db.Version(ctx, s.handle)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取迁移版本失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": version > 0, "schemaVersion": version})
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	version, err := db.Version(r.Context(), s.handle)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取迁移版本失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"app":            "cbct-reading-v2",
		"version":        appVersion,
		"dataRoot":       s.cfg.DataRoot,
		"dbPath":         s.cfg.DBPath(),
		"schemaVersion":  version,
		"startedAt":      s.startedAt.Format(time.RFC3339),
		"documentsTotal": s.countDocuments(r.Context()),
		// build/pid 供启动器识别「同一个数据根上跑的是不是旧二进制」：命中旧构建时
		// 它会先停掉旧进程再起新的，而不是静默复用一份过期的后端。
		"build": buildFingerprint(),
		"pid":   os.Getpid(),
	})
}

// DocumentSummary 与 packages/shared 的 DocumentSummary 一一对应。
type DocumentSummary struct {
	Format             string   `json:"format"`
	HasPDF             bool     `json:"hasPdf"`
	ID                 string   `json:"id"`
	Key                string   `json:"key"`
	Title              string   `json:"title"`
	TranslatedTitle    string   `json:"translatedTitle"`
	Authors            []string `json:"authors"`
	Year               *int     `json:"year"`
	Venue              string   `json:"venue"`
	DOI                string   `json:"doi"`
	URL                string   `json:"url"`
	Status             string   `json:"status"`
	PaperMemoryStatus  string   `json:"paperMemoryStatus,omitempty"`
	PaperMemoryMessage string   `json:"paperMemoryMessage,omitempty"`
	PDFPath            string   `json:"pdfPath"`
	AddedAt            string   `json:"addedAt"`
	UpdatedAt          string   `json:"updatedAt"`
}

func (s *Server) handleDocuments(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	status := r.URL.Query().Get("status")
	search := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if status != "" && !knownStatus(status) {
		writeError(w, http.StatusBadRequest, "status 只能是 queue / reading / done / archive")
		return
	}
	if err := s.syncDerivedDocumentStatuses(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "刷新书库阅读状态失败: "+err.Error())
		return
	}
	query := `SELECT id, key, title, authors, year, venue, doi, url, status, pdf_path, added_at, updated_at, format, translated_title
		 FROM documents`
	var where []string
	var args []any
	if status != "" {
		where = append(where, `status = ?`)
		args = append(args, status)
	}
	if search != "" {
		// 与旧版一样只做包含匹配（LIKE 大小写不敏感对 ASCII 有效），不做模糊打分——
		// 宁可少召回也不要给出无法解释的排序。
		where = append(where, `(lower(title) LIKE ? OR lower(authors) LIKE ? OR lower(venue) LIKE ? OR lower(key) LIKE ? OR translated_title LIKE ?)`)
		pattern := "%" + search + "%"
		args = append(args, pattern, pattern, pattern, pattern, pattern)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += ` ORDER BY CASE status WHEN 'reading' THEN 0 WHEN 'done' THEN 2 ELSE 1 END, added_at DESC, id`

	// 先取一次 library/ 快照：rows 迭代期间不能再做文件系统调用。逐行 os.ReadDir 会
	// 让列表接口变成 O(篇数 × 文件数)，并且单连接会被 rows 占住，其它 DB 请求一起排队。
	pdfIndex := legacy.NewPaths(s.cfg.DataRoot).LibraryPDFIndex()

	rows, err := s.handle.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "查询文档失败: "+err.Error())
		return
	}
	defer rows.Close()

	documents := []DocumentSummary{}
	for rows.Next() {
		var item DocumentSummary
		var authorsJSON string
		var year sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Key, &item.Title, &authorsJSON, &year, &item.Venue,
			&item.DOI, &item.URL, &item.Status, &item.PDFPath, &item.AddedAt, &item.UpdatedAt, &item.Format, &item.TranslatedTitle); err != nil {
			writeError(w, http.StatusInternalServerError, "读取文档行失败: "+err.Error())
			return
		}
		item.Title = normalizePaperTitle(item.Title)
		if err := json.Unmarshal([]byte(authorsJSON), &item.Authors); err != nil || item.Authors == nil {
			item.Authors = []string{}
		}
		if year.Valid {
			parsed := int(year.Int64)
			item.Year = &parsed
		}
		_, item.HasPDF = pdfIndex.Match(item.Key)
		documents = append(documents, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "遍历文档失败: "+err.Error())
		return
	}
	if err := rows.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "关闭文档列表失败: "+err.Error())
		return
	}
	for index := range documents {
		job, found := s.loadImportJobForDocument(r.Context(), documents[index].Key)
		if !found {
			continue
		}
		// skipped（重新翻译复用已有记忆 / 导入时 AI 未就绪跳过）没有「处理进度」可看：
		// 前端以 paperMemoryStatus !== 'done' 点亮「处理」按钮，外露 skipped 会让
		// 按钮在任务早已终态后仍然常亮。
		if stage := job.stage("memory"); stage != nil && stage.Status != "skipped" {
			documents[index].PaperMemoryStatus = stage.Status
			documents[index].PaperMemoryMessage = stage.Message
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": documents, "total": len(documents)})
}

// handleStatic 托管 web 构建产物，并给前端路由做 index.html 兜底。
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/v1/") {
		// 没匹配上的 /v1 路径绝不能被 SPA 兜底成 index.html：
		// 那样客户端只会看到「JSON 解析失败」，掩盖真正的路由/方法错误。
		writeError(w, http.StatusNotFound, "未知的 API 路径或方法")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	// 先把路径归一化到 "/xxx" 再剥掉前导斜杠：这样 Clean 之后不可能残留 ".."，
	// 根路径 "/" 变成 index.html 而不是空串。
	relative := strings.TrimPrefix(path.Clean("/"+strings.TrimPrefix(r.URL.Path, "/")), "/")
	if relative == "" {
		relative = "index.html"
	}
	candidate := filepath.Join(s.cfg.StaticDir, filepath.FromSlash(relative))
	inside, err := filepath.Rel(s.cfg.StaticDir, candidate)
	if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
		writeError(w, http.StatusForbidden, "非法路径")
		return
	}
	info, err := os.Stat(candidate)
	serveIndexFallback := err != nil || info.IsDir()
	if serveIndexFallback {
		// 带扩展名的资源缺失就真缺失，不伪装成 index.html。
		if strings.Contains(filepath.Base(relative), ".") {
			writeError(w, http.StatusNotFound, "资源不存在")
			return
		}
		candidate = filepath.Join(s.cfg.StaticDir, "index.html")
		if _, err := os.Stat(candidate); err != nil {
			writeError(w, http.StatusNotFound, "前端尚未构建（npm run build -w @cbct/web）")
			return
		}
	}
	if strings.EqualFold(filepath.Ext(candidate), ".html") {
		w.Header().Set("Content-Security-Policy", staticCSP)
		// 前端每次构建都会换 hash 的资源名，HTML 本身必须回源，否则新版页面进不来。
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, candidate)
}

// ---- 辅助 ----

func (s *Server) countDocuments(ctx context.Context) int {
	var count int
	if err := s.handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM documents`).Scan(&count); err != nil {
		return 0
	}
	return count
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, `{"error":"序列化失败"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
