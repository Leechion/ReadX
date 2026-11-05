package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"cbctv2/server/internal/latex"
)

func TestLatexFileSaveAcceptsLargeEscapedContentAndRejectsOverflow(t *testing.T) {
	b := newLatexBundle(t)
	id := createLatexProject(t, b)
	endpoint := "/v1/latex/projects/" + id + "/file?path=main.tex"
	content := strings.Repeat(`\`, latex.MaxFileBytes)
	body, _ := json.Marshal(map[string]string{"content": content})
	res, payload := post(t, b, http.MethodPut, endpoint, string(body))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("8 MiB save failed: %d %v", res.StatusCode, payload)
	}
	if got := readProjectFile(t, b, id, "main.tex"); got != content {
		t.Fatal("saved content changed")
	}
	body, _ = json.Marshal(map[string]string{"content": content + "x"})
	res, payload = post(t, b, http.MethodPut, endpoint, string(body))
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("overflow must return 413: %d %v", res.StatusCode, payload)
	}
	if got := readProjectFile(t, b, id, "main.tex"); got != content {
		t.Fatal("rejected save modified original")
	}
}

func TestLeeObservationsDoNotCompleteConcurrentTranslationAndRender(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	s.beginImportJob("overlap", "paper", 2, nil)
	s.jobStage("overlap", "ocr", "running", "recognizing", 0, 2)
	s.jobStage("overlap", "translate", "running", "translating", 0, 2)
	s.jobStage("overlap", "render", "running", "rendering", 0, 2)
	for _, stage := range []string{"translation", "render"} {
		s.leeImportObservation("overlap", leeStageObservation{UserStage: stage, Detail: "in progress"})
		job, _ := s.loadImportJob(context.Background(), "overlap")
		if job.stage("ocr").Status != "done" {
			t.Fatal("OCR prerequisite should complete")
		}
		for _, key := range []string{"translate", "render"} {
			if current := job.stage(key); current.Status != "running" || current.FinishedAt != "" {
				t.Fatalf("%s observation completed concurrent stage: %+v", stage, current)
			}
		}
	}
}
