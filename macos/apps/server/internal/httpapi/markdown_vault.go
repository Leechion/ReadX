package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"cbctv2/server/internal/citation"
)

type vaultAnnotation struct {
	Page  *int
	Kind  string
	Quote string
	Note  string
	Color string
}

type vaultIdeaLink struct {
	Slug     string
	Question string
}

func (s *Server) handleExportMarkdownVault(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	query, err := parseVaultQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	works, _, err := s.loadCitationWorks(ctx, query)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	metaMap, err := s.loadAllMeta(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	ideas, err := s.loadIdeas(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	usedCiteKeys := map[string]int{}
	usedFileNames := map[string]int{}
	paperSlugs := map[string]string{}
	paperCiteKeys := map[string]string{}
	selectedSet := map[string]bool{}

	for _, wItem := range works {
		selectedSet[wItem.Key] = true
		citeKey := citation.CiteKey(wItem, usedCiteKeys)
		paperCiteKeys[wItem.Key] = citeKey
		paperSlugs[wItem.Key] = uniqueVaultNoteName(wItem.Title, citeKey, usedFileNames)
	}

	// Collect relevant ideas & build paper <-> idea backlink maps.
	exportedIdeas := make([]ResearchIdea, 0)
	ideaSlugs := map[string]string{}
	usedIdeaNames := map[string]int{}
	paperIdeas := map[string][]vaultIdeaLink{}
	exportAll := len(query.keys) == 0 && query.category == ""

	for _, idea := range ideas {
		matched := exportAll
		linkedPapers := make([]string, 0)
		seenLinked := map[string]bool{}
		for _, ev := range idea.Evidence {
			if ev.PaperKey == "" {
				continue
			}
			if selectedSet[ev.PaperKey] {
				matched = true
				if !seenLinked[ev.PaperKey] {
					seenLinked[ev.PaperKey] = true
					linkedPapers = append(linkedPapers, ev.PaperKey)
				}
			}
		}
		if !matched {
			continue
		}
		titleSeed := idea.Question
		if strings.TrimSpace(titleSeed) == "" {
			titleSeed = idea.ID
		}
		slug := uniqueVaultNoteName(titleSeed, idea.ID, usedIdeaNames)
		ideaSlugs[idea.ID] = slug
		exportedIdeas = append(exportedIdeas, idea)
		for _, pKey := range linkedPapers {
			paperIdeas[pKey] = append(paperIdeas[pKey], vaultIdeaLink{
				Slug:     slug,
				Question: strings.TrimSpace(idea.Question),
			})
		}
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	if err := writeZipTextFile(zw, "_MOC_文献总览.md", renderVaultMOC(works, metaMap, paperSlugs, paperCiteKeys, exportedIdeas, ideaSlugs)); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	for _, work := range works {
		slug := paperSlugs[work.Key]
		notes, err := s.loadVaultAnnotations(ctx, work.Key)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		readings, err := s.loadVaultReadings(ctx, work.Key)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		md := renderPaperMarkdownNote(work, paperCiteKeys[work.Key], metaMap[work.Key], readings, notes, paperIdeas[work.Key])
		if err := writeZipTextFile(zw, "papers/"+slug+".md", md); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	for _, idea := range exportedIdeas {
		slug := ideaSlugs[idea.ID]
		md := renderIdeaMarkdownNote(idea, paperSlugs)
		if err := writeZipTextFile(zw, "ideas/"+slug+".md", md); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	if err := zw.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("打包 Markdown 笔记库失败: %v", err))
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="ReadX-obsidian-vault.zip"`)
	_, _ = w.Write(buf.Bytes())
}

func parseVaultQuery(r *http.Request) (citationQuery, error) {
	query := citationQuery{
		category: strings.TrimSpace(r.URL.Query().Get("category")),
	}
	for _, raw := range strings.Split(r.URL.Query().Get("keys"), ",") {
		k := strings.TrimSpace(raw)
		if k != "" {
			query.keys = append(query.keys, k)
		}
	}
	if len(query.keys) > 0 && query.category != "" {
		return citationQuery{}, fmt.Errorf("keys 与 category 只能提供一个")
	}
	return query, nil
}

func (s *Server) loadVaultAnnotations(ctx context.Context, docKey string) ([]vaultAnnotation, error) {
	var out []vaultAnnotation
	err := func() error {
		rows, err := s.handle.QueryContext(ctx,
			`SELECT page, kind, quote, note, color FROM annotations WHERE document_id = ? ORDER BY COALESCE(page, 0) ASC, created_at ASC`,
			docKey)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item vaultAnnotation
			if scanErr := rows.Scan(&item.Page, &item.Kind, &item.Quote, &item.Note, &item.Color); scanErr != nil {
				return scanErr
			}
			out = append(out, item)
		}
		return rows.Err()
	}()
	return out, err
}

func (s *Server) loadVaultReadings(ctx context.Context, docKey string) (map[string]ReadingEntry, error) {
	var raw string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id = ?`, docKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) || strings.TrimSpace(raw) == "" {
		return map[string]ReadingEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	var entries map[string]ReadingEntry
	if jsonErr := json.Unmarshal([]byte(raw), &entries); jsonErr != nil {
		return map[string]ReadingEntry{}, nil
	}
	return entries, nil
}

func renderVaultMOC(
	works []citation.Work,
	metaMap map[string]DocumentMeta,
	paperSlugs map[string]string,
	paperCiteKeys map[string]string,
	ideas []ResearchIdea,
	ideaSlugs map[string]string,
) string {
	var out strings.Builder
	out.WriteString("---\n")
	fmt.Fprintf(&out, "exported_at: %s\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Fprintf(&out, "papers_count: %d\n", len(works))
	fmt.Fprintf(&out, "ideas_count: %d\n", len(ideas))
	out.WriteString("tags:\n  - readx/moc\n---\n\n")
	out.WriteString("# ReadX 文献知识库总览 (MOC)\n\n")
	fmt.Fprintf(&out, "> 共导出 %d 篇文献、%d 条研究想法。所有双链 `[[...]]` 可直接在 Obsidian / Logseq / Notion 中跳转。\n\n", len(works), len(ideas))

	out.WriteString("## 文献清单\n\n")
	out.WriteString("| 文献笔记 | 年份 | CiteKey | 分类 / 标签 |\n")
	out.WriteString("| --- | --- | --- | --- |\n")
	for _, w := range works {
		slug := paperSlugs[w.Key]
		meta := metaMap[w.Key]
		yearText := "-"
		if w.Year > 0 {
			yearText = fmt.Sprintf("%d", w.Year)
		}
		labels := append([]string{}, meta.Categories...)
		labels = append(labels, meta.Tags...)
		labelText := strings.Join(labels, ", ")
		if labelText == "" {
			labelText = "-"
		}
		fmt.Fprintf(&out, "| [[papers/%s\\|%s]] | %s | `%s` | %s |\n",
			slug, escapeMarkdownCell(w.Title), yearText, paperCiteKeys[w.Key], escapeMarkdownCell(labelText))
	}

	// Category index
	byCategory := map[string][]citation.Work{}
	for _, w := range works {
		meta := metaMap[w.Key]
		for _, c := range meta.Categories {
			if strings.TrimSpace(c) != "" {
				byCategory[c] = append(byCategory[c], w)
			}
		}
	}
	if len(byCategory) > 0 {
		out.WriteString("\n## 按分类聚合\n\n")
		catNames := make([]string, 0, len(byCategory))
		for c := range byCategory {
			catNames = append(catNames, c)
		}
		sort.Strings(catNames)
		for _, c := range catNames {
			fmt.Fprintf(&out, "### %s\n\n", c)
			for _, w := range byCategory[c] {
				fmt.Fprintf(&out, "- [[papers/%s|%s]]\n", paperSlugs[w.Key], w.Title)
			}
			out.WriteString("\n")
		}
	}

	if len(ideas) > 0 {
		out.WriteString("\n## 研究想法 (Ideas)\n\n")
		for _, idea := range ideas {
			slug := ideaSlugs[idea.ID]
			title := strings.TrimSpace(idea.Question)
			if title == "" {
				title = idea.ID
			}
			fmt.Fprintf(&out, "- [[ideas/%s|%s]] (`%s`)\n", slug, title, idea.Status)
		}
	}
	return out.String()
}

func renderPaperMarkdownNote(
	work citation.Work,
	citeKey string,
	meta DocumentMeta,
	readings map[string]ReadingEntry,
	notes []vaultAnnotation,
	linkedIdeas []vaultIdeaLink,
) string {
	var out strings.Builder
	out.WriteString("---\n")
	fmt.Fprintf(&out, "title: %s\n", yamlQuote(work.Title))
	fmt.Fprintf(&out, "cite_key: %s\n", yamlQuote(citeKey))
	fmt.Fprintf(&out, "readx_key: %s\n", yamlQuote(work.Key))
	if work.Year > 0 {
		fmt.Fprintf(&out, "year: %d\n", work.Year)
	}
	if strings.TrimSpace(work.Venue) != "" {
		fmt.Fprintf(&out, "venue: %s\n", yamlQuote(work.Venue))
	}
	if strings.TrimSpace(work.DOI) != "" {
		fmt.Fprintf(&out, "doi: %s\n", yamlQuote(work.DOI))
	}
	if strings.TrimSpace(work.URL) != "" {
		fmt.Fprintf(&out, "url: %s\n", yamlQuote(work.URL))
	}
	if len(work.Authors) > 0 {
		out.WriteString("authors:\n")
		for _, a := range work.Authors {
			fmt.Fprintf(&out, "  - %s\n", yamlQuote(a))
		}
	}
	allTags := make([]string, 0, len(meta.Categories)+len(meta.Tags)+1)
	allTags = append(allTags, "readx/paper")
	for _, c := range meta.Categories {
		if strings.TrimSpace(c) != "" {
			allTags = append(allTags, strings.TrimSpace(c))
		}
	}
	for _, t := range meta.Tags {
		if strings.TrimSpace(t) != "" {
			allTags = append(allTags, strings.TrimSpace(t))
		}
	}
	out.WriteString("tags:\n")
	for _, t := range allTags {
		fmt.Fprintf(&out, "  - %s\n", yamlQuote(t))
	}
	fmt.Fprintf(&out, "favorite: %t\n", meta.Favorite)
	out.WriteString("---\n\n")

	fmt.Fprintf(&out, "# %s\n\n", work.Title)
	out.WriteString("返回索引：[[_MOC_文献总览]]\n\n")

	if len(work.Authors) > 0 || work.Year > 0 || work.Venue != "" || work.DOI != "" {
		out.WriteString("## 题录信息\n\n")
		if len(work.Authors) > 0 {
			fmt.Fprintf(&out, "- **作者**：%s\n", strings.Join(work.Authors, ", "))
		}
		if work.Year > 0 {
			fmt.Fprintf(&out, "- **年份**：%d\n", work.Year)
		}
		if work.Venue != "" {
			fmt.Fprintf(&out, "- **期刊 / 会议**：%s\n", work.Venue)
		}
		if work.DOI != "" {
			fmt.Fprintf(&out, "- **DOI**：`%s`\n", work.DOI)
		}
		fmt.Fprintf(&out, "- **LaTeX 引用键**：`\\cite{%s}`\n", citeKey)
		out.WriteString("\n")
	}

	if len(linkedIdeas) > 0 {
		out.WriteString("## 关联研究想法\n\n")
		for _, link := range linkedIdeas {
			label := link.Question
			if label == "" {
				label = link.Slug
			}
			fmt.Fprintf(&out, "- [[ideas/%s|%s]]\n", link.Slug, label)
		}
		out.WriteString("\n")
	}

	orderedKinds := []struct {
		key   string
		label string
	}{
		{"motivation", "1. 研究动机与问题"},
		{"method", "2. 核心方法与公式"},
		{"experiment", "3. 实验配置与对比"},
		{"results", "4. 关键结果与分析"},
		{"reproduction", "5. 复现要点"},
	}
	var readingBuf strings.Builder
	for _, item := range orderedKinds {
		entry, ok := readings[item.key]
		if !ok {
			continue
		}
		text := formatReadingEntryText(entry)
		if text == "" {
			continue
		}
		fmt.Fprintf(&readingBuf, "### %s\n\n%s\n\n", item.label, text)
	}
	if readingBuf.Len() > 0 {
		out.WriteString("## AI 精读总结\n\n")
		out.WriteString(readingBuf.String())
	}

	if len(notes) > 0 {
		out.WriteString("## 阅读批注\n\n")
		for _, n := range notes {
			pageLabel := "未知页码"
			if n.Page != nil && *n.Page > 0 {
				pageLabel = fmt.Sprintf("第 %d 页", *n.Page)
			}
			kindLabel := n.Kind
			if kindLabel == "" {
				kindLabel = "highlight"
			}
			fmt.Fprintf(&out, "### %s · `%s`\n\n", pageLabel, kindLabel)
			if strings.TrimSpace(n.Quote) != "" {
				for _, qLine := range strings.Split(strings.TrimSpace(n.Quote), "\n") {
					fmt.Fprintf(&out, "> %s\n", qLine)
				}
				out.WriteString("\n")
			}
			if strings.TrimSpace(n.Note) != "" {
				fmt.Fprintf(&out, "%s\n\n", strings.TrimSpace(n.Note))
			}
		}
	}

	return out.String()
}

func renderIdeaMarkdownNote(idea ResearchIdea, paperSlugs map[string]string) string {
	var out strings.Builder
	title := strings.TrimSpace(idea.Question)
	if title == "" {
		title = idea.ID
	}
	out.WriteString("---\n")
	fmt.Fprintf(&out, "id: %s\n", yamlQuote(idea.ID))
	fmt.Fprintf(&out, "title: %s\n", yamlQuote(title))
	fmt.Fprintf(&out, "status: %s\n", yamlQuote(idea.Status))
	fmt.Fprintf(&out, "updated_at: %s\n", yamlQuote(idea.UpdatedAt))
	out.WriteString("tags:\n  - readx/idea\n---\n\n")
	fmt.Fprintf(&out, "# %s\n\n", title)
	out.WriteString("返回索引：[[_MOC_文献总览]]\n\n")

	sections := []struct {
		label string
		body  string
	}{
		{"观察 (Observation)", idea.Observation},
		{"假设 (Hypothesis)", idea.Hypothesis},
		{"方法思路 (Method)", idea.Method},
		{"实验计划 (Experiment)", idea.Experiment},
	}
	for _, sec := range sections {
		if strings.TrimSpace(sec.body) != "" {
			fmt.Fprintf(&out, "## %s\n\n%s\n\n", sec.label, strings.TrimSpace(sec.body))
		}
	}
	if len(idea.Evidence) > 0 {
		out.WriteString("## 证据与文献双链\n\n")
		for _, ev := range idea.Evidence {
			paperRef := strings.TrimSpace(ev.PaperTitle)
			if slug, ok := paperSlugs[ev.PaperKey]; ok {
				label := paperRef
				if label == "" {
					label = slug
				}
				paperRef = fmt.Sprintf("[[papers/%s|%s]]", slug, label)
			}
			pageStr := ""
			if ev.Page != nil && *ev.Page > 0 {
				pageStr = fmt.Sprintf(" (p.%d)", *ev.Page)
			}
			fmt.Fprintf(&out, "- **%s**%s · `%s`\n", paperRef, pageStr, ev.Origin)
			if strings.TrimSpace(ev.Excerpt) != "" {
				fmt.Fprintf(&out, "  > %s\n", strings.ReplaceAll(strings.TrimSpace(ev.Excerpt), "\n", " "))
			}
		}
		out.WriteString("\n")
	}
	return out.String()
}

func uniqueVaultNoteName(title, fallback string, used map[string]int) string {
	base := sanitizeVaultFilename(title)
	if base == "" {
		base = sanitizeVaultFilename(fallback)
	}
	if base == "" {
		base = "note"
	}
	key := strings.ToLower(base)
	count := used[key]
	used[key] = count + 1
	if count == 0 {
		return base
	}
	suffix := sanitizeVaultFilename(fallback)
	if len(suffix) > 12 {
		suffix = suffix[:12]
	}
	if suffix != "" {
		return base + " (" + suffix + ")"
	}
	return fmt.Sprintf("%s (%d)", base, count+1)
}

func sanitizeVaultFilename(name string) string {
	trimmed := strings.TrimSpace(name)
	var b strings.Builder
	runes := 0
	for _, r := range trimmed {
		if runes >= 72 {
			break
		}
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '#', '^', '[', ']':
			b.WriteRune(' ')
		default:
			if unicode.IsControl(r) {
				b.WriteRune(' ')
			} else {
				b.WriteRune(r)
			}
		}
		runes++
	}
	cleaned := strings.Join(strings.Fields(b.String()), " ")
	cleaned = strings.Trim(cleaned, ". ")
	return filepath.Base(cleaned)
}

func writeZipTextFile(zw *zip.Writer, name, content string) error {
	hdr := &zip.FileHeader{
		Name:     name,
		Method:   zip.Deflate,
		Modified: time.Now(),
	}
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = w.Write([]byte(content))
	return err
}

func yamlQuote(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	escaped = strings.ReplaceAll(escaped, "\r\n", " ")
	escaped = strings.ReplaceAll(escaped, "\n", " ")
	return `"` + escaped + `"`
}

func escapeMarkdownCell(value string) string {
	v := strings.ReplaceAll(value, "|", "\\|")
	v = strings.ReplaceAll(v, "\r\n", " ")
	v = strings.ReplaceAll(v, "\n", " ")
	return strings.TrimSpace(v)
}
