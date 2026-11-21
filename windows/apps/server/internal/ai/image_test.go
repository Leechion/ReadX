package ai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// visionImage 是一张「够像 PNG」的最小字节序列：客户端不解析图片内容，
// 只负责原样转发，所以测试用可辨识的字节就够了。
func visionImage() []byte { return []byte("\x89PNG\r\n\x1a\n-vision-fixture") }

// 假的 OpenAI 兼容服务：把收到的请求体交给脚本，由脚本决定回什么。
func newOpenAIVisionServer(t *testing.T, inspect func(t *testing.T, payload map[string]any) string, calls *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls != nil {
			*calls++
		}
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("应带上 Bearer Key，实际 %q", got)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("请求体不是合法 JSON: %v", err)
			return
		}
		content := ""
		if inspect != nil {
			content = inspect(t, payload)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": content}}},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

// imageMessages 从请求体里取出 messages，并断言 content 是部件数组（不是字符串）。
func imageMessages(t *testing.T, payload map[string]any) []map[string]any {
	t.Helper()
	raw, ok := payload["messages"].([]any)
	if !ok {
		t.Fatalf("messages 应为数组，实际 %T", payload["messages"])
	}
	messages := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		message, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("message 应为对象，实际 %T", item)
		}
		messages = append(messages, message)
	}
	return messages
}

// imageParts 断言某条消息的 content 是部件数组并原样返回。
func imageParts(t *testing.T, message map[string]any) []map[string]any {
	t.Helper()
	raw, ok := message["content"].([]any)
	if !ok {
		t.Fatalf("多模态消息的 content 必须是数组，实际 %T", message["content"])
	}
	parts := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		part, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("content 部件应为对象，实际 %T", item)
		}
		parts = append(parts, part)
	}
	return parts
}

func TestGenerateWithImageSendsDataURLAndParsesReply(t *testing.T) {
	image := visionImage()
	calls := 0
	server := newOpenAIVisionServer(t, func(t *testing.T, payload map[string]any) string {
		if payload["stream"] == true {
			t.Error("带图请求必须是非流式")
		}
		if payload["model"] != "m" {
			t.Errorf("模型名应为 m，实际 %v", payload["model"])
		}
		if temperature, _ := payload["temperature"].(float64); temperature != 0 {
			t.Errorf("temperature 应为 0，实际 %v", payload["temperature"])
		}
		messages := imageMessages(t, payload)
		if len(messages) != 2 || messages[0]["role"] != "system" {
			t.Fatalf("应是一条 system + 一条 user，实际 %v", messages)
		}
		if messages[0]["content"] != "SYS" {
			t.Errorf("system 内容应为纯文本，实际 %v", messages[0]["content"])
		}
		if messages[1]["role"] != "user" {
			t.Fatalf("第二条应为 user，实际 %v", messages[1]["role"])
		}
		parts := imageParts(t, messages[1])
		if len(parts) != 2 {
			t.Fatalf("user content 应有 text + image_url 两个部件，实际 %d", len(parts))
		}
		if parts[0]["type"] != "text" || parts[0]["text"] != "USER" {
			t.Errorf("第一个部件应是文本，实际 %v", parts[0])
		}
		if parts[1]["type"] != "image_url" {
			t.Fatalf("第二个部件应是 image_url，实际 %v", parts[1])
		}
		imageURL, ok := parts[1]["image_url"].(map[string]any)
		if !ok {
			t.Fatalf("image_url 应为对象，实际 %T", parts[1]["image_url"])
		}
		want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(image)
		if imageURL["url"] != want {
			t.Errorf("data URL 不正确：%v", imageURL["url"])
		}
		// 图片字节必须与原始 PNG 完全一致（多一层编码/换行都会让服务端解不出图）。
		if strings.Contains(fmt.Sprint(imageURL["url"]), "\n") {
			t.Error("data URL 不得含换行")
		}
		return `{"groups":[]}`
	}, &calls)
	cfg := Config{BaseURL: server.URL, APIKey: "sk-test", Model: "m"}
	text, err := NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", image, 0, 5*time.Second)
	if err != nil {
		t.Fatalf("带图生成应成功: %v", err)
	}
	if text != `{"groups":[]}` || calls != 1 {
		t.Fatalf("返回体或调用次数异常: %q calls=%d", text, calls)
	}
}

func TestGenerateWithImageAnthropicBody(t *testing.T) {
	image := visionImage()
	received := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = true
		if r.URL.Path != "/messages" {
			t.Errorf("Anthropic 应走 /messages，实际 %q", r.URL.Path)
			return
		}
		if r.Header.Get("x-api-key") != "sk-ant" {
			t.Errorf("应带 x-api-key，实际 %q", r.Header.Get("x-api-key"))
		}
		if r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("应带 anthropic-version，实际 %q", r.Header.Get("anthropic-version"))
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("请求体不是合法 JSON: %v", err)
			return
		}
		if payload["stream"] == true {
			t.Error("带图请求必须是非流式")
		}
		if payload["system"] != "SYS" {
			t.Errorf("system 应为顶层字段，实际 %v", payload["system"])
		}
		if tokens, _ := payload["max_tokens"].(float64); tokens != 8192 {
			t.Errorf("max_tokens 应为 8192，实际 %v", payload["max_tokens"])
		}
		messages := imageMessages(t, payload)
		if len(messages) != 1 || messages[0]["role"] != "user" {
			t.Fatalf("Anthropic 只应有一条 user，实际 %v", messages)
		}
		parts := imageParts(t, messages[0])
		if len(parts) != 2 || parts[0]["type"] != "text" || parts[1]["type"] != "image" {
			t.Fatalf("部件应为 text + image，实际 %v", parts)
		}
		source, ok := parts[1]["source"].(map[string]any)
		if !ok {
			t.Fatalf("image 部件应带 source 对象，实际 %T", parts[1]["source"])
		}
		if source["type"] != "base64" || source["media_type"] != "image/png" {
			t.Errorf("source 类型应固定为 base64/png，实际 %v", source)
		}
		if source["data"] != base64.StdEncoding.EncodeToString(image) {
			t.Errorf("source.data 不是图片的 base64")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": `{"groups":[{"from":0,"to":0,"role":"body"}]}`},
			},
		})
	}))
	t.Cleanup(server.Close)

	cfg := Config{Provider: "anthropic", BaseURL: server.URL, APIKey: "sk-ant", Model: "claude-x"}
	text, err := NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", image, 0, 5*time.Second)
	if err != nil {
		t.Fatalf("Anthropic 带图生成应成功: %v", err)
	}
	if !strings.Contains(text, `"groups"`) || !received {
		t.Fatalf("应解析 content[0].text，实际 %q received=%v", text, received)
	}
}

func TestGenerateWithImageRejectsCLIAndOversizedImage(t *testing.T) {
	// Unsupported CLI channels must reject images. Codex has an attachment transport.
	for _, provider := range []string{"claude", "kimi"} {
		cfg := Config{Provider: provider, Model: "m"}
		_, err := NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", visionImage(), 0, time.Second)
		if err == nil || !strings.Contains(err.Error(), "不支持图片输入") {
			t.Fatalf("%s 渠道应明确降级，实际 %v", provider, err)
		}
	}
	// 超过 8 MiB：在发请求之前就拒绝。
	cfg := Config{BaseURL: "https://x.test/v1", APIKey: "sk-test", Model: "m"}
	_, err := NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", make([]byte, MaxImageBytes+1), 0, time.Second)
	if err == nil || !strings.Contains(err.Error(), "8 MiB") {
		t.Fatalf("超大图片应被拒绝，实际 %v", err)
	}
	_, err = NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", nil, 0, time.Second)
	if err == nil {
		t.Fatal("空图片应被拒绝")
	}
}

func TestGenerateWithImageRedactsKeyOnUpstreamError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"bad key sk-leak-me"}`)
	}))
	t.Cleanup(server.Close)
	cfg := Config{BaseURL: server.URL, APIKey: "sk-leak-me", Model: "m"}
	_, err := NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", visionImage(), 0, 5*time.Second)
	if err == nil {
		t.Fatal("非 200 必须报错")
	}
	message := err.Error()
	if !strings.Contains(message, "401") {
		t.Fatalf("错误应带状态码，实际 %v", message)
	}
	if strings.Contains(message, "sk-leak-me") {
		t.Fatalf("错误信息泄露了 API Key：%v", message)
	}
	if !strings.Contains(message, "[redacted]") {
		t.Fatalf("应把 Key 替换成 [redacted]，实际 %v", message)
	}
}

func TestGenerateWithImageReportsTimeout(t *testing.T) {
	// 上游永不回包：客户端必须按自己的 deadline 结束，并给出「可重试」的提示。
	// 这里额外睡一小段时间再返回，避免 httptest.Server.Close 与请求 context 的取消赛跑。
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		time.Sleep(500 * time.Millisecond)
	}))
	t.Cleanup(server.Close)
	cfg := Config{BaseURL: server.URL, APIKey: "sk-test", Model: "m"}
	_, err := NewClient(cfg).GenerateWithImage(context.Background(), "SYS", "USER", visionImage(), 0, 100*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatalf("超时应给出可重试的提示，实际 %v", err)
	}
}

func TestGenerateWithImageFallsBackToStreamWhenNonStreamNotSupported(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["stream"] != true {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"code":11101,"msg":"Non-stream chat request is currently not supported","requestId":"test-ocr-req"}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: "+`{"choices":[{"delta":{"content":"{\"detectedKind\":\"formula\",\"latex\":\"E=mc^2\",\"markdown\":\"$$E=mc^2$$\"}"}}]}`+"\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)

	cfg := Config{BaseURL: server.URL, APIKey: "sk-test", Model: "stream-vision-model"}
	client := NewClient(cfg)
	res, err := client.GenerateWithImage(context.Background(), "SYS", "识别公式", visionImage(), 0, 5*time.Second)
	if err != nil {
		t.Fatalf("遇到 11101 非流式错误时 GenerateWithImage 应自动流式重试并成功: %v", err)
	}
	if !strings.Contains(res, "E=mc^2") {
		t.Fatalf("返回内容不符: %q", res)
	}
	if calls != 2 {
		t.Fatalf("首次调用应经历 1 次非流式探测 + 1 次流式重试，实际 calls=%d", calls)
	}

	// 第二次调用直接命中流式
	calls = 0
	res2, err := client.GenerateWithImage(context.Background(), "SYS", "识别公式2", visionImage(), 0, 5*time.Second)
	if err != nil {
		t.Fatalf("后续请求应直接成功: %v", err)
	}
	if !strings.Contains(res2, "E=mc^2") {
		t.Fatalf("后续请求返回内容不符: %q", res2)
	}
	if calls != 1 {
		t.Fatalf("后续调用应直接发起 1 次流式，不再产生非流式失败探测，实际 calls=%d", calls)
	}
}
