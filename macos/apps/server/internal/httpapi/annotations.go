package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/publication"
	"cbctv2/server/internal/safekey"
)

// 批注的类型、颜色与长度上限。白名单而不是自由字符串：这些值会写进 CSS 类名与
// 导出文档，放任输入既可能撑坏界面也可能被注入到 Markdown 里。
const (
	maxAnnotationQuote = 4000
	maxAnnotationNote  = 8000
	maxAnnotationTags  = 12
)

var annotationKinds = map[string]string{
	"highlight": "高亮",
	"underline": "下划线",
	"question":  "问题",
	"margin":    "页边笔记",
}

var annotationColors = map[string]bool{
	"amber": true, "rose": true, "sky": true, "green": true, "violet": true,
}

type Annotation struct {
	Locator     *annotationLocator `json:"locator,omitempty"`
	ID          string             `json:"id"`
	DocumentID  string             `json:"documentId"`
	Page        *int               `json:"page"`
	Kind        string             `json:"kind"`
	Quote       string             `json:"quote"`
	Note        string             `json:"note"`
	Color       string             `json:"color"`
	Tags        []string           `json:"tags"`
	StartOffset *int               `json:"startOffset"`
	EndOffset   *int               `json:"endOffset"`
	CreatedAt   string             `json:"createdAt"`
	UpdatedAt   string             `json:"updatedAt"`
}

type annotationRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}
type annotationLocator struct {
	Kind        string           `json:"kind"`
	Href        string           `json:"href,omitempty"`
	BlockStart  int              `json:"blockStart,omitempty"`
	BlockEnd    int              `json:"blockEnd,omitempty"`
	StartOffset int              `json:"startOffset,omitempty"`
	EndOffset   int              `json:"endOffset,omitempty"`
	Rects       []annotationRect `json:"rects,omitempty"`
	NoteRect    *annotationRect  `json:"noteRect,omitempty"`
}

func validAnnotationRect(rect annotationRect) bool {
	return rect.X >= 0 && rect.Y >= 0 && rect.Width > 0 && rect.Height > 0 && rect.X+rect.Width <= 1.002 && rect.Y+rect.Height <= 1.002
}

func newAnnotationID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "an-" + hex.EncodeToString(buf)
}

// handleAnnotationList 返回一篇论文的全部批注（按页与创建时间排序）。
func (s *Server) handleAnnotationList(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	items, err := s.listAnnotations(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "annotations": items, "total": len(items)})
}

func (s *Server) handleAnnotationCreate(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Locator     *annotationLocator `json:"locator"`
		Page        *int               `json:"page"`
		Kind        string             `json:"kind"`
		Quote       string             `json:"quote"`
		Note        string             `json:"note"`
		Color       string             `json:"color"`
		Tags        []string           `json:"tags"`
		StartOffset *int               `json:"startOffset"`
		EndOffset   *int               `json:"endOffset"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	quote := strings.TrimSpace(body.Quote)
	if quote == "" && body.Kind != "margin" {
		writeError(w, http.StatusBadRequest, "批注必须带上被标注的原文摘录")
		return
	}
	if len([]rune(quote)) > maxAnnotationQuote {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("摘录过长（> %d 字），请缩小选区", maxAnnotationQuote))
		return
	}
	if len([]rune(body.Note)) > maxAnnotationNote {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("批注正文过长（上限 %d 字）", maxAnnotationNote))
		return
	}
	kind := body.Kind
	if kind == "" {
		kind = "highlight"
	}
	if _, known := annotationKinds[kind]; !known {
		writeError(w, http.StatusBadRequest, "不支持的批注类型")
		return
	}
	if kind == "margin" && (strings.TrimSpace(body.Note) == "" || body.Locator == nil || body.Locator.Kind != "pdf" || (body.Locator.NoteRect == nil && len(body.Locator.Rects) != 1)) {
		writeError(w, http.StatusBadRequest, "页边笔记需要内容和 PDF 页面位置")
		return
	}
	color := strings.ToLower(strings.TrimSpace(body.Color))
	if color == "" {
		color = "amber"
	}
	if !annotationColors[color] {
		writeError(w, http.StatusBadRequest, "不支持的批注颜色")
		return
	}
	tags, err := normalizeTags(body.Tags)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if body.Page != nil && (*body.Page < 1 || *body.Page > 5000) {
		writeError(w, http.StatusBadRequest, "页码超出合理范围")
		return
	}
	if body.Locator != nil {
		loc := body.Locator
		if loc.Kind == "pdf" {
			if doc.Format != "pdf" || body.Page == nil || len(loc.Rects) == 0 || len(loc.Rects) > 300 {
				writeError(w, 400, "PDF 批注位置无效")
				return
			}
			for _, rect := range loc.Rects {
				if !validAnnotationRect(rect) {
					writeError(w, 400, "选区坐标必须在页面内")
					return
				}
			}
			if loc.NoteRect != nil && (kind != "margin" || !validAnnotationRect(*loc.NoteRect)) {
				writeError(w, 400, "页边笔记位置必须在页面内")
				return
			}
		} else if loc.Kind == "epub" {
			if doc.Format != "epub" || body.Page != nil || loc.Href == "" || loc.BlockStart < 0 || loc.BlockEnd < loc.BlockStart || loc.StartOffset < 0 || loc.EndOffset < 0 {
				writeError(w, 400, "EPUB 批注必须使用章节与字符位置")
				return
			}
			var raw string
			if err := s.handle.QueryRowContext(r.Context(), `SELECT blocks_json FROM document_sections WHERE document_id=? AND href=?`, key, loc.Href).Scan(&raw); err != nil {
				writeError(w, 400, "批注章节不存在")
				return
			}
			var blocks []publication.Block
			if json.Unmarshal([]byte(raw), &blocks) != nil || loc.BlockEnd >= len(blocks) || loc.StartOffset > len(utf16.Encode([]rune(blocks[loc.BlockStart].Text))) || loc.EndOffset > len(utf16.Encode([]rune(blocks[loc.BlockEnd].Text))) || (loc.BlockStart == loc.BlockEnd && loc.EndOffset <= loc.StartOffset) {
				writeError(w, 400, "批注字符范围超出章节正文")
				return
			}
		} else {
			writeError(w, 400, "批注定位格式无效")
			return
		}
	}

	item := Annotation{
		Locator: body.Locator,
		ID:      newAnnotationID(), DocumentID: key, Page: body.Page, Kind: kind, Quote: quote,
		Note: strings.TrimSpace(body.Note), Color: color, Tags: tags,
		StartOffset: body.StartOffset, EndOffset: body.EndOffset,
		CreatedAt: nowStamp(), UpdatedAt: nowStamp(),
	}
	encodedTags, err := json.Marshal(item.Tags)
	encodedLocator, _ := json.Marshal(item.Locator)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.handle.ExecContext(r.Context(),
		`INSERT INTO annotations(id, document_id, page, quote, note, color, tags, kind, start_offset, end_offset, created_at, updated_at,locator_json)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		item.ID, item.DocumentID, item.Page, item.Quote, item.Note, item.Color, string(encodedTags),
		item.Kind, item.StartOffset, item.EndOffset, item.CreatedAt, item.UpdatedAt, string(encodedLocator)); err != nil {
		writeError(w, http.StatusInternalServerError, "写入批注失败: "+err.Error())
		return
	}
	if _, err := s.recalculateDocumentStatus(r.Context(), key); err != nil {
		writeError(w, http.StatusInternalServerError, "刷新阅读状态失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) handleAnnotationPatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := safekey.Check(id); err != nil {
		writeError(w, http.StatusBadRequest, "非法批注 id: "+err.Error())
		return
	}
	var body struct {
		Note     *string         `json:"note"`
		Color    *string         `json:"color"`
		Kind     *string         `json:"kind"`
		Tags     *[]string       `json:"tags"`
		NoteRect *annotationRect `json:"noteRect"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	sets := []string{}
	args := []any{}
	if body.NoteRect != nil {
		if !validAnnotationRect(*body.NoteRect) {
			writeError(w, http.StatusBadRequest, "页边笔记位置必须在页面内")
			return
		}
		var kind, raw string
		if err := s.handle.QueryRowContext(r.Context(), `SELECT kind, locator_json FROM annotations WHERE id=?`, id).Scan(&kind, &raw); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeError(w, http.StatusNotFound, "没有这条批注")
			} else {
				writeError(w, http.StatusInternalServerError, "读取批注失败")
			}
			return
		}
		var locator annotationLocator
		if kind != "margin" || json.Unmarshal([]byte(raw), &locator) != nil || locator.Kind != "pdf" {
			writeError(w, http.StatusBadRequest, "只有 PDF 页边笔记可以调整位置")
			return
		}
		locator.NoteRect = body.NoteRect
		encoded, err := json.Marshal(locator)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "保存笔记位置失败")
			return
		}
		sets = append(sets, `locator_json = ?`)
		args = append(args, string(encoded))
	}
	if body.Note != nil {
		if strings.TrimSpace(*body.Note) == "" {
			var kind string
			if err := s.handle.QueryRowContext(r.Context(), `SELECT kind FROM annotations WHERE id=?`, id).Scan(&kind); err != nil && !errors.Is(err, sql.ErrNoRows) {
				writeError(w, http.StatusInternalServerError, "读取批注失败")
				return
			} else if kind == "margin" {
				writeError(w, http.StatusBadRequest, "页边笔记内容不能为空")
				return
			}
		}
		if len([]rune(*body.Note)) > maxAnnotationNote {
			writeError(w, http.StatusBadRequest, "批注正文过长")
			return
		}
		sets = append(sets, `note = ?`)
		args = append(args, strings.TrimSpace(*body.Note))
	}
	if body.Color != nil {
		color := strings.ToLower(strings.TrimSpace(*body.Color))
		if !annotationColors[color] {
			writeError(w, http.StatusBadRequest, "不支持的批注颜色")
			return
		}
		sets = append(sets, `color = ?`)
		args = append(args, color)
	}
	if body.Kind != nil {
		var currentKind string
		if err := s.handle.QueryRowContext(r.Context(), `SELECT kind FROM annotations WHERE id=?`, id).Scan(&currentKind); err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "读取批注失败")
			return
		}
		if (*body.Kind == "margin") != (currentKind == "margin") {
			writeError(w, http.StatusBadRequest, "页边笔记不能转换为其他批注类型")
			return
		}
		if _, known := annotationKinds[*body.Kind]; !known {
			writeError(w, http.StatusBadRequest, "不支持的批注类型")
			return
		}
		sets = append(sets, `kind = ?`)
		args = append(args, *body.Kind)
	}
	if body.Tags != nil {
		tags, err := normalizeTags(*body.Tags)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		encoded, _ := json.Marshal(tags)
		sets = append(sets, `tags = ?`)
		args = append(args, string(encoded))
	}
	if len(sets) == 0 {
		writeError(w, http.StatusBadRequest, "没有需要更新的字段")
		return
	}
	sets = append(sets, `updated_at = ?`)
	args = append(args, nowStamp())
	args = append(args, id)

	result, err := s.handle.ExecContext(r.Context(),
		`UPDATE annotations SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "更新批注失败: "+err.Error())
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(w, http.StatusNotFound, "没有这条批注")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "updated": true})
}

func (s *Server) handleAnnotationDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := safekey.Check(id); err != nil {
		writeError(w, http.StatusBadRequest, "非法批注 id: "+err.Error())
		return
	}
	var key string
	if err := s.handle.QueryRowContext(r.Context(), `SELECT document_id FROM annotations WHERE id=?`, id).Scan(&key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这条批注")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "读取批注文档失败: "+err.Error())
		return
	}
	result, err := s.handle.ExecContext(r.Context(), `DELETE FROM annotations WHERE id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "删除批注失败: "+err.Error())
		return
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		writeError(w, http.StatusNotFound, "没有这条批注")
		return
	}
	if _, err := s.recalculateDocumentStatus(r.Context(), key); err != nil {
		writeError(w, http.StatusInternalServerError, "刷新阅读状态失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
}

// handleAnnotationExport 导出 Markdown。批注是用户自己的笔记，导出里保留摘录 + 页码 + 标签，
// 但不掺入任何 AI 生成内容——混在一起会让「我写的」和「模型说的」分不清。
func (s *Server) handleAnnotationExport(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	items, err := s.listAnnotations(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	document, docErr := s.loadDocument(r.Context(), key)
	if errors.Is(docErr, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	}
	if docErr != nil {
		writeError(w, http.StatusInternalServerError, docErr.Error())
		return
	}

	var out strings.Builder
	title := document.Title
	if strings.TrimSpace(title) == "" {
		title = key
	}
	fmt.Fprintf(&out, "# 批注 · %s\n\n", title)
	fmt.Fprintf(&out, "- 论文键：%s\n- 批注数：%d\n- 导出时间：%s\n\n", key, len(items), time.Now().UTC().Format(time.RFC3339))
	if len(items) == 0 {
		out.WriteString("（还没有批注）\n")
	}
	byPage := map[int][]Annotation{}
	order := []int{}
	uncategorized := []Annotation{}
	chapterAnnotations := []Annotation{}
	for _, item := range items {
		if item.Locator != nil && item.Locator.Kind == "epub" {
			chapterAnnotations = append(chapterAnnotations, item)
			continue
		}
		if item.Page == nil {
			uncategorized = append(uncategorized, item)
			continue
		}
		if _, seen := byPage[*item.Page]; !seen {
			order = append(order, *item.Page)
		}
		byPage[*item.Page] = append(byPage[*item.Page], item)
	}
	for _, page := range order {
		fmt.Fprintf(&out, "## Page %d\n\n", page)
		for _, item := range byPage[page] {
			writeAnnotationMarkdown(&out, item)
		}
	}
	if len(uncategorized) > 0 {
		out.WriteString("## 未标页码\n\n")
		for _, item := range uncategorized {
			writeAnnotationMarkdown(&out, item)
		}
	}
	if len(chapterAnnotations) > 0 {
		out.WriteString("## EPUB 章节批注\n\n")
		for _, item := range chapterAnnotations {
			fmt.Fprintf(&out, "### %s\n\n", item.Locator.Href)
			writeAnnotationMarkdown(&out, item)
		}
	}

	filename := legacy.SafeFileStem(key) + "-annotations.md"
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(out.String()))
}

func writeAnnotationMarkdown(out *strings.Builder, item Annotation) {
	label := annotationKinds[item.Kind]
	if label == "" {
		label = item.Kind
	}
	fmt.Fprintf(out, "- **%s**", label)
	if len(item.Tags) > 0 {
		fmt.Fprintf(out, " `%s`", strings.Join(item.Tags, "` `"))
	}
	out.WriteString("\n")
	if item.Quote != "" {
		for _, line := range strings.Split(strings.TrimSpace(item.Quote), "\n") {
			fmt.Fprintf(out, "  > %s\n", line)
		}
	}
	if item.Note != "" {
		fmt.Fprintf(out, "  \n  批注：%s\n", strings.ReplaceAll(item.Note, "\n", "\n  "))
	}
}

func (s *Server) listAnnotations(ctx context.Context, key string) ([]Annotation, error) {
	rows, err := s.handle.QueryContext(ctx,
		`SELECT id, document_id, page, kind, quote, note, color, tags, start_offset, end_offset, created_at, updated_at,locator_json
		 FROM annotations WHERE document_id = ?
		 ORDER BY CASE WHEN page IS NULL THEN 1 ELSE 0 END, page, created_at, id`, key)
	if err != nil {
		return nil, fmt.Errorf("读取批注失败: %w", err)
	}
	defer rows.Close()

	out := []Annotation{}
	for rows.Next() {
		var item Annotation
		var tagsJSON string
		var locatorJSON string
		var page, startOffset, endOffset sql.NullInt64
		if err := rows.Scan(&item.ID, &item.DocumentID, &page, &item.Kind, &item.Quote, &item.Note,
			&item.Color, &tagsJSON, &startOffset, &endOffset, &item.CreatedAt, &item.UpdatedAt, &locatorJSON); err != nil {
			return nil, fmt.Errorf("解析批注失败: %w", err)
		}
		if locatorJSON != "{}" && locatorJSON != "null" {
			if err := json.Unmarshal([]byte(locatorJSON), &item.Locator); err != nil {
				return nil, fmt.Errorf("批注定位数据损坏: %w", err)
			}
		}
		if page.Valid {
			value := int(page.Int64)
			item.Page = &value
		}
		if startOffset.Valid {
			value := int(startOffset.Int64)
			item.StartOffset = &value
		}
		if endOffset.Valid {
			value := int(endOffset.Int64)
			item.EndOffset = &value
		}
		if err := json.Unmarshal([]byte(tagsJSON), &item.Tags); err != nil || item.Tags == nil {
			item.Tags = []string{}
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func normalizeTags(tags []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, tag := range tags {
		trimmed := strings.TrimSpace(tag)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		if len([]rune(trimmed)) > 24 {
			return nil, fmt.Errorf("标签「%s」过长（上限 24 字）", trimmed)
		}
		if strings.ContainsAny(trimmed, "\n\r\t") {
			return nil, fmt.Errorf("标签不能含换行")
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	if len(out) > maxAnnotationTags {
		return nil, fmt.Errorf("标签数量上限 %d", maxAnnotationTags)
	}
	return out, nil
}

// decodeJSON 统一处理「带体请求」的读取与报错。
func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return decodeJSONLimit(w, r, target, 1<<20)
}

func decodeJSONLimit(w http.ResponseWriter, r *http.Request, target any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("请求体超过 %d 字节上限", limit))
			return err
		}
		writeError(w, http.StatusBadRequest, "请求体必须是合法 JSON: "+err.Error())
		return err
	}
	return nil
}
