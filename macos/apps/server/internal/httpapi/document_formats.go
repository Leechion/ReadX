package httpapi

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"cbctv2/server/internal/publication"
)

// 文档格式分两类：page（PDF，逐页 OCR/渲染）与 section（EPUB/TXT/MD/DOCX/FB2/
// MOBI，按章节入库、章节阅读器展示）。新增章节型格式只需要登记在这里并在
// parseSectionBook 补一个分支，其余读写路径都按 isSectionFormat 判断。

var sectionFormats = map[string]bool{"epub": true, "txt": true, "md": true, "docx": true, "fb2": true, "mobi": true}

var sectionFileExtensions = map[string]string{
	"epub": ".epub", "txt": ".txt", "md": ".md", "docx": ".docx", "fb2": ".fb2", "mobi": ".mobi",
}

var sectionFileMimes = map[string]string{
	"epub": "application/epub+zip",
	"txt":  "text/plain; charset=utf-8",
	"md":   "text/markdown; charset=utf-8",
	"docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"fb2":  "text/xml; charset=utf-8",
	"mobi": "application/x-mobipocket-ebook",
}

func isSectionFormat(format string) bool { return sectionFormats[format] }

// isSyncAssetExtension 允许同步与网盘导出携带章节型文档的原始文件。
func isSyncAssetExtension(ext string) bool {
	if ext == ".pdf" {
		return true
	}
	for _, candidate := range sectionFileExtensions {
		if candidate == ext {
			return true
		}
	}
	return false
}

// detectDocumentFormat maps an upload name plus its bytes to a stored format
// value. Content wins over the extension where they disagree, so a mislabelled
// file still imports into the right reader.
func detectDocumentFormat(name string, data []byte) (string, error) {
	if isPDFData(data) {
		return "pdf", nil
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".epub":
		return "epub", nil
	case ".txt":
		return "txt", nil
	case ".md", ".markdown", ".mdown", ".mkd":
		return "md", nil
	case ".docx":
		return "docx", nil
	case ".fb2":
		return "fb2", nil
	case ".mobi", ".azw", ".azw3", ".prc":
		return "mobi", nil
	}
	// 扩展名不认识时按内容嗅探；只认容器魔数，不做「看起来像文本就导入」，
	// 否则下载到的 HTML 网页会被误存成 TXT。
	if bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		if z, err := publication.Archive(data); err == nil {
			if _, err = publication.ReadResource(z, "META-INF/container.xml"); err == nil {
				return "epub", nil
			}
			if _, err = publication.ReadResource(z, "word/document.xml"); err == nil {
				return "docx", nil
			}
		}
		return "", fmt.Errorf("压缩包不是有效的 EPUB 或 DOCX")
	}
	if head := data[:min(len(data), 512)]; bytes.Contains(head, []byte("<FictionBook")) || (bytes.Contains(head, []byte("<?xml")) && bytes.Contains(head, []byte("epubtype"))) {
		return "fb2", nil
	}
	if len(data) > 84 && bytes.Equal(data[60:68], []byte("BOOKMOBI")) {
		return "mobi", nil
	}
	if ext == ".txt" || ext == ".md" || ext == ".markdown" || ext == ".mdown" || ext == ".mkd" {
		if looksLikeText(data) {
			if ext == ".md" || ext == ".markdown" || ext == ".mdown" || ext == ".mkd" {
				return "md", nil
			}
			return "txt", nil
		}
		return "", fmt.Errorf("文本文件包含乱码或二进制内容")
	}
	return "", fmt.Errorf("无法识别的文件类型，请确认扩展名为 PDF/EPUB/TXT/MD/DOCX/FB2/MOBI")
}

func looksLikeText(data []byte) bool {
	limit := data
	if len(limit) > 4096 {
		limit = limit[:4096]
	}
	head := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(string(limit), "\ufeff")))
	if strings.HasPrefix(head, "<!doctype html") || strings.HasPrefix(head, "<html") || strings.HasPrefix(head, "<?xml") || strings.HasPrefix(head, "{\\rtf") {
		return false
	}
	if utf8.Valid(limit) {
		return true
	}
	// 允许 GBK 等双字节中文文本：高位字节占比高且没有 NUL/控制字节。
	var high, allowed int
	for _, b := range limit {
		if b == 0 || (b < 0x09 && b != 0) || (b > 0x0d && b < 0x20 && b != 0x1b) {
			return false
		}
		if b >= 0x80 {
			high++
		}
		allowed++
	}
	return allowed > 0 && high*3 <= allowed*2
}

// parseSectionBook turns bytes already classified as a section format into the
// shared chaptered Book structure.
func parseSectionBook(format, name string, data []byte) (publication.Book, error) {
	switch format {
	case "epub":
		return publication.ParseEPUB(data)
	case "txt", "md":
		return publication.ParseText(name, data)
	case "docx":
		return publication.ParseDOCX(name, data)
	case "fb2":
		return publication.ParseFB2(name, data)
	case "mobi":
		return publication.ParseMOBI(name, data)
	}
	return publication.Book{}, fmt.Errorf("不支持的章节格式 %q", format)
}
