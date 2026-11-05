package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"cbctv2/server/internal/appstate"
)

func TestDuplicateUploadDoesNotEnterOCR(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	pdf := []byte("%PDF-1.4\nshared content")
	sum := sha256.Sum256(pdf)
	key := "doc-" + hex.EncodeToString(sum[:16])
	s.beginImportJob(key, "original", 1, func() {})
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for _, name := range []string{"one.pdf", "two.pdf"} {
		part, err := form.CreateFormFile("files", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(pdf); err != nil {
			t.Fatal(err)
		}
	}
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest("POST", "/v1/import/files", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	recorder := httptest.NewRecorder()
	s.handlePublicationUpload(recorder, request)
	var result struct {
		Results []importResult `json:"results"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Results) != 2 {
		t.Fatalf("missing results: %s", recorder.Body.String())
	}
	for _, row := range result.Results {
		if !strings.Contains(row.Error, "正在运行") {
			t.Fatalf("duplicate entered OCR or replaced active job: %+v", row)
		}
	}
	job, _ := s.loadImportJob(context.Background(), key)
	if job.Name != "original" || len(job.Runs) != 1 {
		t.Fatalf("active task was overwritten: %+v", job)
	}
}

func TestImportAdmissionKeepsOriginalCancellationAndAllowsRetry(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	var winners atomic.Int32
	var cancelled atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.beginImportJob("same-pdf", "paper", 1, func() { cancelled.Add(1) }) != nil {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatalf("admitted %d identical jobs", winners.Load())
	}
	if !s.cancelImportJob("same-pdf") {
		t.Fatal("cannot cancel original job")
	}
	if cancelled.Load() != 1 {
		t.Fatalf("wrong cancellation count %d", cancelled.Load())
	}
	var replacement atomic.Bool
	s.setJobCancel("same-pdf", func() { replacement.Store(true) })
	if !replacement.Load() {
		t.Fatal("cancelled job accepted a live replacement worker")
	}
	if s.beginImportJob("same-pdf", "too early", 1, nil) != nil {
		t.Fatal("retry raced the cancelling worker")
	}
	s.finishImportJob("same-pdf", "cancelled", "worker stopped")
	if s.beginImportJob("same-pdf", "retry", 1, nil) == nil {
		t.Fatal("terminal job prevented retry")
	}
}

func TestAppStateConditionalWritePreventsStaleWriteAcrossStores(t *testing.T) {
	_, handle, _ := newTestServer(t, nil)
	first := appstate.New(sqlAppStateKV{handle})
	second := appstate.New(sqlAppStateKV{handle})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := appstate.Save(ctx, first, "documents.meta", map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	read := make(chan struct{})
	release := make(chan struct{})
	secondDone := make(chan struct{})
	var firstRead sync.Once
	var attempts atomic.Int32
	errors := make(chan error, 2)
	go func() {
		errors <- first.Update(ctx, "documents.meta", func(raw []byte, _ bool) ([]byte, error) {
			attempts.Add(1)
			firstRead.Do(func() { close(read); <-release })
			var value map[string]bool
			_ = json.Unmarshal(raw, &value)
			value["favorite"] = true
			return json.Marshal(value)
		})
	}()
	<-read
	go func() {
		errors <- second.Update(ctx, "documents.meta", func(raw []byte, _ bool) ([]byte, error) {
			var value map[string]bool
			_ = json.Unmarshal(raw, &value)
			value["remote-category"] = true
			return json.Marshal(value)
		})
		close(secondDone)
	}()
	select {
	case <-secondDone:
	case <-ctx.Done():
		close(release)
		t.Fatal("concurrent writer blocked during validation")
	}
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	if attempts.Load() < 2 {
		t.Fatal("stale mutation was not recomputed")
	}
	value, _, err := appstate.Load[map[string]bool](ctx, first, "documents.meta")
	if err != nil || !value["favorite"] || !value["remote-category"] {
		t.Fatalf("lost update: %v %v", value, err)
	}
}

func TestAppStateRetriesAfterRawSyncTransaction(t *testing.T) {
	_, handle, _ := newTestServer(t, nil)
	store := appstate.New(sqlAppStateKV{handle})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := appstate.Save(ctx, store, "documents.meta", map[string]bool{}); err != nil {
		t.Fatal(err)
	}
	read, release := make(chan struct{}), make(chan struct{})
	var firstRead sync.Once
	done := make(chan error, 1)
	go func() {
		done <- store.Update(ctx, "documents.meta", func(raw []byte, _ bool) ([]byte, error) {
			// Production idea-validation callbacks also query the same database.
			var n int
			if err := handle.QueryRowContext(ctx, "SELECT 1").Scan(&n); err != nil {
				return nil, err
			}
			firstRead.Do(func() { close(read); <-release })
			var value map[string]bool
			_ = json.Unmarshal(raw, &value)
			value["local-favorite"] = true
			return json.Marshal(value)
		})
	}()
	<-read
	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	_, err = tx.ExecContext(ctx, `UPDATE app_state SET value_json='{"remote-category":true}' WHERE key='documents.meta'`)
	if err != nil {
		tx.Rollback()
		close(release)
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	value, _, err := appstate.Load[map[string]bool](ctx, store, "documents.meta")
	if err != nil || !value["local-favorite"] || !value["remote-category"] {
		t.Fatalf("sync erased metadata: %v %v", value, err)
	}
}
