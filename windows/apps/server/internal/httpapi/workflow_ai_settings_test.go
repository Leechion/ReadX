package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWorkflowSettingsFollowGlobalAndOverride(t *testing.T) {
	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{
	  "provider": "openai",
	  "baseURL": "https://global.example.com/v1",
	  "model": "deepseek-reasoner",
	  "reasoningEffort": "high",
	  "apiKey": "global-secret",
	  "connections": {"openai|https://global.example.com/v1": "global-secret"}
	}`)

	res, body := post(t, bundle, http.MethodGet, "/v1/ai/workflows", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/ai/workflows failed: %d %v", res.StatusCode, body)
	}
	workflows, _ := body["workflows"].(map[string]any)
	for _, kind := range []string{WorkflowTranslation, WorkflowQA, WorkflowReading} {
		wf, _ := workflows[kind].(map[string]any)
		if wf == nil || wf["followGlobal"] != true {
			t.Fatalf("expected workflow %s to follow global by default: %v", kind, wf)
		}
		if wf["model"] != "deepseek-reasoner" || wf["reasoningEffort"] != "high" {
			t.Fatalf("expected workflow %s to reflect global model & effort: %v", kind, wf)
		}
	}

	rawJSON, _ := json.Marshal(body["savedChannels"])
	if strings.Contains(string(rawJSON), "global-secret") {
		t.Fatalf("savedChannels must never expose api keys: %s", string(rawJSON))
	}

	// Override translation to separate HTTP endpoint, and reading to Claude Code High.
	res, updated := post(t, bundle, http.MethodPut, "/v1/ai/workflows", `{
	  "workflows": {
	    "translation": {
	      "followGlobal": false,
	      "provider": "openai",
	      "baseURL": "https://trans.example.com/v1",
	      "model": "deepseek-chat",
	      "reasoningEffort": "low",
	      "apiKey": "trans-secret"
	    },
	    "reading": {
	      "followGlobal": false,
	      "provider": "claude",
	      "model": "",
	      "reasoningEffort": "high"
	    },
	    "qa": {
	      "followGlobal": true
	    }
	  }
	}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("PUT /v1/ai/workflows failed: %d %v", res.StatusCode, updated)
	}

	srv := &Server{cfg: bundle.cfg, handle: bundle.handle}
	transCfg, err := srv.workflowAIConfig(WorkflowTranslation)
	if err != nil {
		t.Fatalf("workflowAIConfig(translation) error: %v", err)
	}
	if transCfg.ProviderName() != "openai" || transCfg.Model != "deepseek-chat" || transCfg.ReasoningEffort != "low" || transCfg.APIKey != "trans-secret" {
		t.Fatalf("unexpected translation config: %+v", transCfg)
	}

	qaCfg, err := srv.workflowAIConfig(WorkflowQA)
	if err != nil {
		t.Fatalf("workflowAIConfig(qa) error: %v", err)
	}
	if qaCfg.Model != "deepseek-reasoner" || qaCfg.ReasoningEffort != "high" || qaCfg.APIKey != "global-secret" {
		t.Fatalf("qa should still follow global config: %+v", qaCfg)
	}

	readCfg, err := srv.workflowAIConfig(WorkflowReading)
	if err != nil {
		t.Fatalf("workflowAIConfig(reading) error: %v", err)
	}
	if readCfg.ProviderName() != "claude" || readCfg.ReasoningEffort != "high" || readCfg.APIKey != "" {
		t.Fatalf("unexpected reading config: %+v", readCfg)
	}

	// Verify reverting translation back to followGlobal works.
	res, _ = post(t, bundle, http.MethodPut, "/v1/ai/workflows", `{"workflow":"translation","followGlobal":true}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("resetting translation workflow failed: %d", res.StatusCode)
	}
	transCfg, _ = srv.workflowAIConfig(WorkflowTranslation)
	if transCfg.Model != "deepseek-reasoner" {
		t.Fatalf("expected translation to follow global after reset, got %+v", transCfg)
	}
}

func TestAIProbeReturnsLatencyAndForwardsReasoningEffort(t *testing.T) {
	var seenReasoningEffort string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(raw, &req)
		if v, ok := req["reasoning_effort"].(string); ok {
			seenReasoningEffort = v
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
	}))
	defer upstream.Close()

	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{
	  "provider": "openai",
	  "baseURL": "`+upstream.URL+`",
	  "model": "deepseek-reasoner",
	  "reasoningEffort": "high",
	  "apiKey": "test-key",
	  "connections": {"openai|`+upstream.URL+`": "test-key"}
	}`)

	res, body := post(t, bundle, http.MethodPost, "/v1/ai/test", `{}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("POST /v1/ai/test failed: %d %v", res.StatusCode, body)
	}
	if body["ok"] != true {
		t.Fatalf("expected ok=true, got %v", body)
	}
	latency, ok := body["latencyMs"].(float64)
	if !ok || latency < 0 {
		t.Fatalf("expected non-negative latencyMs, got %v", body["latencyMs"])
	}
	if seenReasoningEffort != "high" {
		t.Fatalf("expected reasoning_effort=high forwarded to reasoning model, got %q", seenReasoningEffort)
	}
}
