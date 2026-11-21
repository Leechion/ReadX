package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	workBuddyEndpoint      = "https://copilot.tencent.com"
	workBuddyDomain        = "copilot.tencent.com"
	workBuddyPlatform      = "ide"
	workBuddyUA            = "CodeBuddyIDE/1.106.1"
	workBuddyProductCode   = "codebuddy"
	workBuddyProductName   = "CodeBuddy"
	workBuddyClientVersion = "1.106.1"
)

var workBuddyHTTPClient = &http.Client{Timeout: 25 * time.Second}

// WorkBuddyCredential stores the session tokens returned by WorkBuddy's desktop
// login flow. It is kept in a private sidecar and never returned to the renderer.
type WorkBuddyCredential struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresAt        int64  `json:"expires_at"`
	RefreshExpiresAt int64  `json:"refresh_expires_at"`
	Domain           string `json:"domain,omitempty"`
	Nickname         string `json:"nickname,omitempty"`
}

func WorkBuddyCredentialPath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "workbuddy-auth.json")
}

func LoadWorkBuddyCredential(path string) (WorkBuddyCredential, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return WorkBuddyCredential{}, nil
		}
		return WorkBuddyCredential{}, err
	}
	var credential WorkBuddyCredential
	if err := json.Unmarshal(body, &credential); err != nil {
		return WorkBuddyCredential{}, fmt.Errorf("WorkBuddy 登录凭据损坏")
	}
	return credential, nil
}

func SaveWorkBuddyCredential(path string, credential WorkBuddyCredential) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	body, err := json.MarshalIndent(credential, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".workbuddy-auth-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_ = f.Chmod(0600)
	if _, err = f.Write(body); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func DeleteWorkBuddyCredential(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

type WorkBuddyLogin struct{ State, URL string }

// BeginWorkBuddyLogin follows the browser-based login handshake used by the
// WorkBuddy desktop client. The endpoints are undocumented and can change.
func BeginWorkBuddyLogin(ctx context.Context) (WorkBuddyLogin, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	u := workBuddyEndpoint + "/v2/plugin/auth/state?platform=" + url.QueryEscape(workBuddyPlatform)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return WorkBuddyLogin{}, err
	}
	setWorkBuddyBaseHeaders(req, "")
	req.Header.Set("X-No-Authorization", "true")
	req.Header.Set("X-No-User-Id", "true")
	req.Header.Set("X-No-Enterprise-Id", "true")
	req.Header.Set("X-No-Department-Info", "true")
	res, err := workBuddyHTTPClient.Do(req)
	if err != nil {
		return WorkBuddyLogin{}, fmt.Errorf("连接 WorkBuddy 登录服务失败: %w", err)
	}
	defer res.Body.Close()
	var envelope struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			State   string `json:"state"`
			AuthURL string `json:"authUrl"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return WorkBuddyLogin{}, fmt.Errorf("WorkBuddy 登录服务返回无效数据")
	}
	if res.StatusCode != http.StatusOK || envelope.Data.State == "" || envelope.Data.AuthURL == "" {
		return WorkBuddyLogin{}, fmt.Errorf("WorkBuddy 登录地址获取失败 (HTTP %d): %s", res.StatusCode, envelope.Message)
	}
	loginURL, err := url.Parse(envelope.Data.AuthURL)
	if err != nil || (loginURL.Scheme != "https" && loginURL.Scheme != "http") || loginURL.Host == "" {
		return WorkBuddyLogin{}, fmt.Errorf("WorkBuddy 返回的登录地址无效")
	}
	return WorkBuddyLogin{State: envelope.Data.State, URL: loginURL.String()}, nil
}

func WaitWorkBuddyLogin(ctx context.Context, state string) (WorkBuddyCredential, error) {
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		if err := ctx.Err(); err != nil {
			return WorkBuddyCredential{}, err
		}
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return WorkBuddyCredential{}, ctx.Err()
		case <-timer.C:
		}
		u := workBuddyEndpoint + "/v2/plugin/auth/token?state=" + url.QueryEscape(state)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return WorkBuddyCredential{}, err
		}
		setWorkBuddyBaseHeaders(req, "")
		req.Header.Set("X-No-Authorization", "true")
		res, err := workBuddyHTTPClient.Do(req)
		if err != nil {
			continue
		}
		var envelope struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
			Data    *struct {
				AccessToken      string          `json:"accessToken"`
				RefreshToken     string          `json:"refreshToken"`
				ExpiresAt        json.RawMessage `json:"expiresAt"`
				ExpiresIn        float64         `json:"expiresIn"`
				RefreshExpiresAt json.RawMessage `json:"refreshExpiresAt"`
				RefreshExpiresIn float64         `json:"refreshExpiresIn"`
				Domain           string          `json:"domain"`
			} `json:"data"`
		}
		decodeErr := json.NewDecoder(res.Body).Decode(&envelope)
		res.Body.Close()
		if decodeErr != nil {
			continue
		}
		if res.StatusCode == http.StatusOK && envelope.Data != nil && envelope.Data.AccessToken != "" {
			now := time.Now().UnixMilli()
			credential := WorkBuddyCredential{AccessToken: envelope.Data.AccessToken, RefreshToken: envelope.Data.RefreshToken, Domain: envelope.Data.Domain}
			credential.ExpiresAt = parseWorkBuddyExpiry(envelope.Data.ExpiresAt, envelope.Data.ExpiresIn, now)
			credential.RefreshExpiresAt = parseWorkBuddyExpiry(envelope.Data.RefreshExpiresAt, envelope.Data.RefreshExpiresIn, now)
			if credential.ExpiresAt == 0 {
				credential.ExpiresAt = workBuddyJWTExpiry(credential.AccessToken)
			}
			credential.Nickname = workBuddyJWTClaim(credential.AccessToken, "nickname")
			return credential, nil
		}
		if envelope.Code == 11217 || (res.StatusCode == http.StatusOK && envelope.Data == nil && envelope.Code == 0) {
			continue
		}
		if res.StatusCode != http.StatusOK || envelope.Code != 0 {
			return WorkBuddyCredential{}, fmt.Errorf("WorkBuddy 登录失败: %s", envelope.Message)
		}
	}
	return WorkBuddyCredential{}, fmt.Errorf("WorkBuddy 登录等待超时，请重新登录")
}

func WorkBuddyModels(ctx context.Context, authPath string) ([]string, error) {
	credential, err := LoadWorkBuddyCredential(authPath)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(credential.AccessToken) == "" {
		return nil, fmt.Errorf("请先登录 WorkBuddy")
	}
	credential, err = refreshWorkBuddyIfNeeded(ctx, Config{WorkBuddyAuth: credential, workBuddyAuthPath: authPath})
	if err != nil {
		return nil, err
	}
	headers := workBuddyAuthHeaders(credential)
	models, err := fetchWorkBuddyModelEndpoint(ctx, workBuddyEndpoint+"/console/enterprises/personal/models", headers, "cli")
	if err != nil || len(models) == 0 {
		models, err = fetchWorkBuddyModelEndpoint(ctx, workBuddyEndpoint+"/v3/config", headers, "craft")
	}
	if err != nil || len(models) == 0 {
		return nil, fmt.Errorf("读取 WorkBuddy 模型目录失败，请重新登录后重试")
	}
	return models, nil
}

func fetchWorkBuddyModelEndpoint(ctx context.Context, endpoint string, headers http.Header, preferredAgent string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	for key, values := range headers {
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	res, err := workBuddyHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var envelope struct {
		Data struct {
			Models []struct {
				ID, Name        string
				Tags            []string `json:"tags"`
				SupportsExtra   bool     `json:"supportsExtra"`
				MaxOutputTokens int      `json:"maxOutputTokens"`
			} `json:"models"`
			Agents []struct {
				Name   string   `json:"name"`
				Models []string `json:"models"`
			} `json:"agents"`
			ProductFeaturesConfig struct {
				ModelTrialBanner struct {
					Banners []struct {
						TargetModelID string `json:"targetModelId"`
					} `json:"banners"`
				} `json:"ModelTrialBanner"`
			} `json:"productFeaturesConfig"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, err
	}
	eligible := map[string]bool{}
	for _, model := range envelope.Data.Models {
		if model.ID == "" || model.ID == "auto" || model.ID == "default" || strings.HasPrefix(model.ID, "nes-") || strings.HasPrefix(model.ID, "completion-") || strings.HasPrefix(model.ID, "codewise-") || model.SupportsExtra || (model.MaxOutputTokens > 0 && model.MaxOutputTokens <= 256) {
			continue
		}
		imageModel := false
		for _, tag := range model.Tags {
			if tag == "text-to-image" {
				imageModel = true
				break
			}
		}
		if !imageModel {
			eligible[model.ID] = true
		}
	}
	out := []string{}
	seen := map[string]bool{}
	add := func(id string) {
		if eligible[id] && !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	for _, agent := range envelope.Data.Agents {
		if agent.Name == preferredAgent {
			for _, id := range agent.Models {
				add(id)
			}
			break
		}
	}
	for _, model := range envelope.Data.Models {
		add(model.ID)
	}
	for _, banner := range envelope.Data.ProductFeaturesConfig.ModelTrialBanner.Banners {
		if banner.TargetModelID != "" && !seen[banner.TargetModelID] {
			out = append(out, banner.TargetModelID)
			seen[banner.TargetModelID] = true
		}
	}
	return out, nil
}

func refreshWorkBuddyIfNeeded(ctx context.Context, cfg Config) (WorkBuddyCredential, error) {
	credential := cfg.WorkBuddyAuth
	if credential.RefreshToken == "" || credential.ExpiresAt == 0 || time.Now().UnixMilli() < credential.ExpiresAt-2*time.Minute.Milliseconds() {
		return credential, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, workBuddyEndpoint+"/v2/plugin/auth/token/refresh", nil)
	if err != nil {
		return credential, err
	}
	setWorkBuddyBaseHeaders(req, credential.AccessToken)
	req.Header.Set("X-Refresh-Token", credential.RefreshToken)
	req.Header.Set("X-Auth-Refresh-Source", "ide-main")
	res, err := workBuddyHTTPClient.Do(req)
	if err != nil {
		return credential, fmt.Errorf("WorkBuddy 登录续期失败: %w", err)
	}
	defer res.Body.Close()
	var envelope struct {
		Message string `json:"message"`
		Data    *struct {
			AccessToken      string  `json:"accessToken"`
			RefreshToken     string  `json:"refreshToken"`
			ExpiresIn        float64 `json:"expiresIn"`
			RefreshExpiresIn float64 `json:"refreshExpiresIn"`
			Domain           string  `json:"domain"`
		} `json:"data"`
	}
	if json.NewDecoder(res.Body).Decode(&envelope) != nil || res.StatusCode != http.StatusOK || envelope.Data == nil || envelope.Data.AccessToken == "" {
		return credential, fmt.Errorf("WorkBuddy 登录已失效，请重新登录")
	}
	now := time.Now().UnixMilli()
	credential.AccessToken = envelope.Data.AccessToken
	if envelope.Data.RefreshToken != "" {
		credential.RefreshToken = envelope.Data.RefreshToken
	}
	credential.ExpiresAt = parseWorkBuddyExpiry(nil, envelope.Data.ExpiresIn, now)
	credential.RefreshExpiresAt = parseWorkBuddyExpiry(nil, envelope.Data.RefreshExpiresIn, now)
	if envelope.Data.Domain != "" {
		credential.Domain = envelope.Data.Domain
	}
	if cfg.workBuddyAuthPath != "" {
		_ = SaveWorkBuddyCredential(cfg.workBuddyAuthPath, credential)
	}
	return credential, nil
}

func workBuddyAuthHeaders(credential WorkBuddyCredential) http.Header {
	headers := http.Header{}
	setWorkBuddyBaseHeadersTo(headers, credential.AccessToken)
	headers.Set("X-Product", "SaaS")
	headers.Set("X-Product-Code", workBuddyProductCode)
	return headers
}

func setWorkBuddyBaseHeaders(req *http.Request, token string) {
	setWorkBuddyBaseHeadersTo(req.Header, token)
}
func setWorkBuddyBaseHeadersTo(headers http.Header, token string) {
	headers.Set("X-Domain", workBuddyDomain)
	headers.Set("User-Agent", workBuddyUA)
	if token != "" {
		headers.Set("Authorization", "Bearer "+token)
	}
}

func parseWorkBuddyExpiry(raw json.RawMessage, relativeSeconds float64, now int64) int64 {
	if len(raw) > 0 && string(raw) != "null" {
		var text string
		if json.Unmarshal(raw, &text) == nil && text != "" {
			if number, err := time.ParseDuration(text + "ms"); err == nil {
				return number.Milliseconds()
			}
			if parsed, err := time.Parse(time.RFC3339, text); err == nil {
				return parsed.UnixMilli()
			}
			var n int64
			if _, err := fmt.Sscan(text, &n); err == nil {
				if n < 1_000_000_000_000 {
					n *= 1000
				}
				return n
			}
		}
		var number int64
		if json.Unmarshal(raw, &number) == nil {
			if number < 1_000_000_000_000 {
				number *= 1000
			}
			return number
		}
	}
	if relativeSeconds > 0 {
		return now + int64(relativeSeconds*1000)
	}
	return 0
}

func workBuddyJWTClaim(token, name string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return ""
	}
	value, _ := claims[name].(string)
	return strings.TrimSpace(value)
}

func workBuddyJWTExpiry(token string) int64 {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return 0
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims map[string]json.RawMessage
	if json.Unmarshal(payload, &claims) != nil {
		return 0
	}
	var seconds int64
	if json.Unmarshal(claims["exp"], &seconds) != nil || seconds <= 0 {
		return 0
	}
	return seconds * 1000
}
