package httpapi

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"time"
)

type shareNote struct {
	Page  *int   `json:"page"`
	Kind  string `json:"kind"`
	Quote string `json:"quote"`
	Note  string `json:"note"`
}
type shareReading struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}
type shareDocument struct {
	Title    string         `json:"title"`
	Authors  []string       `json:"authors"`
	DOI      string         `json:"doi"`
	Venue    string         `json:"venue"`
	Year     *int           `json:"year"`
	Notes    []shareNote    `json:"notes"`
	Readings []shareReading `json:"readings"`
	PDF      string         `json:"pdf,omitempty"`
	SHA256   string         `json:"sha256,omitempty"`
}
type readonlyShare struct {
	Version    int             `json:"version"`
	CreatedAt  string          `json:"createdAt"`
	Documents  []shareDocument `json:"documents"`
	Disclosure string          `json:"disclosure"`
}

func (s *Server) handleReadonlyShare(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Keys            []string `json:"keys"`
		IncludeOriginal bool     `json:"includeOriginal"`
		IncludeNotes    bool     `json:"includeNotes"`
		IncludeReadings bool     `json:"includeReadings"`
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
		item := shareDocument{Title: doc.Title, Authors: doc.Authors, DOI: doc.DOI, Venue: doc.Venue, Year: doc.Year, Notes: []shareNote{}, Readings: []shareReading{}}
		if body.IncludeNotes {
			rows, e := s.handle.QueryContext(r.Context(), `SELECT page,kind,quote,note FROM annotations WHERE document_id=? ORDER BY page,created_at`, doc.ID)
			if e != nil {
				writeError(w, 500, e.Error())
				return
			}
			for rows.Next() {
				var n shareNote
				if e = rows.Scan(&n.Page, &n.Kind, &n.Quote, &n.Note); e != nil {
					break
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
		if body.IncludeReadings {
			var raw string
			_ = s.handle.QueryRowContext(r.Context(), `SELECT value_json FROM readings WHERE document_id=?`, doc.ID).Scan(&raw)
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
				item.Readings = append(item.Readings, shareReading{Kind: kind, Text: entries[kind].Value})
			}
		}
		if body.IncludeOriginal {
			if doc.Format != "pdf" || doc.PDFPath == "" {
				writeError(w, 400, "所选条目没有可分享 PDF；可取消包含原文后导出题录和笔记")
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
			item.PDF = base64.StdEncoding.EncodeToString(data)
			item.SHA256 = hex.EncodeToString(sum[:])
		}
		bundle.Documents = append(bundle.Documents, item)
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
	html := `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-` + nonce + `'; style-src 'unsafe-inline'; frame-src blob:; object-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>ReadX 只读分享</title><style>body{font:16px/1.7 system-ui;max-width:1100px;margin:24px auto;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}iframe{width:100%;height:70vh;border:1px solid #ccc}article{border-bottom:1px solid #ccc;padding:20px 0}button{margin:8px;padding:8px}small{color:#555}</style><h1>ReadX 只读分享</h1><p id="disclosure"></p><main id="content"></main><script id="share-data" type="application/json">` + base64.StdEncoding.EncodeToString(raw) + `</script><script nonce="` + nonce + `">` + readonlyViewerScript + `</script></html>`
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="ReadX-readonly-share.html"`)
	_, _ = fmt.Fprint(w, html)
}

const readonlyViewerScript = `
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const data=JSON.parse(new TextDecoder().decode(bytes(document.getElementById('share-data').textContent)));
document.getElementById('disclosure').textContent=data.disclosure;
const add=(parent,tag,text)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
for(const doc of data.documents){
 const article=add(document.getElementById('content'),'article','');add(article,'h2',doc.title);add(article,'p',[...(doc.authors||[]),doc.venue,doc.year,doc.doi].filter(Boolean).join(' · '));
 let frame=null,uri='';
 if(doc.pdf){uri=URL.createObjectURL(new Blob([bytes(doc.pdf)],{type:'application/pdf'}));frame=document.createElement('iframe');frame.title=doc.title;frame.src=uri+'#page=1';article.append(frame);add(article,'small','PDF 预览取决于浏览器。无法预览时可下载后用 PDF 阅读器查看。');const link=add(article,'a','下载所附 PDF');link.href=uri;link.download='paper.pdf';}
 else add(article,'p','未附原文，仅展示已选择的题录和研究材料。');
 for(const note of doc.notes||[]){const block=add(article,'section','');add(block,'h3','个人批注 · '+(note.page?'PDF 页序 '+note.page:'章节定位／无页码'));add(block,'blockquote',note.quote||'');add(block,'pre',note.note||'');if(frame&&note.page){const button=add(block,'button','查看原文第 '+note.page+' 页');button.onclick=()=>{frame.src=uri+'#page='+note.page;frame.scrollIntoView({behavior:'smooth'});};}}
 for(const reading of doc.readings||[]){add(article,'h3','AI 精读 · '+reading.kind);add(article,'pre',reading.text);}
}
`
