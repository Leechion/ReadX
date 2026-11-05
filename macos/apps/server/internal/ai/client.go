package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RequestTimeout 与旧版一致：出站请求必须有超时，否则网络挂起会让界面永远停在「生成中」。
const RequestTimeout = 180 * time.Second

// ResultsRequestTimeout gives table-heavy results analysis more time to produce
// its structured output without extending the deadline for other AI actions.
const ResultsRequestTimeout = 8 * time.Minute

// Codex reasoning-heavy turns need a larger bounded window, and remain cancellable.
func (c *Client) operationTimeout(requested time.Duration) time.Duration {
	if c.cfg.ProviderName() == "codex" {
		switch c.cfg.ReasoningEffort {
		case "high", "xhigh", "max", "ultra":
			if requested < 10*time.Minute {
				return 10 * time.Minute
			}
		}
	}
	return requested
}

// Message 是一条对话消息；Role 用 OpenAI 的 system/user/assistant。
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model          string    `json:"model"`
	Messages       []Message `json:"messages"`
	Stream         bool      `json:"stream"`
	Temperature    float64   `json:"temperature"`
	ResponseFormat any       `json:"response_format,omitempty"`
}

type chatChoice struct {
	FinishReason string `json:"finish_reason"`
	Delta        struct {
		Content string `json:"content"`
	} `json:"delta"`
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
}

type chatChunk struct {
	Choices []chatChoice `json:"choices"`
}

// Client 是 OpenAI 兼容接口的最小客户端。
type Client struct {
	command       cliCommandFactory
	cfg           Config
	http          *http.Client
	authMu        sync.Mutex
	workBuddyAuth WorkBuddyCredential
}

type transportError struct{ err error }

func (e *transportError) Error() string { return e.err.Error() }
func (e *transportError) Unwrap() error { return e.err }

type upstreamStatusError struct {
	status     int
	message    string
	retryAfter time.Duration
}

func (e *upstreamStatusError) Error() string { return e.message }

func NewClient(cfg Config) *Client {
	// Request deadlines are applied per operation. A fixed http.Client timeout
	// would silently cap longer operations such as results analysis.
	return &Client{cfg: cfg, http: NewHTTPClient(), workBuddyAuth: cfg.WorkBuddyAuth}
}

func (c *Client) post(ctx context.Context, payload chatRequest, timeout time.Duration) (*http.Response, error) {
	return c.postRaw(ctx, payload, timeout)
}

// postRaw 是出站 POST 的唯一入口：只要 payload 能序列化成 JSON 就能走，
// 这样多模态的「content 为部件数组」请求也能复用同一套超时与脱敏处理。
//
// 与 post 的关系：post 只是它接受 chatRequest 的窄化封装。Generate/Stream 是唯一的
// 既有调用方，收窄成 chatRequest 能让纯文本路径保持编译期同形，不必到处传 any。
func (c *Client) postRaw(ctx context.Context, payload any, timeout time.Duration) (*http.Response, error) {
	endpoint, err := c.cfg.Endpoint()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if c.cfg.ProviderName() == "workbuddy" {
		c.authMu.Lock()
		cfg := c.cfg
		cfg.WorkBuddyAuth = c.workBuddyAuth
		credential, refreshErr := refreshWorkBuddyIfNeeded(ctx, cfg)
		if refreshErr == nil {
			c.workBuddyAuth = credential
			setWorkBuddyBaseHeaders(request, credential.AccessToken)
			request.Header.Set("Accept", "text/event-stream")
			request.Header.Set("X-Product-Code", workBuddyProductCode)
			request.Header.Set("X-Agent-Purpose", "conversation")
			request.Header.Set("X-IDE-Name", workBuddyProductName)
			request.Header.Set("X-IDE-Type", workBuddyProductName)
			request.Header.Set("X-IDE-Version", workBuddyClientVersion)
			request.Header.Set("X-Product", workBuddyProductName)
		}
		c.authMu.Unlock()
		if refreshErr != nil {
			return nil, refreshErr
		}
	} else {
		request.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, requestFailure(err, ctx, timeout)
	}
	if response.StatusCode != http.StatusOK {
		secret := c.cfg.APIKey
		if c.cfg.ProviderName() == "workbuddy" {
			c.authMu.Lock()
			secret = c.workBuddyAuth.AccessToken
			c.authMu.Unlock()
		}
		return nil, statusFailure(response, secret)
	}
	return response, nil
}

// requestFailure 把底层网络错误翻译成可执行的提示：超时与其它失败要能区分开。
func requestFailure(err error, ctx context.Context, timeout time.Duration) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &transportError{err: fmt.Errorf("请求超时（%s），未保存，请重试。", timeout.Round(time.Second))}
	}
	return &transportError{err: fmt.Errorf("请求失败：%s", err.Error())}
}

// statusFailure 读取错误响应并脱敏：上游常把 Key 回显在错误体里，直接透传会写进日志与界面。
func statusFailure(response *http.Response, apiKey string) error {
	defer response.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	text := string(detail)
	if apiKey != "" {
		text = strings.ReplaceAll(text, apiKey, "[redacted]")
	}
	if len([]rune(text)) > 200 {
		text = string([]rune(text)[:200])
	}
	message := fmt.Sprintf("接口返回 %d，请检查 API 地址、模型与访问权限。", response.StatusCode)
	if text != "" {
		message += "\n服务端返回：" + text
	}
	retryAfter := time.Duration(0)
	if response.StatusCode == http.StatusTooManyRequests {
		if seconds, err := strconv.Atoi(strings.TrimSpace(response.Header.Get("Retry-After"))); err == nil && seconds > 0 {
			retryAfter = time.Duration(seconds) * time.Second
		}
	}
	return &upstreamStatusError{status: response.StatusCode, message: message, retryAfter: retryAfter}
}

// IsTransportError matches LeePDF's retryable transport boundary: network
// failures and transient upstream statuses may enter the tail retry queue;
// authentication, quota, request, and response-format failures do not.
func (c *Client) IsTransportError(err error) bool {
	var networkErr *transportError
	if errors.As(err, &networkErr) {
		return true
	}
	var statusErr *upstreamStatusError
	if errors.As(err, &statusErr) {
		switch statusErr.status {
		case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError,
			http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout, 529:
			return true
		default:
			return false
		}
	}
	return false
}

// Generate 是非流式生成：结构化精读要整段 JSON，流式拼接无收益。
func (c *Client) Generate(ctx context.Context, system, user string, temperature float64) (string, error) {
	return c.GenerateWithTimeout(ctx, system, user, temperature, RequestTimeout)
}

// GenerateWithTimeout is the non-streaming JSON generation path with a
// per-operation deadline.
func (c *Client) GenerateWithTimeout(ctx context.Context, system, user string, temperature float64, timeout time.Duration) (string, error) {
	return c.generateWithTimeout(ctx, system, user, temperature, timeout, nil)
}

// GenerateTranslation applies LeePDF's default single-item translation
// deadlines. Long source blocks get a larger bounded window; other operations
// continue using Generate/GenerateWithTimeout and their own limits.
func (c *Client) GenerateTranslation(ctx context.Context, system, user string, temperature float64, sourceChars int) (string, error) {
	timeout := 35 * time.Second
	if sourceChars >= 800 {
		timeout = 55 * time.Second
	}
	if c.usesDeepSeekOfficialEndpoint() {
		timeout = 20 * time.Second
		if sourceChars >= 800 {
			timeout = 30 * time.Second
		}
	}
	return c.GenerateWithTimeout(ctx, system, user, temperature, timeout)
}

// GenerateTranslationBatch uses LeePDF's bounded tagged-batch deadline.
func (c *Client) GenerateTranslationBatch(ctx context.Context, system, user string, temperature float64) (string, error) {
	timeout := 45 * time.Second
	if c.usesDeepSeekOfficialEndpoint() {
		timeout = 25 * time.Second
	}
	return c.GenerateWithTimeout(ctx, system, user, temperature, timeout)
}

// GenerateTranslationTail uses LeePDF's extended timeout for the deferred
// transport retry pass. The official DeepSeek profile caps this at 40 seconds.
func (c *Client) GenerateTranslationTail(ctx context.Context, system, user string, temperature float64, _ int) (string, error) {
	timeout := 70 * time.Second
	if c.usesDeepSeekOfficialEndpoint() {
		timeout = 40 * time.Second
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		text, err := c.GenerateWithTimeout(ctx, system, user, temperature, timeout)
		if err == nil {
			return text, nil
		}
		lastErr = err
		if attempt == 1 || !c.IsTransportError(err) {
			break
		}
		delay := time.Second
		var statusErr *upstreamStatusError
		if errors.As(err, &statusErr) && statusErr.retryAfter > 0 {
			delay = statusErr.retryAfter
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		case <-timer.C:
		}
	}
	return "", lastErr
}

func (c *Client) usesDeepSeekOfficialEndpoint() bool {
	return strings.Contains(strings.ToLower(strings.TrimSpace(c.cfg.BaseURL)), "api.deepseek.com")
}

// GenerateStructured requests a strict structured response from OpenAI-compatible providers.
// Other providers keep their normal response path and rely on the caller's parser.
func (c *Client) GenerateStructured(ctx context.Context, system, user string, temperature float64, responseFormat any) (string, error) {
	return c.generateWithTimeout(ctx, system, user, temperature, RequestTimeout, responseFormat)
}

// GenerateStructuredWithTimeout lets bounded preparation phases preserve their
// own LeePDF request deadline while using the same strict JSON transport.
func (c *Client) GenerateStructuredWithTimeout(ctx context.Context, system, user string, temperature float64, timeout time.Duration, responseFormat any) (string, error) {
	return c.generateWithTimeout(ctx, system, user, temperature, timeout, responseFormat)
}

func (c *Client) generateWithTimeout(ctx context.Context, system, user string, temperature float64, timeout time.Duration, responseFormat any) (string, error) {
	if timeout <= 0 {
		timeout = RequestTimeout
	}
	timeout = c.operationTimeout(timeout)
	requestCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if c.cfg.ProviderName() != "openai" {
		return c.StreamWithTimeout(requestCtx, []Message{{Role: "system", Content: system}, {Role: "user", Content: user}}, temperature, nil, timeout)
	}
	payload := chatRequest{
		Model: c.cfg.ModelName(),
		Messages: []Message{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature:    temperature,
		ResponseFormat: responseFormat,
	}
	response, err := c.post(requestCtx, payload, timeout)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
	if err != nil {
		return "", &transportError{err: fmt.Errorf("读取接口响应失败: %w", err)}
	}
	if len(body) > 8<<20 {
		return "", fmt.Errorf("接口响应超过 8 MiB 上限")
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
		return "", fmt.Errorf("（模型没有返回内容，检查 config.json 里的模型名是否正确）")
	}
	return decoded.Choices[0].Message.Content, nil
}

// Stream 流式对话：onDelta 收到每个增量，返回完整文本。
//
// 与旧版一致的两条硬约束：finish_reason 不是 stop 视为失败；流中断时不返回成功——
// 半个回答比没有回答更危险。
func (c *Client) Stream(ctx context.Context, messages []Message, temperature float64, onDelta func(string)) (string, error) {
	return c.StreamWithTimeout(ctx, messages, temperature, onDelta, RequestTimeout)
}

// StreamWithTimeout allows callers to set a larger bound for long-running
// structured generation while preserving the standard chat timeout.
func (c *Client) StreamWithTimeout(ctx context.Context, messages []Message, temperature float64, onDelta func(string), timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = RequestTimeout
	}
	timeout = c.operationTimeout(timeout)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if c.cfg.IsCLI() {
		return c.streamCLI(ctx, messages, onDelta)
	}
	if c.cfg.ProviderName() == "anthropic" {
		return c.streamAnthropic(ctx, messages, temperature, onDelta)
	}
	response, err := c.post(ctx, chatRequest{
		Model:       c.cfg.ModelName(),
		Messages:    messages,
		Stream:      true,
		Temperature: temperature,
	}, timeout)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	var full strings.Builder
	completed := false
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[len("data:"):])
		if payload == "[DONE]" {
			completed = true
			break
		}
		var chunk chatChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]
		if choice.FinishReason != "" {
			if choice.FinishReason == "stop" {
				completed = true
			} else {
				return full.String(), fmt.Errorf("生成未完成（%s），未保存，请重试。", choice.FinishReason)
			}
		}
		if choice.Delta.Content != "" {
			full.WriteString(choice.Delta.Content)
			if onDelta != nil {
				onDelta(choice.Delta.Content)
			}
		}
		if completed {
			break
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return full.String(), &transportError{err: fmt.Errorf("请求失败：%s", err.Error())}
	}
	if full.Len() == 0 {
		return "", fmt.Errorf("（助教没有返回内容，检查 config.json 里的模型名是否正确）")
	}
	if !completed {
		return full.String(), &transportError{err: fmt.Errorf("连接中断，回答未完成，未保存，请重试。")}
	}
	return full.String(), nil
}

// TrimHistory 对应旧版「只带最近 8 轮」并把 ai 角色映射成 assistant。
func TrimHistory(history []Message, keep int) []Message {
	if len(history) > keep {
		history = history[len(history)-keep:]
	}
	out := make([]Message, 0, len(history))
	for _, item := range history {
		role := item.Role
		if role == "ai" {
			role = "assistant"
		} else if role != "assistant" {
			role = "user"
		}
		out = append(out, Message{Role: role, Content: item.Content})
	}
	return out
}
