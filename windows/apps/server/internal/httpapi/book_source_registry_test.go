package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"cbctv2/server/internal/booksources"
	"cbctv2/server/internal/db"
)

func newAllowedBookSourceServer(t *testing.T) *Server {
	t.Helper()
	cfg := defaultTestConfig(t.TempDir())
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	if _, err := handle.Exec(`INSERT OR IGNORE INTO app_state(key,value_json,updated_at) VALUES('processing.policy.v1','{"revision":1,"library":"allow","documents":{},"projects":{}}','')`); err != nil {
		_ = handle.Close()
		t.Fatal(err)
	}
	s := New(cfg, handle)
	t.Cleanup(func() {
		s.comparisonJobs.Close()
		_ = handle.Close()
	})
	return s
}

type deniedBookSource struct{}

func (deniedBookSource) Info() booksources.Source {
	return booksources.Source{ProviderID: "denied", Enabled: true, Capabilities: booksources.Capability{Search: true, Detail: true, Download: true}}
}
func (deniedBookSource) Search(context.Context, string, string) (booksources.SearchResult, error) {
	return booksources.SearchResult{Books: []booksources.Book{}}, nil
}
func (deniedBookSource) Detail(context.Context, string) (booksources.Book, error) {
	return booksources.Book{ID: "1", Formats: []string{"epub"}, Rights: booksources.Rights{Access: "unknown", Reason: "未核验"}}, nil
}
func (deniedBookSource) Download(context.Context, string, string, booksources.Progress) (booksources.Artifact, error) {
	panic("rights bypass")
}
func TestBookSourceRoutesAuthAndRights(t *testing.T) {
	s := newAllowedBookSourceServer(t)
	s.bookSourcesOnce.Do(func() {
		s.bookSources = booksources.New(t.TempDir(), append(booksources.DefaultProviders(nil), deniedBookSource{})...)
	})
	handler := s.Handler()
	run := func(method, path, body string, auth bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		if auth {
			r.Header.Set("Authorization", "Bearer "+testToken)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := run("GET", "/v1/book-sources", "", false); w.Code != http.StatusUnauthorized {
		t.Fatal(w.Code)
	}
	w := run("GET", "/v1/book-sources", "", true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"providerId":"zlibrary"`) {
		t.Fatal(w.Body.String())
	}
	for _, tc := range []struct {
		method, path, body string
		status             int
		code               string
	}{
		{"GET", "/v1/book-sources/zlibrary/search?q=test", "", 401, "AUTH_REQUIRED"},
		{"POST", "/v1/book-sources/denied/books/1/downloads", `{"format":"epub"}`, 403, "NO_PERMISSION"},
		{"POST", "/v1/book-sources/denied/books/1/downloads", `{"format":"epub","url":"http://127.0.0.1"}`, 400, ""},
		{"GET", "/v1/book-downloads/missing", "", 404, "NOT_CONFIGURED"},
		{"GET", "/v1/book-sources/not-a-source/search?q=test", "", 404, "SOURCE_NOT_SUPPORTED"},
	} {
		w := run(tc.method, tc.path, tc.body, true)
		if w.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		if tc.code != "" {
			var data map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &data)
			if data["code"] != tc.code {
				t.Fatal(data)
			}
		}
	}
}

func TestZLibraryConnectionRoutesDoNotExposeCredentials(t *testing.T) {
	s := newAllowedBookSourceServer(t)
	handler := s.Handler()
	run := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	w := run("GET", "/v1/book-sources/zlibrary/connection", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var status map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &status)
	if status["connected"] != false || status["origin"] != "https://z-lib.gd" {
		t.Fatal(status)
	}
	for _, tc := range []struct {
		method, path, body string
		code               int
	}{
		{"POST", "/v1/book-sources/zlibrary/connection", `{}`, 400},
		{"PUT", "/v1/book-sources/zlibrary/connection", `{"origin":"https://127.0.0.1","downloadOrigins":[]}`, 400},
		{"DELETE", "/v1/book-sources/zlibrary/connection", "", 200},
		{"GET", "/v1/book-sources/zlibrary/books/11:abcdef/cover", "", 401},
	} {
		w = run(tc.method, tc.path, tc.body)
		if w.Code != tc.code {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "userKey") || strings.Contains(w.Body.String(), "password") {
			t.Fatal("credential fields exposed")
		}
	}
}

func TestNilDBDoesNotPanicUnderProcessingMiddleware(t *testing.T) {
	s := New(defaultTestConfig(t.TempDir()), nil)
	handler := s.Handler()
	for _, tc := range []struct {
		method, path string
		expected     int
	}{
		{"GET", "/v1/book-sources", 200},
		{"GET", "/v1/book-sources/zlibrary/connection", 200},
		{"GET", "/v1/book-sources/zlibrary/search?q=test", 428},
	} {
		r := httptest.NewRequest(tc.method, "http://127.0.0.1"+tc.path, nil)
		r.Header.Set("Authorization", "Bearer "+testToken)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.expected {
			t.Fatalf("%s %s: got %d, want %d (%s)", tc.method, tc.path, w.Code, tc.expected, w.Body.String())
		}
	}
}
