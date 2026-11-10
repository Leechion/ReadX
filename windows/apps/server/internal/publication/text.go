package publication

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// ParseText converts a plain-text or Markdown file into the same chaptered
// Book shape the EPUB pipeline produces, so sections, annotations and the
// chapter reader keep working unchanged. TXT splits on chapter-heading lines
// (第N章 / Chapter N / 序言 …) or fixed chunks; Markdown splits on level-1
// headings and maps inline syntax onto the existing block kinds.
func ParseText(name string, data []byte) (Book, error) {
	text := DecodePlainText(data)
	if strings.TrimSpace(text) == "" {
		return Book{}, fmt.Errorf("文本文件没有可读内容")
	}
	title := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".markdown" || ext == ".mdown" || ext == ".mkd" {
		ext = ".md"
	}
	var book Book
	if ext == ".md" {
		text = stripFrontMatter(text)
		book = parseMarkdown(title, text)
	} else {
		book = parsePlainChapters(title, text)
	}
	if len(book.Sections) == 0 {
		return Book{}, fmt.Errorf("文本没有可分章节的内容")
	}
	return book, nil
}

// DecodePlainText strips the BOM, normalises line endings, and falls back from
// UTF-8 to GB18030 so Chinese web-novel TXT exports do not become mojibake.
const bomMark = "\ufeff"

func DecodePlainText(data []byte) string {
	text := strings.TrimPrefix(string(data), bomMark)
	if utf8.Valid([]byte(text)) {
		return normalizeLineEnds(text)
	}
	out, err := simplifiedchinese.GB18030.NewDecoder().Bytes([]byte(text))
	if err == nil && utf8.Valid(out) {
		return normalizeLineEnds(strings.TrimPrefix(string(out), bomMark))
	}
	return normalizeLineEnds(strings.ToValidUTF8(text, ""))
}

func normalizeLineEnds(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.ReplaceAll(text, bomMark, "")
	return text
}

// txtChapterHeading matches whole-line chapter headings typical of Chinese and
// English TXT novels. plainHeading adds the short-line and sentence guards.
var txtChapterHeading = regexp.MustCompile(`^\s*(?:第\s*[0-9零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章回节卷篇](?:[^\p{L}\p{N}]|$)|Chapter\s+[0-9IVXLCivxlcdm]+(?:\s|$)|CHAPTER\s+[0-9IVXLC]+(?:\s|$)|序[言章]|前言|后记|楔子|尾声|终章)`)

const maxTxtChapterTitle = 40

// plainHeading reports whether a TXT/MOBI line is a chapter heading: either an
// ATX Markdown heading (MOBI markup is normalised to those) or a short
// web-novel style title line that does not end like a sentence.
func plainHeading(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return "", "", false
	}
	if level, title, ok := atxHeading(line); ok {
		return fmt.Sprintf("h%d", level), title, true
	}
	if len([]rune(trimmed)) > maxTxtChapterTitle || endsSentence(trimmed) {
		return "", "", false
	}
	if txtChapterHeading.MatchString(trimmed) {
		return "h2", strings.Join(strings.Fields(trimmed), " "), true
	}
	return "", "", false
}

func endsSentence(text string) bool {
	last := []rune(text)[len([]rune(text))-1]
	return strings.ContainsRune("。！？，；、….!?;", last)
}

// parsePlainChapters splits a TXT book on chapter-heading lines, falling back
// to fixed-size paragraph chunks when the file has no headings.
func parsePlainChapters(title, text string) Book {
	book := Book{Title: title, Sections: []Section{}}
	lines := strings.Split(text, "\n")
	starts := make([]int, 0)
	for index, line := range lines {
		if _, _, ok := plainHeading(line); ok {
			starts = append(starts, index)
		}
	}
	if len(starts) > 0 && starts[0] != 0 {
		starts = append([]int{0}, starts...)
	}
	if len(starts) == 0 {
		return parseChunked(title, lines)
	}
	for position, start := range starts {
		end := len(lines)
		if position+1 < len(starts) {
			end = starts[position+1]
		}
		bodyStart := start
		name := ""
		if _, heading, ok := plainHeading(lines[start]); ok {
			name = heading
			bodyStart = start + 1
		}
		blocks := plainBlocks(lines[bodyStart:end])
		if name == "" && len(blocks) > 0 && strings.HasPrefix(blocks[0].Kind, "h") {
			name = blocks[0].Text
			blocks = blocks[1:]
		}
		if name == "" && len(blocks) == 0 {
			continue
		}
		if name == "" {
			name = title
		}
		if len(blocks) == 0 {
			blocks = []Block{{Kind: "p", Text: name}}
		}
		book.Sections = append(book.Sections, sectionFromBlocks(len(book.Sections)+1, name, blocks, fmt.Sprintf("text/%04d.txt", len(book.Sections)+1)))
	}
	if len(book.Sections) == 0 {
		return parseChunked(title, lines)
	}
	return book
}

// plainBlocks renders one non-empty line as one paragraph — the convention in
// Chinese web-novel TXT where soft-wrapping is rare.
func plainBlocks(lines []string) []Block {
	blocks := []Block{}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if kind, heading, ok := plainHeading(line); ok {
			blocks = append(blocks, Block{Kind: kind, Text: heading})
			continue
		}
		blocks = append(blocks, Block{Kind: "p", Text: strings.Join(strings.Fields(trimmed), " ")})
	}
	return blocks
}

// parseChunked groups paragraphs into bounded sections so a heading-less TXT
// still paginates into readable chapters.
func parseChunked(title string, lines []string) Book {
	book := Book{Title: title, Sections: []Section{}}
	blocks := plainBlocks(lines)
	const perSection = 40
	for start := 0; start < len(blocks); start += perSection {
		end := start + perSection
		if end > len(blocks) {
			end = len(blocks)
		}
		group := blocks[start:end]
		name := fmt.Sprintf("%s · 第 %d 节", title, len(book.Sections)+1)
		book.Sections = append(book.Sections, sectionFromBlocks(len(book.Sections)+1, name, group, fmt.Sprintf("text/%04d.txt", len(book.Sections)+1)))
	}
	return book
}

// stripFrontMatter removes a leading YAML front-matter block (--- … ---) so it
// does not become body text; the document title falls back to the file name.
func stripFrontMatter(text string) string {
	if !strings.HasPrefix(text, "---\n") {
		return text
	}
	if end := strings.Index(text[4:], "\n---\n"); end >= 0 {
		return text[end+8:]
	}
	return text
}

// parseMarkdown treats level-1 ATX headings as chapter boundaries; the text
// before the first heading becomes a preamble section.
func parseMarkdown(title, text string) Book {
	book := Book{Title: title, Sections: []Section{}}
	lines := strings.Split(text, "\n")
	type chunk struct {
		heading string
		lines   []string
	}
	chunks := []chunk{{heading: ""}}
	for _, line := range lines {
		if level, heading, ok := atxHeading(line); ok && level == 1 {
			chunks = append(chunks, chunk{heading: heading})
			continue
		}
		last := len(chunks) - 1
		chunks[last].lines = append(chunks[last].lines, line)
	}
	for _, c := range chunks {
		blocks := markdownBlocks(c.lines)
		name := c.heading
		if name == "" && len(blocks) > 0 && strings.HasPrefix(blocks[0].Kind, "h") {
			name = blocks[0].Text
			blocks = blocks[1:]
		}
		if name == "" && len(blocks) == 0 {
			continue
		}
		if name == "" {
			name = title
		}
		if len(blocks) == 0 {
			blocks = []Block{{Kind: "p", Text: name}}
		}
		book.Sections = append(book.Sections, sectionFromBlocks(len(book.Sections)+1, name, blocks, fmt.Sprintf("text/%04d.md", len(book.Sections)+1)))
	}
	return book
}

var (
	mdListMarker  = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+`)
	mdQuoteMarker = regexp.MustCompile(`^\s*>\s?`)
	mdRuleMarker  = regexp.MustCompile(`^\s*(?:-{3,}|\*{3,}|_{3,})\s*$`)
)

// markdownBlocks converts Markdown source lines into the reader's block kinds,
// tolerating unclosed code fences and leftover inline syntax.
func markdownBlocks(lines []string) []Block {
	blocks := []Block{}
	var paragraph []string
	var code []string
	inFence := false
	flush := func() {
		if len(paragraph) == 0 {
			return
		}
		text := strings.Join(strings.Fields(stripInlineMarkdown(strings.Join(paragraph, " "))), " ")
		paragraph = nil
		if text != "" {
			blocks = append(blocks, Block{Kind: "p", Text: text})
		}
	}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			if inFence {
				blocks = append(blocks, Block{Kind: "pre", Text: strings.TrimRight(strings.Join(code, "\n"), "\n")})
				code, inFence = nil, false
			} else {
				flush()
				inFence = true
			}
			continue
		}
		if inFence {
			code = append(code, line)
			continue
		}
		if level, heading, ok := atxHeading(line); ok {
			flush()
			blocks = append(blocks, Block{Kind: fmt.Sprintf("h%d", level), Text: heading})
			continue
		}
		if trimmed == "" {
			flush()
			continue
		}
		if mdRuleMarker.MatchString(trimmed) {
			flush()
			continue
		}
		if mdQuoteMarker.MatchString(trimmed) {
			flush()
			if text := strings.Join(strings.Fields(stripInlineMarkdown(mdQuoteMarker.ReplaceAllString(trimmed, ""))), " "); text != "" {
				blocks = append(blocks, Block{Kind: "blockquote", Text: text})
			}
			continue
		}
		if mdListMarker.MatchString(trimmed) {
			flush()
			if text := strings.Join(strings.Fields(stripInlineMarkdown(mdListMarker.ReplaceAllString(trimmed, ""))), " "); text != "" {
				blocks = append(blocks, Block{Kind: "li", Text: text})
			}
			continue
		}
		paragraph = append(paragraph, trimmed)
	}
	if inFence && len(code) > 0 {
		blocks = append(blocks, Block{Kind: "pre", Text: strings.TrimRight(strings.Join(code, "\n"), "\n")})
	}
	flush()
	return blocks
}

var (
	mdImagePattern    = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLinkPattern     = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdInlineCodeBackt = regexp.MustCompile("`([^`]*)`")
	mdEmphasisPattern = regexp.MustCompile(`[*_~]{1,3}`)
)

func atxHeading(line string) (int, string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "#") {
		return 0, "", false
	}
	level := 0
	for level < len(trimmed) && trimmed[level] == '#' {
		level++
	}
	if level > 6 || level >= len(trimmed) || (trimmed[level] != ' ' && trimmed[level] != '\t') {
		return 0, "", false
	}
	heading := strings.TrimSpace(strings.TrimRight(strings.TrimSpace(trimmed[level:]), "#"))
	heading = strings.TrimSpace(stripInlineMarkdown(heading))
	if heading == "" {
		return 0, "", false
	}
	return level, heading, true
}

func stripInlineMarkdown(text string) string {
	text = mdImagePattern.ReplaceAllString(text, "")
	text = mdLinkPattern.ReplaceAllString(text, "$1")
	text = mdInlineCodeBackt.ReplaceAllString(text, "$1")
	text = strings.NewReplacer("**", "", "__", "").Replace(text)
	text = mdEmphasisPattern.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

func sectionFromBlocks(index int, title string, blocks []Block, href string) Section {
	var paragraphs []string
	for _, block := range blocks {
		if block.Text != "" {
			paragraphs = append(paragraphs, block.Text)
		}
	}
	return Section{Index: index, Href: href, Title: title, Blocks: blocks, Text: strings.Join(paragraphs, "\n\n")}
}
