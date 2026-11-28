package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func open(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "nested", "reader.db")
	handle, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	return handle, path
}

func TestOpenCreatesDirAndMigrates(t *testing.T) {
	handle, path := open(t)
	if fi, err := filepath.Glob(filepath.Dir(path)); err != nil || len(fi) != 1 {
		t.Fatalf("父目录应已创建: %v", err)
	}
	version, err := Version(context.Background(), handle)
	if err != nil {
		t.Fatal(err)
	}
	// 期望值取自内嵌迁移本身：写死数字会让「加一次迁移」等于「测试失败一次」。
	latest, err := LatestVersion()
	if err != nil {
		t.Fatal(err)
	}
	if version != latest {
		t.Fatalf("迁移版本应为 %d，实际 %d", latest, version)
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	// documents / document_pages / readings / annotations / translations / app_state / schema_migrations
	if count < 7 {
		t.Fatalf("建表数量异常: %d", count)
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reader.db")
	first, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec(`INSERT INTO documents(id, title) VALUES('a','A')`); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("重开应幂等: %v", err)
	}
	defer second.Close()

	var applied int
	if err := second.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	// 幂等的判据是「等于迁移条数」，而不是某个写死的数字。
	migrations, err := MigrationCount()
	if err != nil {
		t.Fatal(err)
	}
	if applied != migrations {
		t.Fatalf("重复 Open 不应追加迁移记录，实际 %d 条（迁移共 %d 条）", applied, migrations)
	}
	var title string
	if err := second.QueryRow(`SELECT title FROM documents WHERE id='a'`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "A" {
		t.Fatalf("数据应保留，实际 %q", title)
	}
}

func TestWALAndForeignKeysEnabled(t *testing.T) {
	handle, _ := open(t)
	var mode string
	if err := handle.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode 应为 wal，实际 %q", mode)
	}
	var fk int
	if err := handle.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil {
		t.Fatal(err)
	}
	if fk != 1 {
		t.Fatalf("foreign_keys 应开启，实际 %d", fk)
	}
}

func TestCascadeDeleteKeepsNoOrphans(t *testing.T) {
	ctx := context.Background()
	handle, _ := open(t)
	if _, err := handle.ExecContext(ctx,
		`INSERT INTO documents(id, key, title) VALUES('d1','k1','Paper')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.ExecContext(ctx,
		`INSERT INTO document_pages(document_id, page, text) VALUES('d1', 1, 'first page')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.ExecContext(ctx,
		`INSERT INTO readings(document_id, value_json) VALUES('d1', '{}')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.ExecContext(ctx,
		`INSERT INTO annotations(id, document_id, page, quote) VALUES('a1','d1',1,'q')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.ExecContext(ctx, `DELETE FROM documents WHERE id='d1'`); err != nil {
		t.Fatal(err)
	}
	for table, query := range map[string]string{
		"document_pages": `SELECT COUNT(*) FROM document_pages WHERE document_id='d1'`,
		"readings":       `SELECT COUNT(*) FROM readings WHERE document_id='d1'`,
		"annotations":    `SELECT COUNT(*) FROM annotations WHERE document_id='d1'`,
	} {
		var n int
		if err := handle.QueryRow(query).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s 残留孤儿行 %d 条（级联删除未生效）", table, n)
		}
	}
	var ftsHits int
	if err := handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM document_pages_fts WHERE document_pages_fts MATCH 'first'`).Scan(&ftsHits); err != nil {
		t.Fatalf("查询 FTS5 失败: %v", err)
	}
	if ftsHits != 0 {
		t.Fatalf("级联删除文档后 document_pages_fts 不应残留命中，实际 %d 条", ftsHits)
	}
	var docsize int
	if err := handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM document_pages_fts_docsize`).Scan(&docsize); err != nil {
		t.Fatalf("查询 FTS5 docsize 失败: %v", err)
	}
	if docsize != 0 {
		t.Fatalf("级联删除文档后 document_pages_fts_docsize 应为 0，实际 %d 条", docsize)
	}
	if _, err := handle.ExecContext(ctx, `INSERT INTO document_pages_fts(document_pages_fts) VALUES('integrity-check')`); err != nil {
		t.Fatalf("document_pages_fts integrity-check 失败: %v", err)
	}
}

func TestDuplicateDocumentKeyRejectedButEmptyAllowed(t *testing.T) {
	handle, _ := open(t)
	if _, err := handle.Exec(`INSERT INTO documents(id, key) VALUES('a','same')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO documents(id, key) VALUES('b','')`); err != nil {
		t.Fatalf("key 为空不应受唯一约束: %v", err)
	}
	if _, err := handle.Exec(`INSERT INTO documents(id, key) VALUES('c','')`); err != nil {
		t.Fatalf("多条空 key 应允许: %v", err)
	}
	if _, err := handle.Exec(`INSERT INTO documents(id, key) VALUES('d','same')`); err == nil {
		t.Fatal("重复 key 必须被唯一索引拒绝")
	}
}

func TestEmptyPathRejected(t *testing.T) {
	if _, err := Open(context.Background(), ""); err == nil {
		t.Fatal("空路径应报错")
	}
}
