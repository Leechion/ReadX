package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleSource = "=== Page 1 ===\nWe train using 50 views and report PSNR of 33.05 dB on the Walnut dataset.\n" +
	"Method section here.\n=== Page 2 ===\nMethod: continuous density field with projection loss.\n" +
	"Experiments on Walnut show 33.05 dB.\n=== Page 3 ===\nReferences\n[1] Someone et al.\n"

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadConfigStates(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.json")
	if _, err := LoadConfig(missing); err == nil || !strings.Contains(err.Error(), "app/config.json") {
		t.Fatalf("缺配置应给出可执行的中文提示，实际 %v", err)
	}
	if _, err := LoadConfig(writeConfig(t, `{oops`)); err == nil {
		t.Fatal("损坏 JSON 必须报错")
	}
	cfg, err := LoadConfig(writeConfig(t, `{"baseURL":"https://x.test/v1","model":"m","apiKey":"sk-test"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Ready() {
		t.Fatal("配齐三项应视为可用")
	}
	endpoint, err := cfg.Endpoint()
	if err != nil || endpoint != "https://x.test/v1/chat/completions" {
		t.Fatalf("地址拼接错误: %v %s", err, endpoint)
	}
}

func TestConfigGuards(t *testing.T) {
	placeholder := Config{BaseURL: "https://x.test/v1", APIKey: "在这里填入你的 Key"}
	if placeholder.Ready() {
		t.Fatal("占位符 Key 不能算已配置")
	}
	if _, err := placeholder.Endpoint(); err == nil {
		t.Fatal("未配置时不得给出端点")
	}
	slash := Config{BaseURL: "https://x.test/v1/", APIKey: "sk"}
	endpoint, err := slash.Endpoint()
	if err != nil || endpoint != "https://x.test/v1/chat/completions" {
		t.Fatalf("尾斜杠应被吃掉: %v %s", err, endpoint)
	}
	for _, bad := range []string{"", "x.test/v1", "ftp://x.test/v1"} {
		if _, err := (Config{BaseURL: bad, APIKey: "sk"}).Endpoint(); err == nil {
			t.Fatalf("非法地址应被拒绝: %q", bad)
		}
	}
	if model := (Config{APIKey: "sk", BaseURL: "https://x.test/v1"}).ModelName(); model != "glm-4.6" {
		t.Fatalf("缺省模型应与旧版一致，实际 %q", model)
	}
}

func TestRedactNeverLeaksKey(t *testing.T) {
	cfg := Config{BaseURL: "https://api.example.test/v1", Model: "deepseek-flash", APIKey: "sk-secret-value"}
	body, err := json.Marshal(cfg.Redact())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "sk-secret-value") {
		t.Fatalf("脱敏状态里出现了 Key: %s", body)
	}
	var redacted Redacted
	if err := json.Unmarshal(body, &redacted); err != nil {
		t.Fatal(err)
	}
	if !redacted.Configured || redacted.Host != "api.example.test" || redacted.Model != "deepseek-flash" {
		t.Fatalf("状态字段异常: %+v", redacted)
	}
}

func TestPromptsCoverEveryKind(t *testing.T) {
	for _, kind := range []string{"tldr", "deep", "critical", "motivation", "method", "experiment", "results", "apply", "code"} {
		if strings.TrimSpace(ReadingTask(kind)) == "" {
			t.Fatalf("kind %q 缺少任务提示词", kind)
		}
	}
	if ReadingTask("nope") != "" {
		t.Fatal("未知 kind 应返回空串，由调用方拒绝")
	}
	prompt := ReadingSystemPrompt("experiment", "材料")
	for _, want := range []string{"回答规则：", "【论文全文（按页标记）】", "材料", "【本次任务】", "results\" 数组必须为空"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("system prompt 缺少 %q:\n%s", want, prompt)
		}
	}
	if !JSONKinds["experiment"] || !JSONKinds["results"] || !JSONKinds["apply"] || !JSONKinds["method"] || !JSONKinds["motivation"] || !JSONKinds["reproduction"] {
		t.Fatal("JSON kind 白名单不符")
	}
	repair := RepairInstruction("experiment", "校验错误X", "{\"dataset\":[]}")
	if !strings.Contains(repair, "校验错误X") || !strings.Contains(repair, "{\"dataset\":[]}") {
		t.Fatal("修复轮必须把上次错误与上次输出都回喂")
	}
	downgrade := DowngradeInstruction("校验错误Y")
	if !strings.Contains(downgrade, "校验错误Y") || !strings.Contains(downgrade, "论文未说明") {
		t.Fatal("降级轮必须给出「改为论文未说明」的明确授权")
	}
}

func TestScopedPagesCutsReferencesForEveryScope(t *testing.T) {
	for _, scope := range []string{"Method", "Experiment", "Appendix"} {
		pages := ScopedPages(sampleSource, scope)
		joined := ""
		for _, p := range pages {
			joined += p.Text
		}
		if strings.Contains(joined, "Someone et al.") {
			t.Fatalf("%s 范围把参考文献吸进了证据集", scope)
		}
	}
	methodText := ""
	for _, page := range ScopedPages(sampleSource, "Method") {
		methodText += page.Text
	}
	if !strings.Contains(methodText, "continuous density field") {
		t.Fatalf("Method 范围应命中方法段正文: %q", methodText)
	}
	experimentText := ""
	for _, page := range ScopedPages(sampleSource, "Experiment") {
		experimentText += page.Text
	}
	if !strings.Contains(experimentText, "33.05 dB") {
		t.Fatalf("Experiment 范围应命中结果行: %q", experimentText)
	}
}

func TestSelectWithMetaDisclosesSubset(t *testing.T) {
	// limit 故意小于全文长度：必须只选相关页并如实披露。
	result := SelectWithMeta(sampleSource, "PSNR Walnut", "全文", 200)
	if result.Included >= result.Total || result.Included == 0 {
		t.Fatalf("应选出子集，实际 %d/%d", result.Included, result.Total)
	}
	note := ScopingNote(result)
	if !strings.HasPrefix(note, "【材料范围】") {
		t.Fatalf("子集必须带披露前缀: %s", note[:min(40, len(note))])
	}
	if !strings.Contains(note, "不得仅凭本子集断言论文没有该内容") {
		t.Fatal("披露文案必须禁止凭子集断言缺失")
	}
	// 全文足够短时原样返回，不加披露。
	short := SelectWithMeta(sampleSource, "PSNR", "全文", 100000)
	if short.Included != short.Total || ScopingNote(short) != short.Text {
		t.Fatalf("未截断时不应加披露: %+v", short)
	}
}

func TestPrepareMaterialRejectsUnanswerable(t *testing.T) {
	if _, _, _, err := PrepareMaterial("", "q", "全文"); err == nil || !strings.Contains(err.Error(), "全文缓存") {
		t.Fatalf("无缓存必须拒绝，实际 %v", err)
	}
	if _, _, _, err := PrepareMaterial(sampleSource, "appendix", "Appendix"); err == nil ||
		!strings.Contains(err.Error(), "没有选到任何内容") {
		t.Fatalf("该 scope 选不出内容必须拒绝，实际 %v", err)
	}
	material, included, total, err := PrepareMaterial(sampleSource, "PSNR", "全文")
	if err != nil || material == "" || included == 0 || total == 0 {
		t.Fatalf("正常路径应给出材料: %v %d/%d", err, included, total)
	}
}

// fakeUpstream 是最小 OpenAI 兼容桩：脚本决定每次返回什么。
func fakeUpstream(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			http.NotFound(w, r)
			return
		}
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["stream"] == true {
			w.Header().Set("Content-Type", "text/event-stream")
		}
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

func sseDelta(content string) string {
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": content}}}})
	return "data: " + string(body) + "\n\n"
}

func TestStreamForwardsDeltasAndCompletes(t *testing.T) {
	server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, sseDelta("你好"), sseDelta("，世界\n"))
		fmt.Fprint(w, "data: [DONE]\n\n")
	})
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
	var seen []string
	text, err := NewClient(cfg).Stream(context.Background(), []Message{{Role: "user", Content: "hi"}}, 0.2, func(delta string) {
		seen = append(seen, delta)
	})
	if err != nil {
		t.Fatalf("流式应成功: %v", err)
	}
	if text != "你好，世界\n" || len(seen) != 2 {
		t.Fatalf("增量转发异常: %q %v", text, seen)
	}
}

func TestStreamFailureModes(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		want   string
		status int
	}{
		{"截断流", sseDelta("半句"), "连接中断", 200},
		{"长度上限", "data: " + `{"choices":[{"finish_reason":"length","delta":{"content":"x"}}]}` + "\n\n", "生成未完成", 200},
		{"空返回", "data: [DONE]\n\n", "没有返回内容", 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, c.body) })
			cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
			_, err := NewClient(cfg).Stream(context.Background(), []Message{{Role: "user", Content: "q"}}, 0.2, nil)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("应报「%s」，实际 %v", c.want, err)
			}
		})
	}

	server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, "rate limited")
	})
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
	if _, err := NewClient(cfg).Stream(context.Background(), []Message{{Role: "user", Content: "q"}}, 0.2, nil); err == nil ||
		!strings.Contains(err.Error(), "429") {
		t.Fatalf("非 200 应带上状态码，实际 %v", err)
	}
}

func TestGenerateReadsNonStreamReply(t *testing.T) {
	server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": `{"dataset":[]}`}}}})
		fmt.Fprint(w, string(body))
	})
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
	text, err := NewClient(cfg).Generate(context.Background(), "sys", "user", 0.2)
	if err != nil || text != `{"dataset":[]}` {
		t.Fatalf("非流式解析失败: %q %v", text, err)
	}
}

// 实验配置的最小合法样本：一个字段带逐字摘录。
func validExperiment() string {
	return `{"dataset":[{"k":"数据集","v":"Walnut","page":1,"excerpt":"report PSNR of 33.05 dB on the Walnut dataset"}],` +
		`"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[],"baselines":[]}`
}

func TestGenerateValidatedRepairsThenPasses(t *testing.T) {
	calls := 0
	server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		content := `{"dataset":[{"k":"数据集","v":"Walnut","page":9,"excerpt":"不存在"}],"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[]}`
		if calls > 1 {
			content = validExperiment()
		}
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
		fmt.Fprint(w, string(body))
	})
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
	outcome, err := GenerateValidated(context.Background(), NewClient(cfg), "experiment", "sys", sampleSource, 2)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.ValidationError != "" {
		t.Fatalf("修复轮后应通过校验，实际 %s", outcome.ValidationError)
	}
	if outcome.Attempts != 2 || calls != 2 {
		t.Fatalf("应恰好两轮，实际 attempts=%d calls=%d", outcome.Attempts, calls)
	}
}

func TestGenerateValidatedFallsToDowngradeRound(t *testing.T) {
	calls := 0
	server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		// 前三轮（首轮 + 两次修复）都返回同一份过不去的输出；终局降级轮给出合法输出。
		content := `{"dataset":[{"k":"数据集","v":"Walnut","page":9,"excerpt":"不存在"}],"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[]}`
		if calls >= 4 {
			content = validExperiment()
		}
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
		fmt.Fprint(w, string(body))
	})
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
	outcome, err := GenerateValidated(context.Background(), NewClient(cfg), "experiment", "sys", sampleSource, 2)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.ValidationError != "" || calls != 4 || outcome.Attempts != 4 {
		t.Fatalf("应在第 4 轮（降级轮）通过，实际 calls=%d attempts=%d err=%q", calls, outcome.Attempts, outcome.ValidationError)
	}
}

func TestGenerateValidatedReportsPersistentValidationError(t *testing.T) {
	server := fakeUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{
			"content": `{"dataset":[{"k":"数据集","v":"Walnut","page":9,"excerpt":"不存在"}],"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[]}`,
		}}}})
		fmt.Fprint(w, string(body))
	})
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "m"}
	outcome, err := GenerateValidated(context.Background(), NewClient(cfg), "experiment", "sys", sampleSource, 2)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.ValidationError == "" {
		t.Fatal("四轮都过不去时必须把校验错误带回，交给本地修剪层")
	}
	if outcome.Attempts != 4 {
		t.Fatalf("尝试次数应为 4（首轮 + 2 次修复 + 降级轮），实际 %d", outcome.Attempts)
	}
}

func TestTrimHistoryMapsRolesAndCaps(t *testing.T) {
	history := make([]Message, 12)
	for i := range history {
		if i%2 == 0 {
			history[i] = Message{Role: "ai", Content: fmt.Sprintf("a%d", i)}
		} else {
			history[i] = Message{Role: "user", Content: fmt.Sprintf("u%d", i)}
		}
	}
	trimmed := TrimHistory(history, 8)
	if len(trimmed) != 8 {
		t.Fatalf("应只保留最近 8 条，实际 %d", len(trimmed))
	}
	if trimmed[0].Role != "assistant" {
		t.Fatalf("ai 角色应映射为 assistant，实际 %q", trimmed[0].Role)
	}
	if trimmed[0].Content != "a4" {
		t.Fatalf("应截掉最早 4 条，实际从 %q 开始", trimmed[0].Content)
	}
}

func TestGenerateFallsBackToStreamWhenNonStreamNotSupported(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload["stream"] != true {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"code":11101,"msg":"Non-stream chat request is currently not supported","requestId":"test-id"}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, sseDelta("流式恢复成功"))
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(server.Close)
	cfg := Config{BaseURL: server.URL, APIKey: "sk", Model: "stream-only-model"}
	client := NewClient(cfg)
	text, err := client.Generate(context.Background(), "sys", "user", 0.2)
	if err != nil {
		t.Fatalf("遇到 11101 非流式错误时应自动回退到流式并成功: %v", err)
	}
	if text != "流式恢复成功" {
		t.Fatalf("返回文本不符: %q", text)
	}
	if calls != 2 {
		t.Fatalf("首次调用应经历 1 次非流式探测 + 1 次流式重试，实际 calls=%d", calls)
	}

	// 第二次调用应命中记忆，直接发起流式请求（不再产生 400 失败探测）。
	calls = 0
	text2, err := client.Generate(context.Background(), "sys", "user", 0.2)
	if err != nil {
		t.Fatalf("后续请求应直接流式成功: %v", err)
	}
	if text2 != "流式恢复成功" {
		t.Fatalf("后续请求返回文本不符: %q", text2)
	}
	if calls != 1 {
		t.Fatalf("后续调用应直接发起 1 次流式，不再重复走非流式探测，实际 calls=%d", calls)
	}
}
