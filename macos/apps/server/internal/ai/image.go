package ai

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MaxImageBytes bounds each PNG attachment before encoding it for the provider.
const MaxImageBytes = 8 << 20

// Unsupported providers must never silently discard the images.
const ErrImageUnsupportedByCLI = "当前 AI 渠道不支持图片输入，请使用 Codex Desktop、支持视觉的 OpenAI 兼容或 Anthropic 模型。"

// GenerateWithImage 非流式生成，附带一张 PNG 图片。当前渠道不支持图片时返回明确错误。
//
// Layout callers request structure only; reading callers request visual observations.
func (c *Client) GenerateWithImage(ctx context.Context, system, user string, imagePNG []byte, temperature float64, timeout time.Duration) (string, error) {
	return c.GenerateWithImages(ctx, system, user, [][]byte{imagePNG}, temperature, timeout)
}

// GenerateWithImages keeps attachment order identical to the catalog in the prompt.
func (c *Client) GenerateWithImages(ctx context.Context, system, user string, images [][]byte, temperature float64, timeout time.Duration) (string, error) {
	if len(images) == 0 || len(images) > 4 {
		return "", fmt.Errorf("每批需要 1–4 张图表图片")
	}
	for _, data := range images {
		if len(data) == 0 || len(data) > MaxImageBytes {
			return "", fmt.Errorf("图片为空或超过 8 MiB 上限")
		}
	}
	if timeout <= 0 {
		timeout = RequestTimeout
	}
	timeout = c.operationTimeout(timeout)
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if c.cfg.IsCLI() {
		if c.cfg.ProviderName() == "codex" {
			return c.streamCLIWithImages(requestCtx, []Message{{Role: "system", Content: system}, {Role: "user", Content: user}}, images, nil)
		}
		return "", fmt.Errorf("%s", ErrImageUnsupportedByCLI)
	}
	if c.cfg.ProviderName() == "anthropic" {
		return c.generateWithImageAnthropic(requestCtx, system, user, images, temperature, timeout)
	}
	return c.generateWithImageOpenAI(requestCtx, system, user, images, temperature, timeout)
}

// imageDataURL 组装 OpenAI 兼容接口要求的 data URL：必须是 PNG，且不带换行。
func imageDataURL(imagePNG []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(imagePNG)
}

// generateWithImageOpenAI 走 /chat/completions：content 必须是「部件数组」而不是字符串，
// 因此不能复用只接受 Message{Content string} 的 post。
func (c *Client) generateWithImageOpenAI(ctx context.Context, system, user string, images [][]byte, temperature float64, timeout time.Duration) (string, error) {
	parts := []any{map[string]any{"type": "text", "text": user}}
	for _, data := range images {
		parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": imageDataURL(data)}})
	}
	// 按契约先 text 后 image_url：多模态模型对顺序敏感（先给任务再给图）。
	payload := map[string]any{
		"model":       c.cfg.ModelName(),
		"temperature": temperature,
		"stream":      false,
		"messages": []any{
			map[string]any{"role": "system", "content": system},
			map[string]any{"role": "user", "content": parts},
		},
	}
	if c.requiresStreaming() {
		payload["stream"] = true
		return c.streamRawOpenAI(ctx, payload, timeout, nil)
	}
	response, err := c.postRaw(ctx, payload, timeout)
	if err != nil {
		if isNonStreamUnsupportedError(err) {
			c.markRequiresStreaming()
			payload["stream"] = true
			return c.streamRawOpenAI(ctx, payload, timeout, nil)
		}
		return "", err
	}
	defer response.Body.Close()
	body, err := readResponseBody(response)
	if err != nil {
		return "", err
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return "", fmt.Errorf("接口返回不是合法 JSON: %w", err)
	}
	if len(decoded.Choices) == 0 || strings.TrimSpace(decoded.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("（模型没有返回内容，检查 config.json 里的模型是否支持图片输入）")
	}
	return decoded.Choices[0].Message.Content, nil
}

// generateWithImageAnthropic 走 /messages：图片是 base64 source 部件，system 是顶层字段。
func (c *Client) generateWithImageAnthropic(ctx context.Context, system, user string, images [][]byte, temperature float64, timeout time.Duration) (string, error) {
	parts := []any{map[string]any{"type": "text", "text": user}}
	for _, data := range images {
		parts = append(parts, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": base64.StdEncoding.EncodeToString(data)}})
	}
	endpoint, err := c.cfg.Endpoint()
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"model":       c.cfg.ModelName(),
		"system":      system,
		"max_tokens":  8192,
		"temperature": temperature,
		"stream":      false,
		"messages": []any{
			map[string]any{"role": "user", "content": parts},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-api-key", c.cfg.APIKey)
	request.Header.Set("anthropic-version", "2023-06-01")
	response, err := c.http.Do(request)
	if err != nil {
		return "", requestFailure(err, ctx, timeout)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", statusFailure(response, c.cfg.APIKey)
	}
	raw, err := readResponseBody(response)
	if err != nil {
		return "", err
	}
	var decoded struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", fmt.Errorf("Anthropic 返回不是合法 JSON: %w", err)
	}
	var full strings.Builder
	for _, part := range decoded.Content {
		if part.Type == "text" {
			full.WriteString(part.Text)
		}
	}
	if strings.TrimSpace(full.String()) == "" {
		return "", fmt.Errorf("（Anthropic 没有返回内容，检查 config.json 里的模型是否支持图片输入）")
	}
	return full.String(), nil
}

// readResponseBody 给所有非流式响应统一的读取上限，避免异常上游撑爆内存。
func readResponseBody(response *http.Response) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
	if err != nil {
		return nil, fmt.Errorf("读取接口响应失败: %w", err)
	}
	if len(body) > 8<<20 {
		return nil, fmt.Errorf("接口响应超过 8 MiB 上限")
	}
	return body, nil
}
