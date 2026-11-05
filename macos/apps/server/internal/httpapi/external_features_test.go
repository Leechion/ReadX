package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestScholarSourcesRecordQueriesAndPartialFailures(t *testing.T) {
	s := processingTestServer(t)
	s.scholarFetch = func(ctx context.Context, endpoint string, limit int64) ([]byte, string, error) {
		u, _ := url.Parse(endpoint)
		switch u.Host {
		case "api.openalex.org":
			return nil, "", errors.New("controlled source failure")
		case "api.crossref.org":
			if u.Query().Get("query.bibliographic") != "sparse view" || u.Query().Get("offset") != "20" {
				t.Error("wrong Crossref query/page")
			}
			return []byte(`{"message":{"total-results":81,"items":[{"title":["A paper"],"DOI":"10.1234/x","author":[{"given":"Ada","family":"L"}],"issued":{"date-parts":[[2026]]}}]}}`), "", nil
		default:
			return nil, "", errors.New("unexpected endpoint")
		}
	}
	w := httptest.NewRecorder()
	s.handleScholarSearch(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"queries":{"crossref":"sparse view","openalex":"CBCT AND reconstruction"},"page":2}`)))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var result scholarSearch
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	if len(result.Results) != 1 || result.Runs[0].Total != 81 || result.Runs[1].Error == "" || result.Page != 2 {
		t.Fatal(w.Body.String())
	}
	var saved string
	if e := s.handle.QueryRow(`SELECT value_json FROM app_state WHERE key=?`, "scholar-search:"+result.ID).Scan(&saved); e != nil || !strings.Contains(saved, "CBCT AND reconstruction") {
		t.Fatalf("query not preserved: %s %v", saved, e)
	}
	hits := dedupeScholar([]scholarHit{{paperCandidate: paperCandidate{Title: "one", DOI: "https://doi.org/10.1234/X"}, Source: "openalex", SourceID: "W1"}, {paperCandidate: paperCandidate{Title: "two", DOI: "10.1234/x"}, Source: "crossref", SourceID: "x"}})
	if len(hits) != 1 || len(hits[0].Sources) != 2 {
		t.Fatal("cross-source DOI dedupe lost provenance", hits)
	}
}

func TestScholarSnowballPagesReferencesAndCitations(t *testing.T) {
	s := processingTestServer(t)
	for _, direction := range []string{"references", "citations"} {
		calls := 0
		s.scholarFetch = func(ctx context.Context, endpoint string, limit int64) ([]byte, string, error) {
			calls++
			u, _ := url.Parse(endpoint)
			switch {
			case strings.Contains(endpoint, "https://doi.org/"):
				return []byte(`{"id":"https://openalex.org/W123","title":"seed","doi":"10.1234/seed"}`), "application/json", nil
			case strings.Contains(endpoint, "select=id,referenced_works"):
				ids := []string{}
				for i := 0; i < 21; i++ {
					ids = append(ids, "https://openalex.org/W"+strconv.Itoa(i))
				}
				raw, _ := json.Marshal(map[string]any{"referenced_works": ids})
				return raw, "application/json", nil
			default:
				if direction == "references" && u.Query().Get("filter") != "openalex_id:W20" {
					t.Errorf("wrong reference page: %s", endpoint)
				}
				if direction == "citations" && (u.Query().Get("filter") != "cites:W123" || u.Query().Get("page") != "2") {
					t.Errorf("wrong citation page: %s", endpoint)
				}
				return []byte(`{"meta":{"count":21},"results":[{"id":"https://openalex.org/W20","title":"outside paper","doi":"10.1234/outside","publication_year":2025}]}`), "application/json", nil
			}
		}
		w := httptest.NewRecorder()
		s.handleScholarSnowball(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"doi":"10.1234/seed","direction":"`+direction+`","page":2}`)))
		var found scholarSearch
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &found) != nil || len(found.Results) != 1 || found.Runs[0].Total != 21 {
			t.Fatal(w.Body.String())
		}
		if calls > 3 {
			t.Fatal("unexpected recursive expansion", calls)
		}
	}
}
func TestBrowserCaptureOnlyStoresValidatedLocalDraft(t *testing.T) {
	s := processingTestServer(t)
	for _, source := range []string{"https://example.org/paper", "javascript:alert(1)"} {
		w := httptest.NewRecorder()
		raw, _ := json.Marshal(browserCapture{URL: source, Title: "a paper"})
		s.handleCaptureInbox(w, httptest.NewRequest("POST", "/", strings.NewReader(string(raw))))
		if strings.HasPrefix(source, "javascript") && w.Code != 400 {
			t.Fatal("unsafe URL accepted")
		}
		if strings.HasPrefix(source, "https") && w.Code != 201 {
			t.Fatal(w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	s.handleCaptureInbox(w, httptest.NewRequest("GET", "/", nil))
	if !strings.Contains(w.Body.String(), "example.org") {
		t.Fatal(w.Body.String())
	}
}
func TestReadonlyShareUsesWhitelistAndEscapesContent(t *testing.T) {
	s := processingTestServer(t)
	pdf := filepath.Join(t.TempDir(), "paper.pdf")
	if e := os.WriteFile(pdf, []byte("%PDF-1.4\nfixture"), 0600); e != nil {
		t.Fatal(e)
	}
	_, e := s.handle.Exec(`INSERT INTO documents(id,key,title,pdf_path,format) VALUES('paper','paper',?,?,'pdf')`, `<script>unsafe</script>`, pdf)
	if e != nil {
		t.Fatal(e)
	}
	_, _ = s.handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES('private-test','{"apiKey":"do-not-share"}','')`)
	_, _ = s.handle.Exec(`INSERT INTO annotations(id,document_id,page,quote,note) VALUES('n','paper',3,'evidence','personal judgment')`)
	for _, include := range []bool{false, true} {
		raw, _ := json.Marshal(map[string]any{"keys": []string{"paper"}, "includeOriginal": include, "includeNotes": include})
		w := httptest.NewRecorder()
		s.handleReadonlyShare(w, httptest.NewRequest("POST", "/", strings.NewReader(string(raw))))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		page := w.Body.String()
		begin := strings.Index(page, `type="application/json">`) + len(`type="application/json">`)
		end := strings.Index(page[begin:], "</script>") + begin
		data, e := base64.StdEncoding.DecodeString(page[begin:end])
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(string(data), "do-not-share") || strings.Contains(string(data), pdf) {
			t.Fatal("private configuration or path leaked")
		}
		var bundle readonlyShare
		if e = json.Unmarshal(data, &bundle); e != nil {
			t.Fatal(e)
		}
		doc := bundle.Documents[0]
		if include && (len(doc.Notes) != 1 || doc.PDF == "") {
			t.Fatal("selected content missing")
		}
		if !include && (len(doc.Notes) > 0 || doc.PDF != "") {
			t.Fatal("unselected content included")
		}
		if strings.Contains(page, `<script>unsafe</script>`) {
			t.Fatal("stored title became executable HTML")
		}
	}
}
func TestZoteroNotesRequireGrantAndRejectVersionConflicts(t *testing.T) {
	s := processingTestServer(t)
	_, _ = s.handle.Exec(`INSERT INTO documents(id,key,title) VALUES('paper','paper','Paper')`)
	var saved zoteroObject
	writes := 0
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Zotero-Server-ID", "INSTANCE1")
		switch {
		case r.URL.Path == "/":
			_, _ = w.Write([]byte(`{}`))
		case r.URL.Path == "/local/authorize":
			_, _ = w.Write([]byte(`{"key":"12345678901234567890123456789012","remember":true}`))
		case strings.HasSuffix(r.URL.Path, "/children"):
			_ = json.NewEncoder(w).Encode([]zoteroObject{})
		case r.URL.Path == "/users/0/items" && r.Method == "POST":
			if r.Header.Get("Zotero-API-Key") == "" || r.Header.Get("Zotero-Server-ID") != "INSTANCE1" {
				t.Error("missing authorization")
			}
			var records []map[string]any
			_ = json.NewDecoder(r.Body).Decode(&records)
			saved = zoteroObject{Key: "NOTE1234", Version: 2, Data: records[0]}
			writes++
			_ = json.NewEncoder(w).Encode(map[string]any{"successful": map[string]any{"0": saved}})
		case r.URL.Path == "/users/0/items/NOTE1234" && r.Method == "GET":
			_ = json.NewEncoder(w).Encode(saved)
		case r.URL.Path == "/users/0/items/NOTE1234" && r.Method == "PUT":
			var data map[string]any
			_ = json.NewDecoder(r.Body).Decode(&data)
			if data["version"] != float64(saved.Version) {
				w.WriteHeader(412)
				return
			}
			saved.Version++
			saved.Data = data
			writes++
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer fake.Close()
	s.zoteroTestURL = fake.URL
	push := func(version int) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"documentKey": "paper", "parent": "PARENT12", "text": "my note <script>bad</script>", "version": version})
		w := httptest.NewRecorder()
		s.handleZoteroNote(w, httptest.NewRequest("POST", "/", strings.NewReader(string(body))))
		return w
	}
	if w := push(0); w.Code != 401 || writes != 0 {
		t.Fatal("unapproved write reached Zotero", w.Body.String())
	}
	w := httptest.NewRecorder()
	s.handleZoteroAuthorize(w, httptest.NewRequest("POST", "/", strings.NewReader("{}")))
	if w.Code != 200 || strings.Contains(w.Body.String(), "1234567890") {
		t.Fatal("authorization failed or leaked key", w.Body.String())
	}
	if w := push(0); w.Code != 200 || writes != 1 {
		t.Fatal(w.Body.String())
	}
	note, _ := saved.Data["note"].(string)
	if strings.Contains(note, "<script>") {
		t.Fatal("note text was not escaped")
	}
	if w := push(1); w.Code != 409 || writes != 1 {
		t.Fatal("stale version overwrote remote note", w.Body.String())
	}
	if w := push(2); w.Code != 200 || writes != 2 {
		t.Fatal("confirmed version did not update", w.Body.String())
	}
}
