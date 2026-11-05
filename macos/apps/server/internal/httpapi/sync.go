package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"cbctv2/server/internal/appstate"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/syncmerge"
)

const syncStateKey = "sync.local-state"

type localSyncState struct {
	Provider   string                         `json:"provider,omitempty"`
	WebDAVURL  string                         `json:"webdavUrl,omitempty"`
	WebDAVUser string                         `json:"webdavUsername,omitempty"`
	FolderPath string                         `json:"folderPath"`
	DeviceID   string                         `json:"deviceId"`
	Counter    uint64                         `json:"counter"`
	Base       map[string][]syncmerge.Version `json:"base"`
	LastSync   string                         `json:"lastSync,omitempty"`
	Profiles   map[string]syncReplicaState    `json:"profiles,omitempty"`
}

type syncReplicaState struct {
	DeviceID string                         `json:"deviceId"`
	Counter  uint64                         `json:"counter"`
	Base     map[string][]syncmerge.Version `json:"base"`
	LastSync string                         `json:"lastSync,omitempty"`
}

type syncDocument struct {
	Key             string `json:"key"`
	Title           string `json:"title"`
	TranslatedTitle string `json:"translatedTitle"`
	Authors         string `json:"authors"`
	Year            *int   `json:"year"`
	Venue           string `json:"venue"`
	DOI             string `json:"doi"`
	URL             string `json:"url"`
	Status          string `json:"status"`
	AddedAt         string `json:"addedAt"`
	UpdatedAt       string `json:"updatedAt"`
	Format          string `json:"format"`
	RawJSON         string `json:"rawJson"`
	AssetHash       string `json:"assetHash,omitempty"`
	AssetExt        string `json:"assetExt,omitempty"`
}

type syncAnnotation struct {
	ID          string          `json:"id"`
	DocumentKey string          `json:"documentKey"`
	Page        *int            `json:"page"`
	Quote       string          `json:"quote"`
	Note        string          `json:"note"`
	Color       string          `json:"color"`
	Tags        string          `json:"tags"`
	Kind        string          `json:"kind"`
	StartOffset *int            `json:"startOffset"`
	EndOffset   *int            `json:"endOffset"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt"`
	Locator     json.RawMessage `json:"locator"`
}

type syncLocation struct {
	Value     json.RawMessage `json:"value"`
	UpdatedAt string          `json:"updatedAt"`
}

type syncSection struct {
	DocumentKey string `json:"documentKey"`
	Ordinal     int    `json:"ordinal"`
	Href        string `json:"href"`
	Title       string `json:"title"`
	BlocksJSON  string `json:"blocksJson"`
	Text        string `json:"text"`
}

type syncPage struct {
	DocumentKey string `json:"documentKey"`
	Page        int    `json:"page"`
	Text        string `json:"text"`
	Hash        string `json:"hash"`
	UpdatedAt   string `json:"updatedAt"`
}

type syncQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Server) handleSyncSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		state, err := s.loadLocalSyncState(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "读取同步设置失败")
			return
		}
		provider := state.Provider
		if provider == "" {
			provider = "folder"
		}
		writeJSON(w, http.StatusOK, map[string]any{"enabled": state.FolderPath != "", "provider": provider, "folderPath": state.FolderPath, "webdavUsername": state.WebDAVUser, "lastSync": state.LastSync})
		return
	}
	if r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET 或 PUT")
		return
	}
	var body struct {
		Provider       string `json:"provider"`
		FolderPath     string `json:"folderPath"`
		WebDAVUsername string `json:"webdavUsername"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	provider := strings.TrimSpace(body.Provider)
	if provider == "" {
		provider = "folder"
	}
	if provider != "folder" && provider != "jianguoyun" {
		writeError(w, http.StatusBadRequest, "不支持的同步服务商")
		return
	}
	folder := strings.TrimSpace(body.FolderPath)
	webdavUser := strings.TrimSpace(body.WebDAVUsername)
	if provider == "jianguoyun" {
		if webdavUser == "" {
			writeError(w, http.StatusBadRequest, "请输入坚果云账号邮箱")
			return
		}
		folder = filepath.Join(s.cfg.DataRoot, "app", "data", "sync-cache", "jianguoyun-"+syncKeyPart(webdavUser))
		if err := os.MkdirAll(folder, 0o700); err != nil {
			writeError(w, http.StatusInternalServerError, "创建坚果云同步缓存失败")
			return
		}
	} else if folder != "" {
		abs, err := filepath.Abs(folder)
		if err != nil {
			writeError(w, http.StatusBadRequest, "同步目录路径无效")
			return
		}
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			writeError(w, http.StatusBadRequest, "同步目录不存在或不是文件夹")
			return
		}
		folder = abs
	}
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	state, err := s.loadLocalSyncState(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取同步设置失败")
		return
	}
	if state.FolderPath != folder {
		state.switchFolder(folder)
	}
	state.Provider = provider
	state.WebDAVUser = webdavUser
	if provider == "jianguoyun" {
		state.WebDAVURL = nutstoreDAVRoot
	} else {
		state.WebDAVURL = ""
	}
	if err := s.saveLocalSyncState(r.Context(), state); err != nil {
		writeError(w, http.StatusInternalServerError, "保存同步设置失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": folder != "", "provider": provider, "folderPath": folder, "webdavUsername": webdavUser, "lastSync": state.LastSync})
}

func (s *Server) handleSyncNow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "只允许 POST")
		return
	}
	var request struct {
		Password string `json:"password"`
	}
	if decodeJSON(w, r, &request) != nil {
		return
	}
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	state, err := s.loadLocalSyncState(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取同步状态失败")
		return
	}
	if state.FolderPath == "" {
		writeError(w, http.StatusConflict, "请先配置同步服务商")
		return
	}
	var nutstore *nutstoreWebDAV
	if state.Provider == "jianguoyun" {
		if request.Password == "" {
			writeError(w, http.StatusUnauthorized, "请在同步设置中填写坚果云应用密码")
			return
		}
		nutstore = newNutstoreWebDAV(state.WebDAVUser, request.Password)
		if err := nutstore.downloadPeerStates(r.Context(), state.FolderPath); err != nil {
			writeError(w, http.StatusBadGateway, "连接坚果云失败："+err.Error())
			return
		}
	}
	if state.DeviceID == "" {
		state.DeviceID, err = syncmerge.NewDeviceID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "创建设备标识失败")
			return
		}
	}
	if state.Counter == 0 {
		state.Counter = 1
	}
	observed, err := s.snapshotSyncEntities(r.Context(), s.handle, state.FolderPath, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取本机书库、阅读进度或笔记失败: "+err.Error())
		return
	}
	local, nextCounter, err := syncmerge.Reconcile(state.DeviceID, state.Counter, observed, state.Base, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "记录本机修改失败: "+err.Error())
		return
	}
	merged, err := syncmerge.FolderSync(state.FolderPath, state.DeviceID, local)
	if err != nil {
		writeError(w, http.StatusBadGateway, "同步文件夹暂不可用: "+err.Error())
		return
	}
	// The first shared manifest is durable now. Persist its device counter before
	// any follow-up manifest write so a retry cannot reuse its clocks.
	state.Counter = nextCounter
	if err := s.saveLocalSyncState(r.Context(), state); err != nil {
		writeError(w, http.StatusInternalServerError, "同步清单已发布，但保存本机设备游标失败: "+err.Error())
		return
	}
	expanded, changed, err := expandConflictAnnotations(merged)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "展开并发笔记冲突失败: "+err.Error())
		return
	}
	if changed {
		merged, err = syncmerge.FolderSync(state.FolderPath, state.DeviceID, expanded)
		if err != nil {
			writeError(w, http.StatusBadGateway, "发布并发笔记副本失败: "+err.Error())
			return
		}
	}
	if nutstore != nil {
		if err := nutstore.downloadAssets(r.Context(), state.FolderPath, merged); err != nil {
			writeError(w, http.StatusBadGateway, "下载坚果云文档附件失败："+err.Error())
			return
		}
	}
	if err := materializeSyncAssets(state.FolderPath, merged); err != nil {
		writeError(w, http.StatusBadGateway, "同步文档文件尚未完整到达: "+err.Error())
		return
	}
	if nutstore != nil {
		if err := nutstore.uploadSyncFiles(r.Context(), state.FolderPath); err != nil {
			writeError(w, http.StatusBadGateway, "写入坚果云失败："+err.Error())
			return
		}
	}

	tx, err := s.handle.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "开始应用同步数据失败")
		return
	}
	current, snapshotErr := s.snapshotSyncEntities(r.Context(), tx, state.FolderPath, true)
	if snapshotErr != nil || !sameRawEntities(observed, current) {
		_ = tx.Rollback()
		writeError(w, http.StatusConflict, "同步期间本机数据发生变化，请再点一次同步")
		return
	}
	if err := applySyncDocuments(r.Context(), tx, merged, state.FolderPath, legacy.NewPaths(s.cfg.DataRoot).LibraryDir()); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "合并书库失败: "+err.Error())
		return
	}
	if err := applySyncSections(r.Context(), tx, merged); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "合并 EPUB 章节失败: "+err.Error())
		return
	}
	if err := applySyncPages(r.Context(), tx, merged); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "合并文档文本失败: "+err.Error())
		return
	}
	if err := applySyncLocations(r.Context(), tx, merged); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "合并阅读进度失败: "+err.Error())
		return
	}
	if err := applySyncAnnotations(r.Context(), tx, merged); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "合并笔记失败: "+err.Error())
		return
	}
	if err := applySyncLibraryMeta(r.Context(), tx, merged); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "合并书库分类失败: "+err.Error())
		return
	}
	state.Base = merged
	state.Counter = nextCounter
	state.LastSync = time.Now().UTC().Format(time.RFC3339)
	if err := saveSyncStateTx(r.Context(), tx, state); err != nil {
		_ = tx.Rollback()
		writeError(w, http.StatusInternalServerError, "保存同步游标失败: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "保存同步结果失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"synced": true, "documents": countEntityKind(merged, "document/"), "annotations": countEntityKind(merged, "annotation/"), "readingPositions": countEntityKind(merged, "location/"), "lastSync": state.LastSync})
}

func (s *Server) loadLocalSyncState(ctx context.Context) (localSyncState, error) {
	state, exists, err := appstate.Load[localSyncState](ctx, s.appStateStore, syncStateKey)
	if err != nil {
		return localSyncState{}, err
	}
	if !exists {
		state = localSyncState{Base: map[string][]syncmerge.Version{}}
	}
	if state.Base == nil {
		state.Base = map[string][]syncmerge.Version{}
	}
	if state.Profiles == nil {
		state.Profiles = map[string]syncReplicaState{}
	}
	return state, nil
}

func (s *Server) saveLocalSyncState(ctx context.Context, state localSyncState) error {
	return appstate.Save(ctx, s.appStateStore, syncStateKey, state)
}

func (state *localSyncState) switchFolder(folder string) {
	if state.Profiles == nil {
		state.Profiles = map[string]syncReplicaState{}
	}
	if state.FolderPath != "" {
		state.Profiles[state.FolderPath] = syncReplicaState{DeviceID: state.DeviceID, Counter: state.Counter, Base: state.Base, LastSync: state.LastSync}
	}
	state.FolderPath = folder
	profile, exists := state.Profiles[folder]
	if folder == "" || !exists {
		state.DeviceID = ""
		state.Counter = 0
		state.Base = map[string][]syncmerge.Version{}
		state.LastSync = ""
		return
	}
	delete(state.Profiles, folder)
	state.DeviceID, state.Counter, state.Base, state.LastSync = profile.DeviceID, profile.Counter, profile.Base, profile.LastSync
	if state.Base == nil {
		state.Base = map[string][]syncmerge.Version{}
	}
}

func saveSyncStateTx(ctx context.Context, tx *sql.Tx, state localSyncState) error {
	body, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, syncStateKey, string(body), nowStamp())
	return err
}

func (s *Server) snapshotSyncEntities(ctx context.Context, q syncQueryer, folder string, publishAssets bool) (map[string]json.RawMessage, error) {
	entities := map[string]json.RawMessage{}
	rows, err := q.QueryContext(ctx, `SELECT key,title,translated_title,authors,year,venue,doi,url,status,pdf_path,added_at,updated_at,format,raw_json FROM documents WHERE key<>'' ORDER BY key`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var doc syncDocument
		var translatedTitle, pdfPath sql.NullString
		var year sql.NullInt64
		if err := rows.Scan(&doc.Key, &doc.Title, &translatedTitle, &doc.Authors, &year, &doc.Venue, &doc.DOI, &doc.URL, &doc.Status, &pdfPath, &doc.AddedAt, &doc.UpdatedAt, &doc.Format, &doc.RawJSON); err != nil {
			rows.Close()
			return nil, err
		}
		doc.TranslatedTitle = translatedTitle.String
		if year.Valid {
			y := int(year.Int64)
			doc.Year = &y
		}
		if publishAssets && pdfPath.Valid {
			doc.AssetHash, doc.AssetExt, err = publishSyncAsset(pdfPath.String, folder)
			if err != nil {
				rows.Close()
				return nil, fmt.Errorf("publish %s: %w", doc.Key, err)
			}
		}
		encoded, err := json.Marshal(doc)
		if err != nil {
			rows.Close()
			return nil, err
		}
		entities["document/"+doc.Key] = encoded
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	rows, err = q.QueryContext(ctx, `SELECT d.key,p.page,p.text,p.hash,p.updated_at FROM document_pages p JOIN documents d ON d.id=p.document_id ORDER BY d.key,p.page`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var page syncPage
		if err := rows.Scan(&page.DocumentKey, &page.Page, &page.Text, &page.Hash, &page.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		encoded, err := json.Marshal(page)
		if err != nil {
			rows.Close()
			return nil, err
		}
		entities[fmt.Sprintf("page/%s/%d", page.DocumentKey, page.Page)] = encoded
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	rows, err = q.QueryContext(ctx, `SELECT d.key,s.ordinal,s.href,s.title,s.blocks_json,s.text FROM document_sections s JOIN documents d ON d.id=s.document_id ORDER BY d.key,s.ordinal`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var section syncSection
		if err := rows.Scan(&section.DocumentKey, &section.Ordinal, &section.Href, &section.Title, &section.BlocksJSON, &section.Text); err != nil {
			rows.Close()
			return nil, err
		}
		encoded, err := json.Marshal(section)
		if err != nil {
			rows.Close()
			return nil, err
		}
		entities[fmt.Sprintf("section/%s/%d", section.DocumentKey, section.Ordinal)] = encoded
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	var metaRaw string
	err = q.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key='documents.meta'`).Scan(&metaRaw)
	if err == nil {
		var meta map[string]DocumentMeta
		if err := json.Unmarshal([]byte(metaRaw), &meta); err != nil {
			return nil, fmt.Errorf("decode library metadata: %w", err)
		}
		for key, value := range meta {
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, err
			}
			entities["meta/"+key] = encoded
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var categoriesRaw string
	err = q.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key='library.categories'`).Scan(&categoriesRaw)
	if err == nil {
		var categories []Category
		if err := json.Unmarshal([]byte(categoriesRaw), &categories); err != nil {
			return nil, fmt.Errorf("decode library categories: %w", err)
		}
		for _, category := range categories {
			encoded, err := json.Marshal(category)
			if err != nil {
				return nil, err
			}
			entities["category/"+category.Name] = encoded
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	rows, err = q.QueryContext(ctx, `SELECT d.key,a.id,a.page,a.quote,a.note,a.color,a.tags,a.kind,a.start_offset,a.end_offset,a.created_at,a.updated_at,a.locator_json FROM annotations a JOIN documents d ON d.id=a.document_id ORDER BY d.key,a.id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var note syncAnnotation
		var page, start, end sql.NullInt64
		var locator string
		if err := rows.Scan(&note.DocumentKey, &note.ID, &page, &note.Quote, &note.Note, &note.Color, &note.Tags, &note.Kind, &start, &end, &note.CreatedAt, &note.UpdatedAt, &locator); err != nil {
			rows.Close()
			return nil, err
		}
		note.Locator = json.RawMessage(locator)
		note.Page, note.StartOffset, note.EndOffset = nullableInt(page), nullableInt(start), nullableInt(end)
		encoded, err := json.Marshal(note)
		if err != nil {
			rows.Close()
			return nil, err
		}
		entities["annotation/"+syncKeyPart(note.DocumentKey)+"/"+syncKeyPart(note.ID)] = encoded
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	rows, err = q.QueryContext(ctx, `SELECT d.key,l.location_json,l.updated_at FROM reading_locations l JOIN documents d ON d.id=l.document_id ORDER BY d.key`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key string
		var location syncLocation
		var value string
		if err := rows.Scan(&key, &value, &location.UpdatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		location.Value = json.RawMessage(value)
		encoded, err := json.Marshal(location)
		if err != nil {
			rows.Close()
			return nil, err
		}
		entities["location/"+key] = encoded
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return entities, nil
}

func nullableInt(v sql.NullInt64) *int {
	if !v.Valid {
		return nil
	}
	n := int(v.Int64)
	return &n
}

func sameRawEntities(a, b map[string]json.RawMessage) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if !bytes.Equal(value, b[key]) {
			return false
		}
	}
	return true
}

func publishSyncAsset(source, folder string) (string, string, error) {
	ext := strings.ToLower(filepath.Ext(source))
	if ext != ".pdf" && ext != ".epub" {
		return "", "", nil
	}
	input, err := os.Open(source)
	if err != nil {
		return "", "", nil // metadata still syncs for books without an available local file
	}
	defer input.Close()
	blobDir := filepath.Join(folder, "readx-sync", "blobs")
	if err := os.MkdirAll(blobDir, 0o700); err != nil {
		return "", "", err
	}
	temp, err := os.CreateTemp(blobDir, ".upload-*.tmp")
	if err != nil {
		return "", "", err
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temp, hasher), input); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return "", "", err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return "", "", err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(temp.Name())
		return "", "", err
	}
	hash := hex.EncodeToString(hasher.Sum(nil))
	path := filepath.Join(blobDir, hash+ext)
	if err := publishTempFile(temp.Name(), path, hash); err != nil {
		_ = os.Remove(temp.Name())
		return "", "", err
	}
	return hash, ext, nil
}

func materializeSyncAsset(folder string, doc syncDocument, library string) (string, error) {
	if doc.AssetHash == "" {
		return "", nil
	}
	if len(doc.AssetHash) != 64 || (doc.AssetExt != ".pdf" && doc.AssetExt != ".epub") {
		return "", errors.New("invalid synchronized asset reference")
	}
	if _, err := hex.DecodeString(doc.AssetHash); err != nil {
		return "", errors.New("invalid synchronized asset hash")
	}
	source := filepath.Join(folder, "readx-sync", "blobs", doc.AssetHash+doc.AssetExt)
	if err := os.MkdirAll(library, 0o755); err != nil {
		return "", err
	}
	destination := filepath.Join(library, legacy.SafeFileStem(doc.Key)+"-"+doc.AssetHash[:12]+doc.AssetExt)
	if err := copyVerifiedAsset(source, destination, doc.AssetHash); err != nil {
		return "", err
	}
	return destination, nil
}

func publishTempFile(temp, destination, expectedHash string) error {
	if existing, err := os.Open(destination); err == nil {
		hasher := sha256.New()
		_, copyErr := io.Copy(hasher, existing)
		_ = existing.Close()
		_ = os.Remove(temp)
		if copyErr != nil {
			return copyErr
		}
		if hex.EncodeToString(hasher.Sum(nil)) != expectedHash {
			return errors.New("existing content-addressed file is corrupted")
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(temp, destination); err != nil {
		if existing, openErr := os.Open(destination); openErr == nil {
			hasher := sha256.New()
			_, copyErr := io.Copy(hasher, existing)
			_ = existing.Close()
			_ = os.Remove(temp)
			if copyErr == nil && hex.EncodeToString(hasher.Sum(nil)) == expectedHash {
				return nil
			}
		}
		return err
	}
	return nil
}

func copyVerifiedAsset(source, destination, expectedHash string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if existing, err := os.Open(destination); err == nil {
		hasher := sha256.New()
		_, copyErr := io.Copy(hasher, existing)
		_ = existing.Close()
		if copyErr != nil {
			return copyErr
		}
		if hex.EncodeToString(hasher.Sum(nil)) == expectedHash {
			return nil
		}
		return errors.New("existing library asset does not match its content hash")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(destination), ".readx-sync-*.tmp")
	if err != nil {
		return err
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(temp, hasher), input); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return err
	}
	if hex.EncodeToString(hasher.Sum(nil)) != expectedHash {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return errors.New("synchronized asset is incomplete or corrupted")
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(temp.Name())
		return err
	}
	return publishTempFile(temp.Name(), destination, expectedHash)
}

func applySyncDocuments(ctx context.Context, tx *sql.Tx, merged map[string][]syncmerge.Version, folder, library string) error {
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "document/") {
			continue
		}
		key := strings.TrimPrefix(entity, "document/")
		active := liveValues(versions)
		if len(active) == 0 {
			if _, err := tx.ExecContext(ctx, `DELETE FROM documents WHERE key=?`, key); err != nil {
				return err
			}
			continue
		}
		// Book metadata is one row: merge populated fields from both concurrent
		// imports/edits. Notes retain separate branches because they can be shown
		// side by side in the reader.
		doc, err := mergeSyncDocuments(active)
		if err != nil {
			return fmt.Errorf("decode book %s: %w", key, err)
		}
		if doc.Key != key || doc.Key == "" {
			return errors.New("book record key does not match its sync entity")
		}
		assetPath, err := materializeSyncAsset(folder, doc, library)
		if err != nil {
			return fmt.Errorf("book %s file: %w", key, err)
		}
		var id, currentPath string
		err = tx.QueryRowContext(ctx, `SELECT id,pdf_path FROM documents WHERE key=?`, key).Scan(&id, &currentPath)
		if errors.Is(err, sql.ErrNoRows) {
			id = key
		} else if err != nil {
			return err
		}
		if assetPath == "" {
			assetPath = currentPath
		}
		// documents_key_unique only covers nonempty keys; SQLite requires the
		// conflict target to include the same predicate as that partial index.
		_, err = tx.ExecContext(ctx, `INSERT INTO documents(id,key,title,translated_title,authors,year,venue,doi,url,status,pdf_path,added_at,updated_at,format,raw_json)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) WHERE key <> '' DO UPDATE SET title=excluded.title,translated_title=excluded.translated_title,authors=excluded.authors,year=excluded.year,venue=excluded.venue,doi=excluded.doi,url=excluded.url,status=excluded.status,pdf_path=CASE WHEN excluded.pdf_path<>'' THEN excluded.pdf_path ELSE documents.pdf_path END,added_at=CASE WHEN documents.added_at='' THEN excluded.added_at ELSE documents.added_at END,updated_at=excluded.updated_at,format=excluded.format,raw_json=excluded.raw_json`,
			id, key, doc.Title, doc.TranslatedTitle, doc.Authors, doc.Year, doc.Venue, doc.DOI, doc.URL, doc.Status, assetPath, doc.AddedAt, doc.UpdatedAt, doc.Format, doc.RawJSON)
		if err != nil {
			return err
		}
	}
	return nil
}

func mergeSyncDocuments(values []json.RawMessage) (syncDocument, error) {
	var result syncDocument
	for index, raw := range values {
		var current syncDocument
		if err := json.Unmarshal(raw, &current); err != nil {
			return syncDocument{}, err
		}
		if index == 0 {
			result = current
			continue
		}
		if current.Title != "" {
			result.Title = current.Title
		}
		if current.TranslatedTitle != "" {
			result.TranslatedTitle = current.TranslatedTitle
		}
		if current.Authors != "" {
			result.Authors = current.Authors
		}
		if current.Year != nil {
			result.Year = current.Year
		}
		if current.Venue != "" {
			result.Venue = current.Venue
		}
		if current.DOI != "" {
			result.DOI = current.DOI
		}
		if current.URL != "" {
			result.URL = current.URL
		}
		if current.Status != "" {
			result.Status = current.Status
		}
		if current.AddedAt != "" && (result.AddedAt == "" || current.AddedAt < result.AddedAt) {
			result.AddedAt = current.AddedAt
		}
		if current.UpdatedAt > result.UpdatedAt {
			result.UpdatedAt = current.UpdatedAt
		}
		if current.Format != "" {
			result.Format = current.Format
		}
		if current.RawJSON != "" {
			var merged, incoming map[string]json.RawMessage
			if result.RawJSON == "" {
				result.RawJSON = "{}"
			}
			if json.Unmarshal([]byte(result.RawJSON), &merged) == nil && json.Unmarshal([]byte(current.RawJSON), &incoming) == nil {
				for key, value := range incoming {
					merged[key] = value
				}
				if encoded, err := json.Marshal(merged); err == nil {
					result.RawJSON = string(encoded)
				}
			} else {
				result.RawJSON = current.RawJSON
			}
		}
		if current.AssetHash != "" {
			result.AssetHash, result.AssetExt = current.AssetHash, current.AssetExt
		}
	}
	return result, nil
}

func applySyncLocations(ctx context.Context, tx *sql.Tx, merged map[string][]syncmerge.Version) error {
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "location/") {
			continue
		}
		key := strings.TrimPrefix(entity, "location/")
		active := liveValues(versions)
		if len(active) == 0 {
			if _, err := tx.ExecContext(ctx, `DELETE FROM reading_locations WHERE document_id=(SELECT id FROM documents WHERE key=?)`, key); err != nil {
				return err
			}
			continue
		}
		var location syncLocation
		for _, raw := range active {
			var candidate syncLocation
			if err := json.Unmarshal(raw, &candidate); err != nil || !json.Valid(candidate.Value) {
				return fmt.Errorf("invalid reading position for %s", key)
			}
			if candidate.UpdatedAt >= location.UpdatedAt {
				location = candidate
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO reading_locations(document_id,location_json,updated_at) SELECT id,?,? FROM documents WHERE key=? ON CONFLICT(document_id) DO UPDATE SET location_json=excluded.location_json,updated_at=excluded.updated_at`, string(location.Value), location.UpdatedAt, key); err != nil {
			return err
		}
	}
	return nil
}

func applySyncSections(ctx context.Context, tx *sql.Tx, merged map[string][]syncmerge.Version) error {
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "section/") {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(entity, "section/"), "/", 2)
		if len(parts) != 2 {
			return errors.New("invalid EPUB section sync key")
		}
		ordinal, err := strconv.Atoi(parts[1])
		if err != nil || ordinal < 1 {
			return errors.New("invalid EPUB section ordinal")
		}
		active := liveValues(versions)
		if len(active) == 0 {
			_, err := tx.ExecContext(ctx, `DELETE FROM document_sections WHERE document_id=(SELECT id FROM documents WHERE key=?) AND ordinal=?`, parts[0], ordinal)
			if err != nil {
				return err
			}
			continue
		}
		var section syncSection
		if err := json.Unmarshal(active[len(active)-1], &section); err != nil || section.DocumentKey != parts[0] || section.Ordinal != ordinal {
			return errors.New("EPUB section does not match its sync key")
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO document_sections(document_id,ordinal,href,title,blocks_json,text) SELECT id,?,?,?,?,? FROM documents WHERE key=? ON CONFLICT(document_id,ordinal) DO UPDATE SET href=excluded.href,title=excluded.title,blocks_json=excluded.blocks_json,text=excluded.text`, section.Ordinal, section.Href, section.Title, section.BlocksJSON, section.Text, section.DocumentKey)
		if err != nil {
			return err
		}
	}
	return nil
}

func applySyncPages(ctx context.Context, tx *sql.Tx, merged map[string][]syncmerge.Version) error {
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "page/") {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(entity, "page/"), "/", 2)
		if len(parts) != 2 {
			return errors.New("invalid document page sync key")
		}
		pageNumber, err := strconv.Atoi(parts[1])
		if err != nil || pageNumber < 1 {
			return errors.New("invalid document page number")
		}
		active := liveValues(versions)
		if len(active) == 0 {
			_, err := tx.ExecContext(ctx, `DELETE FROM document_pages WHERE document_id=(SELECT id FROM documents WHERE key=?) AND page=?`, parts[0], pageNumber)
			if err != nil {
				return err
			}
			continue
		}
		var page syncPage
		if err := json.Unmarshal(active[len(active)-1], &page); err != nil || page.DocumentKey != parts[0] || page.Page != pageNumber {
			return errors.New("document page does not match its sync key")
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO document_pages(document_id,page,text,hash,updated_at) SELECT id,?,?,?,? FROM documents WHERE key=? ON CONFLICT(document_id,page) DO UPDATE SET text=excluded.text,hash=excluded.hash,updated_at=excluded.updated_at`, page.Page, page.Text, page.Hash, page.UpdatedAt, page.DocumentKey)
		if err != nil {
			return err
		}
	}
	return nil
}

func applySyncAnnotations(ctx context.Context, tx *sql.Tx, merged map[string][]syncmerge.Version) error {
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "annotation/") {
			continue
		}
		active := liveValues(versions)
		var original syncAnnotation
		if len(active) > 0 {
			if err := json.Unmarshal(active[0], &original); err != nil {
				return fmt.Errorf("decode annotation: %w", err)
			}
		}
		parts := strings.SplitN(strings.TrimPrefix(entity, "annotation/"), "/", 2)
		if len(parts) != 2 {
			return errors.New("invalid annotation sync key")
		}
		docKey, err := decodeSyncKeyPart(parts[0])
		if err != nil {
			return err
		}
		originalID, err := decodeSyncKeyPart(parts[1])
		if err != nil {
			return err
		}
		if len(active) == 0 {
			if _, err := tx.ExecContext(ctx, `DELETE FROM annotations WHERE id=?`, originalID); err != nil {
				return err
			}
			continue
		}
		if original.DocumentKey != docKey || original.ID != originalID {
			return errors.New("annotation record key does not match its sync entity")
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM annotations WHERE id=?`, originalID); err != nil {
			return err
		}
		for i, raw := range active {
			var note syncAnnotation
			if err := json.Unmarshal(raw, &note); err != nil {
				return err
			}
			if i > 0 {
				note.ID = conflictNoteID(originalID, raw, i)
				conflictEntity := "annotation/" + syncKeyPart(docKey) + "/" + syncKeyPart(note.ID)
				if _, exists := merged[conflictEntity]; exists {
					continue // the conflict copy is now an independent, editable note entity
				}
			}
			var documentID string
			if err := tx.QueryRowContext(ctx, `SELECT id FROM documents WHERE key=?`, note.DocumentKey).Scan(&documentID); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					continue
				}
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO annotations(id,document_id,page,quote,note,color,tags,kind,start_offset,end_offset,created_at,updated_at,locator_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				note.ID, documentID, note.Page, note.Quote, note.Note, note.Color, note.Tags, note.Kind, note.StartOffset, note.EndOffset, note.CreatedAt, note.UpdatedAt, string(note.Locator)); err != nil {
				return err
			}
		}
	}
	return nil
}

func conflictNoteID(originalID string, raw json.RawMessage, branch int) string {
	digest := sha256.Sum256(append(append([]byte(nil), raw...), []byte(fmt.Sprint(branch))...))
	return originalID + "~sync-" + hex.EncodeToString(digest[:6])
}

func expandConflictAnnotations(merged map[string][]syncmerge.Version) (map[string][]syncmerge.Version, bool, error) {
	var additions = map[string][]syncmerge.Version{}
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "annotation/") {
			continue
		}
		active := make([]syncmerge.Version, 0, len(versions))
		for _, version := range versions {
			if !version.Deleted {
				active = append(active, version)
			}
		}
		if len(active) < 2 {
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(entity, "annotation/"), "/", 2)
		if len(parts) != 2 {
			return nil, false, errors.New("invalid annotation sync key")
		}
		docKey, err := decodeSyncKeyPart(parts[0])
		if err != nil {
			return nil, false, err
		}
		originalID, err := decodeSyncKeyPart(parts[1])
		if err != nil {
			return nil, false, err
		}
		for index, version := range active {
			if index == 0 {
				continue
			}
			cloneKey := "annotation/" + syncKeyPart(docKey) + "/" + syncKeyPart(conflictNoteID(originalID, version.Value, index))
			if _, exists := merged[cloneKey]; exists {
				continue // a user has already edited or deleted this conflict copy
			}
			var note syncAnnotation
			if err := json.Unmarshal(version.Value, &note); err != nil || note.ID != originalID || note.DocumentKey != docKey {
				return nil, false, errors.New("annotation payload does not match its sync key")
			}
			note.ID = conflictNoteID(originalID, version.Value, index)
			value, err := json.Marshal(note)
			if err != nil {
				return nil, false, err
			}
			version.Value = value
			additions[cloneKey] = []syncmerge.Version{version}
		}
	}
	if len(additions) == 0 {
		return merged, false, nil
	}
	for key, versions := range additions {
		merged[key] = versions
	}
	return merged, true, nil
}

func applySyncLibraryMeta(ctx context.Context, tx *sql.Tx, merged map[string][]syncmerge.Version) error {
	meta := map[string]DocumentMeta{}
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "meta/") {
			continue
		}
		key := strings.TrimPrefix(entity, "meta/")
		active := liveValues(versions)
		if len(active) == 0 {
			continue
		}
		var combined DocumentMeta
		for index, raw := range active {
			var current DocumentMeta
			if err := json.Unmarshal(raw, &current); err != nil {
				return err
			}
			if current.Key != key {
				return errors.New("library metadata key does not match its sync entity")
			}
			if index == 0 {
				combined = current
				continue
			}
			combined.Favorite = combined.Favorite || current.Favorite
			combined.Deleted = combined.Deleted || current.Deleted
			combined.Tags = mergeUniqueStrings(combined.Tags, current.Tags)
			combined.Categories = mergeUniqueStrings(combined.Categories, current.Categories)
			if current.Updated > combined.Updated {
				combined.Updated = current.Updated
			}
		}
		meta[key] = combined
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES('documents.meta',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, string(metaJSON), nowStamp()); err != nil {
		return err
	}

	localIDs := map[string]string{}
	var localRaw string
	if err := tx.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key='library.categories'`).Scan(&localRaw); err == nil {
		var local []Category
		if err = json.Unmarshal([]byte(localRaw), &local); err != nil {
			return err
		}
		for _, category := range local {
			localIDs[category.Name] = category.ID
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	categories := make([]Category, 0)
	for entity, versions := range merged {
		if !strings.HasPrefix(entity, "category/") {
			continue
		}
		active := liveValues(versions)
		if len(active) == 0 {
			continue
		}
		var category Category
		if err := json.Unmarshal(active[len(active)-1], &category); err != nil {
			return err
		}
		if category.Name != strings.TrimPrefix(entity, "category/") {
			return errors.New("category name does not match its sync entity")
		}
		if id := localIDs[category.Name]; id != "" {
			category.ID = id
		}
		if category.ID == "" {
			id, err := randomLeeJobID()
			if err != nil {
				return err
			}
			category.ID = "shelf-" + id
		}
		categories = append(categories, category)
	}
	sortCategories(categories)
	categoriesJSON, err := json.Marshal(categories)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES('library.categories',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, string(categoriesJSON), nowStamp())
	return err
}

func mergeUniqueStrings(left, right []string) []string {
	seen := make(map[string]struct{}, len(left)+len(right))
	merged := make([]string, 0, len(left)+len(right))
	for _, values := range [][]string{left, right} {
		for _, value := range values {
			if _, exists := seen[value]; exists {
				continue
			}
			seen[value] = struct{}{}
			merged = append(merged, value)
		}
	}
	return merged
}

func syncKeyPart(value string) string { return base64.RawURLEncoding.EncodeToString([]byte(value)) }

func decodeSyncKeyPart(value string) (string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) == 0 {
		return "", errors.New("invalid annotation sync key encoding")
	}
	return string(decoded), nil
}

func liveValues(versions []syncmerge.Version) []json.RawMessage {
	values := make([]json.RawMessage, 0, len(versions))
	for _, version := range versions {
		if !version.Deleted {
			values = append(values, version.Value)
		}
	}
	return values
}

func countEntityKind(entities map[string][]syncmerge.Version, prefix string) int {
	count := 0
	for key := range entities {
		if strings.HasPrefix(key, prefix) {
			count++
		}
	}
	return count
}

func materializeSyncAssets(folder string, merged map[string][]syncmerge.Version) error {
	for key, versions := range merged {
		if !strings.HasPrefix(key, "document/") {
			continue
		}
		for _, raw := range liveValues(versions) {
			var doc syncDocument
			if err := json.Unmarshal(raw, &doc); err != nil {
				return err
			}
			if doc.AssetHash == "" {
				continue
			}
			if len(doc.AssetHash) != 64 || (doc.AssetExt != ".pdf" && doc.AssetExt != ".epub") {
				return errors.New("invalid synchronized asset reference")
			}
			if _, err := hex.DecodeString(doc.AssetHash); err != nil {
				return errors.New("invalid synchronized asset hash")
			}
			path := filepath.Join(folder, "readx-sync", "blobs", doc.AssetHash+doc.AssetExt)
			asset, err := os.Open(path)
			if err != nil {
				return err
			}
			hasher := sha256.New()
			_, copyErr := io.Copy(hasher, asset)
			_ = asset.Close()
			if copyErr != nil {
				return copyErr
			}
			if hex.EncodeToString(hasher.Sum(nil)) != doc.AssetHash {
				return fmt.Errorf("asset %s is incomplete", doc.Key)
			}
		}
	}
	return nil
}
