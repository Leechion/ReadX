package publication

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

// ParseFB2 reads a FictionBook 2.1 document. Every top-level <section> inside
// a <body> becomes one reader chapter (a body without sections is a single
// chapter). Binary parts such as cover images are skipped entirely — only the
// text tree reaches the reader.
func ParseFB2(name string, data []byte) (Book, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	book := Book{Title: strings.TrimSuffix(filepath.Base(name), filepath.Ext(name)), Sections: []Section{}}
	// Tracked context: which description element we are inside, and the body
	// section being built.
	var (
		inDescription  bool
		inBookTitle    bool
		inAuthor       bool
		authorParts    []string
		inBody         bool
		bodySections   int
		current        []Block
		currentTitle   string
		titleCandidate string
		inSectionTitle bool
		sectionDepth   int
		kind           = "p"
		text           strings.Builder
	)
	flush := func() {
		t := strings.Join(strings.Fields(text.String()), " ")
		text.Reset()
		if t == "" {
			return
		}
		if inSectionTitle {
			titleCandidate = t
			return
		}
		current = append(current, Block{Kind: kind, Text: t})
	}
	save := func() {
		if len(current) == 0 && currentTitle == "" && titleCandidate == "" {
			return
		}
		title := currentTitle
		if title == "" {
			title = titleCandidate
		}
		if title == "" {
			title = fmt.Sprintf("第 %d 节", len(book.Sections)+1)
		}
		blocks := current
		if len(blocks) == 0 {
			blocks = []Block{{Kind: "p", Text: title}}
		}
		book.Sections = append(book.Sections, sectionFromBlocks(len(book.Sections)+1, title, blocks, fmt.Sprintf("fb2/%04d", len(book.Sections)+1)))
		current, currentTitle, titleCandidate = nil, "", ""
	}
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			if inBody {
				break // tolerate trailing junk once a body exists
			}
			return Book{}, fmt.Errorf("无法解析 FB2: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			tag := strings.ToLower(t.Name.Local)
			switch {
			case tag == "description":
				inDescription = true
			case tag == "book-title" && inDescription:
				inBookTitle = true
				text.Reset()
			case tag == "author" && inDescription:
				inAuthor = true
				authorParts = nil
			case tag == "body":
				inBody = true
				bodySections = 0
				kind = "p"
				current, currentTitle, titleCandidate = nil, "", ""
			case tag == "section" && inBody:
				sectionDepth++
				if sectionDepth == 1 {
					if len(current) > 0 || currentTitle != "" {
						save()
						bodySections++
					}
					currentTitle, titleCandidate = "", ""
				}
			case tag == "title" && inBody:
				inSectionTitle = true
				text.Reset()
			case inBody && sectionDepth > 0:
				flush()
				switch tag {
				case "p", "epigraph", "cite", "poem":
					kind = "p"
				case "stanza", "verse":
					kind = "blockquote"
				case "subtitle":
					kind = "h3"
				}
			case inBody && tag == "empty-line":
				flush()
			}
		case xml.EndElement:
			tag := strings.ToLower(t.Name.Local)
			switch {
			case tag == "description":
				inDescription = false
			case tag == "book-title" && inBookTitle:
				inBookTitle = false
				if title := strings.Join(strings.Fields(text.String()), " "); title != "" {
					book.Title = title
				}
				text.Reset()
			case (tag == "first-name" || tag == "last-name" || tag == "middle-name") && inAuthor:
				if part := strings.TrimSpace(text.String()); part != "" {
					authorParts = append(authorParts, part)
				}
				text.Reset()
			case tag == "author" && inAuthor:
				inAuthor = false
				if len(authorParts) > 0 {
					book.Authors = append(book.Authors, strings.Join(authorParts, " "))
				}
			case tag == "title" && inSectionTitle:
				inSectionTitle = false
				if title := strings.Join(strings.Fields(text.String()), " "); title != "" {
					titleCandidate = title
				}
				text.Reset()
			case tag == "body" && inBody:
				flush()
				if len(current) > 0 || currentTitle != "" || titleCandidate != "" {
					save()
				}
				inBody = false
			case tag == "section" && inBody && sectionDepth > 0:
				if sectionDepth == 1 {
					flush()
					save()
					bodySections++
				}
				sectionDepth--
			case inBody:
				flush()
			}
		case xml.CharData:
			if inBookTitle || inAuthor || inSectionTitle || (inBody && !inDescription) {
				text.Write(t)
			}
		}
	}
	if len(book.Sections) == 0 {
		return Book{}, fmt.Errorf("FB2 没有可读正文（可能是 DRM 保护或结构损坏）")
	}
	return book, nil
}
