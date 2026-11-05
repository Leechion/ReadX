package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func processingTestServer(t *testing.T) *Server {
	_, db, cfg := newTestServer(t, nil)
	if _, err := db.Exec(`DELETE FROM app_state WHERE key=?`, processingPolicyKey); err != nil {
		t.Fatal(err)
	}
	s := New(cfg, db)
	t.Cleanup(s.comparisonJobs.Close)
	return s
}
func policyRequest(s *Server, body, grant string, next http.HandlerFunc) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/v1/ai/chat", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-ReadX-Processing-Grant", grant)
	out := httptest.NewRecorder()
	s.enforceProcessing(next)(out, req)
	return out
}
func approvePolicy(t *testing.T, s *Server, out *httptest.ResponseRecorder) string {
	t.Helper()
	var challenge struct {
		ID string `json:"requestId"`
	}
	if err := json.Unmarshal(out.Body.Bytes(), &challenge); err != nil || challenge.ID == "" {
		t.Fatalf("missing challenge: %s", out.Body.String())
	}
	w := httptest.NewRecorder()
	s.handleProcessingApproval(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"id":"`+challenge.ID+`"}`)))
	var result map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	return result["grant"]
}
func TestProcessingRequiresBoundSingleUseConsent(t *testing.T) {
	s := processingTestServer(t)
	var calls atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer receiver.Close()
	next := func(w http.ResponseWriter, r *http.Request) {
		res, err := http.Get(receiver.URL)
		if err != nil {
			t.Error(err)
		} else {
			res.Body.Close()
		}
		w.WriteHeader(200)
	}
	body := `{"key":"paper","question":"private material"}`
	out := policyRequest(s, body, "", next)
	if out.Code != 428 || calls.Load() != 0 {
		t.Fatal("sent before approval")
	}
	grant := approvePolicy(t, s, out)
	wrong := policyRequest(s, `{"key":"paper","question":"changed"}`, grant, next)
	if wrong.Code != 428 || calls.Load() != 0 {
		t.Fatal("approval authorized changed payload")
	}
	out = policyRequest(s, body, grant, next)
	if out.Code != 200 || calls.Load() != 1 {
		t.Fatalf("approved request not executed: %s", out.Body.String())
	}
	out = policyRequest(s, body, grant, next)
	if out.Code != 428 || calls.Load() != 1 {
		t.Fatal("single-use grant replayed")
	}
	var audit string
	_ = s.handle.QueryRow(`SELECT value_json FROM app_state WHERE key='processing.audit.v1'`).Scan(&audit)
	if strings.Contains(audit, "private material") {
		t.Fatal("audit stored private content")
	}
}
func TestProcessingDenyPrecedesAllowAndRevokesBackground(t *testing.T) {
	s := processingTestServer(t)
	_, err := s.handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,'')`, processingPolicyKey, `{"revision":1,"library":"allow","documents":{"paper":"deny"},"projects":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	var bg context.Context
	out := policyRequest(s, `{"key":"paper"}`, "", func(w http.ResponseWriter, r *http.Request) { t.Fatal("private document escaped") })
	if out.Code != 403 {
		t.Fatal(out.Body.String())
	}
	out = policyRequest(s, `{"key":"public"}`, "", func(w http.ResponseWriter, r *http.Request) {
		var cancel context.CancelFunc
		bg, cancel = s.processingBackground(r.Context(), time.Hour)
		t.Cleanup(cancel)
	})
	if out.Code != 200 || bg == nil {
		t.Fatal(out.Body.String())
	}
	patch := httptest.NewRecorder()
	s.handleProcessingPolicy(patch, httptest.NewRequest("PATCH", "/", strings.NewReader(`{"scope":"library","mode":"deny"}`)))
	if patch.Code != 200 {
		t.Fatal(patch.Body.String())
	}
	select {
	case <-bg.Done():
	case <-time.After(time.Second):
		t.Fatal("background authorization was not revoked")
	}
}
func TestProcessingLocalImportAndMultipartIdentity(t *testing.T) {
	s := processingTestServer(t)
	makeRequest := func(local bool, boundary string) *http.Request {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		_ = form.SetBoundary(boundary)
		file, _ := form.CreateFormFile("files", "paper.pdf")
		_, _ = file.Write([]byte("%PDF-1.4\nprivate"))
		hints, _ := json.Marshal([]publicationMetadataHint{{LocalOnly: local}})
		_ = form.WriteField("metadata", string(hints))
		_ = form.Close()
		req := httptest.NewRequest("POST", "/v1/import/files", &body)
		req.Header.Set("Content-Type", form.FormDataContentType())
		return req
	}
	first := httptest.NewRecorder()
	s.enforceProcessing(func(w http.ResponseWriter, r *http.Request) { t.Fatal("uploaded before consent") })(first, makeRequest(false, "boundary-one"))
	if first.Code != 428 {
		t.Fatal(first.Body.String())
	}
	grant := approvePolicy(t, s, first)
	nextReq := makeRequest(false, "boundary-two")
	nextReq.Header.Set("X-ReadX-Processing-Grant", grant)
	executed := false
	out := httptest.NewRecorder()
	s.enforceProcessing(func(w http.ResponseWriter, r *http.Request) {
		executed = true
		if err := r.ParseMultipartForm(1024); err != nil {
			t.Error(err)
		}
		if r.MultipartForm != nil {
			defer r.MultipartForm.RemoveAll()
		}
	})(out, nextReq)
	if !executed || out.Code != 200 {
		t.Fatal("browser boundary change invalidated same file", out.Body.String())
	}
	_, _ = s.handle.Exec(`UPDATE app_state SET value_json='{"revision":2,"library":"deny"}' WHERE key=?`, processingPolicyKey)
	executed = false
	out = httptest.NewRecorder()
	s.enforceProcessing(func(w http.ResponseWriter, r *http.Request) { executed = true })(out, makeRequest(true, "boundary-local"))
	if !executed {
		t.Fatal("offline import was blocked")
	}
}

func TestProcessingRejectsDuplicateMetadata(t *testing.T) {
	s := processingTestServer(t)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, _ := form.CreateFormFile("files", "paper.pdf")
	_, _ = file.Write([]byte("%PDF-1.4 private"))
	_ = form.WriteField("metadata", `[{"localOnly":false}]`)
	_ = form.WriteField("metadata", `[{"localOnly":true}]`)
	_ = form.Close()
	r := httptest.NewRequest("POST", "/v1/import/files", &body)
	r.Header.Set("Content-Type", form.FormDataContentType())
	w := httptest.NewRecorder()
	s.enforceProcessing(func(http.ResponseWriter, *http.Request) { t.Fatal("duplicate metadata bypassed consent") })(w, r)
	if w.Code != 400 {
		t.Fatalf("got %d: %s", w.Code, w.Body.String())
	}
}

func TestProcessingGETDescriptionUsesArrayScopes(t *testing.T) {
	s := processingTestServer(t)
	w := httptest.NewRecorder()
	s.enforceProcessing(func(http.ResponseWriter, *http.Request) { t.Fatal("GET escaped consent") })(w, httptest.NewRequest("GET", "/v1/import/search?q=CBCT", nil))
	var result struct {
		Processing struct {
			Documents []string `json:"documents"`
			Projects  []string `json:"projects"`
		} `json:"processing"`
	}
	if w.Code != 428 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Processing.Documents == nil || result.Processing.Projects == nil {
		t.Fatal("browser dialog requires array scopes", w.Body.String())
	}
}

func TestProcessingAuthenticatedRoutesDefaultToAsk(t *testing.T) {
	frontend, handle, _ := newTestServer(t, nil)
	if _, err := handle.Exec(`DELETE FROM app_state WHERE key=?`, processingPolicyKey); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, "GET", "/v1/processing/policy", "")
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatalf("unauthenticated policy: %d", response.StatusCode)
	}
	response = do(t, frontend, "GET", "/v1/processing/policy", testToken)
	var policy processingPolicy
	err := json.NewDecoder(response.Body).Decode(&policy)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || policy.Library != "ask" {
		t.Fatalf("unexpected production default: %+v %v", policy, err)
	}
	response = do(t, frontend, "GET", "/v1/import/search?q=CBCT", testToken)
	defer response.Body.Close()
	if response.StatusCode != 428 {
		t.Fatalf("search did not require consent: %d", response.StatusCode)
	}
}

func TestProcessingDownloadedContentRechecksDocumentDeny(t *testing.T) {
	s := processingTestServer(t)
	pdf := []byte("%PDF-1.4 private downloaded content")
	hash := sha256.Sum256(pdf)
	key := "doc-" + hex.EncodeToString(hash[:16])
	policy, _ := json.Marshal(processingPolicy{Revision: 1, Library: "allow", Documents: map[string]string{key: "deny"}})
	_, err := s.handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,'')`, processingPolicyKey, string(policy))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.runLocalPDFImport(context.Background(), "private.pdf", "https://example.com/private.pdf", pdf, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "禁止外部处理") {
		t.Fatalf("document deny was not checked before OCR: %v", err)
	}
}

func TestProcessingShelfIdentityAndDeletePreserveDeny(t *testing.T) {
	s := processingTestServer(t)
	_, err := s.handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES('library.categories','[{"name":"敏感论文","color":"rose","order":0}]','')`)
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.loadCategories(context.Background())
	if err != nil || len(items) != 1 || items[0].ID == "" {
		t.Fatal(items, err)
	}
	id := items[0].ID
	again, _ := s.loadCategories(context.Background())
	if again[0].ID != id {
		t.Fatal("shelf identity changed")
	}
	if err = s.saveMeta(context.Background(), "paper", DocumentMeta{Categories: []string{"敏感论文"}}); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"scope":"library","mode":"allow"}`, `{"scope":"shelf","key":"` + id + `","mode":"deny"}`} {
		w := httptest.NewRecorder()
		s.handleProcessingPolicy(w, httptest.NewRequest("PATCH", "/", strings.NewReader(body)))
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	out := policyRequest(s, `{"key":"paper"}`, "", func(http.ResponseWriter, *http.Request) { t.Fatal("sensitive shelf sent content") })
	if out.Code != 403 {
		t.Fatal(out.Body.String())
	}
	r := httptest.NewRequest("DELETE", "/", nil)
	r.SetPathValue("name", "敏感论文")
	w := httptest.NewRecorder()
	s.handleCategoryDelete(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	p, _ := s.processingPolicy(context.Background())
	if p.Documents["paper"] != "deny" {
		t.Fatal("removing shelf granted permission")
	}
	items, err = s.mutateCategoriesResult(context.Background(), func(items []Category) ([]Category, error) {
		return append(items, Category{Name: "敏感论文", Color: "rose"}), nil
	})
	if err != nil || items[0].ID == id {
		t.Fatal("same name reused deleted identity", items, err)
	}
}
