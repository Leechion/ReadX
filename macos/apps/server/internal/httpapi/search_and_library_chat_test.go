package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestSearchFTS5TermsAndCategoryFilter(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`
		INSERT INTO documents(id,key,title,year) VALUES
			('p1','p1','CBCT Transformer',2024),
			('p2','p2','CBCT Classical FDK',2020),
			('p3','p3','MRI Transformer',2024);
		INSERT INTO document_pages(document_id,page,text) VALUES
			('p1',1,'Vision transformer improves dental CBCT reconstruction.'),
			('p2',2,'Classical CBCT reconstruction without neural network.'),
			('p3',1,'Vision transformer for brain MRI.');
		INSERT INTO app_state(key,value_json) VALUES
			('documents.meta','{"p1":{"categories":["CBCT"]},"p2":{"categories":["CBCT"]},"p3":{"categories":["MRI"]}}');
	`); err != nil {
		t.Fatal(err)
	}

	// mode=terms matches pages containing both words in any order via FTS5.
	res := do(t, frontend, http.MethodGet, "/v1/search?q="+url.QueryEscape("CBCT transformer")+"&mode=terms", cfg.Token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	var payload searchPayload
	if err := decodeResponse(res, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Hits) != 1 || payload.Hits[0].Key != "p1" {
		t.Fatalf("expected only p1 for 'CBCT transformer', got %+v", payload.Hits)
	}

	// category filter limits hits to the chosen shelf.
	res = do(t, frontend, http.MethodGet, "/v1/search?q=transformer&mode=terms&category=MRI", cfg.Token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.StatusCode)
	}
	payload = searchPayload{}
	if err := decodeResponse(res, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Hits) != 1 || payload.Hits[0].Key != "p3" {
		t.Fatalf("expected only p3 in MRI shelf, got %+v", payload.Hits)
	}
}

func TestRetrieveLibraryEvidenceForRAG(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	srv := New(cfg, handle)
	ctx := context.Background()

	if _, err := handle.ExecContext(ctx, `
		INSERT INTO documents(id,key,title,year,venue) VALUES
			('d1','d1','Sparse View CBCT',2024,'MICCAI 2024'),
			('d2','d2','Metal Artifact Reduction',2023,'IEEE TMI'),
			('d3','d3','Trashed Paper',2021,'Workshop');
		INSERT INTO document_pages(document_id,page,text) VALUES
			('d1',4,'Our sparse view CBCT network achieves 35.1 dB PSNR on dental phantom.'),
			('d2',2,'Iterative metal artifact reduction reduces streak noise in CBCT.'),
			('d3',1,'Sparse view CBCT trashed note.');
		INSERT INTO app_state(key,value_json) VALUES
			('documents.meta','{"d1":{"categories":["CBCT"]},"d2":{"categories":["CBCT"]},"d3":{"deleted":true}}');
	`); err != nil {
		t.Fatal(err)
	}

	evidence, sources, err := srv.retrieveLibraryEvidence(ctx, "How does sparse view CBCT perform?", "all", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) == 0 {
		t.Fatal("expected retrieved sources")
	}
	for _, src := range sources {
		if src.Key == "d3" {
			t.Fatal("trashed document d3 must not appear in RAG evidence")
		}
	}
	if !strings.Contains(evidence, "35.1 dB PSNR") || !strings.Contains(evidence, `key="d1"`) {
		t.Fatalf("expected d1 excerpt in evidence:\n%s", evidence)
	}

	// Scope=keys isolates only requested papers.
	_, onlyD2, err := srv.retrieveLibraryEvidence(ctx, "CBCT noise", "keys", "", []string{"d2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(onlyD2) != 1 || onlyD2[0].Key != "d2" {
		t.Fatalf("expected only d2 for scope=keys, got %+v", onlyD2)
	}
}

func TestComparePresentationValidationAndMaterials(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`
		INSERT INTO documents(id,key,title,year,venue) VALUES
			('c1','c1','Method One',2023,'MICCAI'),
			('c2','c2','Method Two',2024,'CVPR');
		INSERT INTO document_pages(document_id,page,text) VALUES
			('c1',1,'Method One introduces dual-domain regularization.'),
			('c2',1,'Method Two introduces diffusion priors.');
	`); err != nil {
		t.Fatal(err)
	}

	// Reject < 2 papers.
	req, _ := http.NewRequest(http.MethodPost, frontend.URL+"/v1/ai/presentation-compare-plan", strings.NewReader(`{"paperKeys":["c1"]}`))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for <2 papers, got %d", res.StatusCode)
	}

	srv := New(cfg, handle)
	materials, err := srv.collectComparePresentationMaterials(context.Background(), []string{"c1", "c2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(materials) != 2 || !strings.Contains(materials[0].OpeningTxt, "dual-domain") {
		t.Fatalf("unexpected compare presentation materials: %+v", materials)
	}
}

func decodeResponse(res *http.Response, target any) error {
	defer res.Body.Close()
	return json.NewDecoder(res.Body).Decode(target)
}
