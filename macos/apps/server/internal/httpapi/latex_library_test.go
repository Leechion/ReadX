package httpapi

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLatexCiteLibraryAndDedupe(t *testing.T) {
	bundle := newLatexBundle(t)
	projectID := createLatexProject(t, bundle)

	ctx := context.Background()
	_, err := bundle.handle.ExecContext(ctx, `
		INSERT INTO documents(id, key, title, authors, year, venue, doi, url, status, added_at, updated_at)
		VALUES
			('doc-1', 'doc-1', 'Vision Transformer for Dental CBCT', '["Alice Smith","Bob Lee"]', 2024, 'MICCAI 2024', '10.1000/cbct.1', '', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
			('doc-2', 'doc-2', 'Cone Beam Reconstruction Notes', '["Carol Wu"]', 2023, 'IEEE Transactions on Medical Imaging', '', '', 'reading', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')
	`)
	if err != nil {
		t.Fatal(err)
	}

	res, payload := post(t, bundle, http.MethodPost, "/v1/latex/projects/"+projectID+"/cite-library",
		`{"keys":["doc-1","doc-2"]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("cite-library failed: %d %v", res.StatusCode, payload)
	}
	if payload["bibFile"] != "references.bib" {
		t.Fatalf("expected references.bib, got %v", payload["bibFile"])
	}
	keysRaw, _ := payload["keys"].([]any)
	if len(keysRaw) != 2 || keysRaw[0] != "smith2024vision" || keysRaw[1] != "wu2023cone" {
		t.Fatalf("unexpected cite keys: %v", keysRaw)
	}

	bib := readProjectFile(t, bundle, projectID, "references.bib")
	if !strings.Contains(bib, "@inproceedings{smith2024vision,") || !strings.Contains(bib, "@article{wu2023cone,") {
		t.Fatalf("unexpected bib content:\n%s", bib)
	}

	// Re-citing doc-1 should detect the existing entry by DOI/title and avoid duplicating it.
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+projectID+"/cite-library",
		`{"keys":["doc-1"]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("re-cite failed: %d %v", res.StatusCode, payload)
	}
	alreadyRaw, _ := payload["alreadyPresent"].([]any)
	insertedRaw, _ := payload["inserted"].([]any)
	if len(alreadyPresentList(alreadyRaw)) != 1 || len(insertedRaw) != 0 {
		t.Fatalf("expected doc-1 in alreadyPresent without insertion, got %v", payload)
	}
	if strings.Count(readProjectFile(t, bundle, projectID, "references.bib"), "smith2024vision") != 1 {
		t.Fatal("duplicate entry was written to references.bib")
	}

	// Reject non-.bib or unsafe paths.
	res, _ = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+projectID+"/cite-library",
		`{"keys":["doc-1"],"bibFile":"../escape.bib"}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for unsafe path, got %d", res.StatusCode)
	}
}

func TestLoadLibraryReferenceContext(t *testing.T) {
	bundle := newLatexBundle(t)
	projectID := createLatexProject(t, bundle)

	ctx := context.Background()
	readingJSON, _ := json.Marshal(map[string]any{
		"motivation": map[string]any{
			"narrative": "解决低剂量 CBCT 伪影问题",
		},
		"experiment": map[string]any{
			"value": `{"dataset":"Dental-500","metric":"PSNR 34.2 dB"}`,
		},
	})
	_, err := bundle.handle.ExecContext(ctx, `
		INSERT INTO documents(id, key, title, authors, year, venue, doi, url, status, added_at, updated_at)
		VALUES ('doc-ref', 'doc-ref', 'Sparse CBCT Denoising', '["Jane Doe"]', 2025, 'CVPR 2025', '', '', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
		INSERT INTO readings(document_id, value_json, updated_at) VALUES ('doc-ref', ?, '2026-01-01T00:00:00Z');
		INSERT INTO annotations(id, document_id, page, kind, quote, note, color, tags, created_at, updated_at)
		VALUES ('an-1', 'doc-ref', 3, 'margin', 'PSNR improved by 2.1 dB', '重点对比数据', 'amber', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
	`, string(readingJSON))
	if err != nil {
		t.Fatal(err)
	}

	srv := New(bundle.cfg, bundle.handle)
	contextText, count, err := srv.loadLibraryReferenceContext(ctx, projectID, []string{"doc-ref"})
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected count=1, got %d", count)
	}
	for _, want := range []string{`citeKey="doe2025sparse"`, "解决低剂量 CBCT 伪影问题", "Dental-500", "重点对比数据"} {
		if !strings.Contains(contextText, want) {
			t.Fatalf("expected %q in reference context:\n%s", want, contextText)
		}
	}
}

func TestLatexSyncTeXEndpointsOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	projectID := createLatexProject(t, bundle)

	srv := New(bundle.cfg, bundle.handle)
	srcDir, err := srv.latexService().SrcDir(projectID)
	if err != nil {
		t.Fatal(err)
	}
	buildID := "build-synctex-1"
	buildDir, err := srv.latexService().BuildDir(projectID, buildID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err = bundle.handle.ExecContext(context.Background(), `
		INSERT INTO latex_builds (id, project_id, revision, status, reason, engine, main_file, started_at, finished_at, exit_code, error_count, warning_count, log_path, pdf_path, message)
		VALUES (?, ?, 'rev1', 'succeeded', '', 'pdflatex', 'main.tex', '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 0, 0, 0, '', '', '')`,
		buildID, projectID)
	if err != nil {
		t.Fatal(err)
	}

	// Write a minimal valid synctex.gz in buildDir.
	const spPerPt = 65781.76
	raw := strings.Join([]string{
		"SyncTeX Version:1",
		"Input:1:" + filepath.Join(srcDir, "main.tex"),
		"Output:pdf",
		"Magnification:1000",
		"Unit:1",
		"X Offset:0",
		"Y Offset:0",
		"Content:",
		"{1",
		"(1,12:4736286,9867264:13156352,657818,131564",
		")",
		"}",
		"Postamble:",
	}, "\n")
	var gzBuf bytes.Buffer
	gz := gzip.NewWriter(&gzBuf)
	_, _ = gz.Write([]byte(raw))
	_ = gz.Close()
	if err := os.WriteFile(filepath.Join(buildDir, "main.synctex.gz"), gzBuf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	res, payload := post(t, bundle, http.MethodGet, "/v1/latex/builds/"+buildID+"/synctex/forward?file=main.tex&line=12", "")
	if res.StatusCode != http.StatusOK || payload["page"] != float64(1) {
		t.Fatalf("forward synctex failed: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodGet, "/v1/latex/builds/"+buildID+"/synctex/reverse?page=1&x=100&y=145", "")
	if res.StatusCode != http.StatusOK || payload["file"] != "main.tex" || payload["line"] != float64(12) {
		t.Fatalf("reverse synctex failed: %d %v", res.StatusCode, payload)
	}
	_ = spPerPt
}

func alreadyPresentList(items []any) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
