package latex

import (
	"bytes"
	"compress/gzip"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyncTeXForwardAndReverse(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(filepath.Join(srcDir, "sec"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"main.tex", "sec/intro.tex"} {
		if err := os.WriteFile(filepath.Join(srcDir, filepath.FromSlash(rel)), []byte("% test\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 100 bp in sp (with Unit:1, Mag:1000): 100 * 65536 * 72.27 / 72 = 6578176
	const spPerPt = 65781.76
	toSP := func(pt float64) int64 { return int64(pt * spPerPt) }

	raw := strings.Join([]string{
		"SyncTeX Version:1",
		"Input:1:" + filepath.Join(srcDir, "main.tex"),
		"Input:2:/usr/share/texlive/texmf-dist/tex/latex/base/article.cls",
		"Input:3:" + filepath.Join(srcDir, "sec", "intro.tex"),
		"Output:pdf",
		"Magnification:1000",
		"Unit:1",
		"X Offset:0",
		"Y Offset:0",
		"Content:",
		"!100",
		"{1",
		"[2,10:0,0:" + itoa(toSP(600)) + "," + itoa(toSP(800)) + ",0",
		"(3,14:" + itoa(toSP(72)) + "," + itoa(toSP(200)) + ":" + itoa(toSP(220)) + "," + itoa(toSP(10)) + "," + itoa(toSP(2)) + "",
		"x3,14:" + itoa(toSP(120)) + "," + itoa(toSP(200)),
		")",
		"(3,28:" + itoa(toSP(72)) + "," + itoa(toSP(240)) + ":" + itoa(toSP(240)) + "," + itoa(toSP(10)) + "," + itoa(toSP(2)) + "",
		")",
		"]",
		"}",
		"Postamble:",
	}, "\n")

	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if _, err := gz.Write([]byte(raw)); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	syncPath := filepath.Join(dir, "main.synctex.gz")
	if err := os.WriteFile(syncPath, compressed.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	data, err := parseSyncTeXFile(syncPath, srcDir)
	if err != nil {
		t.Fatalf("parseSyncTeXFile failed: %v", err)
	}

	// 正向：sec/intro.tex 第 14 行应精确命中第 1 页 y≈190 处
	fwd, err := forwardSyncFromData(data, "sec/intro.tex", 14)
	if err != nil {
		t.Fatalf("forwardSyncFromData failed: %v", err)
	}
	if !fwd.Exact || fwd.Page != 1 || len(fwd.Boxes) == 0 {
		t.Fatalf("unexpected forward result: %+v", fwd)
	}
	if fwd.Boxes[0].X < 70 || fwd.Boxes[0].X > 74 || fwd.Boxes[0].Y < 188 || fwd.Boxes[0].Y > 192 {
		t.Fatalf("unexpected box coordinates: %+v", fwd.Boxes[0])
	}

	// 反向：点击第 1 页 (130, 195) 应跳过外层 article.cls vbox，命中 sec/intro.tex:14
	rev, err := reverseSyncFromData(data, 1, 130, 195)
	if err != nil {
		t.Fatalf("reverseSyncFromData failed: %v", err)
	}
	if rev.File != "sec/intro.tex" || rev.Line != 14 {
		t.Fatalf("unexpected reverse result: %+v", rev)
	}

	// 点击靠近第 28 行处应命中第 28 行
	rev2, err := reverseSyncFromData(data, 1, 150, 236)
	if err != nil {
		t.Fatalf("reverseSyncFromData(28) failed: %v", err)
	}
	if rev2.File != "sec/intro.tex" || rev2.Line != 28 {
		t.Fatalf("unexpected reverse2 result: %+v", rev2)
	}
}

func TestSyncTeXRejectsUnsafeFile(t *testing.T) {
	t.Parallel()
	svc := &Service{}
	if _, err := svc.ForwardSync(context.Background(), "b1", "../secret.tex", 1); err == nil {
		t.Fatal("expected error for unsafe path")
	}
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [32]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
