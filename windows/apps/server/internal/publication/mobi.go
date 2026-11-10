package publication

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"html"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
)

// ParseMOBI reads the PalmDOC/MOBI container used by older Kindle books.
// DRM (encryption 1/2), KF8-only payloads and HUFF/CDIC compression are
// rejected with a clear message instead of producing mojibake. AZW3 (KF8)
// files are reported so users can convert them.
func ParseMOBI(name string, data []byte) (Book, error) {
	if len(data) < 86 {
		return Book{}, fmt.Errorf("MOBI 文件过短")
	}
	numRecords := int(binary.BigEndian.Uint16(data[76:78]))
	if numRecords < 2 || numRecords > 65534 {
		return Book{}, fmt.Errorf("MOBI 记录数无效")
	}
	record := func(index int) ([]byte, error) {
		if index < 0 || index >= numRecords {
			return nil, fmt.Errorf("MOBI 记录号越界")
		}
		entry := 78 + index*8
		if entry+4 > len(data) {
			return nil, fmt.Errorf("MOBI 记录目录损坏")
		}
		start := int(be32(data[entry : entry+4]))
		if start <= 0 || start >= len(data) {
			return nil, fmt.Errorf("MOBI 记录偏移损坏")
		}
		end := len(data)
		if entry+8+4 <= len(data) {
			if next := int(be32(data[entry+8 : entry+12])); next > start && next <= len(data) {
				end = next
			}
		}
		return data[start:end], nil
	}
	header, err := record(0)
	if err != nil {
		return Book{}, fmt.Errorf("MOBI 头部损坏: %w", err)
	}
	if len(header) < 16 {
		return Book{}, fmt.Errorf("MOBI 头部损坏")
	}
	// PalmDOC header: compression u16@0, text_length u32@4, text_records u16@8,
	// encryption u16@12. ("MOBI" magic then starts at offset 16.)
	compression := int(binary.BigEndian.Uint16(header[0:2]))
	textLength := int(be32(header[4:8]))
	textRecords := int(binary.BigEndian.Uint16(header[8:10]))
	encryption := int(binary.BigEndian.Uint16(header[12:14]))
	if encryption != 0 {
		return Book{}, fmt.Errorf("该 MOBI 受 DRM 保护，无法导入")
	}
	switch compression {
	case 1: // none
	case 2: // PalmDOC LZ77
	case 17480:
		return Book{}, fmt.Errorf("暂不支持 HUFF/CDIC 压缩的 MOBI（请在 Kindle 应用重新下载或转成 EPUB）")
	default:
		return Book{}, fmt.Errorf("未知的 MOBI 压缩方式")
	}
	if textRecords <= 0 || textRecords > numRecords-1 {
		textRecords = numRecords - 1
	}
	if textLength <= 0 || textLength > 256<<20 {
		return Book{}, fmt.Errorf("MOBI 正文长度异常")
	}
	var raw bytes.Buffer
	for index := 1; index <= textRecords && raw.Len() < textLength; index++ {
		chunk, e := record(index)
		if e != nil {
			break
		}
		if compression == 2 {
			if chunk, e = palmdocDecompress(chunk); e != nil {
				return Book{}, fmt.Errorf("MOBI 正文解压失败: %w", e)
			}
		}
		raw.Write(chunk)
	}
	text := raw.Bytes()
	if len(text) > textLength {
		text = text[:textLength]
	}
	if len(text) == 0 {
		return Book{}, fmt.Errorf("MOBI 没有可读正文（可能是 KF8/AZW3 新版格式）")
	}
	book := Book{Title: strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)), Authors: []string{}, Sections: []Section{}}
	// EXTH follows the MOBI header inside record 0; it carries the real title
	// and author. The "MOBI" magic sits at header offset 16.
	if len(header) >= 20 && string(header[16:20]) == "MOBI" {
		if at := bytes.Index(header[16:], []byte("EXTH")); at >= 0 {
			title, author := parseEXTH(header[16+at:])
			if title != "" {
				book.Title = title
			}
			if author != "" {
				book.Authors = []string{author}
			}
		}
	}
	plain := mobiMarkupToText(mobiDecodeCharset(text))
	if strings.TrimSpace(plain) == "" {
		return Book{}, fmt.Errorf("MOBI 正文为空")
	}
	parsed := parsePlainChapters(book.Title, plain)
	if len(parsed.Sections) == 0 {
		return Book{}, fmt.Errorf("MOBI 正文无法分章")
	}
	parsed.Title = book.Title
	parsed.Authors = book.Authors
	return parsed, nil
}

func parseEXTH(exth []byte) (title, author string) {
	if len(exth) < 12 || string(exth[:4]) != "EXTH" {
		return "", ""
	}
	count := int(be32(exth[8:12]))
	cursor := 12
	for i := 0; i < count && cursor+8 <= len(exth); i++ {
		kind := be32(exth[cursor : cursor+4])
		size := int(be32(exth[cursor+4 : cursor+8]))
		cursor += 8
		if size < 8 || cursor+size-8 > len(exth) {
			break
		}
		value := string(exth[cursor : cursor+size-8])
		cursor += size - 8
		switch kind {
		case 100:
			if title == "" {
				title = strings.TrimSpace(value)
			}
		case 101:
			if author == "" {
				author = strings.TrimSpace(strings.ReplaceAll(value, "/", "、"))
			}
		}
	}
	return title, author
}

var (
	mobiTagPattern = regexp.MustCompile(`<[^>]*>`)
	mobiHeading    = regexp.MustCompile(`(?is)<h([1-3])[^>]*>(.*?)</h[1-3]>`)
	mobiParaBreak  = regexp.MustCompile(`(?i)</(div|p|li|blockquote|table|h[1-6])\s*>|<br\s*/?>`)
)

// mobiMarkupToText turns MOBI body markup (plain PalmDOC text or stripped
// HTML) into Markdown-ish plain text so the TXT chapter splitter can find
// headings.
func mobiMarkupToText(text string) string {
	text = mobiHeading.ReplaceAllStringFunc(text, func(match string) string {
		groups := mobiHeading.FindStringSubmatch(match)
		return "\n\n" + strings.Repeat("#", len(groups[1])) + " " + strings.TrimSpace(mobiTagPattern.ReplaceAllString(groups[2], "")) + "\n\n"
	})
	text = mobiParaBreak.ReplaceAllString(text, "\n")
	text = mobiTagPattern.ReplaceAllString(text, "")
	text = html.UnescapeString(text)
	return text
}

// mobiDecodeCharset maps the body bytes to UTF-8: files that already validate
// as UTF-8 pass through, CJK byte pairs try GBK/Big5/EUC-JP/EUC-KR, and the
// remaining Latin-1 range falls back to Windows-1252 (the PalmDOC default).
func mobiDecodeCharset(text []byte) string {
	if utf8.Valid(text) {
		return string(text)
	}
	encoders := []struct {
		name    string
		decoder interface {
			Bytes([]byte) ([]byte, error)
		}
	}{
		{"gbk", simplifiedchinese.GBK.NewDecoder()},
		{"big5", traditionalchinese.Big5.NewDecoder()},
		{"eucjp", japanese.EUCJP.NewDecoder()},
		{"euckr", korean.EUCKR.NewDecoder()},
		{"cp1252", charmap.Windows1252.NewDecoder()},
	}
	if hasCJKPairBytes(text) {
		encoders = encoders[:4]
	} else {
		encoders = encoders[4:]
	}
	for _, candidate := range encoders {
		decoded, err := candidate.decoder.Bytes(text)
		if err == nil && utf8.Valid(decoded) {
			return string(decoded)
		}
	}
	return strings.ToValidUTF8(string(text), "")
}

func hasCJKPairBytes(data []byte) bool {
	for i := 0; i+1 < len(data); i++ {
		if data[i] >= 0x81 && data[i] <= 0xf7 && data[i+1] >= 0x40 && data[i+1] <= 0xfe && data[i+1] != 0x7f {
			return true
		}
	}
	return false
}

// palmdocDecompress implements the PalmDOC LZ77 variant used by MOBI.
func palmdocDecompress(data []byte) ([]byte, error) {
	out := make([]byte, 0, len(data)*2)
	for i := 0; i < len(data); {
		b := data[i]
		switch {
		case b == 0 || (b >= 0x09 && b <= 0x7f):
			out = append(out, b)
			i++
		case b <= 0x08:
			n := int(b)
			if i+1+n > len(data) {
				return nil, fmt.Errorf("MOBI 压缩流截断")
			}
			out = append(out, data[i+1:i+1+n]...)
			i += 1 + n
		case b >= 0x80 && b <= 0xbf:
			if i+1 >= len(data) {
				return nil, fmt.Errorf("MOBI 压缩流截断")
			}
			pair := uint16(b)<<8 | uint16(data[i+1])
			distance := int(pair>>3) & 0x7ff
			length := int(pair&7) + 3
			if distance == 0 || distance > len(out) {
				return nil, fmt.Errorf("MOBI 压缩距离越界")
			}
			start := len(out) - distance
			for n := 0; n < length; n++ {
				out = append(out, out[start+n])
			}
			i += 2
		default:
			out = append(out, ' ', b&0x7f)
			i++
		}
	}
	return out, nil
}

func be32(data []byte) uint32 { return binary.BigEndian.Uint32(data) }
