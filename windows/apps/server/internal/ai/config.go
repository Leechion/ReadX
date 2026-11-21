// Package ai 是 v2 的 AI 助教客户端：OpenAI 兼容接口、SSE 流式、
// 结构化生成 + 自动修正重试 + 终局降级轮（四层兜底的前两层）。
//
// API Key 只存在于本进程：渲染进程永远拿不到它，也拿不到 config.json 的原文。
package ai

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Provider               string `json:"provider,omitempty"`
	BaseURL                string `json:"baseURL"`
	Model                  string `json:"model"`
	APIKey                 string `json:"apiKey"`
	ReasoningEffort        string `json:"reasoningEffort,omitempty"`
	CodexFastMode          bool   `json:"codexFastMode,omitempty"`
	TranslationPreparation string `json:"translationPreparation,omitempty"`
	tempRoot               string
	workBuddyAuthPath      string
	WorkBuddyAuth          WorkBuddyCredential `json:"-"`
}

func (c Config) ProviderName() string {
	if c.Provider == "" {
		return "openai"
	}
	return c.Provider
}
func (c Config) IsCLI() bool {
	p := c.ProviderName()
	return p == "codex" || p == "claude" || p == "kimi"
}

// PlaceholderMarker 与旧版一致：配置文件里留的中文占位符不算已配置。
const PlaceholderMarker = "在这里填入"

// WithChannel 用另一个渠道（服务商 / 地址 / 模型 / Key）派生一份配置。
//
// 用途是「某个工作区单独走别的模型」：调用方只需要给出渠道信息，
// 内部字段（临时目录、WorkBuddy 凭据路径）继续沿用原配置，避免各处自己拼装。
// Key 由调用方按「渠道|地址」查表得到——绝不能把其它地址的 Key 带过来。
func (c Config) WithChannel(provider, baseURL, model, apiKey, reasoningEffort string) Config {
	derived := c
	derived.Provider = strings.TrimSpace(provider)
	derived.BaseURL = strings.TrimSpace(baseURL)
	derived.Model = strings.TrimSpace(model)
	derived.APIKey = strings.TrimSpace(apiKey)
	derived.ReasoningEffort = strings.TrimSpace(reasoningEffort)
	// 快模式只对 Codex CLI 有意义：换渠道后必须清掉，否则会带着上一个渠道的开关。
	derived.CodexFastMode = false
	if strings.TrimSpace(provider) == "codex" {
		derived.CodexFastMode = c.CodexFastMode
	}
	return derived
}

// LoadConfig 读取 app/config.json。文件缺失/损坏不 panic，而是返回错误让接口如实回答「未配置」。
func LoadConfig(path string) (Config, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, fmt.Errorf("还没配置 AI 助教：编辑 app/config.json 填入 Key，保存即生效。")
		}
		return Config{}, fmt.Errorf("读取配置文件失败: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return Config{}, fmt.Errorf("app/config.json 不是合法 JSON: %w", err)
	}
	// Keep request scratch files beside application data, where the local server
	// has write access even if Windows denies access to the global temp folder.
	cfg.tempRoot = filepath.Join(filepath.Dir(path), "data", "v2", "tmp")
	cfg.workBuddyAuthPath = WorkBuddyCredentialPath(path)
	// A damaged WorkBuddy sidecar should require re-login without taking other
	// providers (OpenAI, Codex, etc.) offline.
	cfg.WorkBuddyAuth, _ = LoadWorkBuddyCredential(cfg.workBuddyAuthPath)
	return cfg, nil
}

// Endpoint 校验并返回 chat/completions 的完整地址。
func (c Config) Endpoint() (string, error) {
	if c.ProviderName() == "workbuddy" {
		if !c.Ready() {
			return "", fmt.Errorf("请先登录 WorkBuddy")
		}
		return workBuddyEndpoint + "/v2/chat/completions", nil
	}
	if !c.Ready() {
		return "", fmt.Errorf("还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
	}
	suffix := "/chat/completions"
	if c.ProviderName() == "anthropic" {
		suffix = "/messages"
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if !strings.HasSuffix(base, suffix) {
		base += suffix
	}
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("API 地址无效，请在配置文件中填写完整的 http/https 地址。")
	}
	return parsed.String(), nil
}

// PublicBaseURL excludes accidental credentials in legacy endpoint strings.
func (c Config) PublicBaseURL() string {
	u, err := url.Parse(c.BaseURL)
	if err != nil {
		return ""
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// Ready 判断是否真的可用（有 key、有地址、不是占位符）。
func (c Config) Ready() bool {
	if c.ProviderName() == "workbuddy" {
		return strings.TrimSpace(c.WorkBuddyAuth.AccessToken) != ""
	}
	if c.IsCLI() {
		return CLIAvailable(c.ProviderName())
	}
	if c.ProviderName() != "openai" && c.ProviderName() != "anthropic" {
		return false
	}
	return c.APIKey != "" && !strings.Contains(c.APIKey, PlaceholderMarker) && c.BaseURL != ""
}

// ModelName 兜底默认模型，与旧版 generate/askStream 的默认值一致。
func (c Config) ModelName() string {
	if c.IsCLI() {
		return c.Model
	}
	if c.Model == "" {
		if c.ProviderName() == "workbuddy" {
			return "default-model"
		}
		if c.ProviderName() == "anthropic" {
			return "claude-sonnet-4-5"
		}
		return "glm-4.6"
	}
	return c.Model
}

// Redacted 是给界面看的配置状态：只有「是否配置 + 模型 + 地址主机」，永不含 key。
type Redacted struct {
	Provider        string `json:"provider"`
	Configured      bool   `json:"configured"`
	Model           string `json:"model"`
	Host            string `json:"host"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	Error           string `json:"error,omitempty"`
}

func (c Config) Redact() Redacted {
	if !c.Ready() {
		message := "请在 AI 设置中配置地址、模型和 Key"
		if c.ProviderName() == "workbuddy" {
			message = "请先在 AI 助手设置中登录 WorkBuddy"
		}
		if c.IsCLI() {
			message = "未找到 " + c.ProviderName() + " CLI，请先安装并在终端登录"
			if c.ProviderName() == "codex" {
				message = "未找到 Codex CLI，请检查 Codex Desktop、ChatGPT 内置 CLI 或本机 CLI 的安装"
			}
		}
		return Redacted{Provider: c.ProviderName(), Configured: false, Error: message}
	}
	host := ""
	if u, err := url.Parse(c.BaseURL); err == nil {
		host = u.Host
	}
	return Redacted{Provider: c.ProviderName(), Configured: true, Model: c.ModelName(), ReasoningEffort: c.ReasoningEffort, Host: host}
}
