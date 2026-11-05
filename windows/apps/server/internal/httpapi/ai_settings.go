package httpapi

import (
	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/securefile"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func (s *Server) handleAISettings(w http.ResponseWriter, r *http.Request) {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	if r.Method != "PUT" {
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
	}
	if r.Method == "PUT" {
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
		var body struct {
			Provider               string  `json:"provider"`
			BaseURL                string  `json:"baseURL"`
			Model                  string  `json:"model"`
			APIKey                 string  `json:"apiKey"`
			ClearKey               bool    `json:"clearKey"`
			ReasoningEffort        *string `json:"reasoningEffort"`
			CodexFastMode          *bool   `json:"codexFastMode"`
			TranslationPreparation string  `json:"translationPreparation"`
		}
		if decodeJSON(w, r, &body) != nil {
			return
		}
		if body.Provider != "openai" && body.Provider != "anthropic" && body.Provider != "codex" && body.Provider != "claude" && body.Provider != "kimi" && body.Provider != "workbuddy" {
			writeError(w, 400, "不支持的 AI 接入方式")
			return
		}
		raw := map[string]any{}
		prior, err := os.ReadFile(path)
		if err == nil {
			if json.Unmarshal(prior, &raw) != nil {
				writeError(w, 422, "原配置损坏，已拒绝覆盖")
				return
			}
		} else if !os.IsNotExist(err) {
			writeError(w, 500, "读取配置失败")
			return
		}
		// Keep credentials per provider AND endpoint. Switching destinations must never
		// forward a key that belonged to a different service.
		connections, _ := raw["connections"].(map[string]any)
		if connections == nil {
			connections = map[string]any{}
		}
		// 「清除 Key」必须清掉所有历史渠道：切换过服务商之后旧 Key 仍留在 connections 里，
		// 用户以为删干净了，磁盘上却还留着明文。
		if body.ClearKey {
			connections = map[string]any{}
		}
		previousProvider, _ := raw["provider"].(string)
		if previousProvider == "" {
			previousProvider = "openai"
		}
		previousURL, _ := raw["baseURL"].(string)
		previousModel, _ := raw["model"].(string)
		previousKey, _ := raw["apiKey"].(string)
		connections[previousProvider+"|"+strings.TrimRight(previousURL, "/")] = previousKey
		destination := body.Provider + "|" + strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
		savedKey, _ := connections[destination].(string)
		if body.ClearKey {
			savedKey = ""
		} else if strings.TrimSpace(body.APIKey) != "" {
			savedKey = strings.TrimSpace(body.APIKey)
		}
		connections[destination] = savedKey
		raw["connections"] = connections
		raw["provider"] = body.Provider
		raw["baseURL"] = strings.TrimSpace(body.BaseURL)
		raw["model"] = strings.TrimSpace(body.Model)
		preparation := strings.TrimSpace(body.TranslationPreparation)
		if preparation != "terms" && preparation != "terms+style" && preparation != "artifacts_only" && preparation != "editorial" {
			preparation = "off"
		}
		raw["translationPreparation"] = preparation
		if body.ReasoningEffort != nil {
			raw["reasoningEffort"] = strings.TrimSpace(*body.ReasoningEffort)
		} else if previousProvider != body.Provider || previousModel != strings.TrimSpace(body.Model) {
			raw["reasoningEffort"] = ""
		}
		if body.Provider != "codex" {
			raw["reasoningEffort"] = ""
			raw["codexFastMode"] = false
		} else if body.CodexFastMode != nil {
			raw["codexFastMode"] = *body.CodexFastMode
		}
		raw["apiKey"] = savedKey
		encoded, _ := json.MarshalIndent(raw, "", "  ")
		var cfg ai.Config
		_ = json.Unmarshal(encoded, &cfg)
		if err := cfg.ValidateCodexSelection(r.Context()); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if !cfg.IsCLI() && cfg.ProviderName() != "workbuddy" {
			check := cfg
			check.APIKey = "validate"
			if _, err := check.Endpoint(); err != nil {
				writeError(w, 400, "请输入完整 API 地址，例如 https://api.openai.com/v1")
				return
			}
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			writeError(w, 500, "创建配置目录失败")
			return
		}
		f, err := os.CreateTemp(filepath.Dir(path), ".ai-config-*")
		if err != nil {
			writeError(w, 500, "保存配置失败")
			return
		}
		tmp := f.Name()
		defer os.Remove(tmp)
		_ = f.Chmod(0600)
		_, err = f.Write(encoded)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp, path)
		}
		if err != nil {
			writeError(w, 500, "保存配置失败")
			return
		}
		// 配置里有明文 API Key：Windows 上 os.Chmod 不设置 DACL，文件会继承检出目录的
		// ACL（可能含 Authenticated Users）。这里显式收紧到当前用户 + SYSTEM + 管理员。
		if err := securefile.RestrictToCurrentUser(filepath.Dir(path)); err != nil {
			log.Printf("收紧配置目录权限失败（不影响保存）: %v", err)
		}
		if err := securefile.RestrictToCurrentUser(path); err != nil {
			log.Printf("收紧配置文件权限失败（不影响保存）: %v", err)
		}
	}
	cfg, _ := ai.LoadConfig(path)
	writeJSON(w, 200, map[string]any{"provider": cfg.ProviderName(), "baseURL": cfg.PublicBaseURL(), "model": cfg.Model, "reasoningEffort": cfg.ReasoningEffort, "codexFastMode": cfg.CodexFastMode, "translationPreparation": cfg.TranslationPreparation, "keyConfigured": cfg.APIKey != "", "status": cfg.Redact(), "latex": s.latexAISettingsView(cfg), "cli": map[string]bool{"codex": ai.CLIAvailable("codex"), "claude": ai.CLIAvailable("claude"), "kimi": ai.CLIAvailable("kimi")}, "codex": ai.CodexStatus(r.Context()), "workbuddy": s.workBuddyStatus(cfg)})
}

// handleAIModels 读取当前地址可用的模型列表：OpenAI 兼容与 Anthropic 都提供 GET /models。
//
// Key 优先用请求里刚输入的（还没保存也能先看看有哪些模型），否则回落到该「渠道|地址」已保存的 Key。
// 这与保存逻辑一致：绝不会把别的地址的 Key 发到当前地址上。
func (s *Server) handleAIModels(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Provider string `json:"provider"`
		BaseURL  string `json:"baseURL"`
		APIKey   string `json:"apiKey"`
		Refresh  bool   `json:"refresh"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	provider := strings.TrimSpace(body.Provider)
	if provider == "workbuddy" {
		cfg, err := s.aiConfig()
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		models, err := ai.WorkBuddyModels(r.Context(), cfg)
		if err != nil {
			writeError(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"models": models, "source": "workbuddy", "notice": "模型目录来自 WorkBuddy 客户端内部接口"})
		return
	}
	if provider == "codex" {
		cfg, _ := s.aiConfig()
		models, err := cfg.CodexModels(r.Context(), body.Refresh)
		if err != nil {
			writeError(w, 502, err.Error())
			return
		}
		names := make([]string, 0, len(models))
		for _, model := range models {
			names = append(names, model.Model)
		}
		writeJSON(w, 200, map[string]any{"models": names, "catalog": models, "source": "codex", "notice": "目录来自本机 Codex；账号实际访问能力以请求结果为准"})
		return
	}
	if provider != "openai" && provider != "anthropic" {
		writeError(w, 400, "只有 API 渠道能获取模型列表；CLI 渠道留空即使用它自己的默认模型")
		return
	}
	base := strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
	if base == "" {
		writeError(w, 400, "请先填写服务地址，再获取模型列表")
		return
	}
	endpoint := base
	if !strings.HasSuffix(endpoint, "/models") {
		endpoint += "/models"
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		writeError(w, 400, "API 地址无效，请填写完整的 http/https 地址")
		return
	}
	key := strings.TrimSpace(body.APIKey)
	if key == "" {
		key = s.savedConnectionKey(provider, base)
	}
	if key == "" {
		writeError(w, 400, "请先填写 API Key（或先保存设置）再获取模型列表")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		writeError(w, 400, "API 地址无效，请填写完整的 http/https 地址")
		return
	}
	request.Header.Set("Accept", "application/json")
	if provider == "anthropic" {
		request.Header.Set("x-api-key", key)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := ai.NewHTTPClient().Do(request)
	if err != nil {
		writeError(w, 502, "获取模型列表失败："+redactKey(err.Error(), key))
		return
	}
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if response.StatusCode != http.StatusOK {
		text := strings.TrimSpace(string(detail))
		if len([]rune(text)) > 200 {
			text = string([]rune(text)[:200])
		}
		message := fmt.Sprintf("接口返回 %d，无法读取模型列表。", response.StatusCode)
		if text != "" {
			message += "\n服务端返回：" + redactKey(text, key)
		}
		writeError(w, 502, message)
		return
	}
	names := modelNamesFromJSON(detail)
	// 补充目录：LiteLLM 一类网关的 /model/info 会列出全部部署，其中包含 /models 未暴露给当前 Key 的
	// 名字（例如 deepseek-v4-pro、qwen3.5）。只做并集且把 /models 的名字排在前面，确保首选仍是能直接调用的那批。
	if catalog := modelNamesFromJSON(s.fetchModelCatalog(ctx, base, provider, key)); len(catalog) > 0 {
		names = append(names, catalog...)
	}
	seen := map[string]bool{}
	models := []string{}
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		models = append(models, name)
	}
	sort.Strings(models)
	if len(models) > 1000 {
		models = models[:1000]
	}
	writeJSON(w, 200, map[string]any{"models": models})
}

// modelNamesFromJSON 兼容两种常见形状：OpenAI/Anthropic 的 data[].id，以及 LiteLLM /model/info 的
// data[].model_name。**不要**取 model_info.id——那是网关内部的部署 UUID，填进模型名会被上游拒绝。
func modelNamesFromJSON(body []byte) []string {
	if len(body) == 0 {
		return nil
	}
	type entry struct {
		ID        string `json:"id"`
		ModelName string `json:"model_name"`
	}
	var decoded struct {
		Data   []entry `json:"data"`
		Models []entry `json:"models"`
	}
	if json.Unmarshal(body, &decoded) != nil {
		return nil
	}
	out := []string{}
	for _, item := range append(decoded.Data, decoded.Models...) {
		for _, candidate := range []string{item.ID, item.ModelName} {
			if strings.TrimSpace(candidate) != "" {
				out = append(out, candidate)
			}
		}
	}
	return out
}

// fetchModelCatalog 尽力而为地取一次模型目录：超时、非 200、解析不了都只当作"没有补充"。
func (s *Server) fetchModelCatalog(ctx context.Context, base, provider, key string) []byte {
	catalogCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(catalogCtx, http.MethodGet, base+"/model/info", nil)
	if err != nil {
		return nil
	}
	request.Header.Set("Accept", "application/json")
	if provider == "anthropic" {
		request.Header.Set("x-api-key", key)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	response, err := ai.NewHTTPClient().Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil
	}
	return body
}

// savedConnectionKey 读取 app/config.json 里该「渠道|地址」自己的 Key（与保存时同一套归一化）。
func (s *Server) savedConnectionKey(provider, base string) string {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	raw := map[string]any{}
	if json.Unmarshal(body, &raw) != nil {
		return ""
	}
	connections, _ := raw["connections"].(map[string]any)
	if connections == nil {
		return ""
	}
	key, _ := connections[provider+"|"+strings.TrimRight(strings.TrimSpace(base), "/")].(string)
	return strings.TrimSpace(key)
}

// redactKey 保证上游把 Key 回显在错误里时也不会漏到界面与日志。
func redactKey(text, key string) string {
	if key == "" {
		return text
	}
	return strings.ReplaceAll(text, key, "[redacted]")
}

func (s *Server) handleAIProbe(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.aiConfig()
	if err != nil || !cfg.Ready() {
		writeError(w, 409, "请先保存可用的 AI 设置；CLI 需先安装并登录")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	answer, err := ai.NewClient(cfg).Generate(ctx, "仅回复 OK，不使用工具。", "连接测试", 0)
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "answer": answer})
}
