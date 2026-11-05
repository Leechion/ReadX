package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"cbctv2/server/internal/appstate"
	"cbctv2/server/internal/legacy"
)

const processingPolicyKey = "processing.policy.v1"

type processingPolicy struct {
	Revision  int64             `json:"revision"`
	Library   string            `json:"library"`
	Documents map[string]string `json:"documents"`
	Projects  map[string]string `json:"projects"`
}
type processingDescription struct {
	Action        string   `json:"action"`
	Documents     []string `json:"documents"`
	Projects      []string `json:"projects"`
	Materials     []string `json:"materials"`
	Destinations  []string `json:"destinations"`
	Files         []string `json:"files,omitempty"`
	Disclosure    string   `json:"disclosure"`
	DocumentNames []string `json:"documentNames"`
	ProjectNames  []string `json:"projectNames"`
}
type processingAudit struct {
	At        string   `json:"at"`
	Action    string   `json:"action"`
	Decision  string   `json:"decision"`
	Documents []string `json:"documents"`
	Projects  []string `json:"projects"`
}

func (s *Server) recordProcessing(ctx context.Context, d processingDescription, decision string) error {
	return s.appStateStore.Update(ctx, "processing.audit.v1", func(raw []byte, exists bool) ([]byte, error) {
		rows := []processingAudit{}
		if exists {
			if err := json.Unmarshal(raw, &rows); err != nil {
				return nil, err
			}
		}
		rows = append(rows, processingAudit{At: time.Now().UTC().Format(time.RFC3339), Action: d.Action, Decision: decision, Documents: d.Documents, Projects: d.Projects})
		if len(rows) > 200 {
			rows = rows[len(rows)-200:]
		}
		return json.Marshal(rows)
	})
}
func (s *Server) handleProcessingAudit(w http.ResponseWriter, r *http.Request) {
	rows, _, err := appstate.Load[[]processingAudit](r.Context(), s.appStateStore, "processing.audit.v1")
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if rows == nil {
		rows = []processingAudit{}
	}
	writeJSON(w, 200, map[string]any{"records": rows, "disclosure": "仅记录授权决定，不等于接收方已收到或处理成功；不记录正文和密钥。"})
}

type processingTicket struct {
	Digest      string
	Revision    int64
	Expires     time.Time
	Approved    bool
	Description processingDescription
}
type processingEpochKey struct{}

func (s *Server) processingPolicy(ctx context.Context) (processingPolicy, error) {
	p, exists, err := appstate.Load[processingPolicy](ctx, s.appStateStore, processingPolicyKey)
	if err != nil {
		return p, err
	}
	if !exists {
		p = processingPolicy{Revision: 1, Library: "ask"}
	}
	if p.Documents == nil {
		p.Documents = map[string]string{}
	}
	if p.Projects == nil {
		p.Projects = map[string]string{}
	}
	return p, nil
}
func processingMode(mode string) bool { return mode == "ask" || mode == "allow" || mode == "deny" }
func (s *Server) handleProcessingPolicy(w http.ResponseWriter, r *http.Request) {
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	if r.Method == http.MethodGet {
		p, err := s.processingPolicy(r.Context())
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, p)
		return
	}
	var body struct {
		Scope string `json:"scope"`
		Key   string `json:"key"`
		Mode  string `json:"mode"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if !processingMode(body.Mode) || (body.Scope != "library" && body.Scope != "document" && body.Scope != "project") {
		writeError(w, 400, "无效的处理权限")
		return
	}
	if body.Scope != "library" {
		if _, err := safeKey(body.Key, "对象键"); err != nil {
			writeError(w, 400, err.Error())
			return
		}
	}
	var saved processingPolicy
	err := s.appStateStore.Update(r.Context(), processingPolicyKey, func(raw []byte, exists bool) ([]byte, error) {
		p := processingPolicy{Revision: 1, Library: "ask", Documents: map[string]string{}, Projects: map[string]string{}}
		if exists {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, err
			}
		}
		if p.Documents == nil {
			p.Documents = map[string]string{}
		}
		if p.Projects == nil {
			p.Projects = map[string]string{}
		}
		switch body.Scope {
		case "library":
			p.Library = body.Mode
		case "document":
			p.Documents[body.Key] = body.Mode
		case "project":
			p.Projects[body.Key] = body.Mode
		}
		p.Revision++
		saved = p
		return json.Marshal(p)
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	// Policy changes revoke prior plans and cancel work authorized by the old epoch.
	if s.processingCancel != nil {
		s.processingCancel()
	}
	s.processingEpoch, s.processingCancel = context.WithCancel(context.Background())
	s.processingTickets = map[string]processingTicket{}
	writeJSON(w, 200, saved)
}
func (s *Server) handleProcessingApproval(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	s.processingMu.Lock()
	defer s.processingMu.Unlock()
	ticket, ok := s.processingTickets[body.ID]
	p, err := s.processingPolicy(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if !ok || time.Now().After(ticket.Expires) || ticket.Revision != p.Revision {
		writeError(w, 409, "发送计划已失效，请重新操作")
		return
	}
	ticket.Approved = true
	s.processingTickets[body.ID] = ticket
	writeJSON(w, 200, map[string]string{"grant": body.ID})
}

// These are research-related network/AI entry points, not local reading routes.
func processingAction(r *http.Request) string {
	p := r.URL.Path
	switch {
	case p == "/v1/import/files":
		return "文件导入与 OCR／翻译"
	case p == "/v1/import/url" || p == "/v1/import/search" || strings.HasSuffix(p, "/arxiv-pdf"):
		return "论文查询与下载"
	case strings.HasPrefix(p, "/v1/ai/") && r.Method == http.MethodPost:
		return "AI 处理"
	case strings.HasSuffix(p, "/retranslate"):
		return "重新识别与翻译"
	case r.Method == http.MethodPost && (strings.HasSuffix(p, "/translated-page") || strings.HasSuffix(p, "/translated-pdf")):
		return "译文生成与排版（可能补充识别或翻译）"
	case p == "/v1/graph/extract":
		return "知识图谱抽取"
	case p == "/v1/sync" && r.Method == http.MethodPost:
		return "跨设备同步"
	case strings.HasPrefix(p, "/v1/discovery/"):
		return "文献发现与题录查询"
	case p == "/v1/scholar/search" || p == "/v1/scholar/snowball":
		return "学术检索与引文扩展（向目录服务发送查询词或 DOI）"
	case p == "/v1/shares/readonly":
		return "导出只读分享（交给其他人查看）"
	case strings.HasPrefix(p, "/v1/zotero/") && r.Method == http.MethodPost:
		return "本机 Zotero 授权／读取快照／写回子笔记"
	case strings.HasSuffix(p, "/citations") && strings.HasPrefix(p, "/v1/documents/"):
		return "引文目录查询"
	case strings.HasPrefix(p, "/v1/reproduction/") && (strings.HasSuffix(p, "/analyze") || strings.HasSuffix(p, "/repo-checks")):
		return "复现分析与仓库查询"
	case strings.HasSuffix(p, "/comparison-experiment-job") && r.Method == http.MethodPost:
		return "对照实验分析"
	case strings.HasPrefix(p, "/v1/books/") || strings.HasPrefix(p, "/v1/book-sources/"):
		return "外部书源查询"
	}
	return ""
}
func collectProcessingKeys(value any, field string, docs, projects map[string]bool) {
	switch v := value.(type) {
	case map[string]any:
		for k, item := range v {
			collectProcessingKeys(item, k, docs, projects)
		}
	case []any:
		for _, item := range v {
			collectProcessingKeys(item, field, docs, projects)
		}
	case string:
		if field == "projectId" || field == "projectID" {
			if v != "" {
				projects[v] = true
			}
		}
		if field == "key" || field == "keys" || field == "paperKey" || field == "documentKey" || field == "documentKeys" {
			if v != "" {
				docs[v] = true
			}
		}
	}
}
func sortedProcessingKeys(values map[string]bool) []string {
	out := []string{}
	for k := range values {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Read once to a private local temporary file, then replay for the existing
// handler. Multipart identity excludes the random browser-generated boundary.
func prepareProcessingRequest(r *http.Request, d *processingDescription) (string, func(), bool, error) {
	docs, projects := map[string]bool{}, map[string]bool{}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) > 2 && parts[1] == "documents" {
		docs[parts[2]] = true
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s %s?%s\n", r.Method, r.URL.Path, r.URL.RawQuery)
	if r.Body == nil || r.Body == http.NoBody {
		d.Documents = sortedProcessingKeys(docs)
		d.Projects = sortedProcessingKeys(projects)
		return hex.EncodeToString(h.Sum(nil)), func() {}, false, nil
	}
	temp, err := os.CreateTemp("", "readx-processing-*")
	if err != nil {
		return "", nil, false, err
	}
	cleanup := func() { temp.Close(); os.Remove(temp.Name()) }
	media, parameters, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	limit := int64(64 << 20)
	if media == "multipart/form-data" {
		limit = maxPublicationUploadBytes
	}
	_, err = io.Copy(temp, io.LimitReader(r.Body, limit+1))
	r.Body.Close()
	if err != nil {
		cleanup()
		return "", nil, false, err
	}
	info, err := temp.Stat()
	if err != nil || info.Size() > limit {
		cleanup()
		return "", nil, false, fmt.Errorf("处理请求超过大小限制")
	}
	temp.Seek(0, io.SeekStart)
	localOnly := false
	if media == "multipart/form-data" {
		reader := multipart.NewReader(temp, parameters["boundary"])
		fileCount := 0
		allNonPDF := true
		hints := []publicationMetadataHint{}
		metadataSeen := false
		for {
			part, e := reader.NextPart()
			if e == io.EOF {
				break
			}
			if e != nil {
				cleanup()
				return "", nil, false, e
			}
			if part.FileName() != "" {
				contentHash := sha256.New()
				prefix, e := io.ReadAll(io.LimitReader(part, 1024))
				if e != nil {
					cleanup()
					return "", nil, false, e
				}
				contentHash.Write(prefix)
				allNonPDF = allNonPDF && !isPDFData(prefix)
				n, e := io.Copy(contentHash, part)
				if e != nil {
					cleanup()
					return "", nil, false, e
				}
				sum := contentHash.Sum(nil)
				docs["doc-"+hex.EncodeToString(sum[:16])] = true
				d.Files = append(d.Files, part.FileName())
				fileCount++
				fmt.Fprintf(h, "file:%q:%q:%d:%x\n", part.FormName(), part.FileName(), n+int64(len(prefix)), sum)
			} else {
				raw, e := io.ReadAll(io.LimitReader(part, (1<<20)+1))
				if e != nil || len(raw) > 1<<20 {
					cleanup()
					return "", nil, false, fmt.Errorf("导入字段无效或过大")
				}
				fmt.Fprintf(h, "field:%q:%x\n", part.FormName(), raw)
				if part.FormName() == "metadata" {
					if metadataSeen || json.Unmarshal(raw, &hints) != nil {
						cleanup()
						return "", nil, false, fmt.Errorf("导入 metadata 重复或格式无效")
					}
					metadataSeen = true
				}
			}
			part.Close()
		}
		localOnly = fileCount > 0 && len(hints) == fileCount
		for _, hint := range hints {
			localOnly = localOnly && hint.LocalOnly
		}
		localOnly = localOnly || (fileCount > 0 && allNonPDF)
	} else {
		if info.Size() > 64<<20 {
			cleanup()
			return "", nil, false, fmt.Errorf("JSON 请求过大")
		}
		raw, e := io.ReadAll(temp)
		if e != nil {
			cleanup()
			return "", nil, false, e
		}
		h.Write(raw)
		var value any
		if json.Unmarshal(raw, &value) == nil {
			collectProcessingKeys(value, "", docs, projects)
			if object, ok := value.(map[string]any); ok {
				field := ""
				if r.URL.Path == "/v1/ai/models" || r.URL.Path == "/v1/ai/test" {
					field = "baseURL"
				}
				if r.URL.Path == "/v1/import/url" {
					field = "url"
				}
				if address, ok := object[field].(string); ok && address != "" {
					d.Destinations = append(d.Destinations, "本次指定地址："+processingPublicURL(address))
				}
			}
		}
	}
	d.Documents = sortedProcessingKeys(docs)
	d.Projects = sortedProcessingKeys(projects)
	temp.Seek(0, io.SeekStart)
	r.Body = temp
	return hex.EncodeToString(h.Sum(nil)), cleanup, localOnly, nil
}
func effectiveProcessingMode(p processingPolicy, d processingDescription) string {
	modes := []string{p.Library}
	for _, key := range d.Documents {
		if mode := p.Documents[key]; mode != "" {
			modes = append(modes, mode)
		}
	}
	for _, key := range d.Projects {
		if mode := p.Projects[key]; mode != "" {
			modes = append(modes, mode)
		}
	}
	mode := "allow"
	for _, m := range modes {
		if m == "deny" {
			return "deny"
		}
		if m != "allow" {
			mode = "ask"
		}
	}
	return mode
}
func processingPublicURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "（地址无效，执行时将校验）"
	}
	parsed.RawQuery = ""
	parsed.User = nil
	parsed.Fragment = ""
	return parsed.String()
}
func (s *Server) processingDestinations(r *http.Request) []string {
	if strings.HasPrefix(r.URL.Path, "/v1/zotero/") {
		return []string{"本机 Zotero（localhost:23119）；写入内容可能随后由 Zotero 自身同步上传"}
	}
	if strings.HasPrefix(r.URL.Path, "/v1/scholar/") {
		return []string{"按所选来源查询 PubMed / OpenAlex / Crossref；不调用 AI 模型"}
	}
	if strings.HasSuffix(r.URL.Path, "/citations") {
		return []string{"OpenAlex 引文目录服务"}
	}
	if strings.HasPrefix(r.URL.Path, "/v1/books/") || strings.HasPrefix(r.URL.Path, "/v1/book-sources/") {
		return []string{"当前选择的书源服务／下载地址；不调用 AI 模型"}
	}
	if r.URL.Path == "/v1/shares/readonly" {
		return []string{"本机生成分享文件；由你选择的接收者查看，不调用 AI 或云服务"}
	}
	out := []string{}
	config, err := s.aiConfig()
	if strings.Contains(r.URL.Path, "latex") {
		config, err = s.latexAIConfig()
	}
	if err == nil {
		if config.IsCLI() {
			out = append(out, "本机 CLI（可能自行联网，无法精确列出其后续服务）")
		} else {
			base := config.PublicBaseURL()
			if parsed, e := url.Parse(base); e == nil {
				parsed.RawQuery = ""
				parsed.User = nil
				parsed.Fragment = ""
				base = parsed.String()
			}
			out = append(out, config.ProviderName()+" · "+base+" · "+config.ModelName())
		}
	}
	if strings.Contains(r.URL.Path, "import") || strings.Contains(r.URL.Path, "retranslate") {
		out = append(out, "配置的 OCR 服务（可能上传完整 PDF）", "OpenAlex / Crossref（题录查询），以及配置的 AI 服务")
		if ocrConfig, err := s.loadOCRConfig(); err == nil {
			out = append(out, "OCR · "+ocrConfig.Provider+" · "+processingPublicURL(ocrConfig.BaseURL))
		}
	}
	if strings.Contains(r.URL.Path, "citations") || strings.Contains(r.URL.Path, "discovery") {
		out = append(out, "文献目录服务／期刊来源")
	}
	if r.URL.Path == "/v1/sync" {
		out = append(out, "配置的同步文件夹或 WebDAV 服务")
	}
	if len(out) == 0 {
		out = append(out, "本次所选外部服务／来源 URL")
	}
	return out
}

func (s *Server) processingSourceDigest(ctx context.Context, d processingDescription) string {
	h := sha256.New()
	// Hash private settings only for ticket binding; never return their contents.
	if config, err := os.ReadFile(legacy.NewPaths(s.cfg.DataRoot).ConfigFile()); err == nil {
		h.Write(config)
	}
	for _, key := range d.Documents {
		var raw, pdf, updated string
		_ = s.handle.QueryRowContext(ctx, `SELECT title||authors||doi||venue,pdf_path,updated_at FROM documents WHERE key=?`, key).Scan(&raw, &pdf, &updated)
		fmt.Fprintf(h, "%s:%s:%s", key, raw, updated)
		if info, e := os.Stat(pdf); e == nil {
			fmt.Fprintf(h, "%d:%d", info.Size(), info.ModTime().UnixNano())
		}
		if source, e := s.sourceText(ctx, key); e == nil {
			io.WriteString(h, source)
		}
		var reading string
		_ = s.handle.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id=(SELECT id FROM documents WHERE key=?)`, key).Scan(&reading)
		io.WriteString(h, reading)
	}
	for _, id := range d.Projects {
		source, _, err := s.latexProjectSourceContext(ctx, id, "", "")
		if err == nil {
			io.WriteString(h, source)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}
func processingMaterials(r *http.Request) []string {
	p := r.URL.Path
	switch {
	case strings.HasPrefix(p, "/v1/zotero/"):
		return []string{"向本机 Zotero 查询所选条目／集合；写回时发送当前确认的 ReadX 子笔记文本及父条目标识。不会直接修改 Zotero 数据库。"}
	case p == "/v1/shares/readonly":
		return []string{"所选文献的题录，以及你勾选的原文 PDF、个人批注和 AI 精读；不包含配置、密钥、聊天、任务日志或绝对路径"}
	case p == "/v1/ai/models" || p == "/v1/ai/test":
		return []string{"服务凭据、模型标识及测试文本；此接口不发送论文全文"}
	case strings.Contains(p, "latex"):
		return []string{"用户问题、当前未保存源码，以及项目内供助手读取的 TeX/Bib 文件和相关编译日志"}
	case strings.Contains(p, "presentation-theme"):
		return []string{"用户选择的模板摘要；此接口不发送论文全文"}
	case strings.Contains(p, "presentation-plan"):
		return []string{"论文题录、原文上下文、选定精读章节、图表说明及模板摘要"}
	case strings.Contains(p, "citations") || strings.Contains(p, "discovery") || strings.Contains(p, "scholar") || p == "/v1/import/search":
		return []string{"DOI、题名或当前检索词等题录查询字段；不为此发送完整 PDF"}
	case p == "/v1/sync":
		return []string{"本库文献、附件、阅读位置、批注及同步记录；不是仅当前选中文档"}
	case strings.Contains(p, "import") || strings.Contains(p, "retranslate"):
		return []string{"所选原文文件；PDF 可能完整上传 OCR；识别正文、题录、段落上下文随后可能交给 AI 翻译、核对和生成论文记忆"}
	default:
		return []string{"本次输入、历史及附件图片，关联论文的正文／选定页、精读结论或代码；具体取决于操作"}
	}
}
func (s *Server) enforceProcessing(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		action := processingAction(r)
		if action == "" {
			next(w, r)
			return
		}
		d := processingDescription{Action: action, Materials: processingMaterials(r), Disclosure: "这是发送范围说明，不是脱敏或数据驻留保证。后台处理和重试可能继续发送该范围内的材料；CLI／本地代理也可能联网。"}
		digest, cleanup, localOnly, err := prepareProcessingRequest(r, &d)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		defer cleanup()
		if localOnly {
			next(w, r)
			return
		}
		if r.URL.Path == "/v1/sync" {
			rows, e := s.handle.QueryContext(r.Context(), `SELECT key FROM documents ORDER BY key`)
			if e != nil {
				writeError(w, 500, e.Error())
				return
			}
			d.Documents = []string{}
			for rows.Next() {
				var key string
				if e = rows.Scan(&key); e != nil {
					break
				}
				d.Documents = append(d.Documents, key)
			}
			rows.Close()
			if e != nil {
				writeError(w, 500, e.Error())
				return
			}
		}
		for _, id := range d.Projects {
			if nodes, e := s.latexService().Tree(r.Context(), id); e == nil {
				for _, node := range nodes {
					ext := strings.ToLower(filepath.Ext(node.Path))
					if ext == ".tex" || ext == ".bib" {
						d.Files = append(d.Files, node.Path)
					}
				}
			}
		}
		d.Destinations = append(d.Destinations, s.processingDestinations(r)...)
		for _, key := range d.Documents {
			var title string
			_ = s.handle.QueryRowContext(r.Context(), `SELECT title FROM documents WHERE key=?`, key).Scan(&title)
			if title == "" {
				title = "待导入文档"
			}
			d.DocumentNames = append(d.DocumentNames, title)
		}
		for _, id := range d.Projects {
			project, e := s.latexService().Get(r.Context(), id)
			if e == nil {
				d.ProjectNames = append(d.ProjectNames, project.Title)
			}
		}
		// Bind confirmation to the actual destination configuration, not only UI input.
		targetJSON, _ := json.Marshal(d.Destinations)
		sum := sha256.Sum256(append([]byte(digest+s.processingSourceDigest(r.Context(), d)), targetJSON...))
		digest = hex.EncodeToString(sum[:])
		s.processingMu.Lock()
		p, err := s.processingPolicy(r.Context())
		if err != nil {
			s.processingMu.Unlock()
			writeError(w, 500, err.Error())
			return
		}
		mode := effectiveProcessingMode(p, d)
		if mode == "deny" {
			_ = s.recordProcessing(r.Context(), d, "denied")
			s.processingMu.Unlock()
			writeJSON(w, 403, map[string]any{"error": "当前书库／文档／项目禁止向外部服务发送材料；可仅保存原文，或显式修改处理权限。", "processing": d})
			return
		}
		if mode == "ask" {
			id := r.Header.Get("X-ReadX-Processing-Grant")
			ticket, ok := s.processingTickets[id]
			if !ok || !ticket.Approved || ticket.Digest != digest || ticket.Revision != p.Revision || time.Now().After(ticket.Expires) {
				if s.processingTickets == nil {
					s.processingTickets = map[string]processingTicket{}
				}
				for key, t := range s.processingTickets {
					if time.Now().After(t.Expires) {
						delete(s.processingTickets, key)
					}
				}
				if len(s.processingTickets) >= 256 {
					s.processingMu.Unlock()
					writeError(w, 429, "待确认处理请求过多，请稍后重试")
					return
				}
				id, e := randomLeeJobID()
				if e != nil {
					s.processingMu.Unlock()
					writeError(w, 500, e.Error())
					return
				}
				s.processingTickets[id] = processingTicket{Digest: digest, Revision: p.Revision, Expires: time.Now().Add(5 * time.Minute), Description: d}
				s.processingMu.Unlock()
				writeJSON(w, 428, map[string]any{"error": "请先确认本次发送范围", "requestId": id, "processing": d})
				return
			}
			delete(s.processingTickets, id)
		}
		if s.processingEpoch == nil {
			// Epoch cancellation also reaches detached import workers.
			s.processingEpoch, s.processingCancel = context.WithCancel(context.Background())
		}
		epoch := s.processingEpoch
		if err := s.recordProcessing(r.Context(), d, "authorized"); err != nil {
			s.processingMu.Unlock()
			writeError(w, 500, "无法保存授权记录，未执行外部处理")
			return
		}
		s.processingMu.Unlock()
		ctx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(epoch, cancel)
		defer stop()
		defer cancel()
		ctx = context.WithValue(ctx, processingEpochKey{}, epoch)
		next(w, r.WithContext(ctx))
	}
}
func (s *Server) processingBackground(parent context.Context, duration time.Duration) (context.Context, context.CancelFunc) {
	epoch, _ := parent.Value(processingEpochKey{}).(context.Context)
	if epoch == nil {
		epoch = context.Background()
	}
	return context.WithTimeout(epoch, duration)
}
