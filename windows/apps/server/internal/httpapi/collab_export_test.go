package httpapi

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestExportMarkdownVaultZip(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)

	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,authors,year,venue,doi,format) VALUES('doc-vault','doc-vault','Sparse CBCT Reconstruction','["Alice","Bob"]',2025,'MICCAI','10.1000/vault','pdf')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO annotations(id,document_id,page,quote,note,color,kind,created_at,updated_at,locator_json) VALUES('ann-v1','doc-vault',4,'Projection weights','Key derivation on p.4','amber','highlight','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{}')`); err != nil {
		t.Fatal(err)
	}
	readingsJSON := `{"motivation":{"kind":"motivation","value":"Solve sparse view artifacts"}}`
	if _, err := handle.Exec(`INSERT INTO readings(document_id,value_json,updated_at) VALUES('doc-vault',?,'2026-01-01T00:00:00Z')`, readingsJSON); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodGet, frontend.URL+"/v1/export/markdown-vault", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	rawZip, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(rawZip), int64(len(rawZip)))
	if err != nil {
		t.Fatalf("invalid zip archive: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, openErr := f.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		data, readErr := io.ReadAll(rc)
		rc.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		files[f.Name] = string(data)
	}
	moc, ok := files["_MOC_文献总览.md"]
	if !ok || !strings.Contains(moc, "Sparse CBCT Reconstruction") {
		t.Fatalf("missing or incomplete _MOC_文献总览.md: %q", moc)
	}
	foundPaper := false
	for name, content := range files {
		if strings.HasPrefix(name, "papers/") && strings.HasSuffix(name, ".md") {
			foundPaper = true
			if !strings.Contains(content, "cite_key:") || !strings.Contains(content, "Solve sparse view artifacts") || !strings.Contains(content, "第 4 页") {
				t.Fatalf("paper note %s missing expected sections:\n%s", name, content)
			}
		}
	}
	if !foundPaper {
		t.Fatalf("no paper markdown note found in archive")
	}
}

func TestSyncConflictsListAndResolve(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)

	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,format) VALUES('doc-sync','doc-sync','Sync Conflict Paper','pdf')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO annotations(id,document_id,page,quote,note,color,tags,kind,created_at,updated_at,locator_json) VALUES
		('n1','doc-sync',1,'Quote A','Desktop note','amber','[]','highlight','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','{}'),
		('n1~sync-abcdef123456','doc-sync',1,'Quote A','Laptop note','sky','[]','highlight','2026-01-01T00:00:00Z','2026-01-03T00:00:00Z','{}')`); err != nil {
		t.Fatal(err)
	}

	req, _ := http.NewRequest(http.MethodGet, frontend.URL+"/v1/sync/conflicts", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var listPayload struct {
		Total     int                `json:"total"`
		Conflicts []syncConflictPair `json:"conflicts"`
	}
	if err := decodeResponse(res, &listPayload); err != nil {
		t.Fatal(err)
	}
	if listPayload.Total != 1 || listPayload.Conflicts[0].Original == nil || listPayload.Conflicts[0].Original.Note != "Desktop note" {
		t.Fatalf("unexpected sync conflicts list: %+v", listPayload)
	}

	resolveBody, _ := json.Marshal(map[string]any{
		"conflictId": "n1~sync-abcdef123456",
		"originalId": "n1",
		"decision":   "custom",
		"mergedNote": "Desktop + Laptop merged note",
	})
	resReq, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/sync/conflicts/resolve", bytes.NewReader(resolveBody))
	resReq.Header.Set("Authorization", "Bearer "+cfg.Token)
	resReq.Header.Set("Content-Type", "application/json")
	res2, err := http.DefaultClient.Do(resReq)
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 resolving conflict, got %d", res2.StatusCode)
	}

	var noteAfter string
	var remainConflicts int
	if err := handle.QueryRow(`SELECT note FROM annotations WHERE id = 'n1'`).Scan(&noteAfter); err != nil {
		t.Fatal(err)
	}
	if noteAfter != "Desktop + Laptop merged note" {
		t.Fatalf("expected merged note on n1, got %q", noteAfter)
	}
	if err := handle.QueryRow(`SELECT COUNT(1) FROM annotations WHERE id LIKE '%~sync-%'`).Scan(&remainConflicts); err != nil {
		t.Fatal(err)
	}
	if remainConflicts != 0 {
		t.Fatalf("expected 0 remaining conflict notes, got %d", remainConflicts)
	}
}

func TestLANCompanionStartAuthAndStop(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,format) VALUES('doc-lan','doc-lan','LAN Companion Paper','pdf')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO annotations(id,document_id,page,quote,note,color,tags,kind,created_at,updated_at,locator_json) VALUES('n-lan','doc-lan',2,'Sample quote','Tablet view note','amber','[]','highlight','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{}')`); err != nil {
		t.Fatal(err)
	}

	payload, _ := json.Marshal(map[string]any{
		"keys":         []string{"doc-lan"},
		"includeNotes": true,
	})
	req, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/shares/lan", bytes.NewReader(payload))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var started lanShareStatus
	if err := decodeResponse(res, &started); err != nil {
		t.Fatal(err)
	}
	if !started.Active || started.Port == 0 || started.Token == "" || len(started.URLs) == 0 {
		t.Fatalf("unexpected lan share status: %+v", started)
	}
	defer func() {
		stopReq, _ := http.NewRequest(http.MethodDelete, frontend.URL+"/v1/shares/lan", nil)
		stopReq.Header.Set("Authorization", "Bearer "+cfg.Token)
		if stopRes, stopErr := http.DefaultClient.Do(stopReq); stopErr == nil {
			stopRes.Body.Close()
		}
	}()

	targetURL := started.URLs[0]
	noTokenURL := strings.SplitN(targetURL, "?", 2)[0]

	unauthRes, err := http.Get(noTokenURL)
	if err != nil {
		t.Fatal(err)
	}
	unauthRes.Body.Close()
	if unauthRes.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", unauthRes.StatusCode)
	}

	okRes, err := http.Get(targetURL)
	if err != nil {
		t.Fatal(err)
	}
	htmlBytes, _ := io.ReadAll(okRes.Body)
	okRes.Body.Close()
	if okRes.StatusCode != http.StatusOK || !strings.Contains(string(htmlBytes), "ReadX 只读分享") {
		t.Fatalf("expected 200 readonly share HTML, got %d", okRes.StatusCode)
	}

	apiProbe, err := http.Get(noTokenURL + "v1/documents?token=" + started.Token)
	if err != nil {
		t.Fatal(err)
	}
	apiProbe.Body.Close()
	if apiProbe.StatusCode != http.StatusNotFound {
		t.Fatalf("companion listener must return 404 for non-root paths, got %d", apiProbe.StatusCode)
	}
}
