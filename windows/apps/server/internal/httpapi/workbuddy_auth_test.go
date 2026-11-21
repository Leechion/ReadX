package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
)

func TestWorkBuddyLoginStatusBeforeAISettingsAreSaved(t *testing.T) {
	server, _, cfg := newTestServer(t, nil)
	configPath := legacy.NewPaths(cfg.DataRoot).ConfigFile()
	authPath := filepath.Join(filepath.Dir(configPath), "workbuddy-auth.json")
	future := time.Now().Add(time.Hour).UnixMilli()
	if err := ai.SaveWorkBuddyCredential(authPath, ai.WorkBuddyCredential{
		AccessToken: "test-access", RefreshToken: "test-refresh", Nickname: "读者", ExpiresAt: future,
	}); err != nil {
		t.Fatal(err)
	}
	statusRoute := "/v1/ai/workbuddy/login"
	status := do(t, server, http.MethodGet, statusRoute, cfg.Token)
	payload := decode(t, status)
	if status.StatusCode != http.StatusOK || payload["authenticated"] != true || payload["nickname"] != "读者" {
		t.Fatalf("first-run WorkBuddy login was not detected: HTTP %d %v", status.StatusCode, payload)
	}
	if _, ok := payload["access_token"]; ok {
		t.Fatal("login status exposed the token")
	}
	settings := decode(t, do(t, server, http.MethodGet, "/v1/ai/settings", cfg.Token))
	workbuddy, ok := settings["workbuddy"].(map[string]any)
	if !ok || workbuddy["authenticated"] != true || settings["provider"] != "openai" {
		t.Fatalf("settings should show the signed-in account without choosing a provider: %v", settings)
	}
	if _, err := os.Stat(configPath); !os.IsNotExist(err) {
		t.Fatalf("reading login status unexpectedly changed AI settings: %v", err)
	}
	do(t, server, http.MethodDelete, statusRoute, cfg.Token).Body.Close()
	if state := decode(t, do(t, server, http.MethodGet, statusRoute, cfg.Token)); state["authenticated"] != false {
		t.Fatalf("logout left the account authenticated: %v", state)
	}
}
