package httpapi

import (
	"cbctv2/server/internal/appstate"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"golang.org/x/text/unicode/norm"
	"net/http"
	"sort"
	"strings"
	"unicode"
)

type scholarSession struct {
	ID         string          `json:"id"`
	ParentID   string          `json:"parentId,omitempty"`
	Signature  string          `json:"signature"`
	At         string          `json:"at"`
	Pages      []scholarSearch `json:"pages"`
	Results    []scholarHit    `json:"results"`
	Disclosure string          `json:"disclosure"`
}

func scholarComparable(raw string) string {
	var out strings.Builder
	for _, r := range norm.NFKC.String(strings.ToLower(raw)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out.WriteRune(r)
		}
	}
	return out.String()
}
func scholarTitleIdentity(hit scholarHit) string {
	if hit.Year == 0 || len(hit.Authors) == 0 || scholarComparable(hit.Authors[0]) == "" {
		return ""
	}
	return fmt.Sprintf("%s:%d:%s", scholarComparable(hit.Title), hit.Year, scholarComparable(hit.Authors[0]))
}
func scholarSignature(queries map[string]string) string {
	raw, _ := json.Marshal(queries)
	return string(raw)
}

func (s *Server) checkScholarSession(ctx context.Context, id, parent, signature string) error {
	if id != "" {
		if _, err := safeKey(id, "检索会话"); err != nil {
			return err
		}
		session, exists, err := appstate.Load[scholarSession](ctx, s.appStateStore, "scholar-session:"+id)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("检索会话不存在")
		}
		if session.Signature != signature || session.ParentID != parent {
			return fmt.Errorf("会话的检索式或扩展路径已变化，请发起新检索")
		}
	}
	if parent != "" {
		if _, err := safeKey(parent, "父检索记录"); err != nil {
			return err
		}
		_, exists, err := appstate.Load[scholarSearch](ctx, s.appStateStore, "scholar-search:"+parent)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("父检索记录不存在")
		}
	}
	return nil
}

func (s *Server) persistScholarSearch(ctx context.Context, result *scholarSearch, sessionID, parent, signature string) error {
	if err := s.markScholarLibrary(ctx, result.Results); err != nil {
		return err
	}
	if sessionID == "" {
		id, err := randomLeeJobID()
		if err != nil {
			return err
		}
		sessionID = id
	}
	result.SessionID = sessionID
	result.ParentID = parent
	err := s.appStateStore.Update(ctx, "scholar-session:"+sessionID, func(raw []byte, exists bool) ([]byte, error) {
		session := scholarSession{ID: sessionID, ParentID: parent, Signature: signature, At: result.At, Pages: []scholarSearch{}}
		if exists {
			if err := json.Unmarshal(raw, &session); err != nil {
				return nil, err
			}
			if session.Signature != signature || session.ParentID != parent {
				return nil, fmt.Errorf("会话检索式冲突")
			}
		}
		replaced := false
		for i, page := range session.Pages {
			if page.Page == result.Page {
				session.Pages[i] = *result
				replaced = true
			}
		}
		if !replaced {
			session.Pages = append(session.Pages, *result)
		}
		sort.Slice(session.Pages, func(i, j int) bool { return session.Pages[i].Page < session.Pages[j].Page })
		hits := []scholarHit{}
		for _, page := range session.Pages {
			hits = append(hits, page.Results...)
		}
		session.Results = dedupeScholar(hits)
		session.Disclosure = fmt.Sprintf("已抓取 %d 页，去重后 %d 条题录；仅覆盖已抓取页，不是全源完整命中数。无 DOI 仅在题名、年份、首作者均一致时合并。全文未验证。", len(session.Pages), len(session.Results))
		return json.Marshal(session)
	})
	if err != nil {
		return err
	}
	return appstate.Save(ctx, s.appStateStore, "scholar-search:"+result.ID, *result)
}
func (s *Server) handleScholarSessions(w http.ResponseWriter, r *http.Request) {
	if id := r.PathValue("id"); id != "" {
		session, exists, err := appstate.Load[scholarSession](r.Context(), s.appStateStore, "scholar-session:"+id)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if !exists {
			writeError(w, 404, "会话不存在")
			return
		}
		writeJSON(w, 200, session)
		return
	}
	rows, err := s.handle.QueryContext(r.Context(), `SELECT value_json FROM app_state WHERE key LIKE 'scholar-session:%' ORDER BY updated_at DESC LIMIT 100`)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	summaries := []map[string]any{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			break
		}
		var session scholarSession
		if err = json.Unmarshal([]byte(raw), &session); err != nil {
			break
		}
		summaries = append(summaries, map[string]any{"id": session.ID, "parentId": session.ParentID, "at": session.At, "pages": len(session.Pages), "count": len(session.Results), "query": session.Signature})
	}
	if err == nil {
		err = rows.Err()
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"sessions": summaries})
}

func (s *Server) markScholarLibrary(ctx context.Context, hits []scholarHit) error {
	rows, err := s.handle.QueryContext(ctx, `SELECT key,title,authors,year,doi FROM documents`)
	if err != nil {
		return err
	}
	defer rows.Close()
	doiKeys, titleKeys := map[string]string{}, map[string]string{}
	for rows.Next() {
		var key, authors string
		var item scholarHit
		var year sql.NullInt64
		if err = rows.Scan(&key, &item.Title, &authors, &year, &item.DOI); err != nil {
			return err
		}
		_ = json.Unmarshal([]byte(authors), &item.Authors)
		item.Year = int(year.Int64)
		if doi := normalizePublicationDOI(item.DOI); doi != "" {
			doiKeys[strings.ToLower(doi)] = key
		}
		if title := scholarTitleIdentity(item); title != "" {
			titleKeys[title] = key
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for i := range hits {
		hits[i].ExistingKey = ""
		if doi := normalizePublicationDOI(hits[i].DOI); doi != "" {
			hits[i].ExistingKey = doiKeys[strings.ToLower(doi)]
		} else if title := scholarTitleIdentity(hits[i]); title != "" {
			hits[i].ExistingKey = titleKeys[title]
		}
	}
	return nil
}
func (s *Server) handleScholarRecord(w http.ResponseWriter, r *http.Request) {
	record, exists, err := appstate.Load[scholarSearch](r.Context(), s.appStateStore, "scholar-search:"+r.PathValue("id"))
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if !exists {
		writeError(w, 404, "检索记录不存在")
		return
	}
	writeJSON(w, 200, record)
}
