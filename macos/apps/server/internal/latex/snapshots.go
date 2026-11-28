package latex

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Snapshot 是一次源码快照的元数据。文件内容在项目目录下的 snapshots/<id>/src。
type Snapshot struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Note      string `json:"note"`
	Manifest  string `json:"manifest"`
	FileCount int    `json:"fileCount"`
	ByteCount int64  `json:"byteCount"`
	CreatedAt string `json:"createdAt"`
}

// RestoreReport 说明回滚到底做了什么：覆盖了哪些、删掉了哪些。
// 「删掉了什么」必须如实报出来——回滚会丢弃快照之后的新增文件。
type RestoreReport struct {
	SnapshotID   string   `json:"snapshotId"`
	Restored     int      `json:"restored"`
	RemovedFiles []string `json:"removedFiles"`
	// RestoredMainFile 为 true 表示连根文档设置一起回到了快照时的值。
	RestoredMainFile bool `json:"restoredMainFile"`
}

// SnapshotFileDiff 描述单个文件在某个快照与当前工作区之间的差异。
type SnapshotFileDiff struct {
	Path   string `json:"path"`
	Status string `json:"status"` // "modified" | "added" | "deleted"
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
	Binary bool   `json:"binary,omitempty"`
	TooBig bool   `json:"tooBig,omitempty"`
}

// SnapshotDiffResult 返回快照与当前项目源码的逐文件对比结果。
type SnapshotDiffResult struct {
	Snapshot *Snapshot          `json:"snapshot"`
	Files    []SnapshotFileDiff `json:"files"`
}

const (
	// keptSnapshots 是每个项目保留的快照数：太多会悄悄吃掉磁盘。
	keptSnapshots = 20
	// maxSnapshotEntries / maxSnapshotBytes 是快照规模上限。
	maxSnapshotEntries = 5000
	maxSnapshotBytes   = 256 << 20
)

// SnapshotDir 返回某个快照的存放目录。
func (s *Service) SnapshotDir(projectID, snapshotID string) (string, error) {
	projectDir, err := s.ProjectDir(projectID)
	if err != nil {
		return "", err
	}
	if err := safeIDSegment(snapshotID); err != nil {
		return "", err
	}
	return filepath.Join(projectDir, "snapshots", snapshotID), nil
}

// CreateSnapshot 把当前 src/ 完整复制一份，供回滚使用。
//
// 为什么整份复制而不是只存被改的那个文件：一次 AI 修复可能同时影响多个文件
// （实践里还会连带改 .bib），而回滚必须能把项目带回一个**确定**的状态。
func (s *Service) CreateSnapshot(ctx context.Context, projectID, note string) (*Snapshot, error) {
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, err
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	id, err := newID()
	if err != nil {
		return nil, fmt.Errorf("生成快照编号失败: %w", err)
	}
	dir, err := s.SnapshotDir(projectID, id)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(dir, "src")
	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, fmt.Errorf("创建快照目录失败: %w", err)
	}

	snapshot := &Snapshot{ID: id, ProjectID: projectID, Note: strings.TrimSpace(note), CreatedAt: nowStamp()}
	entries := 0
	var bytes int64
	err = filepath.WalkDir(srcDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(srcDir, path)
		if relErr != nil {
			return relErr
		}
		if relative == "." {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			// 符号链接不复制：快照里出现链接会把回滚变成「往项目外写」的通道。
			return nil
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		entries++
		if entries > maxSnapshotEntries {
			return fmt.Errorf("%w: 项目文件超过 %d 个，无法快照", ErrTooLarge, maxSnapshotEntries)
		}
		bytes += info.Size()
		if bytes > maxSnapshotBytes {
			return fmt.Errorf("%w: 源码超过 %d MB，无法快照", ErrTooLarge, maxSnapshotBytes>>20)
		}
		return copyFile(path, destination, info.Mode())
	})
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	manifest, err := s.Manifest(ctx, projectID)
	if err != nil {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	snapshot.Manifest = manifest
	snapshot.FileCount = entries
	snapshot.ByteCount = bytes
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO latex_snapshots (id, project_id, note, manifest, file_count, byte_count, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		snapshot.ID, snapshot.ProjectID, snapshot.Note, snapshot.Manifest,
		snapshot.FileCount, snapshot.ByteCount, snapshot.CreatedAt); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("记录快照失败: %w", err)
	}
	// 快照记录与根文档设置：回滚只回源码，根文档设置由用户在工具栏自己改回来。
	s.pruneSnapshots(ctx, projectID)
	return snapshot, nil
}

// ListSnapshots 列出项目的快照（新的在前）。
func (s *Service) ListSnapshots(ctx context.Context, projectID string, limit int) ([]*Snapshot, error) {
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = keptSnapshots
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, project_id, note, manifest, file_count, byte_count, created_at
		FROM latex_snapshots WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []*Snapshot{}
	for rows.Next() {
		var snapshot Snapshot
		if err := rows.Scan(&snapshot.ID, &snapshot.ProjectID, &snapshot.Note, &snapshot.Manifest,
			&snapshot.FileCount, &snapshot.ByteCount, &snapshot.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, &snapshot)
	}
	return list, rows.Err()
}

// Snapshot 读取单个快照。
func (s *Service) Snapshot(ctx context.Context, snapshotID string) (*Snapshot, error) {
	if err := safeIDSegment(snapshotID); err != nil {
		return nil, err
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT id, project_id, note, manifest, file_count, byte_count, created_at
		FROM latex_snapshots WHERE id = ?`, snapshotID)
	var snapshot Snapshot
	if err := row.Scan(&snapshot.ID, &snapshot.ProjectID, &snapshot.Note, &snapshot.Manifest,
		&snapshot.FileCount, &snapshot.ByteCount, &snapshot.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w: 找不到这个快照", ErrNotFound)
		}
		return nil, err
	}
	return &snapshot, nil
}

// RestoreSnapshot 把源码恢复到快照时的状态。
//
// 语义是「回到那一刻」：快照里存在的文件按快照内容写回，
// 快照之后**新增**的文件会被删除（并在报告里逐条列出来）。
// 这件事必须让用户知道，所以 RestoreReport 里带 RemovedFiles。
func (s *Service) RestoreSnapshot(ctx context.Context, snapshotID string) (*RestoreReport, error) {
	snapshot, err := s.Snapshot(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	dir, err := s.SnapshotDir(snapshot.ProjectID, snapshot.ID)
	if err != nil {
		return nil, err
	}
	source := filepath.Join(dir, "src")
	if info, statErr := os.Stat(source); statErr != nil || !info.IsDir() {
		return nil, fmt.Errorf("%w: 快照内容已不在磁盘上", ErrNotFound)
	}
	srcDir, err := s.SrcDir(snapshot.ProjectID)
	if err != nil {
		return nil, err
	}

	report := &RestoreReport{SnapshotID: snapshot.ID, RemovedFiles: []string{}}
	inSnapshot := map[string]bool{}
	// 1) 写回快照里的全部文件
	err = filepath.WalkDir(source, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(source, path)
		if relErr != nil || relative == "." {
			return relErr
		}
		target, resolveErr := ResolveUnder(srcDir, filepath.ToSlash(relative))
		if resolveErr != nil {
			return resolveErr
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if entry.IsDir() {
			inSnapshot[filepath.ToSlash(relative)+"/"] = true
			return os.MkdirAll(target, 0o755)
		}
		inSnapshot[filepath.ToSlash(relative)] = true
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := copyFile(path, target, info.Mode()); err != nil {
			return err
		}
		report.Restored++
		return nil
	})
	if err != nil {
		return nil, err
	}
	// 2) 删掉快照之后新增的文件/目录
	err = filepath.WalkDir(srcDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, relErr := filepath.Rel(srcDir, path)
		if relErr != nil || relative == "." {
			return relErr
		}
		slash := filepath.ToSlash(relative)
		if entry.IsDir() {
			// 目录留到最后统一清理空目录，避免边遍历边删。
			return nil
		}
		if inSnapshot[slash] {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		report.RemovedFiles = append(report.RemovedFiles, slash)
		return nil
	})
	if err != nil {
		return nil, err
	}
	removeEmptyDirs(srcDir, inSnapshot, report)
	s.Touch(ctx, snapshot.ProjectID)
	return report, nil
}

// restoreSnapshotFile 恢复快照中的单个文件，并要求当前文件仍匹配 expectedRevision。
// AI 自动修复只写入一个文件，因此失败回滚也不应触碰项目里的其他同期改动。
func (s *Service) restoreSnapshotFile(ctx context.Context, snapshotID, relative, expectedRevision string) error {
	snapshot, err := s.Snapshot(ctx, snapshotID)
	if err != nil {
		return err
	}
	normalized, err := NormalizeRelative(relative)
	if err != nil {
		return err
	}
	snapshotDir, err := s.SnapshotDir(snapshot.ProjectID, snapshot.ID)
	if err != nil {
		return err
	}
	source, err := ResolveUnder(filepath.Join(snapshotDir, "src"), normalized)
	if err != nil {
		return err
	}
	content, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("读取快照文件失败（%s）：%w", normalized, err)
	}
	_, err = s.WriteFile(ctx, snapshot.ProjectID, normalized, content, expectedRevision)
	return err
}

// removeEmptyDirs 清掉回滚后变空的目录（快照里没有的目录不该留在磁盘上）。
func removeEmptyDirs(srcDir string, inSnapshot map[string]bool, report *RestoreReport) {
	var dirs []string
	_ = filepath.WalkDir(srcDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() || path == srcDir {
			return nil
		}
		relative, relErr := filepath.Rel(srcDir, path)
		if relErr != nil {
			return nil
		}
		slash := filepath.ToSlash(relative) + "/"
		if !inSnapshot[slash] {
			dirs = append(dirs, path)
		}
		return nil
	})
	// 深的先删，父目录才可能随之变空。
	for index := len(dirs) - 1; index >= 0; index-- {
		if err := os.Remove(dirs[index]); err == nil {
			report.RemovedFiles = append(report.RemovedFiles, filepath.ToSlash(dirs[index])+"/")
		}
	}
}

// DeleteSnapshot 删除快照（目录 + 记录）。
func (s *Service) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	snapshot, err := s.Snapshot(ctx, snapshotID)
	if err != nil {
		return err
	}
	if dir, dirErr := s.SnapshotDir(snapshot.ProjectID, snapshot.ID); dirErr == nil {
		_ = os.RemoveAll(dir)
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM latex_snapshots WHERE id = ?`, snapshot.ID)
	return err
}

// pruneSnapshots 只保留最近的若干份，更老的连目录一起清掉。
func (s *Service) pruneSnapshots(ctx context.Context, projectID string) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id FROM latex_snapshots WHERE project_id = ? ORDER BY created_at DESC`, projectID)
	if err != nil {
		return
	}
	var stale []string
	index := 0
	for rows.Next() {
		var id string
		if scanErr := rows.Scan(&id); scanErr != nil {
			break
		}
		index++
		if index > keptSnapshots {
			stale = append(stale, id)
		}
	}
	rows.Close()
	for _, id := range stale {
		if dir, dirErr := s.SnapshotDir(projectID, id); dirErr == nil {
			_ = os.RemoveAll(dir)
		}
		_, _ = s.db.ExecContext(ctx, `DELETE FROM latex_snapshots WHERE id = ?`, id)
	}
}

// copyFile 复制文件并保留权限位（原子写：先写临时文件再改名）。
func copyFile(source, target string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temp, err := os.CreateTemp(filepath.Dir(target), ".readx-*.snap")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	if _, err := io.Copy(temp, input); err != nil {
		temp.Close()
		_ = os.Remove(tempName)
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Chmod(tempName, mode.Perm()); err != nil {
		// 权限位设不上不致命（Windows 上通常如此），继续改名。
		_ = err
	}
	if err := os.Rename(tempName, target); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return nil
}

const maxSnapshotDiffBytes = 512 << 10

// DiffSnapshot 对比某个历史快照与当前工作区源码，列出新增、删除和修改的文件内容。
func (s *Service) DiffSnapshot(ctx context.Context, snapshotID string) (*SnapshotDiffResult, error) {
	snapshot, err := s.Snapshot(ctx, snapshotID)
	if err != nil {
		return nil, err
	}
	snapDir, err := s.SnapshotDir(snapshot.ProjectID, snapshot.ID)
	if err != nil {
		return nil, err
	}
	snapSrc := filepath.Join(snapDir, "src")
	if info, statErr := os.Stat(snapSrc); statErr != nil || !info.IsDir() {
		return nil, fmt.Errorf("%w: 快照内容已不在磁盘上", ErrNotFound)
	}
	curSrc, err := s.SrcDir(snapshot.ProjectID)
	if err != nil {
		return nil, err
	}

	snapFiles, err := collectTreeFiles(snapSrc)
	if err != nil {
		return nil, err
	}
	curFiles, err := collectTreeFiles(curSrc)
	if err != nil {
		return nil, err
	}

	seen := map[string]struct{}{}
	allPaths := make([]string, 0, len(snapFiles)+len(curFiles))
	for p := range snapFiles {
		seen[p] = struct{}{}
		allPaths = append(allPaths, p)
	}
	for p := range curFiles {
		if _, ok := seen[p]; !ok {
			seen[p] = struct{}{}
			allPaths = append(allPaths, p)
		}
	}
	sort.Strings(allPaths)

	diffs := make([]SnapshotFileDiff, 0)
	for _, rel := range allPaths {
		snapAbs, inSnap := snapFiles[rel]
		curAbs, inCur := curFiles[rel]
		kind := FileKind(rel)
		isText := editableKind(kind)

		if !inSnap && inCur {
			item := SnapshotFileDiff{Path: rel, Status: "added", Binary: !isText}
			if isText {
				text, tooBig, readErr := readDiffTextFile(curAbs)
				if readErr != nil {
					return nil, readErr
				}
				item.After = text
				item.TooBig = tooBig
			}
			diffs = append(diffs, item)
			continue
		}
		if inSnap && !inCur {
			item := SnapshotFileDiff{Path: rel, Status: "deleted", Binary: !isText}
			if isText {
				text, tooBig, readErr := readDiffTextFile(snapAbs)
				if readErr != nil {
					return nil, readErr
				}
				item.Before = text
				item.TooBig = tooBig
			}
			diffs = append(diffs, item)
			continue
		}
		// Both exist: compare raw bytes first.
		snapBytes, err := os.ReadFile(snapAbs)
		if err != nil {
			return nil, err
		}
		curBytes, err := os.ReadFile(curAbs)
		if err != nil {
			return nil, err
		}
		if string(snapBytes) == string(curBytes) {
			continue
		}
		item := SnapshotFileDiff{Path: rel, Status: "modified", Binary: !isText}
		if isText {
			if len(snapBytes) > maxSnapshotDiffBytes || len(curBytes) > maxSnapshotDiffBytes {
				item.TooBig = true
			} else {
				item.Before = string(snapBytes)
				item.After = string(curBytes)
			}
		}
		diffs = append(diffs, item)
	}

	return &SnapshotDiffResult{Snapshot: snapshot, Files: diffs}, nil
}

func collectTreeFiles(root string) (map[string]string, error) {
	result := map[string]string{}
	if _, err := os.Stat(root); os.IsNotExist(err) {
		return result, nil
	}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "" || rel == "." {
			return nil
		}
		result[rel] = p
		return nil
	})
	return result, err
}

func readDiffTextFile(path string) (string, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", false, err
	}
	if info.Size() > maxSnapshotDiffBytes {
		return "", true, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false, err
	}
	return string(data), false, nil
}
