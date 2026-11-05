package httpapi

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestReadonlyShareUnsupportedEPUBImageHasPlaceholder(t *testing.T) {
	original := epubFixture(t)
	archive, err := zip.NewReader(bytes.NewReader(original), int64(len(original)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		name := file.Name
		if name == "picture.png" {
			name = "picture.svg"
			raw = []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>`)
		}
		if name == "chapter.xhtml" {
			raw = []byte(strings.ReplaceAll(string(raw), "picture.png", "picture.svg"))
		}
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write(raw); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	sections, err := shareEPUBSections(out.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, section := range sections {
		for _, block := range section.Blocks {
			if block.Kind == "image" {
				found = true
				if !block.ImageOmitted || block.Image != "" {
					t.Fatal("unsupported image silently vanished or executed", block)
				}
			}
		}
	}
	if !found {
		t.Fatal("image position lost")
	}
}
