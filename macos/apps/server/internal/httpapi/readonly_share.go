package httpapi

import (
	"cbctv2/server/internal/legacy"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type shareNote struct {
	Page    *int          `json:"page"`
	Kind    string        `json:"kind"`
	Quote   string        `json:"quote"`
	Note    string        `json:"note"`
	Locator *shareLocator `json:"locator,omitempty"`
}
type shareReading struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type shareDocument struct {
	Key      string         `json:"key"`
	Title    string         `json:"title"`
	Authors  []string       `json:"authors"`
	DOI      string         `json:"doi"`
	Venue    string         `json:"venue"`
	Year     *int           `json:"year"`
	Notes    []shareNote    `json:"notes"`
	Readings []shareReading `json:"readings"`
	PDF      string         `json:"pdf,omitempty"`
	SHA256   string         `json:"sha256,omitempty"`
	EPUB     string         `json:"epub,omitempty"`
	Sections []shareSection `json:"sections,omitempty"`
}
type readonlyShare struct {
	Version     int               `json:"version"`
	CreatedAt   string            `json:"createdAt"`
	Documents   []shareDocument   `json:"documents"`
	Disclosure  string            `json:"disclosure"`
	Ideas       []shareIdea       `json:"ideas,omitempty"`
	Comparisons []shareComparison `json:"comparisons,omitempty"`
}

func (s *Server) handleReadonlyShare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Keys               []string `json:"keys"`
		IncludeOriginal    bool     `json:"includeOriginal"`
		IncludeNotes       bool     `json:"includeNotes"`
		IncludeReadings    bool     `json:"includeReadings"`
		IncludeIdeas       bool     `json:"includeIdeas"`
		IncludeComparisons bool     `json:"includeComparisons"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if len(body.Keys) == 0 || len(body.Keys) > 10 {
		writeError(w, 400, "请选择 1–10 篇文献")
		return
	}
	bundle := readonlyShare{Version: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Documents: []shareDocument{}, Disclosure: "只读分享：AI 精读是生成内容，批注是个人判断。页码使用 PDF 原始页序；未包含原文时不能查看全文上下文。只读不等于防复制，也不代表已取得论文再分发许可。"}
	total := int64(0)
	seen := map[string]bool{}
	for _, key := range body.Keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		doc, err := s.loadDocument(r.Context(), key)
		if err != nil {
			writeError(w, 404, "文献不存在")
			return
		}
		item := shareDocument{Key: doc.Key, Title: doc.Title, Authors: doc.Authors, DOI: doc.DOI, Venue: doc.Venue, Year: doc.Year, Notes: []shareNote{}, Readings: []shareReading{}}
		if body.IncludeNotes {
			rows, e := s.handle.QueryContext(r.Context(), `SELECT page,kind,quote,note,locator_json FROM annotations WHERE document_id=? ORDER BY page,created_at`, doc.ID)
			if e != nil {
				writeError(w, 500, e.Error())
				return
			}
			for rows.Next() {
				var n shareNote
				var locator string
				if e = rows.Scan(&n.Page, &n.Kind, &n.Quote, &n.Note, &locator); e != nil {
					break
				}
				if locator != "" && locator != "{}" {
					var value shareLocator
					if e = json.Unmarshal([]byte(locator), &value); e != nil {
						break
					}
					n.Locator = &value
				}
				item.Notes = append(item.Notes, n)
			}
			if e == nil {
				e = rows.Err()
			}
			rows.Close()
			if e != nil {
				writeError(w, 500, e.Error())
				return
			}
		}
		if body.IncludeReadings || body.IncludeComparisons {
			var raw string
			if err := s.handle.QueryRowContext(r.Context(), `SELECT value_json FROM readings WHERE document_id=?`, doc.ID).Scan(&raw); err != nil && !errors.Is(err, sql.ErrNoRows) {
				writeError(w, 500, err.Error())
				return
			}
			entries := map[string]ReadingEntry{}
			if raw != "" {
				if e := json.Unmarshal([]byte(raw), &entries); e != nil {
					writeError(w, 500, "精读数据损坏，未导出")
					return
				}
			}
			kinds := []string{}
			for kind := range entries {
				if readingKinds[kind] {
					kinds = append(kinds, kind)
				}
			}
			sort.Strings(kinds)
			for _, kind := range kinds {
				if body.IncludeReadings {
					item.Readings = append(item.Readings, shareReading{Kind: kind, Text: entries[kind].Value})
				}
			}
			if body.IncludeComparisons {
				bundle.Comparisons = append(bundle.Comparisons, shareExperiment(doc, entries["experiment"].Value))
			}
		}
		if body.IncludeOriginal {
			if doc.PDFPath == "" {
				paths := legacy.NewPaths(s.cfg.DataRoot)
				if doc.Format == "pdf" {
					doc.PDFPath, _ = paths.PDFFile(doc.Key)
				} else if doc.Format == "epub" {
					doc.PDFPath = filepath.Join(paths.LibraryDir(), doc.Key+".epub")
				}
			}
			if (doc.Format != "pdf" && doc.Format != "epub") || doc.PDFPath == "" {
				writeError(w, 400, "所选条目没有可分享原文件；可取消包含原文后导出题录和笔记")
				return
			}
			info, e := os.Stat(doc.PDFPath)
			if e != nil {
				writeError(w, 400, "原 PDF 不可读")
				return
			}
			total += info.Size()
			if total > 64<<20 {
				writeError(w, 413, "首版分享原文合计上限 64 MiB；请减少文献或不包含原文")
				return
			}
			data, e := os.ReadFile(doc.PDFPath)
			if e != nil {
				writeError(w, 500, "读取原文失败")
				return
			}
			sum := sha256.Sum256(data)
			if doc.Format == "epub" {
				item.EPUB = base64.StdEncoding.EncodeToString(data)
				item.Sections, e = shareEPUBSections(data)
				if e != nil {
					writeError(w, 400, e.Error())
					return
				}
			} else {
				item.PDF = base64.StdEncoding.EncodeToString(data)
			}
			item.SHA256 = hex.EncodeToString(sum[:])
		}
		bundle.Documents = append(bundle.Documents, item)
	}
	if body.IncludeIdeas {
		ideas, e := s.loadIdeas(r.Context())
		if e != nil {
			writeError(w, 500, e.Error())
			return
		}
		bundle.Ideas = shareSelectedIdeas(ideas, seen, bundle.Documents)
	}
	raw, err := json.Marshal(bundle)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	nonce, err := randomLeeJobID()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	html := `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-` + nonce + `'; style-src 'unsafe-inline'; frame-src blob:; object-src blob:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>ReadX 只读分享</title><style>body{font:16px/1.7 system-ui;max-width:1100px;margin:24px auto;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}iframe{width:100%;height:70vh;border:1px solid #ccc}article{border-bottom:1px solid #ccc;padding:20px 0}button{margin:8px;padding:8px}small{color:#555}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px;vertical-align:top}.evidence-target{outline:3px solid #d99b23;background:#fff1b8}</style><h1>ReadX 只读分享</h1><p id="disclosure"></p><main id="content"></main><script id="share-data" type="application/json">` + base64.StdEncoding.EncodeToString(raw) + `</script><script nonce="` + nonce + `">` + readonlyViewerScript + `</script></html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="ReadX-readonly-share.html"`)
	_, _ = fmt.Fprint(w, html)
}

//go:embed readonly_viewer.js
var readonlyViewerScript string
