package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
)

// Exercise the real upload endpoint with neither AI nor OCR configured.
func TestLocalOnlyPDFUpload(t *testing.T) {
	front, _, cfg := newTestServer(t, nil)
	data := []byte("%PDF-1.4\nlocal-only fixture\n%%EOF")
	var key string
	for attempt := 0; attempt < 2; attempt++ {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, err := form.CreateFormFile("files", "paper.pdf")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(data); err != nil {
			t.Fatal(err)
		}
		hints, _ := json.Marshal([]publicationMetadataHint{{LocalOnly: true, Title: "Offline research paper", Authors: []string{"Ada"}, Year: 2026}})
		if err = form.WriteField("metadata", string(hints)); err != nil {
			t.Fatal(err)
		}
		if err = form.Close(); err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest("POST", front.URL+"/v1/import/files", &body)
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
		req.Header.Set("Content-Type", form.FormDataContentType())
		res, err := front.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		payload := decode(t, res)
		result := payload["results"].([]any)[0].(map[string]any)
		if result["error"] != nil || result["existing"] != (attempt == 1) {
			t.Fatal(result)
		}
		doc := result["document"].(map[string]any)
		if doc["title"] != "Offline research paper" || doc["year"] != float64(2026) {
			t.Fatal(doc)
		}
		if attempt == 1 && doc["key"] != key {
			t.Fatal("duplicate import changed document key")
		}
		key = doc["key"].(string)
	}
	res := get(t, front, "/v1/documents/"+key+"/pdf", cfg.Token)
	defer res.Body.Close()
	saved, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode != http.StatusOK || !bytes.Equal(saved, data) {
		t.Fatalf("original PDF not readable: %s, %v", res.Status, err)
	}
}
