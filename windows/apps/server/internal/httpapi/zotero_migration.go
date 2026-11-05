package httpapi

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"cbctv2/server/internal/appstate"
	"cbctv2/server/internal/legacy"
)

type zoteroMirrorObject struct {
	Kind          string         `json:"kind"`
	Key           string         `json:"key"`
	Version       int            `json:"version"`
	Revision      int            `json:"revision"`
	Base          map[string]any `json:"base"`
	Local         map[string]any `json:"local"`
	Documents     []string       `json:"documentKeys"`
	DocumentBase  map[string]any `json:"documentBase,omitempty"`
	AnnotationIDs []string       `json:"annotationIds,omitempty"`
}
type zoteroMigrationFile struct {
	Key   string   `json:"key"`
	Name  string   `json:"name"`
	Size  int64    `json:"size"`
	Error string   `json:"error,omitempty"`
	Files []string `json:"files,omitempty"`
}
type zoteroMigration struct {
	ID         string                        `json:"id"`
	ServerID   string                        `json:"serverId"`
	At         string                        `json:"at"`
	Status     string                        `json:"status"`
	Objects    map[string]zoteroMirrorObject `json:"objects"`
	Files      []zoteroMigrationFile         `json:"files"`
	Disclosure string                        `json:"disclosure"`
	Snapshot   zoteroSnapshot                `json:"snapshot"`
}
type zoteroSnapshot struct {
	ServerID    string         `json:"serverId"`
	Items       []zoteroObject `json:"items"`
	Collections []zoteroObject `json:"collections"`
}

func zoteroClone(data map[string]any) map[string]any {
	raw, _ := json.Marshal(data)
	var cloned map[string]any
	_ = json.Unmarshal(raw, &cloned)
	return cloned
}
func zoteroString(data map[string]any, key string) string {
	value, _ := data[key].(string)
	return value
}
func zoteroStrings(value any) []string {
	result := []string{}
	if items, ok := value.([]any); ok {
		for _, item := range items {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
	}
	return result
}
func zoteroCreators(value any) []string {
	out := []string{}
	if creators, ok := value.([]any); ok {
		for _, item := range creators {
			if person, ok := item.(map[string]any); ok {
				if creatorType := zoteroString(person, "creatorType"); creatorType != "" && creatorType != "author" {
					continue
				}
				name := zoteroString(person, "name")
				if name == "" {
					name = strings.TrimSpace(zoteroString(person, "firstName") + " " + zoteroString(person, "lastName"))
				}
				if name != "" {
					out = append(out, name)
				}
			}
		}
	}
	return out
}
func zoteroDocumentFields(doc DocumentSummary) map[string]any {
	return map[string]any{"title": doc.Title, "authors": doc.Authors, "doi": doc.DOI, "venue": doc.Venue, "year": doc.Year}
}
func zoteroObjectID(kind, key string) string { return kind + ":" + key }
func (s *Server) loadZoteroMigration(ctx context.Context, id string) (zoteroMigration, error) {
	if _, err := safeKey(id, "迁移标识"); err != nil {
		return zoteroMigration{}, err
	}
	state, exists, err := appstate.Load[zoteroMigration](ctx, s.appStateStore, "zotero.migration:"+id)
	if err != nil {
		return state, err
	}
	if !exists {
		return state, fmt.Errorf("迁移记录不存在")
	}
	return state, nil
}
func (s *Server) saveZoteroMigration(ctx context.Context, state zoteroMigration) error {
	return appstate.Save(ctx, s.appStateStore, "zotero.migration:"+state.ID, state)
}
func (s *Server) zoteroMigrationRoot(id string) string {
	return filepath.Join(legacy.NewPaths(s.cfg.DataRoot).DataDir(), "zotero-migrations", id)
}

// The fixed loopback server, never a page-provided path, resolves local files.
func (s *Server) zoteroAttachmentPath(ctx context.Context, serverID, key string) (string, error) {
	if !zoteroKeyPattern.MatchString(key) {
		return "", fmt.Errorf("附件标识无效")
	}
	_, headers, status, err := s.zoteroLocal(ctx, "GET", "/users/0/items/"+key+"/file", nil, serverID, "")
	if err != nil {
		return "", err
	}
	if status != 302 {
		return "", fmt.Errorf("附件本机不可用（%d）；请先在 Zotero 下载", status)
	}
	location, err := url.Parse(headers.Get("Location"))
	if err != nil || location.Scheme != "file" || (location.Host != "" && location.Host != "localhost") {
		return "", fmt.Errorf("Zotero 未返回本机附件")
	}
	path := location.Path
	if runtime.GOOS == "windows" && len(path) > 2 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	path = filepath.FromSlash(path)
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("附件路径无效")
	}
	return path, nil
}
func copyZoteroAttachment(ctx context.Context, source, destination string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	info, err := os.Lstat(source)
	if err != nil {
		return 0, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxPublicationBytes {
		return 0, fmt.Errorf("附件不是普通文件或超过 512 MiB")
	}
	if err = os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return 0, err
	}
	in, err := os.Open(source)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(destination), ".attachment-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(out.Name())
	n, err := io.Copy(out, io.LimitReader(in, maxPublicationBytes+1))
	closeErr := out.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = ctx.Err()
	}
	if err == nil && n > maxPublicationBytes {
		err = fmt.Errorf("附件过大")
	}
	if err != nil {
		return 0, err
	}
	return n, os.Rename(out.Name(), destination)
}

func (s *Server) handleZoteroMigration(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		if id := r.URL.Query().Get("id"); id != "" {
			state, err := s.loadZoteroMigration(r.Context(), id)
			if err != nil {
				writeError(w, 404, err.Error())
				return
			}
			writeJSON(w, 200, state)
			return
		}
		rows, err := s.handle.QueryContext(r.Context(), `SELECT value_json FROM app_state WHERE key LIKE 'zotero.migration:%' ORDER BY updated_at DESC LIMIT 30`)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		defer rows.Close()
		result := []map[string]any{}
		for rows.Next() {
			var raw string
			if err = rows.Scan(&raw); err != nil {
				break
			}
			var state zoteroMigration
			if err = json.Unmarshal([]byte(raw), &state); err != nil {
				break
			}
			result = append(result, map[string]any{"id": state.ID, "serverId": state.ServerID, "at": state.At, "status": state.Status, "objects": len(state.Objects), "files": len(state.Files)})
		}
		if err == nil {
			err = rows.Err()
		}
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"migrations": result})
		return
	}
	var body struct {
		ServerID string `json:"serverId"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	s.zoteroMigrationMu.Lock()
	defer s.zoteroMigrationMu.Unlock()
	id, err := s.zoteroServerID(r.Context())
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	if id != body.ServerID {
		writeError(w, 409, "Zotero 实例已变化，请重新读取快照")
		return
	}
	snapshot, exists, err := appstate.Load[zoteroSnapshot](r.Context(), s.appStateStore, "zotero.snapshot:"+id)
	if err != nil || !exists {
		writeError(w, 409, "请先读取本机资料库快照")
		return
	}
	source, found, err := appstate.Load[string](r.Context(), s.appStateStore, "zotero.source:"+id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if !found {
		source, err = randomLeeJobID()
		if err == nil {
			err = appstate.Save(r.Context(), s.appStateStore, "zotero.source:"+id, source)
		}
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	state, stateExists, loadErr := appstate.Load[zoteroMigration](r.Context(), s.appStateStore, "zotero.migration:"+source)
	if loadErr != nil {
		writeError(w, 500, loadErr.Error())
		return
	}
	if !stateExists {
		state = zoteroMigration{ID: source, ServerID: id, Objects: map[string]zoteroMirrorObject{}}
	}
	if state.ServerID != id {
		writeError(w, 409, "迁移实例不匹配")
		return
	}
	state.Snapshot = snapshot
	state.At = time.Now().UTC().Format(time.RFC3339)
	state.Status = "running"
	priorFiles := map[string]zoteroMigrationFile{}
	for _, file := range state.Files {
		priorFiles[file.Key] = file
	}
	state.Files = []zoteroMigrationFile{}
	state.Disclosure = "题录、集合、笔记、原生批注完整 JSON 和本机附件保存在本地迁移档案；PDF／EPUB 以原文模式入库，无 OCR／AI。附件不可用会明确列出，不能视作迁移完成。原文件不反向覆盖，删除不自动传播。"
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	if err = os.MkdirAll(s.zoteroMigrationRoot(source), 0700); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	for _, pair := range []struct {
		kind    string
		objects []zoteroObject
	}{{"collections", snapshot.Collections}, {"items", snapshot.Items}} {
		for _, object := range pair.objects {
			if !zoteroKeyPattern.MatchString(object.Key) {
				writeError(w, 502, "快照对象标识无效")
				return
			}
			key := zoteroObjectID(pair.kind, object.Key)
			if _, ok := state.Objects[key]; !ok {
				state.Objects[key] = zoteroMirrorObject{Kind: pair.kind, Key: object.Key, Version: object.Version, Base: zoteroClone(object.Data), Local: zoteroClone(object.Data), Documents: []string{}, AnnotationIDs: []string{}}
			}
		}
	}
	if err = s.saveZoteroMigration(ctx, state); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	objects := append([]zoteroObject{}, snapshot.Items...)
	sort.Slice(objects, func(i, j int) bool { return objects[i].Key < objects[j].Key })
	for _, object := range objects {
		if zoteroString(object.Data, "itemType") != "attachment" || zoteroString(object.Data, "linkMode") == "linked_url" {
			continue
		}
		file := zoteroMigrationFile{Key: object.Key, Name: zoteroString(object.Data, "filename"), Files: []string{}}
		if file.Name == "" {
			file.Name = object.Key
		}
		localPath, fetchErr := s.zoteroAttachmentPath(ctx, id, object.Key)
		if fetchErr == nil {
			storedName := filepath.Base(localPath)
			destination := filepath.Join(s.zoteroMigrationRoot(source), "attachments", object.Key, storedName)
			file.Size, fetchErr = copyZoteroAttachment(ctx, localPath, destination)
			if fetchErr == nil {
				file.Files = append(file.Files, filepath.ToSlash(filepath.Join("attachments", object.Key, storedName)))
				if zoteroString(object.Data, "contentType") == "text/html" && zoteroString(object.Data, "linkMode") == "imported_url" {
					fetchErr = filepath.WalkDir(filepath.Dir(localPath), func(path string, entry os.DirEntry, walkErr error) error {
						if walkErr != nil {
							return walkErr
						}
						if entry.IsDir() {
							return nil
						}
						if path == localPath {
							return nil
						}
						relative, e := filepath.Rel(filepath.Dir(localPath), path)
						if e != nil {
							return e
						}
						to := filepath.Join(s.zoteroMigrationRoot(source), "attachments", object.Key, relative)
						n, e := copyZoteroAttachment(ctx, path, to)
						file.Size += n
						if file.Size > maxPublicationBytes {
							return fmt.Errorf("网页快照超过 512 MiB")
						}
						if e == nil {
							file.Files = append(file.Files, filepath.ToSlash(filepath.Join("attachments", object.Key, relative)))
						}
						return e
					})
				}
				if fetchErr == nil && (zoteroString(object.Data, "contentType") == "application/pdf" || strings.EqualFold(filepath.Ext(file.Name), ".pdf") || strings.EqualFold(filepath.Ext(file.Name), ".epub")) {
					data, e := os.ReadFile(destination)
					if e == nil {
						parent := state.Objects[zoteroObjectID("items", zoteroString(object.Data, "parentItem"))]
						metadata := zoteroMetadata(parent.Local)
						if metadata.Title == "" {
							metadata.Title = zoteroString(object.Data, "title")
						}
						imported, importErr := s.importPublication(ctx, file.Name, "zotero://select/library/items/"+object.Key, data, metadata)
						e = importErr
						if e == nil {
							attachment := state.Objects[zoteroObjectID("items", object.Key)]
							attachment.Documents = []string{imported.Document.Key}
							state.Objects[zoteroObjectID("items", object.Key)] = attachment
							if parent.Key != "" {
								parent.Documents = appendUnique(parent.Documents, imported.Document.Key)
								if parent.DocumentBase == nil {
									parent.DocumentBase = zoteroExpectedDocument(parent.Base)
								}
								state.Objects[zoteroObjectID("items", parent.Key)] = parent
							}
						}
					}
					fetchErr = e
				}
			}
		}
		if fetchErr != nil {
			file.Error = fetchErr.Error()
			if prior, exists := priorFiles[file.Key]; exists && len(file.Files) == 0 {
				file.Files = prior.Files
				file.Size = prior.Size
				file.Error += "；已保留上次成功迁入的附件副本"
			}
		}
		state.Files = append(state.Files, file)
		if err = s.saveZoteroMigration(context.WithoutCancel(ctx), state); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if ctx.Err() != nil {
			break
		}
	}
	for key, object := range state.Objects {
		if object.Kind == "items" && zoteroString(object.Local, "itemType") != "attachment" && zoteroString(object.Local, "itemType") != "note" && zoteroString(object.Local, "itemType") != "annotation" {
			object.Documents = []string{}
			for _, child := range snapshot.Items {
				if zoteroString(child.Data, "parentItem") == object.Key && zoteroString(child.Data, "itemType") == "attachment" {
					for _, doc := range state.Objects[zoteroObjectID("items", child.Key)].Documents {
						object.Documents = appendUnique(object.Documents, doc)
					}
				}
			}
			state.Objects[key] = object
		}
	}
	for key, object := range state.Objects {
		if object.Kind != "items" {
			continue
		}
		kind := zoteroString(object.Local, "itemType")
		if kind != "note" && kind != "annotation" {
			continue
		}
		parent := state.Objects[zoteroObjectID("items", zoteroString(object.Local, "parentItem"))]
		object.Documents = append([]string{}, parent.Documents...)
		state.Objects[key] = object
		if err = s.installZoteroNote(ctx, &state, key, false); err != nil {
			state.Status = "partial"
			break
		}
	}
	if err == nil {
		err = s.installZoteroCollections(ctx, &state)
	}
	if ctx.Err() != nil {
		state.Status = "interrupted"
	} else if err != nil {
		state.Status = "partial"
		state.Disclosure += " 本地映射失败：" + err.Error()
	} else {
		state.Status = "complete"
		for _, file := range state.Files {
			if file.Error != "" {
				state.Status = "partial"
			}
		}
	}
	if saveErr := s.saveZoteroMigration(context.WithoutCancel(ctx), state); saveErr != nil {
		writeError(w, 500, saveErr.Error())
		return
	}
	writeJSON(w, 200, state)
	s.processingMu.Lock()
	s.revokeProcessingLocked()
	s.processingMu.Unlock()
}
func appendUnique(items []string, item string) []string {
	for _, prior := range items {
		if prior == item {
			return items
		}
	}
	return append(items, item)
}
func zoteroMetadata(data map[string]any) recognizedPaperMetadata {
	metadata := recognizedPaperMetadata{Title: zoteroString(data, "title"), DOI: zoteroString(data, "DOI"), Venue: zoteroString(data, "publicationTitle"), Authors: zoteroCreators(data["creators"])}
	if metadata.Venue == "" {
		metadata.Venue = zoteroString(data, "proceedingsTitle")
	}
	if year := zoteroYearPattern.FindString(zoteroString(data, "date")); year != "" {
		_, _ = fmt.Sscan(year, &metadata.Year)
	}
	return metadata
}

var zoteroHTMLTags = regexp.MustCompile(`<[^>]*>`)

func zoteroPlainNote(value string) string {
	for _, tag := range []string{"</p>", "</div>", "<br>", "<br/>", "<br />"} {
		value = strings.ReplaceAll(value, tag, "\n")
	}
	return strings.TrimSpace(html.UnescapeString(zoteroHTMLTags.ReplaceAllString(value, "")))
}

func (s *Server) installZoteroNote(ctx context.Context, state *zoteroMigration, key string, overwrite bool) error {
	object := state.Objects[key]
	kind := zoteroString(object.Local, "itemType")
	if kind != "note" && kind != "annotation" {
		return nil
	}
	quote, note, page := "", "", (*int)(nil)
	if kind == "note" {
		note = "[Zotero 笔记]\n" + zoteroPlainNote(zoteroString(object.Local, "note"))
	} else {
		quote = zoteroString(object.Local, "annotationText")
		note = zoteroString(object.Local, "annotationComment")
		var position struct {
			PageIndex *int `json:"pageIndex"`
		}
		if json.Unmarshal([]byte(zoteroString(object.Local, "annotationPosition")), &position) == nil && position.PageIndex != nil && *position.PageIndex >= 0 {
			value := *position.PageIndex + 1
			page = &value
		}
		note = "[Zotero 原生批注；原始坐标保留在迁移档案]\n" + note
	}
	ids := []string{}
	for _, doc := range object.Documents {
		id := "zotero-" + state.ID + "-" + object.Key + "-" + doc
		ids = append(ids, id)
		conflict := "DO NOTHING"
		if overwrite {
			conflict = "DO UPDATE SET quote=excluded.quote,note=excluded.note,page=excluded.page,updated_at=excluded.updated_at"
		}
		_, err := s.handle.ExecContext(ctx, `INSERT INTO annotations(id,document_id,page,kind,quote,note,color,tags,locator_json,created_at,updated_at) VALUES(?,?,?,'question',?,?,'amber','[]','{}',?,?) ON CONFLICT(id) `+conflict, id, doc, page, quote, note, nowStamp(), nowStamp())
		if err != nil {
			return err
		}
	}
	object.AnnotationIDs = ids
	state.Objects[key] = object
	return nil
}
func (s *Server) installZoteroCollections(ctx context.Context, state *zoteroMigration, only ...[]string) error {
	labels, renames, managed := map[string]string{}, map[string]string{}, map[string]bool{}
	if err := s.mutateCategories(ctx, func(categories []Category) ([]Category, error) {
		for _, object := range state.Objects {
			if object.Kind != "collections" {
				continue
			}
			name := []rune(zoteroString(object.Local, "name"))
			if len(name) > 14 {
				name = name[:14]
			}
			label := string(name) + "·" + object.Key
			id := "zotero-" + state.ID + "-" + object.Key
			labels[object.Key] = label
			managed[label] = true
			found := false
			for i, category := range categories {
				if category.ID == id {
					managed[category.Name] = true
					if category.Name != label {
						renames[category.Name] = label
					}
					categories[i].Name = label
					found = true
				}
			}
			if !found {
				categories = append(categories, Category{ID: id, Name: label, Color: "sky", Order: len(categories)})
			}
		}
		return categories, nil
	}); err != nil {
		return err
	}
	allowed := map[string]bool{}
	if len(only) > 0 {
		for _, key := range only[0] {
			allowed[key] = true
		}
	}
	membership := map[string][]string{}
	for _, object := range state.Objects {
		kind := zoteroString(object.Local, "itemType")
		if object.Kind != "items" || kind == "note" || kind == "annotation" || kind == "attachment" {
			continue
		}
		for _, key := range object.Documents {
			if len(only) > 0 && !allowed[key] {
				continue
			}
			if membership[key] == nil {
				membership[key] = []string{}
			}
			for _, collection := range zoteroStrings(object.Local["collections"]) {
				if label := labels[collection]; label != "" {
					membership[key] = appendUnique(membership[key], label)
				}
			}
		}
	}
	var latest map[string]DocumentMeta
	err := s.mutateAllMeta(ctx, func(all map[string]DocumentMeta) (map[string]DocumentMeta, error) {
		for key, meta := range all {
			for i, label := range meta.Categories {
				if name := renames[label]; name != "" {
					meta.Categories[i] = name
				}
			}
			all[key] = meta
		}
		for key, labels := range membership {
			meta, ok := all[key]
			if !ok {
				meta = emptyMeta(key)
			}
			kept := []string{}
			for _, label := range meta.Categories {
				if !managed[label] {
					kept = append(kept, label)
				}
			}
			for _, label := range labels {
				kept = appendUnique(kept, label)
			}
			meta.Categories = kept
			all[key] = meta
		}
		latest = all
		return all, nil
	})
	if err != nil {
		return err
	}
	for key, object := range state.Objects {
		if object.DocumentBase != nil && len(object.Documents) > 0 {
			doc := object.Documents[0]
			if len(only) == 0 || allowed[doc] {
				object.DocumentBase["categories"] = latest[doc].Categories
				state.Objects[key] = object
			}
		}
	}
	// A collection write must also honor policies of papers in descendant collections.
	for id, collection := range state.Objects {
		if collection.Kind != "collections" {
			continue
		}
		documents := []string{}
		for _, item := range state.Objects {
			if item.Kind != "items" || len(item.Documents) == 0 {
				continue
			}
			for _, member := range zoteroStrings(item.Local["collections"]) {
				seen := map[string]bool{}
				for member != "" && !seen[member] {
					seen[member] = true
					if member == collection.Key {
						for _, doc := range item.Documents {
							documents = appendUnique(documents, doc)
						}
						break
					}
					parent := state.Objects[zoteroObjectID("collections", member)]
					member = zoteroString(parent.Local, "parentCollection")
				}
			}
		}
		sort.Strings(documents)
		collection.Documents = documents
		state.Objects[id] = collection
	}
	return nil
}
func zoteroExpectedDocument(data map[string]any) map[string]any {
	meta := zoteroMetadata(data)
	var year any
	if meta.Year > 0 {
		year = meta.Year
	}
	return map[string]any{"title": meta.Title, "authors": meta.Authors, "doi": meta.DOI, "venue": meta.Venue, "year": year}
}

func (s *Server) handleZoteroArchive(w http.ResponseWriter, r *http.Request) {
	s.zoteroMigrationMu.Lock()
	defer s.zoteroMigrationMu.Unlock()
	state, err := s.loadZoteroMigration(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	root := s.zoteroMigrationRoot(state.ID)
	for _, file := range state.Files {
		for _, name := range file.Files {
			if !strings.HasPrefix(name, "attachments/"+file.Key+"/") || strings.Contains(name, "\\") || filepath.IsAbs(name) || filepath.ToSlash(filepath.Clean(filepath.FromSlash(name))) != name {
				writeError(w, 500, "附件归档路径无效")
				return
			}
			info, err := os.Stat(filepath.Join(root, filepath.FromSlash(name)))
			if err != nil || !info.Mode().IsRegular() {
				writeError(w, 409, "归档附件缺失，请重新迁入后导出")
				return
			}
		}
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": "ReadX-Zotero-migration.zip"}))
	archive := zip.NewWriter(w)
	defer archive.Close()
	entry, err := archive.Create("migration.json")
	if err != nil {
		return
	}
	raw, _ := json.MarshalIndent(state, "", "  ")
	if _, err = entry.Write(raw); err != nil {
		return
	}
	for _, file := range state.Files {
		for _, name := range file.Files {
			if err = r.Context().Err(); err != nil {
				return
			}
			source, err := os.Open(filepath.Join(root, filepath.FromSlash(name)))
			if err != nil {
				return
			}
			target, err := archive.Create(name)
			if err == nil {
				_, err = io.Copy(target, source)
			}
			source.Close()
			if err != nil {
				return
			}
		}
	}
}
