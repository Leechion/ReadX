package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"cbctv2/server/internal/appstate"
)

func TestZoteroMigrationPreservesFilesAndSyncConflicts(t *testing.T) {
	s := processingTestServer(t)
	root := t.TempDir()
	pdf := filepath.Join(root, "original.pdf")
	other := filepath.Join(root, "appendix.docx")
	for name, data := range map[string]string{pdf: "%PDF-1.4\nfixture", other: "binary appendix"} {
		if err := os.WriteFile(name, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	objects := map[string]zoteroObject{
		"PARENT01": {Key: "PARENT01", Version: 1, Data: map[string]any{"itemType": "journalArticle", "title": "Paper", "creators": []any{map[string]any{"creatorType": "author", "name": "Ada"}}, "DOI": "10.1234/parent", "date": "2025", "collections": []string{"COLL0001"}}},
		"ATTACH01": {Key: "ATTACH01", Version: 1, Data: map[string]any{"itemType": "attachment", "parentItem": "PARENT01", "filename": "original.pdf", "contentType": "application/pdf", "linkMode": "imported_file"}},
		"ATTACH02": {Key: "ATTACH02", Version: 1, Data: map[string]any{"itemType": "attachment", "parentItem": "PARENT01", "filename": "appendix.docx", "contentType": "application/octet-stream", "linkMode": "imported_file"}},
		"NOTES001": {Key: "NOTES001", Version: 1, Data: map[string]any{"itemType": "note", "parentItem": "PARENT01", "note": "<div>Original note</div>"}},
		"ANNOT001": {Key: "ANNOT001", Version: 1, Data: map[string]any{"itemType": "annotation", "parentItem": "ATTACH01", "annotationText": "evidence", "annotationComment": "comment", "annotationPosition": `{"pageIndex":0,"rects":[[10,20,30,40]]}`}},
		"COLL0001": {Key: "COLL0001", Version: 1, Data: map[string]any{"name": "Project", "parentCollection": false}},
	}
	var mu sync.Mutex
	writes := 0
	missingOther := false
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Zotero-Server-ID", "INSTANCE1")
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/" {
			io.WriteString(w, `{}`)
			return
		}
		if r.URL.Path == "/local/authorize" {
			io.WriteString(w, `{"key":"12345678901234567890123456789012","remember":true}`)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 4 {
			w.WriteHeader(404)
			return
		}
		key := parts[3]
		if len(parts) == 5 && parts[4] == "file" {
			path := pdf
			if key == "ATTACH02" {
				if missingOther {
					w.WriteHeader(404)
					return
				}
				path = other
			}
			location := url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(path), "/")}
			w.Header().Set("Location", location.String())
			w.WriteHeader(302)
			return
		}
		object, ok := objects[key]
		if !ok {
			w.WriteHeader(404)
			return
		}
		if r.Method == "PUT" {
			if r.Header.Get("Zotero-API-Key") == "" {
				w.WriteHeader(401)
				return
			}
			var data map[string]any
			if json.NewDecoder(r.Body).Decode(&data) != nil {
				w.WriteHeader(400)
				return
			}
			if data["version"] != float64(object.Version) {
				w.WriteHeader(412)
				return
			}
			if r.Header.Get("If-Unmodified-Since-Version") == "" || r.Header.Get("Zotero-Write-Token") == "" {
				t.Error("missing write preconditions")
			}
			object.Version++
			object.Data = data
			objects[key] = object
			writes++
			w.WriteHeader(204)
			return
		}
		json.NewEncoder(w).Encode(object)
	}))
	defer fake.Close()
	s.zoteroTestURL = fake.URL
	snapshot := zoteroSnapshot{ServerID: "INSTANCE1", Items: []zoteroObject{}, Collections: []zoteroObject{objects["COLL0001"]}}
	for key, object := range objects {
		if key != "COLL0001" {
			snapshot.Items = append(snapshot.Items, object)
		}
	}
	if err := appstate.Save(context.Background(), s.appStateStore, "zotero.snapshot:INSTANCE1", snapshot); err != nil {
		t.Fatal(err)
	}
	migrate := func() zoteroMigration {
		w := httptest.NewRecorder()
		s.handleZoteroMigration(w, httptest.NewRequest("POST", "/", strings.NewReader(`{"serverId":"INSTANCE1"}`)))
		var result zoteroMigration
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatal(w.Body.String())
		}
		return result
	}
	state := migrate()
	if state.Status != "complete" || len(state.Files) != 2 || len(state.Objects) != 6 {
		t.Fatal(state.Status, state.Files)
	}
	parent := state.Objects["items:PARENT01"]
	if len(parent.Documents) != 1 {
		t.Fatal("PDF did not enter library", parent)
	}
	docKey := parent.Documents[0]
	var count int
	s.handle.QueryRow(`SELECT count(*) FROM annotations`).Scan(&count)
	if count != 2 {
		t.Fatal("notes/annotations missing", count)
	}
	native := state.Objects["items:ANNOT001"]
	var page int
	var quote string
	if err := s.handle.QueryRow(`SELECT page,quote FROM annotations WHERE id=?`, native.AnnotationIDs[0]).Scan(&page, &quote); err != nil || page != 1 || quote != "evidence" {
		t.Fatal(page, quote, err)
	}
	again := migrate()
	s.handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count)
	if count != 1 || again.ID != state.ID {
		t.Fatal("migration duplicated documents")
	}
	s.handle.QueryRow(`SELECT count(*) FROM annotations`).Scan(&count)
	if count != 2 {
		t.Fatal("migration duplicated notes")
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.SetPathValue("id", state.ID)
	s.handleZoteroArchive(w, r)
	archive, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, file := range archive.File {
		reader, _ := file.Open()
		data, _ := io.ReadAll(reader)
		reader.Close()
		seen[file.Name] = string(data)
	}
	if seen["attachments/ATTACH02/appendix.docx"] != "binary appendix" || !strings.Contains(seen["migration.json"], "annotationPosition") {
		t.Fatal("archive lost original objects or non-PDF files", seen)
	}
	noteID := state.Objects["items:NOTES001"].AnnotationIDs[0]
	if _, err = s.handle.Exec(`UPDATE annotations SET note='[Zotero 笔记]'||char(10)||'local edit' WHERE id=?`, noteID); err != nil {
		t.Fatal(err)
	}
	reconcile := func(objectID string) zoteroSyncPlan {
		w := httptest.NewRecorder()
		raw, _ := json.Marshal(map[string]any{"migrationId": state.ID, "objects": []string{objectID}})
		s.handleZoteroReconcile(w, httptest.NewRequest("POST", "/", bytes.NewReader(raw)))
		var plan zoteroSyncPlan
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &plan) != nil || len(plan.Entries) != 1 {
			t.Fatal(w.Body.String())
		}
		return plan
	}
	apply := func(plan zoteroSyncPlan, choice string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		entry := plan.Entries[0]
		raw, _ := json.Marshal(map[string]any{"planId": plan.ID, "objectId": entry.ObjectID, "choice": choice, "documentKeys": entry.Documents})
		s.handleZoteroReconcileApply(w, httptest.NewRequest("POST", "/", bytes.NewReader(raw)))
		return w
	}
	plan := reconcile("items:NOTES001")
	if plan.Entries[0].State != "push" {
		t.Fatal(plan.Entries)
	}
	mu.Lock()
	remote := objects["NOTES001"]
	remote.Version = 2
	remote.Data = zoteroClone(remote.Data)
	remote.Data["note"] = "<div>remote edit</div>"
	objects["NOTES001"] = remote
	mu.Unlock()
	if out := apply(plan, "push"); out.Code != 409 {
		t.Fatal("stale plan overwrote remote", out.Body.String())
	}
	plan = reconcile("items:NOTES001")
	if plan.Entries[0].State != "conflict" {
		t.Fatal("missing conflict", plan.Entries)
	}
	if out := apply(plan, "pull"); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	var note string
	s.handle.QueryRow(`SELECT note FROM annotations WHERE id=?`, noteID).Scan(&note)
	if !strings.Contains(note, "remote edit") {
		t.Fatal("pull failed", note)
	}
	if _, err = s.handle.Exec(`UPDATE annotations SET note='[Zotero 笔记]'||char(10)||'final local' WHERE id=?`, noteID); err != nil {
		t.Fatal(err)
	}
	auth := httptest.NewRecorder()
	s.handleZoteroAuthorize(auth, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)))
	if auth.Code != 200 {
		t.Fatal(auth.Body.String())
	}
	plan = reconcile("items:NOTES001")
	if out := apply(plan, "push"); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	mu.Lock()
	saved := zoteroString(objects["NOTES001"].Data, "note")
	putCount := writes
	mu.Unlock()
	if putCount != 1 || !strings.Contains(saved, "final local") {
		t.Fatal("push did not save confirmed content", saved, putCount)
	}
	mu.Lock()
	collection := objects["COLL0001"]
	collection.Version++
	collection.Data = zoteroClone(collection.Data)
	collection.Data["name"] = "Renamed"
	objects["COLL0001"] = collection
	mu.Unlock()
	categories, _ := s.loadCategories(context.Background())
	idBefore := categories[0].ID
	plan = reconcile("collections:COLL0001")
	if out := apply(plan, "pull"); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	categories, _ = s.loadCategories(context.Background())
	meta, _ := s.loadMeta(context.Background(), docKey)
	if categories[0].ID != idBefore || !strings.HasPrefix(categories[0].Name, "Renamed") || meta.Categories[0] != categories[0].Name {
		t.Fatal("collection rename lost stable identity or members", categories, meta)
	}
	mu.Lock()
	missingOther = true
	mu.Unlock()
	partial := migrate()
	if partial.Status != "partial" {
		t.Fatal("missing attachment claimed complete", partial.Status)
	}
	cached := false
	for _, file := range partial.Files {
		if file.Key == "ATTACH02" && file.Error != "" && len(file.Files) > 0 {
			cached = true
		}
	}
	if !cached {
		t.Fatal("retry discarded previous attachment copy", partial.Files)
	}
	state, _ = s.loadZoteroMigration(context.Background(), state.ID)
	object := state.Objects["items:PARENT01"]
	data := zoteroClone(object.Local)
	data["title"] = "Edited mirror title"
	edit := func(revision int) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]any{"migrationId": state.ID, "objectId": "items:PARENT01", "revision": revision, "data": data})
		s.handleZoteroMirrorEdit(w, httptest.NewRequest("PATCH", "/", bytes.NewReader(body)))
		return w
	}
	if out := edit(object.Revision); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	if out := edit(object.Revision); out.Code != 409 {
		t.Fatal("stale mirror revision accepted", out.Body.String())
	}
	plan = reconcile("items:PARENT01")
	if plan.Entries[0].State != "push" {
		t.Fatal(plan.Entries)
	}
	if out := apply(plan, "push"); out.Code != 200 {
		t.Fatal(out.Body.String())
	}
	doc, err := s.loadDocument(context.Background(), docKey)
	if err != nil || doc.Title != "Edited mirror title" {
		t.Fatal("metadata not reflected to library", doc.Title, err)
	}
	filtered := []zoteroObject{}
	for _, item := range snapshot.Items {
		if item.Key != "ATTACH02" {
			filtered = append(filtered, item)
		}
	}
	snapshot.Items = filtered
	if err = appstate.Save(context.Background(), s.appStateStore, "zotero.snapshot:INSTANCE1", snapshot); err != nil {
		t.Fatal(err)
	}
	retained := migrate()
	historyKept := false
	for _, file := range retained.Files {
		if file.Key == "ATTACH02" && file.Retained && len(file.Files) > 0 {
			historyKept = true
		}
	}
	if !historyKept {
		t.Fatal("source removal discarded archive membership", retained.Files)
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.SetPathValue("id", state.ID)
	s.handleZoteroArchive(w, r)
	archive, err = zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	historyKept = false
	for _, file := range archive.File {
		if file.Name == "attachments/ATTACH02/appendix.docx" {
			historyKept = true
		}
	}
	if !historyKept {
		t.Fatal("removed source attachment no longer exportable")
	}
}

func TestZoteroLocalViewsPreserveIndependentEdits(t *testing.T) {
	s := processingTestServer(t)
	_, err := s.handle.Exec(`INSERT INTO documents(id,key,title,year) VALUES('paper','paper','reader title',2026)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.handle.Exec(`INSERT INTO annotations(id,document_id,note) VALUES('note','paper','[Zotero 笔记]'||char(10)||'reader edit')`)
	if err != nil {
		t.Fatal(err)
	}
	note := zoteroMirrorObject{Base: map[string]any{"itemType": "note", "note": "<div>base</div>"}, Local: map[string]any{"itemType": "note", "note": "<div>mirror edit</div>"}, AnnotationIDs: []string{"note"}}
	local, err := s.zoteroLocalView(context.Background(), zoteroMigration{}, note)
	if err == nil || zoteroString(local, "note") != "<div>mirror edit</div>" {
		t.Fatal("local note copy overwritten", local, err)
	}
	base := map[string]any{"itemType": "journalArticle", "title": "base title", "date": "2025-03-05"}
	documentBase := zoteroExpectedDocument(base)
	object := zoteroMirrorObject{Base: base, Local: zoteroClone(base), Documents: []string{"paper"}, DocumentBase: documentBase}
	object.Local["title"] = "mirror title"
	if _, err = s.zoteroLocalView(context.Background(), zoteroMigration{}, object); err == nil {
		t.Fatal("local metadata conflict not surfaced")
	}
	_, err = s.handle.Exec(`UPDATE documents SET title='base title' WHERE key='paper'`)
	if err != nil {
		t.Fatal(err)
	}
	object.Local = zoteroClone(base)
	local, err = s.zoteroLocalView(context.Background(), zoteroMigration{}, object)
	if err != nil || local["date"] != "2026-03-05" {
		t.Fatal("year edit lost original month/day", local, err)
	}
}

func TestZoteroSnapshotReadsBeyondFiveThousandObjects(t *testing.T) {
	s := processingTestServer(t)
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Zotero-Server-ID", "INSTANCE1")
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/" {
			io.WriteString(w, `{}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/collections") {
			io.WriteString(w, `[]`)
			return
		}
		start, _ := strconv.Atoi(r.URL.Query().Get("start"))
		items := []zoteroObject{}
		for i := start; i < min(start+100, 5101); i++ {
			items = append(items, zoteroObject{Key: fmt.Sprintf("A%07d", i), Version: 1, Data: map[string]any{"itemType": "journalArticle", "title": "Paper"}})
		}
		json.NewEncoder(w).Encode(items)
	}))
	defer fake.Close()
	s.zoteroTestURL = fake.URL
	w := httptest.NewRecorder()
	s.handleZoteroSnapshot(w, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)))
	var snapshot zoteroSnapshot
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &snapshot) != nil || len(snapshot.Items) != 5101 {
		t.Fatal("snapshot was truncated", w.Code)
	}
}
