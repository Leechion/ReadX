package httpapi

import (
	"cbctv2/server/internal/appstate"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"sort"
	"strings"
	"time"
)

type zoteroSyncEntry struct {
	ObjectID      string         `json:"objectId"`
	State         string         `json:"state"`
	Revision      int            `json:"revision"`
	Local         map[string]any `json:"local"`
	Remote        map[string]any `json:"remote"`
	RemoteVersion int            `json:"remoteVersion"`
	Documents     []string       `json:"documentKeys"`
	Error         string         `json:"error,omitempty"`
}
type zoteroSyncPlan struct {
	ID          string            `json:"id"`
	MigrationID string            `json:"migrationId"`
	ServerID    string            `json:"serverId"`
	At          time.Time         `json:"at"`
	Entries     []zoteroSyncEntry `json:"entries"`
	Disclosure  string            `json:"disclosure"`
}

func zoteroEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}
func zoteroComparable(data map[string]any) map[string]any {
	result := zoteroClone(data)
	for _, key := range []string{"key", "version", "dateAdded", "dateModified"} {
		delete(result, key)
	}
	return result
}
func zoteroNoteValues(data map[string]any) (string, string) {
	if zoteroString(data, "itemType") == "note" {
		return "", "[Zotero 笔记]\n" + zoteroPlainNote(zoteroString(data, "note"))
	}
	return zoteroString(data, "annotationText"), "[Zotero 原生批注；原始坐标保留在迁移档案]\n" + zoteroString(data, "annotationComment")
}

func (s *Server) zoteroLocalView(ctx context.Context, state zoteroMigration, object zoteroMirrorObject) (map[string]any, error) {
	local := zoteroClone(object.Local)
	if len(object.Documents) > 0 && object.DocumentBase != nil {
		doc, err := s.loadDocument(ctx, object.Documents[0])
		if err != nil {
			return nil, err
		}
		fields := zoteroDocumentFields(doc)
		for source, target := range map[string]string{"title": "title", "doi": "DOI", "venue": "publicationTitle"} {
			if !zoteroEqual(fields[source], object.DocumentBase[source]) {
				if source == "venue" && local["proceedingsTitle"] != nil {
					target = "proceedingsTitle"
				}
				if !zoteroEqual(local[target], object.Base[target]) && !zoteroEqual(local[target], fields[source]) {
					return local, fmt.Errorf("本地镜像与书库题录同时修改了 %s，请先统一或明确采用 Zotero", source)
				}
				local[target] = fields[source]
			}
		}
		if !zoteroEqual(fields["authors"], object.DocumentBase["authors"]) {
			if !zoteroEqual(local["creators"], object.Base["creators"]) && !zoteroEqual(zoteroCreators(local["creators"]), doc.Authors) {
				return local, fmt.Errorf("本地镜像与书库作者同时修改，请先统一或明确采用 Zotero")
			}
			creators := []any{}
			if prior, ok := local["creators"].([]any); ok {
				for _, entry := range prior {
					if person, ok := entry.(map[string]any); ok && zoteroString(person, "creatorType") != "author" {
						creators = append(creators, person)
					}
				}
			}
			for _, name := range doc.Authors {
				creators = append(creators, map[string]any{"creatorType": "author", "name": name})
			}
			local["creators"] = creators
		}
		if !zoteroEqual(fields["year"], object.DocumentBase["year"]) {
			year := ""
			if doc.Year != nil {
				year = fmt.Sprint(*doc.Year)
				before := zoteroString(object.Base, "date")
				if location := zoteroYearPattern.FindStringIndex(before); location != nil {
					year = before[:location[0]] + year + before[location[1]:]
				}
			}
			if !zoteroEqual(local["date"], object.Base["date"]) && !zoteroEqual(local["date"], year) {
				return local, fmt.Errorf("本地镜像与书库年份同时修改，请先统一或明确采用 Zotero")
			}
			local["date"] = year
		}
		if before, exists := object.DocumentBase["categories"]; exists {
			meta, err := s.loadMeta(ctx, doc.Key)
			if err != nil {
				return nil, err
			}
			if !zoteroEqual(meta.Categories, before) {
				categories, err := s.loadCategories(ctx)
				if err != nil {
					return nil, err
				}
				byName := map[string]string{}
				for _, category := range categories {
					for _, mirror := range state.Objects {
						if mirror.Kind == "collections" && category.ID == "zotero-"+state.ID+"-"+mirror.Key {
							byName[category.Name] = mirror.Key
						}
					}
				}
				selected := []string{}
				for _, name := range meta.Categories {
					if key := byName[name]; key != "" {
						selected = appendUnique(selected, key)
					}
				}
				baseCollections := zoteroStrings(object.Base["collections"])
				mirrorCollections := zoteroStrings(local["collections"])
				sort.Strings(baseCollections)
				sort.Strings(mirrorCollections)
				sort.Strings(selected)
				if !zoteroEqual(selected, baseCollections) {
					if !zoteroEqual(mirrorCollections, baseCollections) && !zoteroEqual(mirrorCollections, selected) {
						return local, fmt.Errorf("本地镜像与书库的集合归属同时修改，请先统一或明确采用 Zotero")
					}
					local["collections"] = selected
				}
			}
		}
	}
	expectedQuote, expectedNote := zoteroNoteValues(object.Base)
	var changed map[string]any
	for _, id := range object.AnnotationIDs {
		var quote, note string
		err := s.handle.QueryRowContext(ctx, `SELECT quote,note FROM annotations WHERE id=?`, id).Scan(&quote, &note)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return nil, err
		}
		if quote == expectedQuote && note == expectedNote {
			continue
		}
		localQuote, localNote := zoteroNoteValues(local)
		if (localQuote != expectedQuote || localNote != expectedNote) && (localQuote != quote || localNote != note) {
			return local, fmt.Errorf("本地镜像与阅读器批注同时修改且内容不同，请先统一或明确采用 Zotero")
		}
		edited := zoteroClone(local)
		if zoteroString(local, "itemType") == "note" {
			text := strings.TrimPrefix(note, "[Zotero 笔记]\n")
			edited["note"] = "<div>" + strings.ReplaceAll(html.EscapeString(text), "\n", "<br/>") + "</div>"
		} else {
			edited["annotationText"] = quote
			edited["annotationComment"] = strings.TrimPrefix(note, "[Zotero 原生批注；原始坐标保留在迁移档案]\n")
		}
		if changed != nil && !zoteroEqual(changed, edited) {
			return local, fmt.Errorf("多个本地附件视图的批注修改不同，请先统一或明确采用 Zotero 内容")
		}
		changed = edited
	}
	if changed != nil {
		local = changed
	}
	return local, nil
}

func (s *Server) handleZoteroMirrorEdit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MigrationID string         `json:"migrationId"`
		ObjectID    string         `json:"objectId"`
		Revision    int            `json:"revision"`
		Data        map[string]any `json:"data"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	s.zoteroMigrationMu.Lock()
	defer s.zoteroMigrationMu.Unlock()
	state, err := s.loadZoteroMigration(r.Context(), body.MigrationID)
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	object, exists := state.Objects[body.ObjectID]
	if !exists || body.Data == nil {
		writeError(w, 400, "对象不存在或编辑内容无效")
		return
	}
	if object.Revision != body.Revision {
		writeError(w, 409, "本地对象已变化，请重新读取")
		return
	}
	for _, field := range []string{"key", "version", "itemType", "parentItem", "linkMode", "path", "filename", "md5", "mtime", "contentType"} {
		if !zoteroEqual(body.Data[field], object.Local[field]) {
			writeError(w, 400, "此编辑器不能更改对象身份、父条目或附件原文件字段："+field)
			return
		}
	}
	object.Local = zoteroClone(body.Data)
	object.Revision++
	state.Objects[body.ObjectID] = object
	if err = s.saveZoteroMigration(r.Context(), state); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, object)
}

func (s *Server) handleZoteroReconcile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MigrationID string   `json:"migrationId"`
		Objects     []string `json:"objects"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	s.zoteroMigrationMu.Lock()
	defer s.zoteroMigrationMu.Unlock()
	state, err := s.loadZoteroMigration(r.Context(), body.MigrationID)
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	id, err := s.zoteroServerID(r.Context())
	if err != nil || id != state.ServerID {
		writeError(w, 409, "无法确认同一 Zotero 实例，请重新连接")
		return
	}
	if len(body.Objects) == 0 {
		for key := range state.Objects {
			body.Objects = append(body.Objects, key)
		}
		sort.Strings(body.Objects)
	}
	if len(body.Objects) > 100 {
		writeError(w, 400, "每次最多核对 100 个对象，请在界面分批选择")
		return
	}
	planID, err := randomLeeJobID()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	plan := zoteroSyncPlan{ID: planID, MigrationID: state.ID, ServerID: id, At: time.Now().UTC(), Entries: []zoteroSyncEntry{}, Disclosure: "核对只读取 Zotero，不自动覆盖任何一端；双边改动列为冲突。每个对象应用时重新校验版本。缺失对象不传播删除；附件原文件不反向覆盖。"}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	seen := map[string]bool{}
	for _, key := range body.Objects {
		if seen[key] {
			continue
		}
		seen[key] = true
		object, ok := state.Objects[key]
		if !ok {
			writeError(w, 400, "未知对象")
			return
		}
		local, localErr := s.zoteroLocalView(ctx, state, object)
		entry := zoteroSyncEntry{ObjectID: key, Revision: object.Revision, Local: local, Documents: object.Documents}
		raw, _, status, err := s.zoteroLocal(ctx, "GET", "/users/0/"+object.Kind+"/"+object.Key, nil, id, "")
		if status == 404 {
			entry.State = "remote-missing"
		} else if err != nil || status != 200 {
			entry.State = "error"
			entry.Error = fmt.Sprintf("本机 API 未返回对象（%d）", status)
		} else {
			var remote zoteroObject
			if err = json.Unmarshal(raw, &remote); err != nil {
				entry.State = "error"
				entry.Error = err.Error()
			} else {
				entry.Remote = zoteroClone(remote.Data)
				entry.RemoteVersion = remote.Version
				localChanged := !zoteroEqual(zoteroComparable(local), zoteroComparable(object.Base))
				remoteChanged := !zoteroEqual(zoteroComparable(remote.Data), zoteroComparable(object.Base))
				switch {
				case zoteroEqual(zoteroComparable(local), zoteroComparable(remote.Data)):
					entry.State = "unchanged"
				case localChanged && remoteChanged:
					entry.State = "conflict"
				case localChanged:
					entry.State = "push"
				case remoteChanged:
					entry.State = "pull"
				default:
					entry.State = "unchanged"
				}
			}
		}
		if localErr != nil {
			entry.State = "local-conflict"
			entry.Error = localErr.Error()
		}
		plan.Entries = append(plan.Entries, entry)
	}
	if err = appstate.Save(r.Context(), s.appStateStore, "zotero.sync-plan:"+plan.ID, plan); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, plan)
}

func (s *Server) handleZoteroReconcileApply(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PlanID    string   `json:"planId"`
		ObjectID  string   `json:"objectId"`
		Choice    string   `json:"choice"`
		Documents []string `json:"documentKeys"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if body.Choice != "pull" && body.Choice != "push" {
		writeError(w, 400, "请选择采用 Zotero 或 ReadX")
		return
	}
	s.zoteroMigrationMu.Lock()
	defer s.zoteroMigrationMu.Unlock()
	plan, exists, err := appstate.Load[zoteroSyncPlan](r.Context(), s.appStateStore, "zotero.sync-plan:"+body.PlanID)
	if err != nil || !exists || time.Since(plan.At) > 15*time.Minute {
		writeError(w, 409, "核对计划已失效，请重新核对")
		return
	}
	var planned *zoteroSyncEntry
	for i := range plan.Entries {
		if plan.Entries[i].ObjectID == body.ObjectID {
			planned = &plan.Entries[i]
		}
	}
	if planned == nil || planned.State == "error" || planned.State == "remote-missing" || planned.State == "unchanged" || (planned.State == "local-conflict" && body.Choice == "push") {
		writeError(w, 409, "当前对象不能执行此操作")
		return
	}
	state, err := s.loadZoteroMigration(r.Context(), plan.MigrationID)
	if err != nil {
		writeError(w, 404, err.Error())
		return
	}
	object, ok := state.Objects[body.ObjectID]
	if !ok || object.Revision != planned.Revision || !zoteroEqual(body.Documents, object.Documents) {
		writeError(w, 409, "对象或关联论文已变化，请重新核对")
		return
	}
	current, localErr := s.zoteroLocalView(r.Context(), state, object)
	if (localErr != nil && planned.State != "local-conflict") || !zoteroEqual(current, planned.Local) {
		writeError(w, 409, "本地编辑已变化，请重新核对")
		return
	}
	id, err := s.zoteroServerID(r.Context())
	if err != nil || id != plan.ServerID {
		writeError(w, 409, "Zotero 实例已变化")
		return
	}
	raw, _, status, err := s.zoteroLocal(r.Context(), "GET", "/users/0/"+object.Kind+"/"+object.Key, nil, id, "")
	var remote zoteroObject
	if err != nil || status != 200 || json.Unmarshal(raw, &remote) != nil || remote.Version != planned.RemoteVersion || !zoteroEqual(remote.Data, planned.Remote) {
		writeError(w, 409, "Zotero 对象已变化，请重新核对")
		return
	}
	if body.Choice == "push" {
		s.zoteroWriteMu.Lock()
		if s.zoteroWriteKey == "" || s.zoteroWriteServer != id {
			s.zoteroWriteMu.Unlock()
			writeError(w, 401, "请先授予当前 Zotero 实例写入权限")
			return
		}
		key := s.zoteroWriteKey
		if !s.zoteroWriteRemember {
			s.zoteroWriteKey = ""
		}
		data := zoteroClone(planned.Local)
		data["key"] = object.Key
		data["version"] = remote.Version
		_, _, status, err = s.zoteroLocal(r.Context(), "PUT", "/users/0/"+object.Kind+"/"+object.Key, data, id, key)
		if status == 401 {
			s.zoteroWriteKey = ""
		}
		s.zoteroWriteMu.Unlock()
		if err != nil {
			writeError(w, 502, "写入结果未确认，请先重新核对远端")
			return
		}
		if status == 412 {
			writeError(w, 409, "远端版本冲突，未覆盖，请重新核对")
			return
		}
		if status < 200 || status >= 300 {
			writeError(w, 502, fmt.Sprintf("Zotero 拒绝写入（%d）", status))
			return
		}
		raw, _, status, err = s.zoteroLocal(r.Context(), "GET", "/users/0/"+object.Kind+"/"+object.Key, nil, id, "")
		if err != nil || status != 200 || json.Unmarshal(raw, &remote) != nil {
			writeError(w, 502, "远端可能已写入，但无法确认最新对象；请重新核对")
			return
		}
	}
	object.Base = zoteroClone(remote.Data)
	object.Local = zoteroClone(remote.Data)
	object.Version = remote.Version
	object.Revision++
	state.Objects[body.ObjectID] = object
	if err = s.reflectZoteroObject(r.Context(), &state, body.ObjectID); err != nil {
		writeError(w, 500, "本地映射未完成，原计划保留，请核对后重试："+err.Error())
		return
	}
	if err = s.saveZoteroMigration(r.Context(), state); err != nil {
		writeError(w, 500, "本地状态保存失败，请重新核对")
		return
	}
	writeJSON(w, 200, map[string]any{"saved": true, "object": state.Objects[body.ObjectID], "disclosure": "已应用本次明确选择；未传播删除或覆盖原文件。再次同步前请重新核对。"})
	s.processingMu.Lock()
	s.revokeProcessingLocked()
	s.processingMu.Unlock()
}

func (s *Server) reflectZoteroObject(ctx context.Context, state *zoteroMigration, key string) error {
	object := state.Objects[key]
	kind := zoteroString(object.Local, "itemType")
	if object.Kind == "items" && kind != "note" && kind != "annotation" && kind != "attachment" {
		metadata := zoteroMetadata(object.Local)
		authors, _ := json.Marshal(metadata.Authors)
		var year any
		if metadata.Year > 0 {
			year = metadata.Year
		}
		for _, key := range object.Documents {
			if _, err := s.handle.ExecContext(ctx, `UPDATE documents SET title=?,authors=?,doi=?,venue=?,year=?,updated_at=? WHERE key=?`, metadata.Title, string(authors), metadata.DOI, metadata.Venue, year, nowStamp(), key); err != nil {
				return err
			}
		}
		if len(object.Documents) > 0 {
			doc, err := s.loadDocument(ctx, object.Documents[0])
			if err != nil {
				return err
			}
			object.DocumentBase = zoteroDocumentFields(doc)
			state.Objects[key] = object
		}
	}
	if err := s.installZoteroNote(ctx, state, key, true); err != nil {
		return err
	}
	docs := []string{}
	if object.Kind == "items" && kind != "note" && kind != "annotation" && kind != "attachment" {
		docs = object.Documents
	}
	if err := s.installZoteroCollections(ctx, state, docs); err != nil {
		return err
	}
	return nil
}
