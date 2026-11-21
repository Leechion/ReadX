package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestInkAnnotationCreateAndValidate(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,format) VALUES('doc-ink','doc-ink','Ink Paper','pdf')`); err != nil {
		t.Fatal(err)
	}

	payload := map[string]any{
		"page":  2,
		"kind":  "ink",
		"color": "sky",
		"note":  "重点公式推导",
		"locator": map[string]any{
			"kind": "pdf",
			"strokes": []any{
				map[string]any{
					"width": 0.004,
					"points": []any{
						map[string]any{"x": 0.1, "y": 0.2},
						map[string]any{"x": 0.3, "y": 0.25},
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(payload)
	req, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/annotations/doc-ink", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created Annotation
	if err := decodeResponse(res, &created); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", res.StatusCode)
	}
	if created.Kind != "ink" || created.Locator == nil || len(created.Locator.Strokes) != 1 || len(created.Locator.Rects) != 1 {
		t.Fatalf("unexpected ink annotation: %+v", created)
	}

	// Out-of-bounds stroke point must be rejected.
	badPayload := map[string]any{
		"page": 1,
		"kind": "ink",
		"locator": map[string]any{
			"kind": "pdf",
			"strokes": []any{
				map[string]any{"points": []any{map[string]any{"x": 1.5, "y": 0.2}, map[string]any{"x": 0.3, "y": 0.2}}},
			},
		},
	}
	badRaw, _ := json.Marshal(badPayload)
	badReq, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/annotations/doc-ink", bytes.NewReader(badRaw))
	badReq.Header.Set("Authorization", "Bearer "+cfg.Token)
	badReq.Header.Set("Content-Type", "application/json")
	badRes, err := http.DefaultClient.Do(badReq)
	if err != nil {
		t.Fatal(err)
	}
	badRes.Body.Close()
	if badRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for out-of-bounds ink stroke, got %d", badRes.StatusCode)
	}
}

func TestFlashcardsBuildReviewAndExport(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`
		INSERT INTO glossary_terms(source,target,level,note) VALUES('CBCT','锥形束CT','must','牙科成像');
		INSERT INTO documents(id,key,title,format) VALUES('doc-fc','doc-fc','Flashcard Paper','pdf');
		INSERT INTO annotations(id,document_id,page,kind,quote,note,color,tags) VALUES('a-fc','doc-fc',1,'highlight','Voxel size 0.2mm','分辨率关键参数','amber','[]');
	`); err != nil {
		t.Fatal(err)
	}

	res := do(t, frontend, http.MethodGet, "/v1/flashcards", cfg.Token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	var list struct {
		Cards    []Flashcard `json:"cards"`
		Total    int         `json:"total"`
		DueCount int         `json:"dueCount"`
	}
	if err := decodeResponse(res, &list); err != nil {
		t.Fatal(err)
	}
	if list.Total < 2 || list.DueCount != list.Total {
		t.Fatalf("expected >=2 due cards, got %+v", list)
	}

	// Review the first card with quality=2 (掌握 -> interval 1 day, not due anymore).
	targetID := list.Cards[0].ID
	revBody, _ := json.Marshal(map[string]any{"cardId": targetID, "quality": 2})
	req, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/flashcards/review", bytes.NewReader(revBody))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	revRes, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	revRes.Body.Close()
	if revRes.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on review, got %d", revRes.StatusCode)
	}

	// Verify dueCount dropped by 1.
	res = do(t, frontend, http.MethodGet, "/v1/flashcards", cfg.Token)
	var after struct {
		Total    int `json:"total"`
		DueCount int `json:"dueCount"`
	}
	_ = decodeResponse(res, &after)
	if after.DueCount != list.Total-1 {
		t.Fatalf("expected dueCount=%d after review, got %d", list.Total-1, after.DueCount)
	}

	// Verify Anki TSV export.
	expRes := do(t, frontend, http.MethodGet, "/v1/flashcards/export?format=anki", cfg.Token)
	expBytes, _ := io.ReadAll(expRes.Body)
	expRes.Body.Close()
	if expRes.StatusCode != http.StatusOK || !strings.Contains(string(expBytes), "CBCT") || !strings.Contains(string(expBytes), "锥形束CT") {
		t.Fatalf("unexpected Anki export: %d %s", expRes.StatusCode, string(expBytes))
	}

	// Verify SM-2 progression.
	s1 := nextSM2Schedule(flashcardSchedule{}, 2, time.Now().UTC())
	s2 := nextSM2Schedule(s1, 2, time.Now().UTC())
	if s1.IntervalDays != 1 || s2.IntervalDays != 6 {
		t.Fatalf("unexpected SM-2 progression: s1=%+v s2=%+v", s1, s2)
	}
}

func TestOCRRegionRejectsInvalidPNG(t *testing.T) {
	frontend, _, cfg := newTestServer(t, nil)
	req, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/ai/ocr-region", strings.NewReader(`{"imageBase64":"not-a-png","target":"formula"}`))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid PNG, got %d", res.StatusCode)
	}
}
