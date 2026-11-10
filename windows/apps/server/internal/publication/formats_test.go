package publication

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestParseTextChapters(t *testing.T) {
	text := "楔子\n\n很久以前有一座山。\n\n第一章 起风\n\n风从北面来。\n又短又急。\n\n第二章 归途\n\n他往南走。\n"
	book, err := ParseText("novel.txt", []byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "novel" {
		t.Fatalf("title = %q", book.Title)
	}
	if len(book.Sections) != 3 {
		for _, s := range book.Sections {
			t.Logf("section %d: %q blocks=%d", s.Index, s.Title, len(s.Blocks))
		}
		t.Fatalf("sections = %d, want 3", len(book.Sections))
	}
	if book.Sections[1].Title != "第一章 起风" {
		t.Fatalf("section 2 title = %q", book.Sections[1].Title)
	}
	// Each source line becomes its own paragraph (web-novel convention).
	if len(book.Sections[1].Blocks) != 2 || book.Sections[1].Blocks[0].Text != "风从北面来。" {
		t.Fatalf("blocks = %+v", book.Sections[1].Blocks)
	}
	if !strings.Contains(book.Sections[1].Text, "风从北面来") {
		t.Fatalf("section text = %q", book.Sections[1].Text)
	}
}

func TestParseTextChunkedFallback(t *testing.T) {
	var builder strings.Builder
	for i := 0; i < 100; i++ {
		builder.WriteString("普通段落内容，没有任何章节标题。\n\n")
	}
	book, err := ParseText("plain.txt", []byte(builder.String()))
	if err != nil {
		t.Fatal(err)
	}
	if len(book.Sections) < 2 {
		t.Fatalf("expected chunked sections, got %d", len(book.Sections))
	}
	total := 0
	for _, s := range book.Sections {
		total += len(s.Blocks)
	}
	if total != 100 {
		t.Fatalf("paragraph count = %d, want 100", total)
	}
}

func TestParseTextGBKDecodes(t *testing.T) {
	gbk, err := gb18030Encode("第一章 标题\n\n中文正文。\n")
	if err != nil {
		t.Fatal(err)
	}
	book, err := ParseText("gbk.txt", gbk)
	if err != nil {
		t.Fatal(err)
	}
	if len(book.Sections) == 0 || book.Sections[0].Title != "第一章 标题" {
		t.Fatalf("sections = %+v", book.Sections)
	}
}

func TestParseMarkdownSplitsOnH1(t *testing.T) {
	source := "---\ntitle: 笔记\n---\n\n# 引言\n\n这是**引言**正文,含[链接](https://example.com)。\n\n# 方法\n\n> 引用一句\n\n- 第一点\n- 第二点\n\n```python\nprint(1)\n```\n\n## 小节\n\n完成。\n"
	book, err := ParseText("note.md", []byte(source))
	if err != nil {
		t.Fatal(err)
	}
	if len(book.Sections) != 2 {
		for _, s := range book.Sections {
			t.Logf("section %d: %q", s.Index, s.Title)
		}
		t.Fatalf("sections = %d, want 2", len(book.Sections))
	}
	if book.Sections[0].Title != "引言" {
		t.Fatalf("first title = %q", book.Sections[0].Title)
	}
	kinds := map[string]int{}
	for _, b := range book.Sections[1].Blocks {
		kinds[b.Kind]++
		if b.Kind == "pre" && b.Text != "print(1)" {
			t.Fatalf("code block = %q", b.Text)
		}
		if b.Kind == "li" && !strings.HasPrefix(b.Text, "第") {
			t.Fatalf("list item = %q", b.Text)
		}
	}
	if kinds["p"] == 0 || kinds["li"] != 2 || kinds["blockquote"] != 1 || kinds["pre"] != 1 || kinds["h2"] != 1 {
		t.Fatalf("kinds = %+v", kinds)
	}
	if strings.Contains(book.Sections[0].Blocks[len(book.Sections[0].Blocks)-1].Text, "[") {
		t.Fatal("inline markdown not stripped")
	}
}

func TestParseDOCXHeadingsAndTables(t *testing.T) {
	body := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
		`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 绪论</w:t></w:r></w:p>` +
		`<w:p><w:r><w:t>正文一段。</w:t></w:r></w:p>` +
		`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>列一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>列二</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
		`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第二章 方法</w:t></w:r></w:p>` +
		`<w:p><w:r><w:t>方法正文。</w:t></w:r></w:p>` +
		`<w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
		`<w:p><w:r><w:t>页面分隔后的续篇。</w:t></w:r></w:p>` +
		`</w:body></w:document>`
	meta := `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">研究报告</dc:title></cp:coreProperties>`
	data := zipFixture(t, map[string]string{"word/document.xml": body, "docProps/core.xml": meta})
	book, err := ParseDOCX("paper.docx", data)
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "研究报告" {
		t.Fatalf("title = %q", book.Title)
	}
	if len(book.Sections) != 3 {
		for _, s := range book.Sections {
			t.Logf("section %d: %q blocks=%+v", s.Index, s.Title, s.Blocks)
		}
		t.Fatalf("sections = %d, want 3", len(book.Sections))
	}
	if book.Sections[0].Title != "第一章 绪论" {
		t.Fatalf("section 1 title = %q", book.Sections[0].Title)
	}
	var hasTable bool
	for _, b := range book.Sections[0].Blocks {
		if b.Kind == "tr" {
			hasTable = true
		}
	}
	if !hasTable {
		t.Fatalf("table row missing: %+v", book.Sections[0].Blocks)
	}
}

func TestParseDOCXRejectsNonZip(t *testing.T) {
	if _, err := ParseDOCX("bad.docx", []byte("not a zip")); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseFB2Sections(t *testing.T) {
	doc := `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>雪山</book-title><author><first-name>李</first-name><last-name>白</last-name></author></title-info></description>
<body>
<section><title><p>序章</p></title><p>山在那里。</p></section>
<section><title><p>第一章</p></title><p>雪落了一夜。</p><empty-line/><p>他出发了。</p><stanza><verse>北风卷地</verse><verse>白草折</verse></stanza></section>
</body>
</FictionBook>`
	book, err := ParseFB2("snow.fb2", []byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "雪山" {
		t.Fatalf("title = %q", book.Title)
	}
	if len(book.Authors) != 1 || book.Authors[0] != "李 白" {
		t.Fatalf("authors = %+v", book.Authors)
	}
	if len(book.Sections) != 2 {
		t.Fatalf("sections = %d", len(book.Sections))
	}
	if book.Sections[0].Title != "序章" {
		t.Fatalf("section 1 title = %q", book.Sections[0].Title)
	}
	kinds := map[string]int{}
	for _, b := range book.Sections[1].Blocks {
		kinds[b.Kind]++
	}
	if kinds["p"] != 2 || kinds["blockquote"] != 2 {
		t.Fatalf("kinds = %+v blocks=%+v", kinds, book.Sections[1].Blocks)
	}
}

func TestParseFB2RejectsEmpty(t *testing.T) {
	if _, err := ParseFB2("bad.fb2", []byte("<FictionBook><body></body></FictionBook>")); err == nil {
		t.Fatal("expected error")
	}
}

func TestParseMOBIPlain(t *testing.T) {
	text := "<h1>第一章 出发</h1><p>清晨的路。</p><p>第二段。</p><br/><h1>第二章 抵达</h1><p>到了。</p>"
	data := mobiFixture(t, []byte(text), 1, "移动书", "王二")
	book, err := ParseMOBI("moving.mobi", data)
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "移动书" {
		t.Fatalf("title = %q", book.Title)
	}
	if len(book.Authors) != 1 || book.Authors[0] != "王二" {
		t.Fatalf("authors = %+v", book.Authors)
	}
	if len(book.Sections) != 2 {
		for _, s := range book.Sections {
			t.Logf("section %d: %q", s.Index, s.Title)
		}
		t.Fatalf("sections = %d", len(book.Sections))
	}
	if book.Sections[0].Title != "第一章 出发" {
		t.Fatalf("section 1 title = %q", book.Sections[0].Title)
	}
	if len(book.Sections[0].Blocks) != 2 {
		t.Fatalf("blocks = %+v", book.Sections[0].Blocks)
	}
}

func TestParseMOBIRejectsDRM(t *testing.T) {
	data := mobiFixture(t, []byte("<p>x</p>"), 1, "", "")
	// Flip the encryption flag (u16 at MOBI header offset 12) in record 0.
	rec0 := int(binary.BigEndian.Uint32(data[78:82]))
	data[rec0+13] = 1
	if _, err := ParseMOBI("drm.mobi", data); err == nil || !strings.Contains(err.Error(), "DRM") {
		t.Fatalf("err = %v", err)
	}
}

func TestPalmDocDecompress(t *testing.T) {
	// literal run {3, A, B, C}, then back-reference pair distance=3 length=3.
	encoded := []byte{3, 'A', 'B', 'C', 0x80, 0x18}
	out, err := palmdocDecompress(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "ABCABC" {
		t.Fatalf("out = %q", out)
	}
}

// zipFixture builds a small in-memory zip used by DOCX tests.
func zipFixture(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// mobiFixture assembles a minimal uncompressed MOBI: 78-byte header plus
// record-info entries, record 0 with MOBI+EXTH headers, and text records.
func mobiFixture(t *testing.T, body []byte, numTextRecords int, title, author string) []byte {
	t.Helper()
	records := 1 + numTextRecords
	header := make([]byte, 78)
	binary.BigEndian.PutUint16(header[76:78], uint16(records))

	mobi := make([]byte, 232)
	binary.BigEndian.PutUint16(mobi[0:2], 1) // compression: none
	binary.BigEndian.PutUint32(mobi[4:8], uint32(len(body)*numTextRecords))
	binary.BigEndian.PutUint16(mobi[8:10], uint16(numTextRecords))
	binary.BigEndian.PutUint16(mobi[12:14], 0) // encryption: none
	copy(mobi[16:20], "MOBI")
	binary.BigEndian.PutUint32(mobi[20:24], uint32(len(mobi)))

	var exthRecords bytes.Buffer
	exthCount := 0
	for _, item := range []struct {
		kind  uint32
		value string
	}{{100, title}, {101, author}} {
		if item.value == "" {
			continue
		}
		exthRecords.Write(exthRecord(item.kind, item.value))
		exthCount++
	}
	exth := make([]byte, 12)
	copy(exth, "EXTH")
	binary.BigEndian.PutUint32(exth[4:8], uint32(12+exthRecords.Len()))
	binary.BigEndian.PutUint32(exth[8:12], uint32(exthCount))

	recordZero := append(append(append([]byte{}, mobi...), exth...), exthRecords.Bytes()...)

	offsets := make([]uint32, records)
	cursor := uint32(len(header) + records*8)
	for index := range offsets {
		offsets[index] = cursor
		if index == 0 {
			cursor += uint32(len(recordZero))
		} else {
			cursor += uint32(len(body))
		}
	}
	var buf bytes.Buffer
	buf.Write(header)
	for _, off := range offsets {
		var entry [8]byte
		binary.BigEndian.PutUint32(entry[:4], off)
		buf.Write(entry[:])
	}
	buf.Write(recordZero)
	for i := 0; i < numTextRecords; i++ {
		buf.Write(body)
	}
	return buf.Bytes()
}

func gb18030Encode(text string) ([]byte, error) {
	return simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(text))
}

func exthRecord(kind uint32, value string) []byte {
	var out bytes.Buffer
	var head [8]byte
	binary.BigEndian.PutUint32(head[:4], kind)
	binary.BigEndian.PutUint32(head[4:], uint32(8+len(value)))
	out.Write(head[:])
	out.WriteString(value)
	return out.Bytes()
}
