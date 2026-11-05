package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"cbctv2/server/internal/appstate"
)

type browserCapture struct {
	ID      string   `json:"id"`
	URL     string   `json:"url"`
	PDFURL  string   `json:"pdfUrl"`
	Title   string   `json:"title"`
	DOI     string   `json:"doi"`
	Authors []string `json:"authors"`
	At      string   `json:"at"`
}

func captureURL(value string) bool {
	if value == "" {
		return true
	}
	u, e := url.Parse(value)
	return e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil && len(value) < 8000
}
func (s *Server) handleCaptureInbox(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		rows, _, err := appstate.Load[[]browserCapture](r.Context(), s.appStateStore, "capture.inbox")
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []browserCapture{}
		}
		writeJSON(w, 200, map[string]any{"records": rows})
		return
	}
	var body browserCapture
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if body.URL == "" || !captureURL(body.URL) || !captureURL(body.PDFURL) || len(body.Title) > 2000 || len(body.DOI) > 500 || len(body.Authors) > 40 {
		writeError(w, 400, "采集来源或题录无效")
		return
	}
	for _, author := range body.Authors {
		if len(author) > 500 {
			writeError(w, 400, "作者字段过长")
			return
		}
	}
	body.Title = strings.TrimSpace(body.Title)
	body.DOI = normalizePublicationDOI(body.DOI)
	body.At = time.Now().UTC().Format(time.RFC3339)
	sum := sha256.Sum256([]byte(body.URL))
	body.ID = hex.EncodeToString(sum[:16])
	err := s.appStateStore.Update(r.Context(), "capture.inbox", func(raw []byte, exists bool) ([]byte, error) {
		rows := []browserCapture{}
		if exists {
			if e := json.Unmarshal(raw, &rows); e != nil {
				return nil, e
			}
		}
		next := []browserCapture{body}
		for _, row := range rows {
			if row.ID != body.ID {
				next = append(next, row)
			}
		}
		if len(next) > 1000 {
			next = next[:1000]
		}
		return json.Marshal(next)
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"record": body, "disclosure": "仅保存来源和候选题录；未下载、未联网补全、未执行 OCR 或翻译。"})
}
