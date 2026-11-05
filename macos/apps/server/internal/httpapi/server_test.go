package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/config"
	"cbctv2/server/internal/db"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// httptestServerBundle 把「真实 handler + 真实 SQLite」打包，测试只关心请求与响应。
type httptestServerBundle struct {
	frontend *httptest.Server
	token    string
	cfg      config.Config
	handle   *sql.DB
}

func defaultTestConfig(root string) config.Config {
	return config.Config{DataRoot: root, Host: "127.0.0.1", Port: 0, Token: testToken}
}

func serve(t *testing.T, cfg config.Config, handle *sql.DB) *httptestServerBundle {
	t.Helper()
	// Existing behavior tests explicitly allow external processing. Policy tests
	// remove this fixture value to exercise the production ask-by-default mode.
	if _, err := handle.Exec(`INSERT OR IGNORE INTO app_state(key,value_json,updated_at) VALUES('processing.policy.v1','{"revision":1,"library":"allow","documents":{},"projects":{}}','')`); err != nil {
		t.Fatal(err)
	}
	frontend := httptest.NewServer(New(cfg, handle).Handler())
	bundle := &httptestServerBundle{frontend: frontend, token: cfg.Token, cfg: cfg, handle: handle}
	t.Cleanup(func() {
		frontend.Close()
		_ = handle.Close()
		// Windows 上 SQLite 的 WAL/SHM 偶尔比连接晚一步释放，会让 t.TempDir 的
		// RemoveAll 偶发失败；这里带退避重试地把整棵临时目录收掉（本函数的 cleanup
		// 先于 TempDir 的 cleanup 执行），避免把测试抖动带到整条测试链。
		deadline := time.Now().Add(3 * time.Second)
		for {
			for _, suffix := range []string{"", "-wal", "-shm"} {
				_ = os.Remove(cfg.DBPath() + suffix)
			}
			if err := os.RemoveAll(cfg.DataRoot); err == nil {
				return
			}
			if time.Now().After(deadline) {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	return bundle
}

// newTestServer 起一份真实 SQLite + 真实 handler，测试走 HTTP 而不是内部函数。
func newTestServer(t *testing.T, tune func(*config.Config)) (*httptest.Server, *sql.DB, config.Config) {
	t.Helper()
	cfg := defaultTestConfig(t.TempDir())
	if tune != nil {
		tune(&cfg)
	}
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	bundle := serve(t, cfg, handle)
	return bundle.frontend, handle, cfg
}

func do(t *testing.T, frontend *httptest.Server, method, path, token string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, frontend.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := frontend.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s 请求失败: %v", method, path, err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

func decode(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("响应不是 JSON（%d）: %s", res.StatusCode, string(body))
	}
	return payload
}

// latestSchemaVersion 取内嵌迁移的真实最高版本号。
//
// 这里刻意不写字面量：写死数字会让「加一次迁移」就等于「测试失败一次」，
// 而失败信息只说「内容异常」，看的人会以为是功能坏了（真发生过）。
func latestSchemaVersion(t *testing.T) int {
	t.Helper()
	version, err := db.LatestVersion()
	if err != nil {
		t.Fatalf("读取迁移版本号失败: %v", err)
	}
	return version
}

func TestHealthzNeedsNoToken(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	res := do(t, frontend, http.MethodGet, "/healthz", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("healthz 应公开可访问，实际 %d", res.StatusCode)
	}
	payload := decode(t, res)
	if payload["ok"] != true || payload["schemaVersion"] != float64(latestSchemaVersion(t)) {
		t.Fatalf("healthz 内容异常: %v", payload)
	}
}

func TestProtectedRoutesRejectMissingAndWrongToken(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	for _, path := range []string{"/v1/meta", "/v1/documents"} {
		if res := do(t, frontend, http.MethodGet, path, ""); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s 无 token 应 401，实际 %d", path, res.StatusCode)
		}
		wrong := testToken[:len(testToken)-1] + "0"
		res := do(t, frontend, http.MethodGet, path, wrong)
		if res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s 错误 token 应 401，实际 %d", path, res.StatusCode)
		}
		if www := res.Header.Get("WWW-Authenticate"); www != "Bearer" {
			t.Fatalf("应带 WWW-Authenticate，实际 %q", www)
		}
	}
}

func TestMetaWithToken(t *testing.T) {
	frontend, _, cfg := newTestServer(t, nil)
	res := do(t, frontend, http.MethodGet, "/v1/meta", testToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", res.StatusCode)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("/v1 必须 no-store，实际 %q", cc)
	}
	if sn := res.Header.Get("X-Content-Type-Options"); sn != "nosniff" {
		t.Fatalf("应带 nosniff，实际 %q", sn)
	}
	payload := decode(t, res)
	if payload["app"] != "cbct-reading-v2" {
		t.Fatalf("meta.app 异常: %v", payload)
	}
	if payload["dataRoot"] != cfg.DataRoot {
		t.Fatalf("meta.dataRoot 应为 %v，实际 %v", cfg.DataRoot, payload["dataRoot"])
	}
	if payload["dbPath"] != cfg.DBPath() {
		t.Fatalf("meta.dbPath 异常: %v", payload["dbPath"])
	}
	if payload["schemaVersion"] != float64(latestSchemaVersion(t)) || payload["documentsTotal"] != float64(0) {
		t.Fatalf("meta 计数异常: %v", payload)
	}
	if started, _ := payload["startedAt"].(string); started == "" {
		t.Fatal("meta.startedAt 不应为空")
	}
	// 启动器靠 build 判断后端是否过期：字段缺失或恒为空都会让「重启到新构建」失效。
	build, _ := payload["build"].(string)
	if len(build) != 64 {
		t.Fatalf("meta.build 应是 64 位十六进制指纹，实际 %q", build)
	}
	if pid, _ := payload["pid"].(float64); pid != float64(os.Getpid()) {
		t.Fatalf("meta.pid 应是当前进程号 %d，实际 %v", os.Getpid(), payload["pid"])
	}
}

func TestBearerSchemeIsCaseInsensitive(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	req, err := http.NewRequest(http.MethodGet, frontend.URL+"/v1/meta", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "bearer "+testToken)
	res, err := frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("scheme 大小写不应影响鉴权，实际 %d", res.StatusCode)
	}
}

func TestDocumentsEmptyIsArrayNotNull(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	payload := decode(t, do(t, frontend, http.MethodGet, "/v1/documents", testToken))
	list, ok := payload["documents"].([]any)
	if !ok {
		t.Fatalf("documents 应为数组而不是 null，实际 %T", payload["documents"])
	}
	if len(list) != 0 || payload["total"] != float64(0) {
		t.Fatalf("应为空数组且 total=0，实际 %v", payload)
	}
}

func TestDocumentsOrderFieldsAndAuthorFallback(t *testing.T) {
	frontend, handle, _ := newTestServer(t, nil)
	seed := []struct {
		id, status, added, authors string
		year                       any
	}{
		{"d-queue-old", "queue", "2026-01-01T00:00:00Z", `["A","B"]`, 2025},
		{"d-reading", "reading", "2026-09-09T00:00:00Z", `["C"]`, nil},
		{"d-queue-new", "queue", "2026-08-01T00:00:00Z", `not-json`, 2026},
		{"d-done", "done", "2026-10-10T00:00:00Z", `null`, nil},
	}
	for _, row := range seed {
		if _, err := handle.Exec(
			`INSERT INTO documents(id, key, title, authors, year, status, added_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`,
			row.id, row.id, row.id, row.authors, row.year, row.status, row.added, row.added); err != nil {
			t.Fatalf("插入 %s 失败: %v", row.id, err)
		}
	}
	for id, state := range map[string]string{
		"d-reading": `{"motivation":{"value":"one section"}}`,
		"d-done":    `{"motivation":{"value":"1"},"method":{"value":"2"},"experiment":{"value":"3"},"results":{"value":"4"},"reproduction":{"value":"5"}}`,
	} {
		if _, err := handle.Exec(`INSERT INTO readings(document_id, value_json, updated_at) VALUES(?,?,?)`, id, state, "now"); err != nil {
			t.Fatalf("插入 %s 精读状态失败: %v", id, err)
		}
	}

	payload := decode(t, do(t, frontend, http.MethodGet, "/v1/documents", testToken))
	list := payload["documents"].([]any)
	if len(list) != 4 || payload["total"] != float64(4) {
		t.Fatalf("应有 4 篇，实际 %v", payload["total"])
	}
	got := make([]string, 0, len(list))
	for _, raw := range list {
		got = append(got, raw.(map[string]any)["id"].(string))
	}
	// reading 最前，done 最后，其余按 added_at 倒序。
	want := []string{"d-reading", "d-queue-new", "d-queue-old", "d-done"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("排序应为 %v，实际 %v", want, got)
		}
	}

	reading := list[0].(map[string]any)
	if reading["year"] != nil {
		t.Fatalf("未填年份应序列化为 null，实际 %v", reading["year"])
	}
	if reading["key"] != "d-reading" || reading["status"] != "reading" {
		t.Fatalf("字段映射异常: %v", reading)
	}
	for _, index := range []int{1, 3} {
		authors, ok := list[index].(map[string]any)["authors"].([]any)
		if !ok || len(authors) != 0 {
			t.Fatalf("非法/缺失 authors JSON 应降级为空数组，实际 %v", list[index].(map[string]any)["authors"])
		}
	}
	first := list[2].(map[string]any)
	authors := first["authors"].([]any)
	if len(authors) != 2 || authors[0] != "A" {
		t.Fatalf("authors 解析异常: %v", first["authors"])
	}
	if year, _ := first["year"].(float64); year != 2025 {
		t.Fatalf("year 应为 2025，实际 %v", first["year"])
	}
}

func TestUnknownStatusFilterRejected(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	if res := do(t, frontend, http.MethodGet, "/v1/documents?status=nope", testToken); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知 status 应 400，实际 %d", res.StatusCode)
	}
	if res := do(t, frontend, http.MethodGet, "/v1/documents?status=queue", testToken); res.StatusCode != http.StatusOK {
		t.Fatalf("合法 status 筛选应 200，实际 %d", res.StatusCode)
	}
}

func TestUnknownRouteAndMethod(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	if res := do(t, frontend, http.MethodGet, "/v1/nope", testToken); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知 /v1 路径在无静态目录时应 404，实际 %d", res.StatusCode)
	}
	if res := do(t, frontend, http.MethodPost, "/healthz", ""); res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("healthz POST 应 405，实际 %d", res.StatusCode)
	}
	// 方法不匹配时是 404 而不是 405：ServeMux 里 "/" 兜底模式也算命中，Go 因此不会合成 405。
	// 对本地 API 来说两者都不泄露信息，这里把实际行为钉住，避免将来误改。
	if res := do(t, frontend, http.MethodPost, "/v1/documents", testToken); res.StatusCode != http.StatusNotFound {
		t.Fatalf("documents POST 应落到兜底 404，实际 %d", res.StatusCode)
	}
}

func TestNonLoopbackHostRejected(t *testing.T) {
	frontend, _, _ := newTestServer(t, nil)
	for _, host := range []string{"evil.example.com", "10.0.0.5:45123", "attacker.test:80"} {
		req, err := http.NewRequest(http.MethodGet, frontend.URL+"/healthz", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		res, err := frontend.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Fatalf("Host %q 应被拒绝，实际 %d", host, res.StatusCode)
		}
	}
}

func TestStaticServesAssetsAndFallsBackToIndex(t *testing.T) {
	staticDir := t.TempDir()
	index := "<html>workspace</html>"
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte(index), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(staticDir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staticDir, "assets", "app.js"), []byte("console.log(1)"), 0o600); err != nil {
		t.Fatal(err)
	}

	frontend, _, _ := newTestServer(t, func(cfg *config.Config) { cfg.StaticDir = staticDir })
	for path, want := range map[string]string{
		"/":              index,
		"/workspace/abc": index,
		"/assets/app.js": "console.log(1)",
	} {
		res, err := frontend.Client().Get(frontend.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK || string(body) != want {
			t.Fatalf("%s 期望 %q，得到 %d %q", path, want, res.StatusCode, string(body))
		}
	}

	// HTML 响应必须带服务端 CSP（生产态加固，dev 态由 Vite 提供页面不受影响）。
	res, err := frontend.Client().Get(frontend.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	csp := res.Header.Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'"} {
		if !strings.Contains(csp, want) {
			t.Fatalf("CSP 应含 %q，实际 %q", want, csp)
		}
	}

	// 带扩展名的缺失资源不能被 index.html 兜底掩盖。
	res, err = frontend.Client().Get(frontend.URL + "/assets/missing.css")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("缺失资源应 404，实际 %d", res.StatusCode)
	}
}

func TestStaticGuardRejectsParentTraversal(t *testing.T) {
	staticDir := t.TempDir()
	parent := filepath.Dir(staticDir)
	secretPath := filepath.Join(parent, "secret-"+filepath.Base(staticDir)+".txt")
	if err := os.WriteFile(secretPath, []byte("do not read"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(secretPath) })

	cfg := config.Config{DataRoot: staticDir, Host: "127.0.0.1", Token: testToken, StaticDir: staticDir}
	server := New(cfg, nil)
	for _, path := range []string{"/../" + filepath.Base(secretPath), "/../../" + filepath.Base(secretPath)} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.URL.Path = path
		rec := httptest.NewRecorder()
		server.handleStatic(rec, req)
		if rec.Code == http.StatusOK {
			t.Fatalf("目录穿越 %q 必须被拒绝，实际返回 %q", path, rec.Body.String())
		}
	}
}

func TestAllowedHostUnit(t *testing.T) {
	cases := []struct {
		host  string
		bound string
		want  bool
	}{
		{"127.0.0.1:45123", "127.0.0.1", true},
		{"localhost", "127.0.0.1", true},
		{"LOCALHOST:80", "127.0.0.1", true},
		{"localhost.", "127.0.0.1", true},
		{"[::1]:8080", "127.0.0.1", true},
		{"::1", "127.0.0.1", true},
		{"::1", "::1", true},
		{"0.0.0.0", "127.0.0.1", false},
		{"192.168.0.9", "127.0.0.1", false},
		{"", "127.0.0.1", false},
	}
	for _, c := range cases {
		if got := allowedHost(c.host, c.bound); got != c.want {
			t.Fatalf("allowedHost(%q, %q) = %v，期望 %v", c.host, c.bound, got, c.want)
		}
	}
}

func TestBearerTokenExtraction(t *testing.T) {
	cases := []struct{ header, want string }{
		{"", ""},
		{"Token abc", ""},
		{"Bearer", ""},
		{"Bearer ", ""},
		{"Bearer abc", "abc"},
		{"bearer abc", "abc"},
		{"Bearer  abc ", "abc"},
	}
	for _, c := range cases {
		if got := bearerToken(c.header); got != c.want {
			t.Fatalf("bearerToken(%q) = %q，期望 %q", c.header, got, c.want)
		}
	}
}
