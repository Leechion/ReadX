package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
)

const (
	WorkflowTranslation = "translation"
	WorkflowQA          = "qa"
	WorkflowReading     = "reading"
)

var validWorkflowKinds = []string{
	WorkflowTranslation,
	WorkflowQA,
	WorkflowReading,
}

func isValidWorkflowKind(kind string) bool {
	for _, k := range validWorkflowKinds {
		if k == kind {
			return true
		}
	}
	return false
}

func isValidAIProvider(provider string) bool {
	return provider == "openai" || provider == "anthropic" || provider == "codex" || provider == "claude" || provider == "kimi" || provider == "workbuddy"
}

func normalizeReasoningEffort(provider, effort string) string {
	trimmed := strings.ToLower(strings.TrimSpace(effort))
	if trimmed == "" {
		return ""
	}
	if provider == "codex" {
		return trimmed
	}
	switch trimmed {
	case "low", "medium", "high":
		return trimmed
	default:
		return trimmed
	}
}

type workflowAISettingStored struct {
	Provider        string `json:"provider"`
	BaseURL         string `json:"baseURL"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// WorkflowAISetting 是返回给前端的按流程指定配置状态（永不含密钥）。
type WorkflowAISetting struct {
	FollowGlobal    bool        `json:"followGlobal"`
	Provider        string      `json:"provider"`
	BaseURL         string      `json:"baseURL"`
	Model           string      `json:"model"`
	ReasoningEffort string      `json:"reasoningEffort,omitempty"`
	KeyConfigured   bool        `json:"keyConfigured"`
	Status          ai.Redacted `json:"status"`
}

// WorkflowAISettingInput 是保存按流程指定配置时的请求体。
type WorkflowAISettingInput struct {
	FollowGlobal    bool   `json:"followGlobal"`
	Provider        string `json:"provider"`
	BaseURL         string `json:"baseURL"`
	Model           string `json:"model"`
	APIKey          string `json:"apiKey,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// SavedChannelView 是已保存在本机的渠道索引（脱敏，不含 Key，供按流程下拉切换复用）。
type SavedChannelView struct {
	Provider      string `json:"provider"`
	BaseURL       string `json:"baseURL"`
	Host          string `json:"host,omitempty"`
	KeyConfigured bool   `json:"keyConfigured"`
}

func (s *Server) readWorkflowMap() (map[string]workflowAISettingStored, map[string]any, error) {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, map[string]any{}, nil
		}
		return nil, nil, fmt.Errorf("读取配置失败: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, nil, fmt.Errorf("app/config.json 不是合法 JSON: %w", err)
	}
	out := map[string]workflowAISettingStored{}
	workflowsRaw, ok := raw["workflows"].(map[string]any)
	if !ok {
		return out, raw, nil
	}
	for _, kind := range validWorkflowKinds {
		sec, ok := workflowsRaw[kind].(map[string]any)
		if !ok {
			continue
		}
		item := workflowAISettingStored{}
		item.Provider, _ = sec["provider"].(string)
		item.BaseURL, _ = sec["baseURL"].(string)
		item.Model, _ = sec["model"].(string)
		item.ReasoningEffort, _ = sec["reasoningEffort"].(string)
		item.Provider = strings.TrimSpace(item.Provider)
		item.BaseURL = strings.TrimSpace(item.BaseURL)
		item.Model = strings.TrimSpace(item.Model)
		item.ReasoningEffort = normalizeReasoningEffort(item.Provider, item.ReasoningEffort)
		if item.Provider == "" {
			continue
		}
		if (item.Provider == "openai" || item.Provider == "anthropic") && item.BaseURL == "" {
			continue
		}
		out[kind] = item
	}
	return out, raw, nil
}

func channelReadyKey(provider, baseURL string, raw map[string]any) string {
	connections, _ := raw["connections"].(map[string]any)
	if connections == nil {
		return ""
	}
	key, _ := connections[provider+"|"+strings.TrimRight(strings.TrimSpace(baseURL), "/")].(string)
	return strings.TrimSpace(key)
}

func resolveWorkflowChannelConfig(global ai.Config, item workflowAISettingStored, raw map[string]any) ai.Config {
	key := ""
	if item.Provider == "openai" || item.Provider == "anthropic" {
		key = channelReadyKey(item.Provider, item.BaseURL, raw)
	}
	return global.WithChannel(item.Provider, item.BaseURL, item.Model, key, item.ReasoningEffort)
}

// workflowAIConfig 返回指定流程（translation / qa / reading）实际使用的 AI 配置；
// 未单独配置或设为 followGlobal 时自动跟随全局。
func (s *Server) workflowAIConfig(kind string) (ai.Config, error) {
	global, globalErr := s.aiConfig()
	if !isValidWorkflowKind(kind) {
		return global, globalErr
	}
	s.settingsMu.Lock()
	workflows, raw, readErr := s.readWorkflowMap()
	s.settingsMu.Unlock()
	if readErr != nil {
		return global, globalErr
	}
	item, ok := workflows[kind]
	if !ok {
		return global, globalErr
	}
	// 全局配置加载失败（例如尚未创建 config.json）时仍尽力使用已读取到的流程覆盖。
	baseCfg := global
	if globalErr != nil {
		baseCfg = ai.Config{}
	}
	return resolveWorkflowChannelConfig(baseCfg, item, raw), nil
}

func (s *Server) workflowAISettingsView(global ai.Config) map[string]WorkflowAISetting {
	workflows, raw, _ := s.readWorkflowMap()
	out := make(map[string]WorkflowAISetting, len(validWorkflowKinds))
	for _, kind := range validWorkflowKinds {
		item, hasOverride := workflows[kind]
		if !hasOverride {
			out[kind] = WorkflowAISetting{
				FollowGlobal:    true,
				Provider:        global.ProviderName(),
				BaseURL:         global.PublicBaseURL(),
				Model:           global.ModelName(),
				ReasoningEffort: global.ReasoningEffort,
				KeyConfigured:   strings.TrimSpace(global.APIKey) != "",
				Status:          global.Redact(),
			}
			continue
		}
		effective := resolveWorkflowChannelConfig(global, item, raw)
		out[kind] = WorkflowAISetting{
			FollowGlobal:    false,
			Provider:        item.Provider,
			BaseURL:         effective.PublicBaseURL(),
			Model:           item.Model,
			ReasoningEffort: item.ReasoningEffort,
			KeyConfigured:   strings.TrimSpace(effective.APIKey) != "",
			Status:          effective.Redact(),
		}
	}
	return out
}

func (s *Server) savedChannelsView(global ai.Config) []SavedChannelView {
	_, raw, _ := s.readWorkflowMap()
	connections, _ := raw["connections"].(map[string]any)
	seen := map[string]bool{}
	out := make([]SavedChannelView, 0, len(connections)+1)
	appendChannel := func(provider, baseURL, key string) {
		provider = strings.TrimSpace(provider)
		baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
		if provider != "openai" && provider != "anthropic" {
			return
		}
		if baseURL == "" {
			return
		}
		id := provider + "|" + baseURL
		if seen[id] {
			return
		}
		seen[id] = true
		host := baseURL
		if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
			host = u.Host
		}
		out = append(out, SavedChannelView{
			Provider:      provider,
			BaseURL:       baseURL,
			Host:          host,
			KeyConfigured: strings.TrimSpace(key) != "" && !strings.Contains(key, ai.PlaceholderMarker),
		})
	}
	if global.ProviderName() == "openai" || global.ProviderName() == "anthropic" {
		appendChannel(global.ProviderName(), global.PublicBaseURL(), global.APIKey)
	}
	for dest, v := range connections {
		parts := strings.SplitN(dest, "|", 2)
		if len(parts) != 2 {
			continue
		}
		key, _ := v.(string)
		appendChannel(parts[0], parts[1], key)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].Provider < out[j].Provider
	})
	return out
}

func applyWorkflowInputs(raw map[string]any, inputs map[string]WorkflowAISettingInput, globalBase ai.Config) error {
	if len(inputs) == 0 {
		return nil
	}
	connections, _ := raw["connections"].(map[string]any)
	if connections == nil {
		connections = map[string]any{}
	}
	workflowsRaw, _ := raw["workflows"].(map[string]any)
	if workflowsRaw == nil {
		workflowsRaw = map[string]any{}
	}
	for kind, input := range inputs {
		if !isValidWorkflowKind(kind) {
			return fmt.Errorf("不支持的工作流类型: %s", kind)
		}
		if input.FollowGlobal {
			delete(workflowsRaw, kind)
			continue
		}
		provider := strings.TrimSpace(input.Provider)
		if !isValidAIProvider(provider) {
			return fmt.Errorf("流程 %s 不支持的 AI 接入方式: %s", kind, provider)
		}
		baseURL := strings.TrimSpace(input.BaseURL)
		model := strings.TrimSpace(input.Model)
		effort := normalizeReasoningEffort(provider, input.ReasoningEffort)
		if provider == "openai" || provider == "anthropic" {
			if baseURL == "" {
				return fmt.Errorf("流程 %s 使用 HTTP 渠道时必须填写 API 地址", kind)
			}
			check := globalBase.WithChannel(provider, baseURL, model, "validate", effort)
			if _, err := check.Endpoint(); err != nil {
				return fmt.Errorf("流程 %s 的 API 地址无效，请填写完整 http/https 地址", kind)
			}
			destination := provider + "|" + strings.TrimRight(baseURL, "/")
			if strings.TrimSpace(input.APIKey) != "" {
				connections[destination] = strings.TrimSpace(input.APIKey)
			} else if _, exists := connections[destination]; !exists {
				connections[destination] = ""
			}
		} else {
			baseURL = ""
		}
		workflowsRaw[kind] = map[string]any{
			"provider":        provider,
			"baseURL":         baseURL,
			"model":           model,
			"reasoningEffort": effort,
		}
	}
	raw["connections"] = connections
	if len(workflowsRaw) == 0 {
		delete(raw, "workflows")
	} else {
		raw["workflows"] = workflowsRaw
	}
	return nil
}

// handleWorkflowAISettings 读写「按流程指定」的模型配置（翻译 / 论文问答 / 精读五重奏）。
func (s *Server) handleWorkflowAISettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
		global, err := ai.LoadConfig(legacy.NewPaths(s.cfg.DataRoot).ConfigFile())
		if err != nil {
			global = ai.Config{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"workflows":     s.workflowAISettingsView(global),
			"savedChannels": s.savedChannelsView(global),
		})
		return
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	var body struct {
		Workflow  string                            `json:"workflow,omitempty"`
		Workflows map[string]WorkflowAISettingInput `json:"workflows,omitempty"`
		WorkflowAISettingInput
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	inputs := body.Workflows
	if inputs == nil && strings.TrimSpace(body.Workflow) != "" {
		inputs = map[string]WorkflowAISettingInput{
			strings.TrimSpace(body.Workflow): body.WorkflowAISettingInput,
		}
	}
	if len(inputs) == 0 {
		writeError(w, http.StatusBadRequest, "请提供 workflows 或 workflow 配置")
		return
	}
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	raw := map[string]any{}
	if prior, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(prior, &raw) != nil {
			writeError(w, http.StatusUnprocessableEntity, "原配置损坏，已拒绝覆盖")
			return
		}
	} else if !os.IsNotExist(err) {
		writeError(w, http.StatusInternalServerError, "读取配置失败")
		return
	}
	global, _ := ai.LoadConfig(path)
	if err := applyWorkflowInputs(raw, inputs, global); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	encoded, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "创建配置目录失败")
		return
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".workflow-ai-config-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	temp := file.Name()
	defer os.Remove(temp)
	_ = file.Chmod(0o600)
	_, writeErr := file.Write(encoded)
	closeErr := file.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr == nil {
		writeErr = os.Rename(temp, path)
	}
	if writeErr != nil {
		writeError(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	global, loadErr := ai.LoadConfig(path)
	if loadErr != nil {
		global = ai.Config{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workflows":     s.workflowAISettingsView(global),
		"savedChannels": s.savedChannelsView(global),
	})
}
