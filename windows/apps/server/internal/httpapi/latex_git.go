package httpapi

import (
	"encoding/json"
	"net/http"

	"cbctv2/server/internal/latex"
)

func (s *Server) handleLatexGitStatus(w http.ResponseWriter, r *http.Request) {
	id, err := safeKey(r.PathValue("id"), "项目标识")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	report, err := s.latexService().GitStatus(r.Context(), id)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleLatexGitInit(w http.ResponseWriter, r *http.Request) {
	id, err := safeKey(r.PathValue("id"), "项目标识")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Branch string `json:"branch"`
	}
	if err := decodeOptionalJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "初始化参数无效")
		return
	}
	report, err := s.latexService().GitInit(r.Context(), id, body.Branch)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleLatexGitCommit(w http.ResponseWriter, r *http.Request) {
	id, err := safeKey(r.PathValue("id"), "项目标识")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Message string `json:"message"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "提交参数无效")
		return
	}
	report, err := s.latexService().GitCommit(r.Context(), id, body.Message)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleLatexGitRemote(w http.ResponseWriter, r *http.Request) {
	id, err := safeKey(r.PathValue("id"), "项目标识")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		RemoteURL string `json:"remoteUrl"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "远程仓库参数无效")
		return
	}
	report, err := s.latexService().GitSetRemote(r.Context(), id, body.RemoteURL)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleLatexGitSync(w http.ResponseWriter, r *http.Request) {
	id, err := safeKey(r.PathValue("id"), "项目标识")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Mode          string `json:"mode"`
		CommitMessage string `json:"commitMessage"`
	}
	if err := decodeOptionalJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "Git 同步参数无效")
		return
	}
	result, err := s.latexService().GitSync(r.Context(), id, body.Mode, body.CommitMessage)
	if err != nil {
		if result != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error":  err.Error(),
				"result": result,
			})
			return
		}
		writeLatexError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// Keep compiler check that latex.GitStatusReport is imported cleanly if helpers change.
var _ = (*latex.GitStatusReport)(nil)
