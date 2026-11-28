package httpapi

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLatexAgentModeDirectlyModifiesAndCreatesMultipleFilesWithSnapshot(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	const initialMain = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n"
	saveBody, _ := json.Marshal(map[string]string{"content": initialMain, "revision": ""})
	res, payload := post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path=main.tex", string(saveBody))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("write main.tex: %d %v", res.StatusCode, payload)
	}

	const updatedMain = "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}\n"
	const newMethodFile = "\\section{Method}\nOur agent workflow updates files directly.\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req map[string]any
		_ = json.Unmarshal(raw, &req)
		respJSON, _ := json.Marshal(map[string]any{
			"thinking": "先拆分方法章节到 sections/method.tex，再在 main.tex 中通过 \\input 引入",
			"plan":     []string{"扫描 main.tex 结构", "新建 sections/method.tex", "更新 main.tex 引用"},
			"reply":    "已为你新建 `sections/method.tex` 并更新 `main.tex`。",
			"summary":  "拆分 Method 章节并更新主文档",
			"edits": []map[string]string{
				{
					"filePath": "main.tex",
					"summary":  "引入 sections/method",
					"content":  updatedMain,
				},
				{
					"filePath": "sections/method.tex",
					"summary":  "新建 Method 章节",
					"content":  newMethodFile,
				},
			},
		})
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": string(respJSON)}}},
		})
	}))
	defer upstream.Close()
	writeAIConfig(t, bundle, upstream.URL)

	reqBody, _ := json.Marshal(map[string]any{
		"projectId":    id,
		"projectTitle": "Agent Paper",
		"filePath":     "main.tex",
		"source":       initialMain,
		"agentMode":    "agent",
		"question":     "@章节撰写 新建 sections/method.tex 并在 main.tex 里引入",
	})
	req, _ := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/ai/latex-chat", strings.NewReader(string(reqBody)))
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var (
		seenTaskPlans int
		seenToolCalls int
		doneEvent     struct {
			Done        bool                  `json:"done"`
			Error       string                `json:"error"`
			Text        string                `json:"text"`
			AutoApplied bool                  `json:"autoApplied"`
			SnapshotID  string                `json:"snapshotId"`
			Edits       []latexAIEditResponse `json:"edits"`
		}
	)
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		rawFrame := strings.TrimPrefix(line, "data: ")
		var generic map[string]any
		if err := json.Unmarshal([]byte(rawFrame), &generic); err != nil {
			t.Fatal(err)
		}
		if _, ok := generic["taskPlan"]; ok {
			seenTaskPlans++
		}
		if _, ok := generic["toolCall"]; ok {
			seenToolCalls++
		}
		if generic["done"] == true || generic["error"] != nil {
			_ = json.Unmarshal([]byte(rawFrame), &doneEvent)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !doneEvent.Done || doneEvent.Error != "" {
		t.Fatalf("expected agent workflow completion, got %+v", doneEvent)
	}
	if !doneEvent.AutoApplied || doneEvent.SnapshotID == "" {
		t.Fatalf("expected autoApplied=true and non-empty snapshotId, got %+v", doneEvent)
	}
	if seenTaskPlans == 0 || seenToolCalls < 3 {
		t.Fatalf("expected taskPlan and toolCall frames, got plans=%d tools=%d", seenTaskPlans, seenToolCalls)
	}
	if len(doneEvent.Edits) != 2 {
		t.Fatalf("expected 2 applied edits, got %d", len(doneEvent.Edits))
	}

	// Verify both files were written to disk
	if got := readProjectFile(t, bundle, id, "main.tex"); got != updatedMain {
		t.Fatalf("main.tex not updated on disk: %q", got)
	}
	if got := readProjectFile(t, bundle, id, "sections/method.tex"); got != newMethodFile {
		t.Fatalf("sections/method.tex not created on disk: %q", got)
	}

	// Verify 1-click rollback via the auto-created snapshot restores main.tex and removes sections/method.tex
	res, rollbackReport := post(t, bundle, http.MethodPost, "/v1/latex/snapshots/"+doneEvent.SnapshotID, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("rollback failed: %d %v", res.StatusCode, rollbackReport)
	}
	if got := readProjectFile(t, bundle, id, "main.tex"); got != initialMain {
		t.Fatalf("rollback did not restore main.tex: %q", got)
	}
}

func TestLatexAgentMultiTurnToolLoopReadsAndSearchesBeforeEditing(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	const initialMain = "\\documentclass{article}\n\\begin{document}\nOLD_TOKEN\n\\end{document}\n"
	saveBody, _ := json.Marshal(map[string]string{"content": initialMain, "revision": ""})
	res, _ := post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path=main.tex", string(saveBody))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("write main.tex failed")
	}

	callCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		var resp map[string]any
		if callCount == 1 {
			resp = map[string]any{
				"thinking": "先全局检索 OLD_TOKEN 在哪个文件",
				"action":   "tool",
				"tool":     "search_project",
				"query":    "OLD_TOKEN",
			}
		} else {
			resp = map[string]any{
				"thinking": "已定位 main.tex 第 3 行，执行替换",
				"reply":    "已通过工具检索定位并修改 main.tex。",
				"summary":  "替换 OLD_TOKEN 为 NEW_TOKEN",
				"filePath": "main.tex",
				"content":  "\\documentclass{article}\n\\begin{document}\nNEW_TOKEN\n\\end{document}\n",
			}
		}
		encoded, _ := json.Marshal(resp)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": string(encoded)}}},
		})
	}))
	defer upstream.Close()
	writeAIConfig(t, bundle, upstream.URL)

	reqBody, _ := json.Marshal(map[string]any{
		"projectId":    id,
		"projectTitle": "MultiTurn Paper",
		"filePath":     "main.tex",
		"source":       initialMain,
		"agentMode":    "agent",
		"question":     "找到 OLD_TOKEN 并替换为 NEW_TOKEN",
	})
	req, _ := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/ai/latex-chat", strings.NewReader(string(reqBody)))
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var seenSearchTool bool
	var done bool
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var frame map[string]any
		_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame)
		if tc, ok := frame["toolCall"].(map[string]any); ok && tc["toolName"] == "search_project" {
			seenSearchTool = true
		}
		if frame["done"] == true {
			done = true
		}
	}
	if !done || !seenSearchTool || callCount != 2 {
		t.Fatalf("expected 2-round tool loop with search_project, got calls=%d seenSearch=%v done=%v", callCount, seenSearchTool, done)
	}
	if got := readProjectFile(t, bundle, id, "main.tex"); !strings.Contains(got, "NEW_TOKEN") {
		t.Fatalf("expected NEW_TOKEN written to disk, got %q", got)
	}
}

func TestPaperAIChatEmitsAgentWorkflowFrames(t *testing.T) {
	bundle := newLatexBundle(t)
	if _, err := bundle.handle.Exec(`INSERT INTO documents(id, key, title) VALUES(?, ?, ?)`,
		"paper-agent-1", "paper-agent-1", "Test Paper"); err != nil {
		t.Fatal(err)
	}
	if _, err := bundle.handle.Exec(`INSERT INTO document_pages(document_id, page, text, hash) VALUES(?, ?, ?, 'h1')`,
		"paper-agent-1", 1, "We propose Method Alpha with Equation (1) for CBCT reconstruction."); err != nil {
		t.Fatal(err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"delta":{"content":"本文在第 1 页提出 Method Alpha (Page 1)。"}}]}`+"\n\n")
		_, _ = io.WriteString(w, "data: "+`{"choices":[{"finish_reason":"stop","delta":{}}]}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	writeAIConfig(t, bundle, upstream.URL)

	reqBody, _ := json.Marshal(map[string]any{
		"key":      "paper-agent-1",
		"question": "@方法拆解 解释核心方法",
	})
	req, _ := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/ai/chat", strings.NewReader(string(reqBody)))
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	var (
		seenPlan       bool
		seenSearchTool bool
		seenVerifyTool bool
		seenDone       bool
	)
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var frame map[string]any
		_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame)
		if _, ok := frame["taskPlan"]; ok {
			seenPlan = true
		}
		if tc, ok := frame["toolCall"].(map[string]any); ok {
			if tc["toolName"] == "search_paper_pages" {
				seenSearchTool = true
			}
			if tc["toolName"] == "verify_citations" {
				seenVerifyTool = true
			}
		}
		if frame["done"] == true {
			seenDone = true
		}
	}
	if !seenDone || !seenPlan || !seenSearchTool || !seenVerifyTool {
		t.Fatalf("expected paper agent frames, got done=%v plan=%v search=%v verify=%v", seenDone, seenPlan, seenSearchTool, seenVerifyTool)
	}
}
