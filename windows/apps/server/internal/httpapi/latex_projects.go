package httpapi

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"cbctv2/server/internal/latex"
	"cbctv2/server/internal/legacy"
)

// latexService 按需构造：LaTeX Studio 与阅读/翻译链路完全独立，
// 没打开过这个工作区就不该付出任何额外成本。
func (s *Server) latexService() *latex.Service {
	return latex.NewService(s.handle, s.cfg.DataRoot)
}

// writeLatexError 把 latex 包的语义化错误映射成合适的 HTTP 状态码。
//
// 路径不安全是 400（调用方给的输入不对），文件不存在是 404，revision 冲突是 409，
// 太大是 413，二进制不能当文本编辑是 415。区分这些不是为了好看：
// 前端要按状态码决定是「提示重命名」还是「提示重新加载」。
func writeLatexError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, latex.ErrUnsafePath):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, latex.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, latex.ErrRevisionMismatch):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, latex.ErrAssetExists):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, latex.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, err.Error())
	case errors.Is(err, latex.ErrBinaryFile):
		writeError(w, http.StatusUnsupportedMediaType, err.Error())
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}

// handleLatexProjects 处理 /v1/latex/projects：GET 列表、POST 新建。
func (s *Server) handleLatexProjects(w http.ResponseWriter, r *http.Request) {
	service := s.latexService()
	switch r.Method {
	case http.MethodGet:
		projects, err := service.List(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"projects": projects, "total": len(projects)})
	case http.MethodPost:
		var body struct {
			Title    string `json:"title"`
			Engine   string `json:"engine"`
			MainFile string `json:"mainFile"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			return
		}
		project, err := service.Create(r.Context(), body.Title, latex.Engine(body.Engine), body.MainFile)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, project)
	default:
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / POST")
	}
}

// handleLatexProject 处理 /v1/latex/projects/{id}：详情、改设置、删除。
func (s *Server) handleLatexProject(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	service := s.latexService()
	switch r.Method {
	case http.MethodGet:
		project, err := service.Get(r.Context(), id)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, project)
	case http.MethodPatch:
		// 指针字段区分「没传」与「传了零值」：只改用户真的改过的东西。
		var body struct {
			Title       *string `json:"title"`
			MainFile    *string `json:"mainFile"`
			Engine      *string `json:"engine"`
			AutoCompile *bool   `json:"autoCompile"`
			AIAutoFix   *bool   `json:"aiAutoFix"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			return
		}
		project, err := service.Update(r.Context(), id, latex.ProjectPatch{
			Title: body.Title, MainFile: body.MainFile, Engine: body.Engine,
			AutoCompile: body.AutoCompile, AIAutoFix: body.AIAutoFix,
		})
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, project)
	case http.MethodDelete:
		if err := service.Delete(r.Context(), id); err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / PATCH / DELETE")
	}
}

func (s *Server) handleLatexProjectDuplicate(w http.ResponseWriter, r *http.Request) {
	service := s.latexService()
	source, err := service.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeLatexError(w, err)
		return
	}
	var archive bytes.Buffer
	if _, err := service.WriteExportZip(r.Context(), source.ID, &archive); err != nil {
		writeLatexError(w, err)
		return
	}
	copy, err := service.Create(r.Context(), source.Title+"（副本）", latex.Engine(source.Engine), source.MainFile)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	cleanup := func() { _ = service.Delete(r.Context(), copy.ID) }
	if _, err := service.ImportZip(r.Context(), copy.ID, bytes.NewReader(archive.Bytes()), int64(archive.Len())); err != nil {
		cleanup()
		writeLatexError(w, err)
		return
	}
	updated, err := service.Update(r.Context(), copy.ID, latex.ProjectPatch{AutoCompile: &source.AutoCompile})
	if err != nil {
		cleanup()
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, updated)
}

// handleLatexTree 返回文件树。
func (s *Server) handleLatexTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	nodes, err := s.latexService().Tree(r.Context(), r.PathValue("id"))
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": nodes, "total": len(nodes)})
}

// handleLatexIndex 返回项目的引用键/标签索引（补全用），以及「用了但没定义」的键。
func (s *Server) handleLatexIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	index, err := s.latexService().Index(r.Context(), r.PathValue("id"))
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, index)
}

// handleLatexFile 处理单个文件：读、写、删。路径走 query 参数，不接受绝对路径。
func (s *Server) handleLatexFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	relative := strings.TrimSpace(r.URL.Query().Get("path"))
	if relative == "" {
		writeError(w, http.StatusBadRequest, "缺少 path 参数")
		return
	}
	service := s.latexService()
	switch r.Method {
	case http.MethodGet:
		content, err := service.ReadFile(r.Context(), id, relative)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, content)
	case http.MethodPut:
		var body struct {
			Content  string `json:"content"`
			Revision string `json:"revision"`
		}
		// JSON escaping can expand each UTF-8 byte to six ASCII bytes. The
		// service still enforces the 8 MiB limit on decoded file content.
		if err := decodeJSONLimit(w, r, &body, 6*latex.MaxFileBytes+(1<<20)); err != nil {
			return
		}
		revision, err := service.WriteFile(r.Context(), id, relative, []byte(body.Content), body.Revision)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"revision": revision})
	case http.MethodDelete:
		if err := service.DeletePath(r.Context(), id, relative); err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
	default:
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / PUT / DELETE")
	}
}

// handleLatexFileOps 处理新建/重命名/移动/复制。
func (s *Server) handleLatexFileOps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "只允许 POST")
		return
	}
	var body latex.FileOp
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if err := s.latexService().ApplyFileOp(r.Context(), r.PathValue("id"), body); err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleLatexImportZip 接收一个 ZIP 并安全解压进项目。
//
// 直接把压缩包当请求体发（不是 multipart）：客户端只有一个文件要传，
// 少一层 multipart 解析就少一处边界（文件名编码、临时文件、二次写盘）。
func (s *Server) handleLatexImportZip(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "只允许 POST")
		return
	}
	id := r.PathValue("id")
	if _, err := s.latexService().Get(r.Context(), id); err != nil {
		writeLatexError(w, err)
		return
	}
	declared, _ := strconv.ParseInt(r.Header.Get("Content-Length"), 10, 64)
	report, err := s.latexService().ImportZip(r.Context(), id, r.Body, declared)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// handleLatexExportZip 打包源码（排除副产物），带 Content-Disposition 供直接下载。
func (s *Server) handleLatexExportZip(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	id := r.PathValue("id")
	project, err := s.latexService().Get(r.Context(), id)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	// 先在内存里打包完再回响应：中途失败还能给一个正常的错误响应，
	// 而不是一个「已经下载了一半」的残包。打包的是源码（不含 build 产物），体积可控。
	var buffer bytes.Buffer
	if _, err := s.latexService().WriteExportZip(r.Context(), id, &buffer); err != nil {
		writeLatexError(w, err)
		return
	}
	name := legacy.SafeFileStem(project.Title)
	if strings.TrimSpace(name) == "" {
		name = "readx-latex-project"
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.zip"`, name))
	w.Header().Set("Content-Length", strconv.Itoa(buffer.Len()))
	_, _ = w.Write(buffer.Bytes())
}
