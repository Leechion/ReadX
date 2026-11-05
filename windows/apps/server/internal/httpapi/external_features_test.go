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
	"time"
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
			case strings.Contains(endpoint, "select=id,doi,title"):
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
		anchor := "10.1234/seed"
		if direction == "citations" {
			anchor = "W123"
		}
		s.handleScholarSnowball(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"doi":"`+anchor+`","direction":"`+direction+`","page":2}`)))
		var found scholarSearch
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &found) != nil || len(found.Results) != 1 || found.Runs[0].Total != 21 {
			t.Fatal(w.Body.String())
		}
		if calls > 3 {
			t.Fatal("unexpected recursive expansion", calls)
		}
	}
}

func TestScholarSessionsMergePagesAndKeepExpansionParent(t *testing.T) {
	s := processingTestServer(t)
	hit := func(source, id, doi, title string) scholarHit {
		return scholarHit{paperCandidate: paperCandidate{Title: title, Year: 2025, Authors: []string{"Li Wei"}, DOI: doi}, Source: source, SourceID: id}
	}
	first := scholarSearch{ID: "first", At: "2026-11-05T00:00:00Z", Page: 1, Results: []scholarHit{hit("pubmed", "1", "", "Sparse-view CBCT")}}
	if err := s.persistScholarSearch(context.Background(), &first, "", "", "query"); err != nil {
		t.Fatal(err)
	}
	second := scholarSearch{ID: "second", Page: 2, Results: []scholarHit{hit("crossref", "2", "10.1234/a", "Sparse view CBCT")}}
	if err := s.checkScholarSession(context.Background(), first.SessionID, "", "changed"); err == nil {
		t.Fatal("changed query accepted")
	}
	if err := s.persistScholarSearch(context.Background(), &second, first.SessionID, "", "query"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.SetPathValue("id", first.SessionID)
	s.handleScholarSessions(w, r)
	var session scholarSession
	if json.Unmarshal(w.Body.Bytes(), &session) != nil || len(session.Pages) != 2 || len(session.Results) != 1 || len(session.Results[0].Sources) != 2 || session.Results[0].DOI == "" {
		t.Fatal(w.Body.String())
	}
	child := scholarSearch{ID: "child", Page: 1, Results: []scholarHit{}}
	if err := s.checkScholarSession(context.Background(), "", first.ID, "references:10.1234/a"); err != nil {
		t.Fatal(err)
	}
	if err := s.persistScholarSearch(context.Background(), &child, "", first.ID, "references:10.1234/a"); err != nil || child.ParentID != first.ID {
		t.Fatal(child, err)
	}
	different := hit("crossref", "3", "10.1234/different", "Sparse view CBCT")
	if len(dedupeScholar([]scholarHit{second.Results[0], different})) != 2 {
		t.Fatal("different known DOIs merged")
	}
}

func TestScholarLibraryMatchesKnownDOIAndConservativeMetadata(t *testing.T) {
	s := processingTestServer(t)
	_, err := s.handle.Exec(`INSERT INTO documents(id,key,title,authors,year,doi) VALUES('p','p','Sparse-view CBCT','["Li Wei"]',2025,'10.1234/A')`)
	if err != nil {
		t.Fatal(err)
	}
	hits := []scholarHit{{paperCandidate: paperCandidate{DOI: "https://doi.org/10.1234/a"}}, {paperCandidate: paperCandidate{Title: "Sparse view CBCT", Authors: []string{"Li Wei"}, Year: 2025}}, {paperCandidate: paperCandidate{Title: "Sparse view CBCT"}}}
	if err = s.markScholarLibrary(context.Background(), hits); err != nil {
		t.Fatal(err)
	}
	if hits[0].ExistingKey != "p" || hits[1].ExistingKey != "p" || hits[2].ExistingKey != "" {
		t.Fatal(hits)
	}
}

func TestScholarLiveSources(t *testing.T) {
	if os.Getenv("READX_LIVE_SCHOLAR") != "1" {
		t.Skip("opt-in public-source integration test")
	}
	s := processingTestServer(t)
	for _, source := range []string{"crossref", "pubmed", "openalex"} {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		results, total, err := s.searchScholar(ctx, source, "CBCT", 1)
		cancel()
		if err != nil {
			t.Errorf("%s: %v", source, err)
			continue
		}
		if len(results) == 0 || total == 0 {
			t.Errorf("%s: empty live result", source)
		} else {
			t.Logf("%s: %d entries, source reports %d", source, len(results), total)
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

func TestReadonlyShareIncludesEPUBLocatorsSelectedIdeasAndComparisonStates(t *testing.T) {
	s := processingTestServer(t)
	imported, err := s.importPublication(context.Background(), "fixture.epub", "fixture", epubFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	key := imported.Document.Key
	_, err = s.handle.Exec(`INSERT INTO annotations(id,document_id,quote,note,locator_json) VALUES('epub-note',?,'Original chapter text.','My question',?)`, imported.Document.ID, `{"kind":"epub","href":"chapter.xhtml","blockStart":1,"blockEnd":1,"startOffset":0,"endOffset":22}`)
	if err != nil {
		t.Fatal(err)
	}
	ideas := []ResearchIdea{{Question: "Why this result?", Status: "draft", Evidence: []IdeaEvidence{{PaperKey: key, Origin: "个人笔记", Excerpt: "My evidence"}, {PaperKey: "not-selected", Origin: "个人笔记", Excerpt: "do-not-share-other-evidence"}}}, {Question: "do-not-share-unrelated-idea", Evidence: []IdeaEvidence{{PaperKey: "not-selected"}}}}
	rawIdeas, _ := json.Marshal(ideas)
	_, err = s.handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES('ideas',?,'')`, string(rawIdeas))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleReadonlyShare(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"keys":["`+key+`"],"includeOriginal":true,"includeNotes":true,"includeIdeas":true,"includeComparisons":true}`)))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	page := w.Body.String()
	begin := strings.Index(page, `type="application/json">`) + len(`type="application/json">`)
	end := strings.Index(page[begin:], "</script>") + begin
	raw, err := base64.StdEncoding.DecodeString(page[begin:end])
	if err != nil {
		t.Fatal(err)
	}
	var bundle readonlyShare
	if json.Unmarshal(raw, &bundle) != nil {
		t.Fatal(string(raw))
	}
	doc := bundle.Documents[0]
	if doc.EPUB == "" || len(doc.Sections) != 1 || doc.Notes[0].Locator.Href != "chapter.xhtml" || doc.Notes[0].Locator.BlockStart != 1 {
		t.Fatal("missing chapter context", doc)
	}
	sections, _ := json.Marshal(doc.Sections)
	if strings.Contains(string(sections), "malicious()") || !strings.Contains(string(sections), "data:image/png;base64,") {
		t.Fatal("unsafe or missing EPUB content", string(sections))
	}
	if len(bundle.Ideas) != 1 || len(bundle.Ideas[0].Evidence) != 1 || strings.Contains(string(raw), "do-not-share") {
		t.Fatal("unselected idea or evidence leaked", string(raw))
	}
	if len(bundle.Comparisons) != 1 || bundle.Comparisons[0].Status != "未抽取" {
		t.Fatal("missing comparison fabricated a claim", bundle.Comparisons)
	}
	comparison := shareExperiment(DocumentSummary{Key: "paper"}, `{"dataset":[{"k":"Views","v":"50","page":3,"excerpt":"50 views","secret":"private"}],"config":{"apiKey":"private"}}`)
	encoded, _ := json.Marshal(comparison)
	if comparison.Status != "已有抽取" || len(comparison.Groups["dataset"]) != 1 || strings.Contains(string(encoded), "private") {
		t.Fatal(string(encoded))
	}
	if output := os.Getenv("READX_SHARE_FIXTURE_PATH"); output != "" {
		if err = os.WriteFile(output, w.Body.Bytes(), 0600); err != nil {
			t.Fatal(err)
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
