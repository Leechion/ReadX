package ai

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestAIHTTPClientAllowsLocalSameOriginButBlocksCredentialRedirect(t *testing.T) {
	var reached atomic.Bool
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached.Store(true) }))
	defer foreign.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/models":
			http.Redirect(w, r, "/local-models", http.StatusTemporaryRedirect)
		case "/foreign":
			http.Redirect(w, r, foreign.URL, http.StatusTemporaryRedirect)
		default:
			if r.Header.Get("x-api-key") != "private-key" {
				t.Error("same-origin request lost key")
			}
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer origin.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, test := range []struct {
		path    string
		blocked bool
	}{{"/models", false}, {"/foreign", true}} {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, origin.URL+test.path, nil)
		req.Header.Set("x-api-key", "private-key")
		response, err := NewHTTPClient().Do(req)
		if response != nil {
			response.Body.Close()
		}
		if (err != nil) != test.blocked {
			t.Fatalf("%s unexpected result: %v", test.path, err)
		}
	}
	if reached.Load() {
		t.Fatal("foreign server received credential-bearing redirect")
	}
}
