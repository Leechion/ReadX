package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/appstate"
)

const flashcardsScheduleKey = "flashcards.schedule"

type flashcardSchedule struct {
	Repetitions    int     `json:"repetitions"`
	IntervalDays   int     `json:"intervalDays"`
	EaseFactor     float64 `json:"easeFactor"`
	DueAt          string  `json:"dueAt"`
	LastReviewedAt string  `json:"lastReviewedAt"`
}

type Flashcard struct {
	ID            string             `json:"id"`
	Source        string             `json:"source"` // "glossary" | "reading" | "annotation"
	DocumentKey   string             `json:"documentKey,omitempty"`
	DocumentTitle string             `json:"documentTitle,omitempty"`
	Page          int                `json:"page,omitempty"`
	Front         string             `json:"front"`
	Back          string             `json:"back"`
	Tags          []string           `json:"tags"`
	Due           bool               `json:"due"`
	Schedule      *flashcardSchedule `json:"schedule,omitempty"`
}

func (s *Server) handleFlashcards(w http.ResponseWriter, r *http.Request) {
	scope := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("scope")))
	if scope == "" {
		scope = "all"
	}
	docFilter := strings.TrimSpace(r.URL.Query().Get("key"))

	cards, dueCount, err := s.buildFlashcards(r.Context(), docFilter, time.Now().UTC())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	total := len(cards)
	if scope == "due" {
		filtered := make([]Flashcard, 0, dueCount)
		for _, card := range cards {
			if card.Due {
				filtered = append(filtered, card)
			}
		}
		cards = filtered
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cards":    cards,
		"total":    total,
		"dueCount": dueCount,
	})
}

func (s *Server) handleFlashcardReview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CardID  string `json:"cardId"`
		Quality int    `json:"quality"` // 0: 重来, 1: 困难, 2: 掌握, 3: 轻松
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	cardID := strings.TrimSpace(body.CardID)
	if cardID == "" || body.Quality < 0 || body.Quality > 3 {
		writeError(w, http.StatusBadRequest, "请提供有效 cardId 与评分（0–3）")
		return
	}

	now := time.Now().UTC()
	var updated flashcardSchedule
	err := s.appStateStore.Update(r.Context(), flashcardsScheduleKey, func(raw []byte, exists bool) ([]byte, error) {
		schedules := map[string]flashcardSchedule{}
		if exists && len(raw) > 0 && string(raw) != "null" {
			_ = json.Unmarshal(raw, &schedules)
		}
		updated = nextSM2Schedule(schedules[cardID], body.Quality, now)
		schedules[cardID] = updated
		return json.Marshal(schedules)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存闪卡复习记录失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"cardId":   cardID,
		"schedule": updated,
	})
}

func (s *Server) handleFlashcardsExport(w http.ResponseWriter, r *http.Request) {
	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "anki"
	}
	if format != "anki" && format != "markdown" {
		writeError(w, http.StatusBadRequest, "format 只能是 anki 或 markdown")
		return
	}
	docFilter := strings.TrimSpace(r.URL.Query().Get("key"))
	cards, _, err := s.buildFlashcards(r.Context(), docFilter, time.Now().UTC())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	var out strings.Builder
	if format == "anki" {
		out.WriteString("#separator:tab\n#html:false\n#tags column:3\n")
		for _, card := range cards {
			front := strings.Join(strings.Fields(card.Front), " ")
			back := strings.ReplaceAll(strings.TrimSpace(card.Back), "\t", " ")
			back = strings.ReplaceAll(back, "\r\n", "\n")
			back = strings.ReplaceAll(back, "\n", " / ")
			tags := strings.Join(card.Tags, " ")
			fmt.Fprintf(&out, "%s\t%s\t%s\n", front, back, tags)
		}
		w.Header().Set("Content-Type", "text/tab-separated-values; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="readx-flashcards-anki.tsv"`)
	} else {
		out.WriteString("# ReadX 复习闪卡\n\n")
		for _, card := range cards {
			fmt.Fprintf(&out, "## %s\n\n", strings.TrimSpace(card.Front))
			fmt.Fprintf(&out, "%s\n\n", strings.TrimSpace(card.Back))
			if card.DocumentTitle != "" {
				pageInfo := ""
				if card.Page > 0 {
					pageInfo = fmt.Sprintf(" · 第 %d 页", card.Page)
				}
				fmt.Fprintf(&out, "> 来源：%s%s\n\n", card.DocumentTitle, pageInfo)
			}
			out.WriteString("---\n\n")
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="readx-flashcards.md"`)
	}
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(out.String()))
}

func nextSM2Schedule(prev flashcardSchedule, quality int, now time.Time) flashcardSchedule {
	ef := prev.EaseFactor
	if ef <= 0 {
		ef = 2.5
	}
	// Map 0..3 -> SM-2 quality 1, 3, 4, 5
	qScore := []int{1, 3, 4, 5}[quality]
	reps := prev.Repetitions
	interval := prev.IntervalDays

	if qScore < 3 {
		reps = 0
		interval = 1
	} else {
		switch reps {
		case 0:
			interval = 1
		case 1:
			interval = 6
		default:
			interval = int(math.Round(float64(interval) * ef))
			if interval < 1 {
				interval = 1
			}
		}
		reps++
	}
	ef = ef + (0.1 - float64(5-qScore)*(0.08+float64(5-qScore)*0.02))
	if ef < 1.3 {
		ef = 1.3
	}
	ef = math.Round(ef*100) / 100
	due := now.Add(time.Duration(interval) * 24 * time.Hour)
	return flashcardSchedule{
		Repetitions:    reps,
		IntervalDays:   interval,
		EaseFactor:     ef,
		DueAt:          due.Format(time.RFC3339),
		LastReviewedAt: now.Format(time.RFC3339),
	}
}

func (s *Server) buildFlashcards(ctx context.Context, docFilter string, now time.Time) ([]Flashcard, int, error) {
	schedules := map[string]flashcardSchedule{}
	if loaded, ok, err := appstate.Load[map[string]flashcardSchedule](ctx, s.appStateStore, flashcardsScheduleKey); err == nil && ok && loaded != nil {
		schedules = loaded
	}

	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, 0, err
	}

	docTitles := map[string]string{}
	_ = func() error {
		rows, qErr := s.handle.QueryContext(ctx, `SELECT id, title FROM documents`)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var id, title string
			if rows.Scan(&id, &title) == nil {
				docTitles[id] = normalizePaperTitle(title)
			}
		}
		return rows.Err()
	}()

	cards := make([]Flashcard, 0, 64)

	// 1. 术语表卡片
	if docFilter == "" {
		terms, termErr := s.translationGlossary(ctx)
		if termErr == nil {
			for _, term := range terms {
				id := "glossary-" + shortCardHash(term.Source+"|"+term.Target)
				back := term.Target
				if strings.TrimSpace(term.Note) != "" {
					back += "\n" + strings.TrimSpace(term.Note)
				}
				cards = append(cards, decorateCardSchedule(Flashcard{
					ID:     id,
					Source: "glossary",
					Front:  fmt.Sprintf("术语释义：%s", term.Source),
					Back:   back,
					Tags:   []string{"ReadX", "术语"},
				}, schedules, now))
			}
		}
	}

	// 2. 批注与高亮卡片（含页边笔记）
	_ = func() error {
		query := `SELECT id, document_id, page, kind, quote, note FROM annotations`
		args := []any{}
		if docFilter != "" {
			query += ` WHERE document_id = ?`
			args = append(args, docFilter)
		}
		query += ` ORDER BY updated_at DESC LIMIT 200`
		rows, qErr := s.handle.QueryContext(ctx, query, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		for rows.Next() {
			var id, docID, kind, quote, note string
			var page sql.NullInt64
			if rows.Scan(&id, &docID, &page, &kind, &quote, &note) != nil {
				continue
			}
			if meta[docID].Deleted || kind == "ink" {
				continue
			}
			quote = strings.TrimSpace(quote)
			note = strings.TrimSpace(note)
			if quote == "" || note == "" {
				continue
			}
			p := 0
			if page.Valid {
				p = int(page.Int64)
			}
			cards = append(cards, decorateCardSchedule(Flashcard{
				ID:            "ann-" + id,
				Source:        "annotation",
				DocumentKey:   docID,
				DocumentTitle: docTitles[docID],
				Page:          p,
				Front:         truncateRunes(quote, 260),
				Back:          truncateRunes(note, 500),
				Tags:          []string{"ReadX", "批注"},
			}, schedules, now))
		}
		return rows.Err()
	}()

	// 3. 精读五重奏卡片
	_ = func() error {
		query := `SELECT document_id, value_json FROM readings`
		args := []any{}
		if docFilter != "" {
			query += ` WHERE document_id = ?`
			args = append(args, docFilter)
		}
		query += ` ORDER BY updated_at DESC LIMIT 80`
		rows, qErr := s.handle.QueryContext(ctx, query, args...)
		if qErr != nil {
			return qErr
		}
		defer rows.Close()
		labels := []struct {
			kind  string
			label string
		}{
			{"motivation", "核心动机与痛点"},
			{"method", "核心方法与公式"},
			{"results", "核心实验结论"},
		}
		for rows.Next() {
			var docID, rawJSON string
			if rows.Scan(&docID, &rawJSON) != nil || meta[docID].Deleted {
				continue
			}
			var parsed map[string]ReadingEntry
			if json.Unmarshal([]byte(rawJSON), &parsed) != nil {
				continue
			}
			title := docTitles[docID]
			if title == "" {
				title = docID
			}
			for _, item := range labels {
				entry, ok := parsed[item.kind]
				if !ok {
					continue
				}
				txt := formatReadingEntryText(entry)
				if strings.TrimSpace(txt) == "" {
					continue
				}
				cards = append(cards, decorateCardSchedule(Flashcard{
					ID:            "read-" + docID + "-" + item.kind,
					Source:        "reading",
					DocumentKey:   docID,
					DocumentTitle: title,
					Front:         fmt.Sprintf("《%s》的%s是什么？", truncateRunes(title, 60), item.label),
					Back:          truncateRunes(txt, 650),
					Tags:          []string{"ReadX", "精读", item.kind},
				}, schedules, now))
			}
		}
		return rows.Err()
	}()

	sort.SliceStable(cards, func(i, j int) bool {
		if cards[i].Due != cards[j].Due {
			return cards[i].Due
		}
		return cards[i].ID < cards[j].ID
	})
	dueCount := 0
	for _, c := range cards {
		if c.Due {
			dueCount++
		}
	}
	return cards, dueCount, nil
}

func decorateCardSchedule(card Flashcard, schedules map[string]flashcardSchedule, now time.Time) Flashcard {
	sched, ok := schedules[card.ID]
	if !ok {
		card.Due = true
		return card
	}
	card.Schedule = &sched
	if dueTime, err := time.Parse(time.RFC3339, sched.DueAt); err == nil {
		card.Due = !dueTime.After(now)
	} else {
		card.Due = true
	}
	return card
}

func shortCardHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

// ---- 论文语音速听（TTS 播客讲稿） ----

type podcastSegment struct {
	Heading string `json:"heading"`
	Text    string `json:"text"`
}

func (s *Server) handlePodcastScript(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	key, err := safeKey(body.Key, "论文键")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusNotFound, "没有找到这篇论文")
		return
	}

	material := s.summarizeReadingForLatex(r.Context(), key)
	if material == "" {
		source, srcErr := s.sourceText(r.Context(), key)
		if srcErr != nil {
			writeError(w, http.StatusInternalServerError, srcErr.Error())
			return
		}
		material = truncateRunes(source, 8000)
	}
	if strings.TrimSpace(material) == "" {
		writeError(w, http.StatusConflict, "这篇论文还没有正文缓存或精读内容，请先打开正文或翻译后再生成速听讲稿")
		return
	}

	config, err := s.aiConfig()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if !config.Ready() {
		writeError(w, http.StatusServiceUnavailable, "还没配置 AI 助教的 API Key")
		return
	}

	system := "你是学术播客撰稿人。把所给论文资料改写成一段 2 分钟左右、自然口语化、适合语音朗读的中文速听讲稿（避免复杂 LaTeX 命令和生硬符号，公式用口语概括）。" +
		"只返回 JSON：{\"segments\":[{\"heading\":\"背景与问题\",\"text\":\"...\"},{\"heading\":\"核心方法\",\"text\":\"...\"},{\"heading\":\"实验与结论\",\"text\":\"...\"}]}。"
	user := fmt.Sprintf("论文标题：%s\n年份：%v\n资料：\n%s", doc.Title, doc.Year, material)
	raw, err := ai.NewClient(config).GenerateStructured(r.Context(), system, user, 0.35, map[string]any{"type": "json_object"})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	var decoded struct {
		Segments []podcastSegment `json:"segments"`
	}
	if start := strings.IndexByte(raw, '{'); start >= 0 {
		if end := strings.LastIndexByte(raw, '}'); end > start {
			_ = json.Unmarshal([]byte(raw[start:end+1]), &decoded)
		}
	}
	if len(decoded.Segments) == 0 {
		decoded.Segments = []podcastSegment{{Heading: "论文速听", Text: strings.TrimSpace(raw)}}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key":      key,
		"title":    doc.Title,
		"segments": decoded.Segments,
	})
}
