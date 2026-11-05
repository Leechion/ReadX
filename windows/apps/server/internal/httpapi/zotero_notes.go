package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"cbctv2/server/internal/appstate"
)

type zoteroNoteLink struct {
	ServerID string `json:"serverId"`
	Parent   string `json:"parent"`
	NoteKey  string `json:"noteKey"`
	Version  int    `json:"version"`
	Text     string `json:"text"`
	NoteHTML string `json:"noteHTML"`
}
type zoteroObject struct {
	Key     string         `json:"key"`
	Version int            `json:"version"`
	Data    map[string]any `json:"data"`
}

func (s *Server) handleZoteroDraft(w http.ResponseWriter, r *http.Request) {
	doc, e := s.loadDocument(r.Context(), r.URL.Query().Get("documentKey"))
	if e != nil {
		writeError(w, 404, "文献不存在")
		return
	}
	var text strings.Builder
	fmt.Fprintf(&text, "ReadX · %s\n阅读状态：%s\nDOI：%s\n", doc.Title, doc.Status, doc.DOI)
	rows, e := s.handle.QueryContext(r.Context(), `SELECT page,quote,note FROM annotations WHERE document_id=? ORDER BY page,created_at`, doc.ID)
	if e != nil {
		writeError(w, 500, e.Error())
		return
	}
	for rows.Next() {
		var page *int
		var quote, note string
		if e = rows.Scan(&page, &quote, &note); e != nil {
			break
		}
		label := "章节位置"
		if page != nil {
			label = fmt.Sprintf("PDF 页序 %d", *page)
		}
		fmt.Fprintf(&text, "\n[个人批注 · %s]\n%s\n%s\n", label, quote, note)
	}
	rows.Close()
	if e != nil {
		writeError(w, 500, e.Error())
		return
	}
	var raw string
	_ = s.handle.QueryRowContext(r.Context(), `SELECT value_json FROM readings WHERE document_id=?`, doc.ID).Scan(&raw)
	entries := map[string]ReadingEntry{}
	_ = json.Unmarshal([]byte(raw), &entries)
	for _, kind := range []string{"motivation", "method", "experiment", "results", "reproduction"} {
		if entry, ok := entries[kind]; ok {
			fmt.Fprintf(&text, "\n[AI 精读 · %s]\n%s\n", kind, entry.Value)
		}
	}
	if text.Len() > 256<<10 {
		writeError(w, 413, "草稿超过 256 KiB，请减少材料后自行粘贴所需部分")
		return
	}
	writeJSON(w, 200, map[string]string{"draft": text.String()})
}
func (s *Server) zoteroLocal(ctx context.Context, method, resource string, payload any, serverID, key string) ([]byte, http.Header, int, error) {
	base := "http://127.0.0.1:23119/api"
	if s.zoteroTestURL != "" {
		base = s.zoteroTestURL
	}
	var body io.Reader
	var encoded []byte
	if payload != nil {
		raw, e := json.Marshal(payload)
		if e != nil {
			return nil, nil, 0, e
		}
		body = bytes.NewReader(raw)
		encoded = raw
	}
	req, e := http.NewRequestWithContext(ctx, method, base+resource, body)
	if e != nil {
		return nil, nil, 0, e
	}
	req.Header.Set("Zotero-API-Version", "3")
	req.Header.Set("Content-Type", "application/json")
	if method != "GET" && resource != "/local/authorize" {
		sum := sha256.Sum256(append([]byte(serverID+method+resource), encoded...))
		req.Header.Set("Zotero-Write-Token", hex.EncodeToString(sum[:16]))
	}
	if object, ok := payload.(map[string]any); ok {
		if version, ok := object["version"].(int); ok {
			req.Header.Set("If-Unmodified-Since-Version", fmt.Sprint(version))
		}
	}
	if serverID != "" {
		req.Header.Set("Zotero-Server-ID", serverID)
	}
	if key != "" {
		req.Header.Set("Zotero-API-Key", key)
	}
	response, e := zoteroLocalClient.Do(req)
	if e != nil {
		return nil, nil, 0, e
	}
	defer response.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if e != nil {
		return nil, nil, 0, e
	}
	return raw, response.Header, response.StatusCode, nil
}
func (s *Server) zoteroServerID(ctx context.Context) (string, error) {
	_, headers, status, e := s.zoteroLocal(ctx, "GET", "/", nil, "", "")
	if e != nil {
		return "", e
	}
	if status != 200 {
		return "", fmt.Errorf("Zotero 本机 API 返回 %d", status)
	}
	id := headers.Get("Zotero-Server-ID")
	if id == "" {
		return "", fmt.Errorf("此功能需要提供 Server-ID 的新版 Zotero；旧版仍可使用现有 PDF 导入")
	}
	return id, nil
}
func (s *Server) handleZoteroAuthorize(w http.ResponseWriter, r *http.Request) {
	s.zoteroWriteMu.Lock()
	defer s.zoteroWriteMu.Unlock()
	id, e := s.zoteroServerID(r.Context())
	if e != nil {
		writeError(w, 409, e.Error())
		return
	}
	raw, _, status, e := s.zoteroLocal(r.Context(), "POST", "/local/authorize", map[string]string{"appName": "ReadX — 用户确认的研究笔记回写"}, id, "")
	if e != nil {
		writeError(w, 502, e.Error())
		return
	}
	if status != 200 {
		writeError(w, status, "Zotero 未授予写入权限，请在 Zotero 中确认；重复请求可能被限流")
		return
	}
	var grant struct {
		Key      string `json:"key"`
		Remember bool   `json:"remember"`
	}
	if e = json.Unmarshal(raw, &grant); e != nil || len(grant.Key) != 32 {
		writeError(w, 502, "Zotero 授权响应无效")
		return
	}
	s.zoteroWriteKey = grant.Key
	s.zoteroWriteRemember = grant.Remember
	s.zoteroWriteServer = id
	writeJSON(w, 200, map[string]any{"authorized": true, "remember": grant.Remember, "serverId": id, "disclosure": "只在内存保留授权，不返回密钥。写入本机 Zotero 的内容可能随后由 Zotero 自己的同步上传。"})
}
func (s *Server) handleZoteroSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		var raw string
		err := s.handle.QueryRowContext(r.Context(), `SELECT value_json FROM app_state WHERE key LIKE 'zotero.snapshot:%' ORDER BY updated_at DESC LIMIT 1`).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, 200, map[string]any{"serverId": "", "collections": []any{}, "items": []any{}, "disclosure": "尚未读取快照"})
			return
		}
		if err != nil {
			writeError(w, 500, "读取 Zotero 快照失败")
			return
		}
		var snapshot any
		if json.Unmarshal([]byte(raw), &snapshot) != nil {
			writeError(w, 500, "Zotero 快照损坏")
			return
		}
		writeJSON(w, 200, snapshot)
		return
	}
	id, e := s.zoteroServerID(r.Context())
	if e != nil {
		writeError(w, 409, e.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	snapshot := map[string]any{"serverId": id, "at": time.Now().UTC().Format(time.RFC3339), "disclosure": "本机题录、集合关系和笔记原始数据快照；不含附件二进制，不等于完整文库迁移。"}
	for _, resource := range []string{"collections", "items"} {
		objects := []zoteroObject{}
		for page := 0; ; page++ {
			raw, _, status, e := s.zoteroLocal(ctx, "GET", "/users/0/"+resource+"?limit=100&start="+fmt.Sprint(page*100), nil, id, "")
			if e != nil {
				writeError(w, 502, e.Error())
				return
			}
			if status != 200 {
				writeError(w, 502, fmt.Sprintf("Zotero %s 返回 %d，未保存部分快照", resource, status))
				return
			}
			var batch []zoteroObject
			if e = json.Unmarshal(raw, &batch); e != nil {
				writeError(w, 502, e.Error())
				return
			}
			objects = append(objects, batch...)
			if len(batch) < 100 {
				break
			}
		}
		snapshot[resource] = objects
	}
	if e = appstate.Save(r.Context(), s.appStateStore, "zotero.snapshot:"+id, snapshot); e != nil {
		writeError(w, 500, e.Error())
		return
	}
	writeJSON(w, 200, snapshot)
}
func zoteroLinkKey(serverID, document string) string {
	return "zotero.note-link:" + serverID + ":" + document
}
func (s *Server) handleZoteroNote(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		document := r.URL.Query().Get("documentKey")
		id, e := s.zoteroServerID(r.Context())
		if e != nil {
			writeError(w, 409, e.Error())
			return
		}
		link, exists, e := appstate.Load[zoteroNoteLink](r.Context(), s.appStateStore, zoteroLinkKey(id, document))
		if e != nil {
			writeError(w, 500, e.Error())
			return
		}
		if !exists {
			writeJSON(w, 200, map[string]any{"linked": false})
			return
		}
		raw, _, status, e := s.zoteroLocal(r.Context(), "GET", "/users/0/items/"+url.PathEscape(link.NoteKey), nil, id, "")
		if e != nil || status != 200 {
			writeError(w, 409, "远端笔记不可读，未删除本地映射")
			return
		}
		var object zoteroObject
		if json.Unmarshal(raw, &object) != nil {
			writeError(w, 502, "笔记数据无效")
			return
		}
		remoteHTML, _ := object.Data["note"].(string)
		writeJSON(w, 200, map[string]any{"linked": true, "parent": link.Parent, "noteKey": link.NoteKey, "version": object.Version, "localText": link.Text, "remoteHTML": remoteHTML, "changed": object.Version != link.Version})
		return
	}
	var body struct {
		DocumentKey string `json:"documentKey"`
		Parent      string `json:"parent"`
		Text        string `json:"text"`
		Version     int    `json:"version"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if !zoteroKeyPattern.MatchString(body.Parent) || len(body.Text) > 256<<10 || strings.TrimSpace(body.Text) == "" {
		writeError(w, 400, "请选择 Zotero 父条目并填写不超过 256 KiB 的笔记")
		return
	}
	if _, e := s.loadDocument(r.Context(), body.DocumentKey); e != nil {
		writeError(w, 404, "本地文献不存在")
		return
	}
	s.zoteroWriteMu.Lock()
	defer s.zoteroWriteMu.Unlock()
	id, e := s.zoteroServerID(r.Context())
	if e != nil {
		writeError(w, 409, e.Error())
		return
	}
	if s.zoteroWriteKey == "" || s.zoteroWriteServer != id {
		writeError(w, 401, "请先授权当前 Zotero 实例写入")
		return
	}
	key := s.zoteroWriteKey
	link, exists, e := appstate.Load[zoteroNoteLink](r.Context(), s.appStateStore, zoteroLinkKey(id, body.DocumentKey))
	if e != nil {
		writeError(w, 500, e.Error())
		return
	}
	if exists && link.Parent != body.Parent {
		writeError(w, 409, "已有映射指向另一父条目，未覆盖，请先核对")
		return
	}
	noteHTML := "<div><p>ReadX document: " + html.EscapeString(body.DocumentKey) + "</p><pre>" + html.EscapeString(body.Text) + "</pre></div>"
	if !exists {
		// Recover a successful creation whose response or local persistence was lost.
		raw, _, status, fetchErr := s.zoteroLocal(r.Context(), "GET", "/users/0/items/"+body.Parent+"/children", nil, id, "")
		if fetchErr != nil || status != 200 {
			writeError(w, 502, "无法核对已有子笔记，未创建新笔记")
			return
		}
		var children []zoteroObject
		if json.Unmarshal(raw, &children) != nil {
			writeError(w, 502, "子笔记响应无效")
			return
		}
		for _, child := range children {
			note, _ := child.Data["note"].(string)
			if strings.Contains(note, "<p>ReadX document: "+html.EscapeString(body.DocumentKey)+"</p>") {
				link = zoteroNoteLink{ServerID: id, Parent: body.Parent, NoteKey: child.Key, Version: child.Version, NoteHTML: note}
				exists = true
				if err := appstate.Save(r.Context(), s.appStateStore, zoteroLinkKey(id, body.DocumentKey), link); err != nil {
					writeError(w, 500, "发现已有子笔记，但映射保存失败；未创建或覆盖笔记")
					return
				}
				writeError(w, 409, "发现已有 ReadX 子笔记，已恢复映射；请先读取并核对版本再写回")
				return
			}
		}
	}
	var raw []byte
	var status int
	if exists {
		if body.Version <= 0 {
			writeError(w, 409, "请先读取远端笔记并确认版本")
			return
		}
		data := map[string]any{"key": link.NoteKey, "version": body.Version, "itemType": "note", "parentItem": body.Parent, "note": noteHTML}
		if !s.zoteroWriteRemember {
			s.zoteroWriteKey = ""
		}
		raw, _, status, e = s.zoteroLocal(r.Context(), "PUT", "/users/0/items/"+link.NoteKey, data, id, key)
		if e == nil && status >= 200 && status < 300 {
			current, _, code, readErr := s.zoteroLocal(r.Context(), "GET", "/users/0/items/"+link.NoteKey, nil, id, "")
			var object zoteroObject
			if readErr != nil || code != 200 || json.Unmarshal(current, &object) != nil {
				writeError(w, 502, "写入可能已成功，但无法确认版本；请先读取远端核对")
				return
			}
			link.Version = object.Version
		}
	} else {
		if !s.zoteroWriteRemember {
			s.zoteroWriteKey = ""
		}
		raw, _, status, e = s.zoteroLocal(r.Context(), "POST", "/users/0/items", []map[string]any{{"itemType": "note", "parentItem": body.Parent, "note": noteHTML}}, id, key)
		if e == nil && status >= 200 && status < 300 {
			var result struct {
				Successful map[string]zoteroObject `json:"successful"`
				Failed     map[string]any          `json:"failed"`
			}
			if json.Unmarshal(raw, &result) != nil || len(result.Failed) > 0 || result.Successful["0"].Key == "" {
				writeError(w, 502, "Zotero 未确认创建成功，请先核对远端")
				return
			}
			object := result.Successful["0"]
			link = zoteroNoteLink{ServerID: id, Parent: body.Parent, NoteKey: object.Key, Version: object.Version}
		}
	}
	if e != nil {
		writeError(w, 502, "写回结果未确认，请读取远端核对后再重试")
		return
	}
	if status == 401 {
		s.zoteroWriteKey = ""
	}
	if status == 412 {
		writeError(w, 409, "Zotero 笔记版本冲突，未覆盖远端，请读取后人工核对")
		return
	}
	if status < 200 || status >= 300 {
		writeError(w, 502, fmt.Sprintf("Zotero 写入返回 %d，未确认保存", status))
		return
	}
	link.Text = body.Text
	link.NoteHTML = noteHTML
	if e = appstate.Save(r.Context(), s.appStateStore, zoteroLinkKey(id, body.DocumentKey), link); e != nil {
		writeError(w, 500, "远端已写入，但本地映射保存失败；下次先读取核对")
		return
	}
	writeJSON(w, 200, map[string]any{"saved": true, "noteKey": link.NoteKey, "version": link.Version, "disclosure": "已写入 ReadX 专属子笔记；未修改原有用户笔记、附件或删除对象。Zotero 自身同步可能随后上传此内容。"})
}
