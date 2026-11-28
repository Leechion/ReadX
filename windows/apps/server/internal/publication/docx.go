package publication

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
)

// ParseDOCX reads a WordprocessingML document (docx / Office Open XML zip).
// The package is deliberately strict about its own inputs: only document.xml
// and the two relationship parts are parsed, and embedded media is ignored so
// no untrusted binary ever reaches the reader.
func ParseDOCX(name string, data []byte) (Book, error) {
	z, err := Archive(data)
	if err != nil {
		return Book{}, fmt.Errorf("不是有效的 DOCX 压缩包: %w", err)
	}
	raw, err := ReadResource(z, "word/document.xml")
	if err != nil {
		return Book{}, fmt.Errorf("DOCX 缺少正文 document.xml")
	}
	book := Book{Title: strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)), Sections: []Section{}}
	if meta, metaErr := ReadResource(z, "docProps/core.xml"); metaErr == nil {
		var props struct {
			Titles []string `xml:"title"`
		}
		if xml.Unmarshal(meta, &props) == nil && len(props.Titles) > 0 && strings.TrimSpace(props.Titles[0]) != "" {
			book.Title = strings.TrimSpace(props.Titles[0])
		}
	}
	body, err := parseDOCXBody(raw)
	if err != nil {
		return Book{}, fmt.Errorf("无法解析 DOCX 正文: %w", err)
	}
	if len(body) == 0 {
		return Book{}, fmt.Errorf("DOCX 没有可读正文")
	}
	// Split into chapters on page breaks (w:br type="page" / w:sectPr) and on
	// Heading-1 paragraphs; a document with neither becomes a single section.
	var current []Block
	currentTitle := ""
	flush := func() {
		if len(current) == 0 && currentTitle == "" {
			return
		}
		title := currentTitle
		if title == "" {
			title = fmt.Sprintf("第 %d 节", len(book.Sections)+1)
		}
		blocks := current
		if len(blocks) == 0 {
			blocks = []Block{{Kind: "p", Text: title}}
		}
		book.Sections = append(book.Sections, sectionFromBlocks(len(book.Sections)+1, title, blocks, fmt.Sprintf("docx/%04d", len(book.Sections)+1)))
		current, currentTitle = nil, ""
	}
	for _, block := range body {
		switch {
		case block.Kind == "pagebreak":
			flush()
		case block.Kind == "h1":
			// a chapter heading opens the next section and titles it
			flush()
			currentTitle = block.Text
		default:
			current = append(current, block)
		}
	}
	flush()
	if len(book.Sections) == 0 {
		return Book{}, fmt.Errorf("DOCX 没有可读正文")
	}
	return book, nil
}

// parseDOCXBody walks paragraphs and tables of document.xml and emits reader
// blocks. Style names drive heading levels; numbering and fonts are dropped.
func parseDOCXBody(raw []byte) ([]Block, error) {
	d := xml.NewDecoder(bytes.NewReader(raw))
	d.Entity = xml.HTMLEntity
	blocks := []Block{}
	var text strings.Builder
	style := ""
	inCell := false
	var row []string
	var table []Block
	inTable := false
	headingLevel := 0
	pendingPageBreak := false
	flushParagraph := func() {
		t := strings.Join(strings.Fields(text.String()), " ")
		text.Reset()
		kind := "p"
		if headingLevel > 0 {
			kind = fmt.Sprintf("h%d", headingLevel)
		}
		if t != "" {
			if inCell {
				row = append(row, t)
			} else {
				blocks = append(blocks, Block{Kind: kind, Text: t})
			}
		}
		if pendingPageBreak && !inCell {
			blocks = append(blocks, Block{Kind: "pagebreak"})
		}
		pendingPageBreak = false
		headingLevel = 0
		style = ""
	}
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch strings.ToLower(t.Name.Local) {
			case "tbl":
				flushParagraph()
				inTable = true
				table = nil
			case "tr":
				row = nil
			case "tc":
				inCell = true
			case "p":
				if inCell {
					inCell = true
				}
			case "pstyle":
				for _, a := range t.Attr {
					if a.Name.Local == "val" {
						style = a.Value
					}
				}
				if level := docxHeadingLevel(style); level > 0 {
					headingLevel = level
				}
			case "br":
				for _, a := range t.Attr {
					if a.Name.Local == "type" && a.Value == "page" && !inCell {
						pendingPageBreak = true
					}
				}
				if !pendingPageBreak {
					text.WriteByte('\n')
				}
			case "sectpr":
				if !inTable {
					pendingPageBreak = true
				}
			case "t":
				// CharData handled below.
			}
		case xml.EndElement:
			switch strings.ToLower(t.Name.Local) {
			case "p":
				flushParagraph()
				if inCell {
					inCell = false
				}
			case "tr":
				if len(row) > 0 {
					table = append(table, Block{Kind: "tr", Text: strings.Join(row, " | ")})
					row = nil
				}
			case "tc":
				inCell = false
			case "tbl":
				flushParagraph()
				blocks = append(blocks, table...)
				table, inTable = nil, false
			}
		case xml.CharData:
			text.Write(t)
		}
	}
	flushParagraph()
	// resolve style names lazily: Word uses style ids like "Heading1" or the
	// Chinese UI's localized ids; the prefix check above covers the common ones.
	return blocks, nil
}

func docxHeadingLevel(style string) int {
	lower := strings.ToLower(style)
	for level := 1; level <= 6; level++ {
		if lower == fmt.Sprintf("heading%d", level) || lower == fmt.Sprintf("h%d", level) {
			return level
		}
	}
	if strings.HasPrefix(lower, "标题") {
		if n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(lower, "标题"))); err == nil && n >= 1 && n <= 6 {
			return n
		}
	}
	return 0
}
