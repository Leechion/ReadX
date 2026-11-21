package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"cbctv2/server/internal/latex"
)

// handleLatexToolchains 报告本机 TeX 工具链的真实状态。
//
// 如实返回「哪个可用、哪个不可用、为什么」：本机 latexmk 就是「exe 在但缺 Perl」，
// 让界面把这句话显示出来，用户才知道下一步该装什么。
func (s *Server) handleLatexToolchains(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
		return
	}
	refresh := r.URL.Query().Get("refresh") == "1"
	writeJSON(w, http.StatusOK, latex.DetectToolchains(r.Context(), refresh))
}

// handleLatexBuilds 处理项目的编译动作与历史：POST 发起编译，GET 列出历史。
func (s *Server) handleLatexBuilds(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	service := s.latexService()
	switch r.Method {
	case http.MethodPost:
		var body struct {
			Engine      string `json:"engine"`
			TimeoutSecs int    `json:"timeoutSeconds"`
		}
		// 允许空 body：最常用的动作就是「用项目设置编译一次」。
		if r.ContentLength != 0 {
			if err := decodeJSON(w, r, &body); err != nil {
				return
			}
		}
		options := latex.BuildOptions{Engine: body.Engine}
		if body.TimeoutSecs > 0 {
			options.Timeout = time.Duration(body.TimeoutSecs) * time.Second
		}
		build, err := service.StartBuild(r.Context(), id, options)
		if err != nil {
			switch {
			case errors.Is(err, latex.ErrBuildInProgress):
				writeError(w, http.StatusConflict, err.Error())
			case errors.Is(err, latex.ErrNotFound):
				writeError(w, http.StatusNotFound, err.Error())
			default:
				// 「没装 TeX」这类问题属于环境不满足，用 409 让前端把它当提示而不是故障。
				writeError(w, http.StatusConflict, err.Error())
			}
			return
		}
		writeJSON(w, http.StatusAccepted, build)
	case http.MethodGet:
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		builds, err := service.Builds(r.Context(), id, limit)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"builds": builds, "total": len(builds)})
	default:
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / POST")
	}
}

// handleLatexBuild 处理单次编译：查状态、看日志、取消、下载 PDF。
func (s *Server) handleLatexBuild(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	service := s.latexService()
	action := r.PathValue("action")
	switch action {
	case "":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
			return
		}
		build, err := service.Build(r.Context(), id)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, build)
	case "log":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
			return
		}
		content, err := service.BuildLog(r.Context(), id)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"log": content})
	case "cancel":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "只允许 POST")
			return
		}
		if err := service.CancelBuild(r.Context(), id); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
	case "pdf":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "只允许 GET")
			return
		}
		path, build, err := service.BuildPDFPath(r.Context(), id)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			writeError(w, http.StatusInternalServerError, "读取 PDF 失败: "+readErr.Error())
			return
		}
		// inline：预览要用它直接喂给 PDF.js；下载由前端另加 download 属性。
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Header().Set("X-ReadX-Build", build.ID)
		w.Header().Set("X-ReadX-Pages", strconv.Itoa(build.Pages))
		if r.URL.Query().Get("download") == "1" {
			name := legacySafeStem(build.MainFile)
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.pdf"`, name))
		}
		_, _ = w.Write(content)
	default:
		writeError(w, http.StatusNotFound, "未知的编译操作")
	}
}

// handleLatexSyncTeXForward 把源码「文件:行号」映射到编译产物 PDF 的页码与坐标框。
func (s *Server) handleLatexSyncTeXForward(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	file := strings.TrimSpace(r.URL.Query().Get("file"))
	if file == "" {
		writeError(w, http.StatusBadRequest, "缺少 file 参数")
		return
	}
	line, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("line")))
	if err != nil || line < 1 {
		writeError(w, http.StatusBadRequest, "line 必须是大于等于 1 的整数")
		return
	}
	result, err := s.latexService().ForwardSync(r.Context(), id, file, line)
	if err != nil {
		if errors.Is(err, latex.ErrUnsafePath) || errors.Is(err, latex.ErrNotFound) {
			writeLatexError(w, err)
			return
		}
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleLatexSyncTeXReverse 把 PDF 页码和点击坐标反查回项目内的源码文件与行号。
func (s *Server) handleLatexSyncTeXReverse(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	page, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("page")))
	if err != nil || page < 1 {
		writeError(w, http.StatusBadRequest, "page 必须是大于等于 1 的整数")
		return
	}
	x, err := strconv.ParseFloat(strings.TrimSpace(r.URL.Query().Get("x")), 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "x 必须是数字")
		return
	}
	y, err := strconv.ParseFloat(strings.TrimSpace(r.URL.Query().Get("y")), 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "y 必须是数字")
		return
	}
	location, err := s.latexService().ReverseSync(r.Context(), id, page, x, y)
	if err != nil {
		if errors.Is(err, latex.ErrUnsafePath) || errors.Is(err, latex.ErrNotFound) {
			writeLatexError(w, err)
			return
		}
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, location)
}

func legacySafeStem(mainFile string) string {
	stem := strings.TrimSuffix(mainFile, ".tex")
	stem = strings.ReplaceAll(stem, "/", "-")
	if stem == "" {
		stem = "document"
	}
	return stem
}
