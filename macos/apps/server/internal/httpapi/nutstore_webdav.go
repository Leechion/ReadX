package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cbctv2/server/internal/syncmerge"
)

const nutstoreDAVRoot = "https://dav.jianguoyun.com/dav/ReadX/"

type nutstoreWebDAV struct {
	root     *url.URL
	username string
	password string
	client   *http.Client
}

func newNutstoreWebDAV(username, password string) *nutstoreWebDAV {
	root, _ := url.Parse(nutstoreDAVRoot)
	return &nutstoreWebDAV{root: root, username: username, password: password, client: &http.Client{Timeout: 2 * time.Minute}}
}

type webDAVItem struct {
	Href      string `xml:"href"`
	Propstats []struct {
		Prop struct {
			ResourceType struct {
				Collection *struct{} `xml:"collection"`
			} `xml:"resourcetype"`
			ContentLength int64 `xml:"getcontentlength"`
		} `xml:"prop"`
	} `xml:"propstat"`
}

func (d *nutstoreWebDAV) request(ctx context.Context, method, relative string, body io.Reader, size int64) (*http.Response, error) {
	if method == "PROPFIND" {
		body = strings.NewReader(`<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>`)
		size = -1
	}
	target := *d.root
	base := strings.TrimSuffix(target.Path, "/")
	relative = strings.Trim(relative, "/")
	if relative != "" {
		base += "/" + relative
	}
	target.Path = base
	target.RawPath = ""
	req, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(d.username, d.password)
	if size >= 0 {
		req.ContentLength = size
	}
	if method == "PROPFIND" {
		req.Header.Set("Depth", "1")
		req.Header.Set("Content-Type", "application/xml; charset=utf-8")
	}
	return d.client.Do(req)
}

func (d *nutstoreWebDAV) ensureCollection(ctx context.Context, relative string) error {
	if err := d.ensureNutstoreFolder(ctx); err != nil {
		return err
	}
	parts := strings.Split(strings.Trim(relative, "/"), "/")
	current := ""
	for _, part := range parts {
		current = filepath.ToSlash(filepath.Join(current, part))
		response, err := d.request(ctx, "MKCOL", current, nil, 0)
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusMethodNotAllowed && response.StatusCode != http.StatusConflict {
			if authErr := nutstoreAuthError(response.StatusCode); authErr != nil {
				return authErr
			}
			return fmt.Errorf("WebDAV 创建目录返回 HTTP %d", response.StatusCode)
		}
	}
	return nil
}

func (d *nutstoreWebDAV) ensureNutstoreFolder(ctx context.Context) error {
	target := *d.root
	target.Path = strings.TrimSuffix(target.Path, "/")
	target.RawPath = ""
	req, err := http.NewRequestWithContext(ctx, "MKCOL", target.String(), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(d.username, d.password)
	response, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusCreated || response.StatusCode == http.StatusMethodNotAllowed {
		return nil
	}
	if authErr := nutstoreAuthError(response.StatusCode); authErr != nil {
		return authErr
	}
	return fmt.Errorf("WebDAV 创建 ReadX 目录返回 HTTP %d", response.StatusCode)
}

func (d *nutstoreWebDAV) list(ctx context.Context, relative string) ([]webDAVItem, error) {
	response, err := d.request(ctx, "PROPFIND", relative, nil, 0)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 207 && response.StatusCode != http.StatusOK {
		if authErr := nutstoreAuthError(response.StatusCode); authErr != nil {
			return nil, authErr
		}
		return nil, fmt.Errorf("WebDAV 目录读取返回 HTTP %d", response.StatusCode)
	}
	var result struct {
		Items []webDAVItem `xml:"response"`
	}
	if err := xml.NewDecoder(response.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("解析 WebDAV 目录失败: %w", err)
	}
	return result.Items, nil
}

func nutstoreAuthError(status int) error {
	if status != http.StatusUnauthorized && status != http.StatusForbidden {
		return nil
	}
	return errors.New("坚果云拒绝了登录：请使用坚果云注册邮箱，以及“安全选项 → 第三方应用管理”生成的应用密码（不是账号登录密码）")
}

func (d *nutstoreWebDAV) itemPath(href string) (string, error) {
	parsed, err := url.Parse(href)
	if err != nil {
		return "", err
	}
	decoded, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil {
		return "", err
	}
	root := strings.TrimSuffix(d.root.Path, "/") + "/"
	if !strings.HasPrefix(decoded, root) {
		return "", errors.New("WebDAV 返回了根目录之外的路径")
	}
	relative := strings.Trim(strings.TrimPrefix(decoded, root), "/")
	if relative == "" || strings.Contains(relative, "\\") {
		return "", errors.New("WebDAV 返回了无效路径")
	}
	for _, part := range strings.Split(relative, "/") {
		if part == ".." || part == "." {
			return "", errors.New("WebDAV 返回了无效路径")
		}
	}
	return relative, nil
}

func (d *nutstoreWebDAV) downloadPeerStates(ctx context.Context, folder string) error {
	if err := d.ensureCollection(ctx, "readx-sync/peers"); err != nil {
		return err
	}
	items, err := d.list(ctx, "readx-sync/peers")
	if err != nil {
		return err
	}
	for _, item := range items {
		remote, err := d.itemPath(item.Href)
		if err != nil {
			return err
		}
		if strings.HasSuffix(remote, "/") || filepath.Ext(remote) != ".json" || !strings.HasPrefix(remote, "readx-sync/peers/") {
			continue
		}
		if err := d.downloadTo(ctx, remote, filepath.Join(folder, filepath.FromSlash(remote)), ""); err != nil {
			return err
		}
	}
	return nil
}

func (d *nutstoreWebDAV) downloadAssets(ctx context.Context, folder string, merged map[string][]syncmerge.Version) error {
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
			if len(doc.AssetHash) != 64 || !isSyncAssetExtension(doc.AssetExt) {
				return errors.New("invalid synchronized asset reference")
			}
			remote := "readx-sync/blobs/" + doc.AssetHash + doc.AssetExt
			local := filepath.Join(folder, filepath.FromSlash(remote))
			if localAssetMatches(local, doc.AssetHash) {
				continue
			}
			if err := d.downloadTo(ctx, remote, local, doc.AssetHash); err != nil {
				return fmt.Errorf("%s: %w", doc.Key, err)
			}
		}
	}
	return nil
}

func localAssetMatches(path, expected string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return false
	}
	return hex.EncodeToString(hasher.Sum(nil)) == expected
}

func (d *nutstoreWebDAV) downloadTo(ctx context.Context, remote, local, expectedHash string) error {
	response, err := d.request(ctx, http.MethodGet, remote, nil, -1)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if authErr := nutstoreAuthError(response.StatusCode); authErr != nil {
			return authErr
		}
		return fmt.Errorf("WebDAV 文件读取返回 HTTP %d", response.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(local), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(local), ".sync-download-*.tmp")
	if err != nil {
		return err
	}
	hasher := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(temporary, hasher), response.Body)
	closeErr := temporary.Close()
	if copyErr != nil {
		_ = os.Remove(temporary.Name())
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary.Name())
		return closeErr
	}
	if expectedHash != "" && hex.EncodeToString(hasher.Sum(nil)) != expectedHash {
		_ = os.Remove(temporary.Name())
		return errors.New("下载文件校验失败")
	}
	if err := os.Rename(temporary.Name(), local); err != nil {
		_ = os.Remove(temporary.Name())
		return err
	}
	return nil
}

func (d *nutstoreWebDAV) uploadSyncFiles(ctx context.Context, folder string) error {
	if err := d.ensureCollection(ctx, "readx-sync/blobs"); err != nil {
		return err
	}
	remoteItems := map[string]struct{}{}
	for _, dir := range []string{"readx-sync/peers", "readx-sync/blobs"} {
		items, err := d.list(ctx, dir)
		if err != nil {
			return err
		}
		for _, item := range items {
			remote, err := d.itemPath(item.Href)
			if err == nil {
				remoteItems[remote] = struct{}{}
			}
		}
	}
	localPeerNames := map[string]struct{}{}
	peerDir := filepath.Join(folder, "readx-sync", "peers")
	peerEntries, err := os.ReadDir(peerDir)
	if err != nil {
		return err
	}
	deviceID := ""
	for _, entry := range peerEntries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		localPeerNames["readx-sync/peers/"+entry.Name()] = struct{}{}
		if deviceID == "" {
			body, readErr := os.ReadFile(filepath.Join(peerDir, entry.Name()))
			if readErr != nil {
				return readErr
			}
			var state syncmerge.FolderState
			if json.Unmarshal(body, &state) == nil {
				deviceID = state.DeviceID
			}
		}
	}
	for _, relativeDir := range []string{"readx-sync/peers", "readx-sync/blobs"} {
		localDir := filepath.Join(folder, filepath.FromSlash(relativeDir))
		entries, err := os.ReadDir(localDir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			remote := relativeDir + "/" + entry.Name()
			if _, exists := remoteItems[remote]; exists {
				continue
			}
			file, err := os.Open(filepath.Join(localDir, entry.Name()))
			if err != nil {
				return err
			}
			info, statErr := file.Stat()
			if statErr != nil {
				_ = file.Close()
				return statErr
			}
			response, putErr := d.request(ctx, http.MethodPut, remote, file, info.Size())
			_ = file.Close()
			if putErr != nil {
				return putErr
			}
			_ = response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				if authErr := nutstoreAuthError(response.StatusCode); authErr != nil {
					return authErr
				}
				return fmt.Errorf("WebDAV 上传返回 HTTP %d", response.StatusCode)
			}
		}
	}
	if deviceID != "" {
		items, err := d.list(ctx, "readx-sync/peers")
		if err != nil {
			return err
		}
		for _, item := range items {
			remote, err := d.itemPath(item.Href)
			if err != nil || !strings.HasPrefix(filepath.Base(remote), deviceID+"-") || filepath.Ext(remote) != ".json" {
				continue
			}
			if _, keep := localPeerNames[remote]; keep {
				continue
			}
			response, err := d.request(ctx, "DELETE", remote, nil, 0)
			if err != nil {
				return err
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusNotFound && response.StatusCode != http.StatusOK {
				return fmt.Errorf("WebDAV 清理旧同步清单返回 HTTP %d", response.StatusCode)
			}
		}
	}
	return nil
}
