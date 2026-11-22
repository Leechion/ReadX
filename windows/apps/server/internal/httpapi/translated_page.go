// translated_page.go：阅读器按页取「排版后的译文页」。
//
// 这是 LeePDF 完整翻译链在 ReadX 里的落点：
//  1. 用 PaddleOCR 做整篇文档解析（结果按原 PDF 内容哈希缓存在本机）；
//  2. 按上游 document.v1 的翻译策略挑出正文/标题/摘要/图注块，参考文献、脚注、
//     页眉页脚、公式、表格、图片一律保留原样；
//  3. 把相邻段落作为消歧上下文，交给 internal/translate 的翻译引擎；
//  4. 用内置 rpr 引擎按原页坐标与字号把译文排回版面，只输出这一页。
//
// 与「导出译文 PDF」共用同一套 OCR/翻译/渲染组件，区别只是这里按页生成、直接回给
// 阅读器渲染，因而扫描件也能在双语窗格里看到排版后的译文。
package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/render"
	"cbctv2/server/internal/translate"
)

const maxTranslatedPageBody = 64 << 10

// layoutBlock / layoutPage / layoutDoc 是「导入时 OCR 识别出的段落」的持久化形态：
// 块文本 + 类型 + 原页坐标。译文仍放在 translations 表里（按段落哈希），
// 阅读器渲染时按哈希取译文，因此换模型重译不会让版式数据失效。
type layoutBlock struct {
	Kind                      string         `json:"kind"`
	SourceOrder               int            `json:"sourceOrder"`
	HasSourceOrder            bool           `json:"hasSourceOrder"`
	ProviderBlockID           string         `json:"providerBlockId,omitempty"`
	RawGroupID                string         `json:"rawGroupId,omitempty"`
	RawGlobalGroupID          string         `json:"rawGlobalGroupId,omitempty"`
	RawBlockOrder             int            `json:"rawBlockOrder,omitempty"`
	HasRawBlockOrder          bool           `json:"hasRawBlockOrder,omitempty"`
	Text                      string         `json:"text"`
	Box                       [4]float64     `json:"box"`
	LayoutRole                string         `json:"layoutRole,omitempty"`
	SemanticRole              string         `json:"semanticRole,omitempty"`
	StructureRole             string         `json:"structureRole,omitempty"`
	PolicyReason              string         `json:"policyReason,omitempty"`
	NotTranslatable           bool           `json:"notTranslatable,omitempty"`
	Segments                  []ocr.Segment  `json:"segments,omitempty"`
	Lines                     []ocr.Line     `json:"lines,omitempty"`
	LineTexts                 []string       `json:"lineTexts,omitempty"`
	ColumnLayoutMode          string         `json:"columnLayoutMode,omitempty"`
	ColumnIndexGuess          string         `json:"columnIndexGuess,omitempty"`
	CrossColumnMergeSuspected bool           `json:"crossColumnMergeSuspected,omitempty"`
	ReadingOrderUnreliable    bool           `json:"readingOrderUnreliable,omitempty"`
	StructureUnreliable       bool           `json:"structureUnreliable,omitempty"`
	TextMissingButBBoxPresent bool           `json:"textMissingButBBoxPresent,omitempty"`
	PeerBlockAbsorbedText     bool           `json:"peerBlockAbsorbedText,omitempty"`
	SuspectedPeerBlockID      string         `json:"suspectedPeerBlockId,omitempty"`
	LayoutMode                string         `json:"layoutMode,omitempty"`
	LayoutSplitX              float64        `json:"layoutSplitX,omitempty"`
	LayoutZone                string         `json:"layoutZone,omitempty"`
	LayoutZoneRank            int            `json:"layoutZoneRank"`
	LayoutZoneSize            int            `json:"layoutZoneSize"`
	BoundaryRole              string         `json:"boundaryRole,omitempty"`
	ContinuationGroup         string         `json:"continuationGroup,omitempty"`
	ContinuationSignature     string         `json:"continuationSignature,omitempty"`
	ContinuationDecision      string         `json:"continuationDecision,omitempty"`
	ContinuationPrevious      string         `json:"continuationPrevious,omitempty"`
	ContinuationNext          string         `json:"continuationNext,omitempty"`
	ProviderContinuationRole  string         `json:"providerContinuationRole,omitempty"`
	ProviderContinuationScope string         `json:"providerContinuationScope,omitempty"`
	ProviderContinuationOrder int            `json:"providerContinuationOrder"`
	ProviderContinuationScore float64        `json:"providerContinuationScore"`
	ProviderContinuationSkip  string         `json:"providerContinuationSkip,omitempty"`
	LeeMetadata               map[string]any `json:"retainMetadata,omitempty"`
	LeeContent                map[string]any `json:"retainContent,omitempty"`
}

type layoutPage struct {
	Page   int           `json:"page"`
	Width  float64       `json:"width"`
	Height float64       `json:"height"`
	Blocks []layoutBlock `json:"blocks"`
}

type layoutDoc struct {
	Pages []layoutPage `json:"pages"`
}

const layoutStatePrefix = "ocr-layout:"

func importPageSizes(pages []publicationPageHint) ([]ocr.Size, bool) {
	sizes := make([]ocr.Size, len(pages))
	complete := true
	for index, page := range pages {
		if page.Width <= 0 || page.Height <= 0 {
			complete = false
			continue
		}
		sizes[index] = ocr.Size{Width: page.Width, Height: page.Height}
	}
	return sizes, complete
}

// prepareOCRLayoutTranslations 是导入阶段的 LeePDF 翻译链：
// OCR 识别段落 → 按上游策略挑块 → 逐段翻译（含跨页上下文）→ 记录每页块坐标。
// 返回 handled=false 表示 OCR 没有产生可用页面，导入链路会报错而不静默换成文本层结果。
func (s *Server) prepareOCRLayoutTranslations(ctx context.Context, pdf []byte, sizes []ocr.Size, metadata *recognizedPaperMetadata, progress ...func(completed, total, start, end, cached, untranslated int)) (bool, error) {
	client, err := s.ocrClient()
	if err != nil {
		return false, err
	}
	sum := sha256.Sum256(pdf)
	key := "doc-" + hex.EncodeToString(sum[:16])
	s.jobStage(key, "ocr", "running", "OCR 已接收任务，等待排队", 0, -1)
	client.OnState = func(state string) {
		message := "OCR 识别中"
		switch state {
		case "submitted":
			message = "OCR 已接收任务，等待排队"
		case "done", "finished", "succeeded", "success":
			message = "OCR 识别完成，正在整理段落"
		}
		s.jobStage(key, "ocr", "running", message, -1, -1)
	}
	layouts, err := s.cachedOCRLayouts(ctx, key, pdf, client)
	if err != nil {
		s.jobStage(key, "ocr", "failed", err.Error(), 0, -1)
		return false, fmt.Errorf("导入时 OCR 失败: %w", err)
	}
	pages, err := client.MapLayouts(ctx, layouts, sizes)
	if err != nil {
		s.jobStage(key, "ocr", "failed", err.Error(), 0, -1)
		return false, fmt.Errorf("OCR 结果解析失败: %w", err)
	}
	if len(pages) == 0 {
		return false, fmt.Errorf("OCR 没有返回页面")
	}
	if len(sizes) > 0 && len(pages) != len(sizes) {
		return false, fmt.Errorf("OCR 返回 %d 页，原 PDF 有 %d 页，无法可靠对齐页面", len(pages), len(sizes))
	}
	config, configErr := s.workflowAIConfig(WorkflowTranslation)
	if configErr == nil && config.Ready() {
		if err := annotateContinuationGroups(ctx, pages, ai.NewClient(config)); err != nil && ctx.Err() != nil {
			return false, err
		}
	} else {
		_ = annotateContinuationGroups(ctx, pages, nil)
	}
	s.jobStage(key, "ocr", "done", fmt.Sprintf("识别到 %d 页", len(pages)), len(pages), len(pages))

	type pageItems struct {
		items   []translate.Item
		owners  []int
		indexes []int
	}
	perPage := make([]pageItems, len(pages))
	allItems := []translate.Item{}
	for index := range pages {
		var before, after *ocr.Page
		if index > 0 {
			before = &pages[index-1]
		}
		if index+1 < len(pages) {
			after = &pages[index+1]
		}
		items, owners, _ := pageTranslationItems(pages[index], before, after)
		indexes := make([]int, len(items))
		for itemIndex := range indexes {
			indexes[itemIndex] = len(allItems) + itemIndex
		}
		perPage[index] = pageItems{items: items, owners: owners, indexes: indexes}
		allItems = append(allItems, items...)
	}
	if len(allItems) == 0 {
		return false, errors.New("OCR 没有识别出可翻译的正文块")
	}
	domain := translate.DomainContext{}
	domainGuidance := ""
	if configErr == nil && config.Ready() {
		var domainErr error
		pageTexts := make([]string, len(pages))
		for pageIndex, page := range pages {
			var blocks []string
			for _, block := range page.Blocks {
				if text := strings.TrimSpace(block.Text); text != "" {
					blocks = append(blocks, text)
				}
			}
			pageTexts[pageIndex] = strings.Join(blocks, "\n")
		}
		domain, domainErr = s.documentDomainContext(ctx, key, config, formatOCRPreview(pageTexts))
		if domainErr != nil {
			log.Printf("领域识别未完成，继续翻译: %v", domainErr)
		}
		domainGuidance = translate.RenderDomainGuidance(domain)
		if domainGuidance != "" {
			for index := range allItems {
				allItems[index].StyleHint = domainGuidance
			}
		}
	}
	if err := attachTranslationTerms(ctx, s, allItems); err != nil {
		return false, err
	}
	if configErr == nil && config.Ready() {
		termBase, prepareErr := s.documentTermPrescan(ctx, key, config, allItems, domain)
		if prepareErr != nil {
			log.Printf("译前术语预扫未完成，继续翻译: %v", prepareErr)
		}
		if config.TranslationPreparation == "terms" || config.TranslationPreparation == "terms+style" || config.TranslationPreparation == "editorial" {
			seenFirstOccurrence := map[string]bool{}
			for index := range allItems {
				matched := translate.MatchTerms(allItems[index].Source, termBase)
				known := map[string]bool{}
				for _, term := range allItems[index].Terms {
					known[strings.ToLower(term.Source)+"\x00"+strings.ToLower(term.Target)] = true
				}
				for _, term := range matched {
					if term.Annotate {
						term.FirstOccurrence = !seenFirstOccurrence[strings.ToLower(term.Source)]
						seenFirstOccurrence[strings.ToLower(term.Source)] = true
					}
					id := strings.ToLower(term.Source) + "\x00" + strings.ToLower(term.Target)
					if !known[id] {
						known[id] = true
						allItems[index].Terms = append(allItems[index].Terms, term)
					}
				}
			}
		}
		if config.TranslationPreparation == "terms+style" || config.TranslationPreparation == "artifacts_only" || config.TranslationPreparation == "editorial" {
			guidance, styleErr := s.documentStyleGuide(ctx, key, config, allItems, termBase, domain)
			if styleErr != nil {
				log.Printf("译前风格指南未完整生成，继续翻译: %v", styleErr)
			}
			if config.TranslationPreparation == "terms+style" || config.TranslationPreparation == "editorial" {
				for index := range allItems {
					allItems[index].StyleHint = strings.TrimSpace(domainGuidance + "\n" + guidance)
				}
			}
		}
	}
	termOffset := 0
	for pageIndex := range perPage {
		for itemIndex := range perPage[pageIndex].items {
			perPage[pageIndex].items[itemIndex] = allItems[termOffset]
			termOffset++
		}
	}
	continuationMembers := map[string][]int{}
	for index, item := range allItems {
		if item.ContinuationGroup != "" {
			continuationMembers[item.ContinuationGroup] = append(continuationMembers[item.ContinuationGroup], index)
		}
	}
	var cacheConfig *ai.Config
	if configErr == nil {
		cacheConfig = &config
	}
	hashes := make([]string, len(allItems))
	for index, item := range allItems {
		hashes[index] = translationCacheHash(item, cacheConfig)
	}
	cached, err := s.cachedTranslations(ctx, key, hashes)
	if err != nil {
		return false, err
	}
	// LeePDF runs repair and final recovery once for the complete document.
	// Keep that same document-wide boundary here instead of resetting limits per page.
	type pendingTranslation struct {
		item    translate.Item
		members []int
	}
	pending := make([]pendingTranslation, 0, len(allItems))
	scheduled := map[string]int{}
	seenGroups := map[string]bool{}
	for index, item := range allItems {
		if item.ContinuationGroup != "" {
			if seenGroups[item.ContinuationGroup] {
				continue
			}
			seenGroups[item.ContinuationGroup] = true
			memberIndexes := continuationMembers[item.ContinuationGroup]
			if len(memberIndexes) < 2 {
				memberIndexes = []int{index}
			}
			allCached := true
			sourceParts := make([]string, 0, len(memberIndexes))
			groupLines := []string{}
			terms := []translate.Term{}
			seenTerms := map[string]bool{}
			for _, memberIndex := range memberIndexes {
				if strings.TrimSpace(cached[hashes[memberIndex]]) == "" {
					allCached = false
				}
				member := allItems[memberIndex]
				sourceParts = append(sourceParts, member.Source)
				groupLines = append(groupLines, member.LineTexts...)
				for _, term := range member.Terms {
					termKey := strings.ToLower(strings.TrimSpace(term.Source)) + "\x00" + term.Level + "\x00" + term.Target
					if !seenTerms[termKey] {
						seenTerms[termKey] = true
						terms = append(terms, term)
					}
				}
			}
			if allCached {
				continue
			}
			groupItem := allItems[memberIndexes[0]]
			groupItem.Source = joinContinuationSources(sourceParts)
			groupItem.Terms = terms
			groupItem.LineTexts = groupLines
			groupItem.ContextBefore, groupItem.ContextAfter = "", ""
			pending = append(pending, pendingTranslation{item: groupItem, members: memberIndexes})
			continue
		}
		hash := hashes[index]
		if strings.TrimSpace(cached[hash]) != "" {
			continue
		}
		if unitIndex, ok := scheduled[hash]; ok {
			pending[unitIndex].members = append(pending[unitIndex].members, index)
			continue
		}
		scheduled[hash] = len(pending)
		pending = append(pending, pendingTranslation{item: item, members: []int{index}})
	}
	processedSegments := 0
	for _, item := range allItems {
		if strings.TrimSpace(cached[translationCacheHash(item, cacheConfig)]) != "" {
			processedSegments++
		}
	}
	untranslatedSegments := len(allItems) - processedSegments
	progressTranslation := func() {
		for _, callback := range progress {
			if callback != nil {
				callback(processedSegments, len(allItems), 0, 0, 0, untranslatedSegments)
			}
		}
	}
	s.jobStage(key, "translate", "running", "正在逐段翻译", processedSegments, len(allItems))
	progressTranslation()
	if len(pending) > 0 {
		if configErr != nil {
			return false, configErr
		}
		if !config.Ready() {
			return false, errors.New("还没配置 AI 助教的 API Key，无法翻译 OCR 段落")
		}
		requests := make([]translate.Item, len(pending))
		pendingMemberCount := 0
		for index, unit := range pending {
			requests[index] = unit.item
			for _, memberIndex := range unit.members {
				if strings.TrimSpace(cached[hashes[memberIndex]]) == "" {
					pendingMemberCount++
				}
			}
		}
		translationCtx, cancel := context.WithTimeout(ctx, translate.Budget(len(requests)))
		result, translateErr := translate.Translate(translationCtx, ai.NewClient(config), requests, translate.Options{BestEffort: true}, func(completed, total, _, _ int) {
			if total > 0 {
				estimated := processedSegments + pendingMemberCount*completed/total
				if estimated > len(allItems) {
					estimated = len(allItems)
				}
				if estimated > processedSegments {
					processedSegments = estimated
					untranslatedSegments = len(allItems) - processedSegments
					s.jobStage(key, "translate", "running", fmt.Sprintf("已处理翻译段落 %d / %d 段", processedSegments, len(allItems)), processedSegments, len(allItems))
					progressTranslation()
				}
			}
		})
		cancel()
		if translateErr != nil && ctx.Err() != nil {
			s.jobStage(key, "translate", "failed", "已取消", processedSegments, len(allItems))
			return false, fmt.Errorf("全文翻译已取消，尚未导入: %w", translateErr)
		}
		for unitIndex, unit := range pending {
			if unitIndex >= len(result.Targets) || strings.TrimSpace(result.Targets[unitIndex]) == "" {
				continue
			}
			if unit.item.ContinuationGroup != "" {
				members := make([]translate.Item, 0, len(unit.members))
				for _, memberIndex := range unit.members {
					members = append(members, allItems[memberIndex])
				}
				chunks := splitContinuationTranslation(result.Targets[unitIndex], members)
				for chunkIndex, memberIndex := range unit.members {
					if chunkIndex >= len(chunks) {
						break
					}
					cached[hashes[memberIndex]] = chunks[chunkIndex]
					metadata.Translations = append(metadata.Translations, translateSegment{Hash: hashes[memberIndex], Source: allItems[memberIndex].Source, Target: chunks[chunkIndex]})
				}
				continue
			}
			for _, memberIndex := range unit.members {
				cached[hashes[memberIndex]] = result.Targets[unitIndex]
				metadata.Translations = append(metadata.Translations, translateSegment{Hash: hashes[memberIndex], Source: allItems[memberIndex].Source, Target: result.Targets[unitIndex]})
			}
		}
	}
	processedSegments = len(allItems)
	untranslatedSegments = 0
	qaTargets := make([]string, len(allItems))
	for index, item := range allItems {
		hash := translationCacheHash(item, cacheConfig)
		qaTargets[index] = cached[hash]
		if strings.TrimSpace(cached[hash]) == "" {
			untranslatedSegments++
		}
	}
	qaReport := translate.BuildNumericQA(allItems, qaTargets)
	metadata.TranslationQA = &qaReport
	s.jobStage(key, "translate", "done", fmt.Sprintf("已处理翻译段落 %d / %d 段", processedSegments, len(allItems)), len(allItems), len(allItems))
	progressTranslation()
	untranslated := 0
	layout := layoutDoc{Pages: make([]layoutPage, len(pages))}
	metadata.Pages = make([]publicationPageHint, 0, len(pages))
	for pageIndex, page := range pages {
		entry := layoutPage{Page: page.Index + 1, Width: page.Width, Height: page.Height}
		segments := make([]string, 0, len(perPage[pageIndex].owners))
		ownerItemIndex := make(map[int]int, len(perPage[pageIndex].owners))
		for itemIndex, blockIndex := range perPage[pageIndex].owners {
			ownerItemIndex[blockIndex] = itemIndex
		}
		for blockIndex, block := range page.Blocks {
			itemIndex, hasTranslationItem := ownerItemIndex[blockIndex]
			if hasTranslationItem && (itemIndex >= len(perPage[pageIndex].items) || strings.TrimSpace(cached[translationCacheHash(perPage[pageIndex].items[itemIndex], cacheConfig)]) == "") {
				untranslated++
			}
			entry.Blocks = append(entry.Blocks, layoutBlock{
				Kind: block.Kind, SourceOrder: block.SourceOrder, HasSourceOrder: block.HasSourceOrder, ProviderBlockID: block.ProviderBlockID, RawGroupID: block.RawGroupID, RawGlobalGroupID: block.RawGlobalGroupID, RawBlockOrder: block.RawBlockOrder, HasRawBlockOrder: block.HasRawBlockOrder, Text: block.Text, Box: block.Box,
				LayoutRole: block.LayoutRole, SemanticRole: block.SemanticRole,
				StructureRole: block.StructureRole, PolicyReason: block.PolicyReason, NotTranslatable: !block.Translatable,
				Segments: block.Segments, Lines: block.Lines, LineTexts: block.LineTexts,
				ColumnLayoutMode: block.ColumnLayoutMode, ColumnIndexGuess: block.ColumnIndexGuess,
				CrossColumnMergeSuspected: block.CrossColumnMergeSuspected, ReadingOrderUnreliable: block.ReadingOrderUnreliable,
				StructureUnreliable: block.StructureUnreliable, TextMissingButBBoxPresent: block.TextMissingButBBoxPresent,
				PeerBlockAbsorbedText: block.PeerBlockAbsorbedText, SuspectedPeerBlockID: block.SuspectedPeerBlockID,
				LayoutMode: block.LayoutMode, LayoutSplitX: block.LayoutSplitX, LayoutZone: block.LayoutZone, LayoutZoneRank: block.LayoutZoneRank, LayoutZoneSize: block.LayoutZoneSize, BoundaryRole: block.BoundaryRole,
				ContinuationGroup: block.ContinuationGroup, ContinuationSignature: block.ContinuationSignature, ContinuationDecision: block.ContinuationDecision,
				ContinuationPrevious: block.ContinuationPrevious, ContinuationNext: block.ContinuationNext,
				ProviderContinuationRole: block.ProviderContinuationRole, ProviderContinuationScope: block.ProviderContinuationScope,
				ProviderContinuationOrder: block.ProviderContinuationOrder, ProviderContinuationScore: block.ProviderContinuationScore,
				ProviderContinuationSkip: block.ProviderContinuationSkip,
				LeeMetadata:              block.LeeMetadata, LeeContent: block.LeeContent,
			})
			if hasTranslationItem {
				segments = append(segments, block.Text)
			}
		}
		layout.Pages[pageIndex] = entry
		metadata.Pages = append(metadata.Pages, publicationPageHint{
			Page:     page.Index + 1,
			Text:     strings.Join(segments, "\n"),
			Segments: segments,
			Width:    page.Width,
			Height:   page.Height,
		})
	}
	metadata.LayoutPages = layout.Pages
	metadata.Untranslated = untranslated
	untranslatedSegments = untranslated
	progressTranslation()
	return true, nil
}

// saveLayoutTx 在文档事务内写入 OCR 版式数据：文档提交成功后才对阅读器可见。
func saveLayoutTx(ctx context.Context, tx *sql.Tx, key string, pages []layoutPage) error {
	if len(pages) == 0 {
		return nil
	}
	encoded, err := json.Marshal(layoutDoc{Pages: pages})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		layoutStatePrefix+key, string(encoded), nowStamp())
	return err
}

func (s *Server) loadLayout(ctx context.Context, key string) (layoutDoc, bool, error) {
	var body string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, layoutStatePrefix+key).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return layoutDoc{}, false, nil
	}
	if err != nil {
		return layoutDoc{}, false, err
	}
	var layout layoutDoc
	if err := json.Unmarshal([]byte(body), &layout); err != nil {
		return layoutDoc{}, false, err
	}
	if len(layout.Pages) == 0 {
		return layoutDoc{}, false, nil
	}
	return layout, true, nil
}

// layoutOCRPages 把持久化的版式数据还原成渲染用的 OCR 页。
func layoutOCRPages(layout layoutDoc) []ocr.Page {
	pages := make([]ocr.Page, len(layout.Pages))
	for index, entry := range layout.Pages {
		page := ocr.Page{Index: entry.Page - 1, Width: entry.Width, Height: entry.Height}
		for blockIndex, block := range entry.Blocks {
			page.Blocks = append(page.Blocks, ocr.Block{
				ID:               fmt.Sprintf("layout-p%d-b%d", entry.Page, blockIndex+1),
				SourceOrder:      block.SourceOrder,
				HasSourceOrder:   block.HasSourceOrder,
				ProviderBlockID:  block.ProviderBlockID,
				RawGroupID:       block.RawGroupID,
				RawGlobalGroupID: block.RawGlobalGroupID,
				RawBlockOrder:    block.RawBlockOrder,
				HasRawBlockOrder: block.HasRawBlockOrder,
				Kind:             block.Kind,
				Text:             block.Text,
				Box:              block.Box,
				Translatable:     !block.NotTranslatable,
				LayoutRole:       block.LayoutRole,
				SemanticRole:     block.SemanticRole,
				StructureRole:    block.StructureRole,
				PolicyReason:     block.PolicyReason,
				Segments:         block.Segments,
				Lines:            block.Lines,
				LineTexts:        block.LineTexts,
				LayoutMode:       block.LayoutMode, LayoutSplitX: block.LayoutSplitX,
				LayoutZone: block.LayoutZone, LayoutZoneRank: block.LayoutZoneRank, LayoutZoneSize: block.LayoutZoneSize,
				BoundaryRole:     block.BoundaryRole,
				ColumnLayoutMode: block.ColumnLayoutMode, ColumnIndexGuess: block.ColumnIndexGuess,
				CrossColumnMergeSuspected: block.CrossColumnMergeSuspected,
				ReadingOrderUnreliable:    block.ReadingOrderUnreliable,
				StructureUnreliable:       block.StructureUnreliable,
				TextMissingButBBoxPresent: block.TextMissingButBBoxPresent,
				PeerBlockAbsorbedText:     block.PeerBlockAbsorbedText,
				SuspectedPeerBlockID:      block.SuspectedPeerBlockID,
				ContinuationGroup:         block.ContinuationGroup, ContinuationSignature: block.ContinuationSignature, ContinuationDecision: block.ContinuationDecision,
				ContinuationPrevious: block.ContinuationPrevious, ContinuationNext: block.ContinuationNext,
				ProviderContinuationRole: block.ProviderContinuationRole, ProviderContinuationScope: block.ProviderContinuationScope,
				ProviderContinuationOrder: block.ProviderContinuationOrder, ProviderContinuationScore: block.ProviderContinuationScore,
				ProviderContinuationSkip: block.ProviderContinuationSkip,
				LeeMetadata:              block.LeeMetadata,
			})
		}
		pages[index] = page
	}
	return pages
}

// ocrFirstPageText 供导入时给「没有文本层」的扫描件补一份首页文本：
// 题录识别需要可读的首页，否则只能退回文件名。OCR 结果仍走同一份缓存，不会重复计费。
func (s *Server) ocrFirstPageText(ctx context.Context, pdf []byte) string {
	client, err := s.ocrClient()
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(pdf)
	layouts, err := s.cachedOCRLayouts(ctx, "doc-"+hex.EncodeToString(sum[:16]), pdf, client)
	if err != nil || len(layouts) == 0 {
		return ""
	}
	pages, err := client.MapLayouts(ctx, layouts, nil)
	if err != nil || len(pages) == 0 {
		return ""
	}
	var builder strings.Builder
	for _, block := range pages[0].Blocks {
		if !block.Translatable {
			continue
		}
		if text := strings.TrimSpace(block.Text); text != "" {
			builder.WriteString(text)
			builder.WriteString("\n")
		}
	}
	return strings.TrimSpace(builder.String())
}

// handleLayoutStatus 让阅读器知道这篇文档是否带 OCR 版式数据（导入时生成）。
func (s *Server) handleLayoutStatus(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	layout, available, err := s.loadLayout(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": available,
		"pages":     len(layout.Pages),
	})
}

type paragraphBlock struct {
	Index        int        `json:"index"`
	Text         string     `json:"text"`
	Box          [4]float64 `json:"box"`
	Kind         string     `json:"kind"`
	Role         string     `json:"role,omitempty"`
	SourceOrder  int        `json:"sourceOrder,omitempty"`
	Translatable bool       `json:"translatable"`
}

type visualLayoutBlock struct {
	Index int        `json:"index"`
	Kind  string     `json:"kind"`
	Text  string     `json:"text"`
	Box   [4]float64 `json:"box"`
}

// handleDocumentParagraphs 返回 Lee document.v1 归一化后的页面段落：
// 阅读器的「段落识别」直接使用这套块与坐标，不再用 PDF.js 重新切段。
func (s *Server) handleDocumentParagraphs(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	pageNumber, err := strconv.Atoi(strings.TrimSpace(r.PathValue("page")))
	if err != nil || pageNumber < 1 {
		writeError(w, http.StatusBadRequest, "页码必须是从 1 开始的整数")
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇文档")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	layout, available, err := s.loadLayout(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !available || pageNumber > len(layout.Pages) {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "page": pageNumber, "blocks": []paragraphBlock{}, "visuals": []visualLayoutBlock{}})
		return
	}
	entry := layout.Pages[pageNumber-1]
	blocks := make([]paragraphBlock, 0, len(entry.Blocks))
	visuals := make([]visualLayoutBlock, 0)
	for index, block := range entry.Blocks {
		if kind, ok := visualLayoutKind(block.Kind); ok {
			visuals = append(visuals, visualLayoutBlock{Index: index, Kind: kind, Text: strings.TrimSpace(block.Text), Box: block.Box})
			continue
		}
		text := strings.TrimSpace(block.Text)
		if text == "" || nonParagraphKind(block.Kind) {
			continue
		}
		blocks = append(blocks, paragraphBlock{
			Index: index, Text: text, Box: block.Box, Kind: block.Kind,
			Role: roleForKind(block.Kind), SourceOrder: block.SourceOrder,
			Translatable: !block.NotTranslatable,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": true, "page": pageNumber,
		"width": entry.Width, "height": entry.Height, "blocks": blocks, "visuals": visuals,
	})
}

func visualLayoutKind(kind string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "table", "table_body":
		return "table", true
	case "image", "figure", "chart":
		return "image", true
	case "formula", "display_formula", "inline_formula":
		return "formula", true
	default:
		return "", false
	}
}

// nonParagraphKind 排除公式、表格与图片块：它们没有可提问的正文段落。
func nonParagraphKind(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "formula", "display_formula", "inline_formula", "table", "table_body", "image", "figure", "chart":
		return true
	}
	return false
}

type translatedPageRequest struct {
	// Width/Height 是原 PDF 该页的尺寸（pt），由前端从 PDF.js 读出；
	// OCR 结果的像素坐标要按它换算，叠加层也才能和原页严格对齐。
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Force  bool    `json:"force"`
}

type translatedPageStats struct {
	Page       int  `json:"page"`
	Blocks     int  `json:"blocks"`
	Skipped    int  `json:"skipped"`
	Overflow   int  `json:"overflow"`
	Collisions int  `json:"collisions"`
	Cached     bool `json:"cached"`
	// Extracted 表示这一页没有可译正文，返回的是原页副本。
	Extracted bool `json:"extracted"`
}

// handleTranslatedPage 返回单页译文 PDF（原页 + 译文叠加层），供阅读器直接渲染。
func (s *Server) handleTranslatedPage(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	pageNumber, err := strconv.Atoi(strings.TrimSpace(r.PathValue("page")))
	if err != nil || pageNumber < 1 {
		writeError(w, http.StatusBadRequest, "页码必须是从 1 开始的整数")
		return
	}
	var body translatedPageRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxTranslatedPageBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "请求体必须是 {width, height, force?}")
		return
	}
	if body.Width <= 0 || body.Height <= 0 {
		writeError(w, http.StatusBadRequest, "缺少页面尺寸（width/height）")
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇文档")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	paths := legacy.NewPaths(s.cfg.DataRoot)
	sourcePath, found := paths.PDFFile(key)
	if !found {
		writeError(w, http.StatusNotFound, "没有原 PDF 文件")
		return
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取原 PDF 失败: "+err.Error())
		return
	}
	renderer := render.New(s.cfg.DataRoot)
	if err := renderer.Available(); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Minute)
	defer cancel()

	// 导入时已经生成过 OCR 版式：直接复用，不再调用 Paddle。
	var pages []ocr.Page
	stored, hasLayout, layoutErr := s.loadLayout(r.Context(), key)
	if layoutErr != nil {
		writeError(w, http.StatusInternalServerError, "读取 OCR 版式数据失败: "+layoutErr.Error())
		return
	}
	if hasLayout && pageNumber <= len(stored.Pages) {
		pages = layoutOCRPages(stored)
	} else {
		client, err := s.ocrClient()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		layouts, err := s.cachedOCRLayouts(ctx, key, source, client)
		if err != nil {
			writeError(w, http.StatusBadGateway, "OCR 失败: "+err.Error())
			return
		}
		if pageNumber > len(layouts) {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("OCR 只返回 %d 页，没有第 %d 页", len(layouts), pageNumber))
			return
		}
		sizes := make([]ocr.Size, len(layouts))
		sizes[pageNumber-1] = ocr.Size{Width: body.Width, Height: body.Height}
		pages, err = client.MapLayouts(ctx, layouts, sizes)
		if err != nil {
			writeError(w, http.StatusBadGateway, "OCR 结果解析失败: "+err.Error())
			return
		}
	}
	if pageNumber > len(pages) {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("只有 %d 页，没有第 %d 页", len(pages), pageNumber))
		return
	}

	stats, pdf, err := s.renderTranslatedPage(ctx, key, source, pageNumber, pages[pageNumber-1], neighbor(pages, pageNumber-2), neighbor(pages, pageNumber), body.Force, renderer)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "生成排版译文超时")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-CBCT-Page-Blocks", strconv.Itoa(stats.Blocks))
	w.Header().Set("X-CBCT-Page-Overflow", strconv.Itoa(stats.Overflow))
	w.Header().Set("X-CBCT-Page-Cached", strconv.FormatBool(stats.Cached))
	w.Header().Set("X-CBCT-Page-Extracted", strconv.FormatBool(stats.Extracted))
	if _, err := w.Write(pdf); err != nil {
		return
	}
}

// cachedOCRLayouts 把原始 OCR 结果按「原 PDF 内容哈希」缓存到本机。
// 缓存原始结果而不是换算后的块：不同调用可能只带一页的真实尺寸，换算是按调用做的。
func (s *Server) cachedOCRLayouts(ctx context.Context, key string, pdf []byte, client *ocr.Client) ([]json.RawMessage, error) {
	dir := s.translationCacheDir()
	sum := sha256.Sum256(pdf)
	path := filepath.Join(dir, "ocr-"+hex.EncodeToString(sum[:16])+".json")
	if client.Provider == "mineru" {
		identity := sha256.Sum256([]byte(client.BaseURL + "\n" + client.Model))
		path = filepath.Join(dir, "ocr-mineru-"+hex.EncodeToString(identity[:8])+"-"+hex.EncodeToString(sum[:16])+".json")
	}
	if data, err := os.ReadFile(path); err == nil {
		var layouts []json.RawMessage
		if json.Unmarshal(data, &layouts) == nil && len(layouts) > 0 {
			return layouts, nil
		}
	}
	layouts, err := client.Layouts(ctx, pdf, key+".pdf")
	if err != nil {
		return nil, err
	}
	if len(layouts) == 0 {
		return nil, errors.New("OCR 没有返回任何页面")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return layouts, nil
	}
	encoded, err := json.Marshal(layouts)
	if err != nil {
		return layouts, nil
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, encoded, 0o600); err != nil {
		return layouts, nil
	}
	_ = os.Rename(temporary, path)
	return layouts, nil
}

func (s *Server) translationCacheDir() string {
	return filepath.Join(filepath.Dir(s.cfg.DBPath()), "cache")
}

// neighbor 取相邻页（越界返回 nil）：跨页续接只用于消歧，不要越界。
func neighbor(pages []ocr.Page, index int) *ocr.Page {
	if index < 0 || index >= len(pages) {
		return nil
	}
	return &pages[index]
}

// renderTranslatedPage 翻译一页 OCR 块并渲染成单页 PDF，按输入哈希缓存结果。
// 整页没有可译正文（公式/表格/图片页、或译文全空）时不报错，改为原样抽出该页。
func (s *Server) renderTranslatedPage(ctx context.Context, key string, source []byte, pageNumber int, page ocr.Page, before, after *ocr.Page, force bool, renderer *render.Renderer) (translatedPageStats, []byte, error) {
	stats := translatedPageStats{Page: pageNumber}
	items, owners, kept := pageTranslationItems(page, before, after)
	if len(items) == 0 {
		return s.extractOriginalPage(ctx, stats, source, pageNumber, force, renderer)
	}
	targets, err := s.translatePageItems(ctx, key, items, force)
	if err != nil {
		return stats, nil, err
	}
	renderPage := render.Page{Index: 0, Width: page.Width, Height: page.Height}
	for index, owner := range owners {
		if index >= len(targets) || strings.TrimSpace(targets[index]) == "" {
			stats.Skipped++
			continue
		}
		block := page.Blocks[owner]
		role := roleForKind(block.Kind)
		renderPage.Blocks = append(renderPage.Blocks, render.Block{
			Text:     targets[index],
			Box:      block.Box,
			FontSize: estimateFontSize(block.Box, block.Kind),
			Role:     role,
		})
	}
	stats.Blocks = len(renderPage.Blocks)
	if stats.Blocks == 0 {
		return s.extractOriginalPage(ctx, stats, source, pageNumber, force, renderer)
	}
	cachePath, err := pageRenderCachePath(s.translationCacheDir(), key, source, pageNumber, renderPage.Blocks)
	if err != nil {
		return stats, nil, err
	}
	if !force {
		if data, readErr := os.ReadFile(cachePath); readErr == nil && len(data) > 0 {
			stats.Cached = true
			return stats, data, nil
		}
	}
	report, err := renderer.RenderPage(ctx, source, pageNumber, renderPage, cachePath)
	if err != nil {
		return stats, nil, err
	}
	stats.Overflow = report.Overflow
	stats.Collisions = report.Collisions
	if len(kept) > 0 {
		stats.Skipped += len(kept)
	}
	data, err := os.ReadFile(cachePath)
	if err != nil {
		return stats, nil, fmt.Errorf("读取排版结果失败: %w", err)
	}
	return stats, data, nil
}

// renderTranslatedDocument builds a complete translated PDF from the persisted
// Lee-normalized layout and ReadX translation cache. OCR and paragraph
// normalization are only rerun when the document has no saved layout.
func (s *Server) renderTranslatedDocument(ctx context.Context, key string, source []byte, pages []ocr.Page, renderer *render.Renderer, outputPath string) (render.Report, error) {
	if len(pages) == 0 {
		return render.Report{}, errors.New("没有可用于排版的 OCR 页面")
	}
	renderPages := make([]render.Page, len(pages))
	for pageIndex, page := range pages {
		if page.Index != pageIndex {
			return render.Report{}, fmt.Errorf("OCR 页码不连续：第 %d 个位置对应页 %d", pageIndex+1, page.Index+1)
		}
		items, owners, _ := pageTranslationItems(page, neighbor(pages, pageIndex-1), neighbor(pages, pageIndex+1))
		targets, err := s.translatePageItems(ctx, key, items, false)
		if err != nil {
			return render.Report{}, fmt.Errorf("第 %d 页译文准备失败: %w", pageIndex+1, err)
		}
		outputPage := render.Page{Index: pageIndex, Width: page.Width, Height: page.Height}
		for itemIndex, blockIndex := range owners {
			if itemIndex >= len(targets) || strings.TrimSpace(targets[itemIndex]) == "" {
				continue
			}
			block := page.Blocks[blockIndex]
			outputPage.Blocks = append(outputPage.Blocks, render.Block{
				Text: targets[itemIndex], Box: block.Box,
				FontSize: estimateFontSize(block.Box, block.Kind), Role: roleForKind(block.Kind),
			})
		}
		renderPages[pageIndex] = outputPage
	}
	return renderer.Render(ctx, source, renderPages, outputPath)
}

// extractOriginalPage 原样返回这一页：公式/表格/图片页或译文为空时使用，
// 让阅读器可以正常翻页，而不是把整份导入任务标成失败。
func (s *Server) extractOriginalPage(ctx context.Context, stats translatedPageStats, source []byte, pageNumber int, force bool, renderer *render.Renderer) (translatedPageStats, []byte, error) {
	stats.Extracted = true
	cachePath := pageExtractCachePath(s.translationCacheDir(), source, pageNumber)
	if !force {
		if data, err := os.ReadFile(cachePath); err == nil && len(data) > 0 {
			stats.Cached = true
			return stats, data, nil
		}
	}
	if _, err := renderer.ExtractPage(ctx, source, pageNumber, cachePath); err != nil {
		return stats, nil, err
	}
	data, err := os.ReadFile(cachePath)
	if err != nil {
		return stats, nil, fmt.Errorf("读取原页副本失败: %w", err)
	}
	return stats, data, nil
}

func pageExtractCachePath(cacheDir string, source []byte, pageNumber int) string {
	sum := sha256.Sum256(append([]byte(fmt.Sprintf("extract:%d:", pageNumber)), source...))
	return filepath.Join(cacheDir, "page-"+hex.EncodeToString(sum[:16])+".pdf")
}

func pageRenderCachePath(cacheDir, key string, source []byte, pageNumber int, blocks []render.Block) (string, error) {
	sourceSum := sha256.Sum256(source)
	inputSignature, err := json.Marshal(struct {
		DocumentKey  string         `json:"documentKey"`
		SourceSHA256 string         `json:"sourceSHA256"`
		Page         int            `json:"page"`
		Blocks       []render.Block `json:"blocks"`
	}{DocumentKey: key, SourceSHA256: hex.EncodeToString(sourceSum[:]), Page: pageNumber, Blocks: blocks})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(inputSignature)
	return filepath.Join(cacheDir, "page-"+hex.EncodeToString(sum[:16])+".pdf"), nil
}

// pageTranslationItems 把一页 OCR 块变成翻译条目：
//   - 只保留上游策略允许翻译、且不是作者/单位/参考文献的块；
//   - 相邻可译块互为消歧上下文，跨页时接入上一页末块 / 下一页首块；
//   - 上一块没写完时标记 Continuation；
//   - owners 记录「第几条译文 → 页内第几块」，渲染时按块坐标回填。
func pageTranslationItems(page ocr.Page, before, after *ocr.Page) ([]translate.Item, []int, []int) {
	owners := make([]int, 0, len(page.Blocks))
	kept := make([]int, 0)
	for index, block := range page.Blocks {
		if !block.Translatable || keepOriginalOCRText(block.Text, page.Index, block.Box[1], page.Height, block.ContinuationGroup == "") {
			kept = append(kept, index)
			continue
		}
		owners = append(owners, index)
	}
	items := make([]translate.Item, len(owners))
	for offset, blockIndex := range owners {
		block := page.Blocks[blockIndex]
		item := translate.Item{ItemID: fmt.Sprintf("p%d-b%d", page.Index+1, blockIndex+1), PageIndex: page.Index, Source: block.Text, MathMode: "direct_typst", Role: roleForKind(block.Kind), BlockType: block.Kind, PolicyTranslate: block.Translatable, SemanticRole: block.SemanticRole, StructureRole: block.StructureRole, LayoutRole: block.LayoutRole, LineTexts: block.LineTexts, FormulaTexts: formulaTextsFromOCR(block.Segments), CrossColumnMergeSuspected: block.CrossColumnMergeSuspected, ReadingOrderUnreliable: block.ReadingOrderUnreliable, StructureUnreliable: block.StructureUnreliable, ContinuationGroup: block.ContinuationGroup, ContinuationSignature: block.ContinuationSignature}
		if block.ContinuationGroup != "" {
			item.Continuation = true
			item.ContextBefore = block.ContinuationPrevious
			item.ContextAfter = block.ContinuationNext
		}
		if offset > 0 {
			previous := page.Blocks[owners[offset-1]]
			if item.ContinuationGroup == "" && item.ContextBefore == "" && previous.ContinuationGroup == "" && !unreliableLayout(item) && !unreliableOCRBlock(previous) {
				item.ContextBefore = previous.Text
			}
			if item.ContinuationGroup == "" && previous.ContinuationGroup == "" && !unreliableLayout(item) && !unreliableOCRBlock(previous) {
				item.Continuation = !hasSentenceEnd(previous.Text)
			}
		} else if before != nil && item.ContinuationGroup == "" && !unreliableLayout(item) {
			// 跨页续接：上一页的最后一段没写完时，当前页第一段需要它来消歧。
			if text, ok := lastTranslatableText(*before); ok {
				if item.ContextBefore == "" {
					item.ContextBefore = text
				}
				if item.ContinuationGroup == "" {
					item.Continuation = !hasSentenceEnd(text)
				}
			}
		}
		if offset+1 < len(owners) {
			if item.ContinuationGroup == "" && item.ContextAfter == "" && !unreliableLayout(item) && !unreliableOCRBlock(page.Blocks[owners[offset+1]]) {
				item.ContextAfter = page.Blocks[owners[offset+1]].Text
			}
		} else if after != nil && item.ContinuationGroup == "" && !unreliableLayout(item) {
			item.ContextAfter, _ = firstTranslatableText(*after)
		}
		items[offset] = item
	}
	return items, owners, kept
}

func formulaTextsFromOCR(segments []ocr.Segment) []string {
	formulas := make([]string, 0)
	for _, segment := range segments {
		if segment.Type == "formula" || segment.Type == "inline_formula" {
			if strings.TrimSpace(segment.Text) != "" {
				formulas = append(formulas, segment.Text)
			}
		}
	}
	return formulas
}

func unreliableLayout(item translate.Item) bool {
	return item.CrossColumnMergeSuspected || item.ReadingOrderUnreliable || item.StructureUnreliable
}

func unreliableOCRBlock(block ocr.Block) bool {
	return block.CrossColumnMergeSuspected || block.ReadingOrderUnreliable || block.StructureUnreliable
}

func joinContinuationSources(parts []string) string {
	joined := ""
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if joined == "" {
			joined = part
			continue
		}
		joined, part = dropDuplicatedContinuationTail(joined, part)
		if part == "" {
			continue
		}
		separator := " "
		if strings.HasSuffix(joined, "-") && len(part) > 0 {
			first := []rune(part)[0]
			if first >= 'A' && first <= 'Z' || first >= 'a' && first <= 'z' || first >= '0' && first <= '9' {
				separator = ""
			}
		}
		joined += separator + part
	}
	return joined
}

func dropDuplicatedContinuationTail(previous, next string) (string, string) {
	prevRunes, nextRunes := []rune(previous), []rune(next)
	wordEnd := len(prevRunes)
	if wordEnd > 0 && prevRunes[wordEnd-1] == '.' {
		wordEnd--
	}
	wordStart := wordEnd
	for wordStart > 0 && ((prevRunes[wordStart-1] >= 'A' && prevRunes[wordStart-1] <= 'Z') || (prevRunes[wordStart-1] >= 'a' && prevRunes[wordStart-1] <= 'z')) {
		wordStart--
	}
	fragmentEnd := 0
	for fragmentEnd < len(nextRunes) && nextRunes[fragmentEnd] >= 'a' && nextRunes[fragmentEnd] <= 'z' {
		fragmentEnd++
	}
	whole, fragment := string(prevRunes[wordStart:wordEnd]), string(nextRunes[:fragmentEnd])
	if len([]rune(fragment)) < 3 || len([]rune(whole)) < len([]rune(fragment))+3 || !strings.HasSuffix(strings.ToLower(whole), strings.ToLower(fragment)) {
		return previous, next
	}
	return string(prevRunes[:wordEnd]), strings.TrimSpace(string(nextRunes[fragmentEnd:]))
}

func lastTranslatableText(page ocr.Page) (string, bool) {
	for index := len(page.Blocks) - 1; index >= 0; index-- {
		block := page.Blocks[index]
		if block.Translatable && strings.TrimSpace(block.Text) != "" {
			return block.Text, true
		}
	}
	return "", false
}

func firstTranslatableText(page ocr.Page) (string, bool) {
	for _, block := range page.Blocks {
		if block.Translatable && strings.TrimSpace(block.Text) != "" {
			return block.Text, true
		}
	}
	return "", false
}

// translatePageItems 复用段落翻译缓存：同一段原文只翻译一次，force 时重译。
func (s *Server) translatePageItems(ctx context.Context, key string, items []translate.Item, force bool) ([]string, error) {
	return s.translatePageItemsMode(ctx, key, items, force, false)
}

func (s *Server) translatePageItemsMode(ctx context.Context, key string, items []translate.Item, force, cachedOnly bool) ([]string, error) {
	if err := attachTranslationTerms(ctx, s, items); err != nil {
		return nil, err
	}
	config, configErr := s.workflowAIConfig(WorkflowTranslation)
	var cacheConfig *ai.Config
	if configErr == nil {
		cacheConfig = &config
	}
	hashes := make([]string, len(items))
	for index, item := range items {
		hashes[index] = translationCacheHash(item, cacheConfig)
	}
	cached := map[string]string{}
	if !force {
		var err error
		cached, err = s.cachedTranslations(ctx, key, hashes)
		if err != nil {
			return nil, err
		}
		// 指纹没命中的段落，退回「同一篇论文 + 逐字相同的原文」再找一次：
		// 旧版式丢了续接字段后指纹永远对不上，这个兜底让库里已有的译文能立刻显示出来。
		missing := false
		for _, hash := range hashes {
			if _, hit := cached[hash]; !hit {
				missing = true
				break
			}
		}
		if missing {
			bySource, sourceErr := s.translationsBySource(ctx, key)
			if sourceErr != nil {
				return nil, sourceErr
			}
			for index, hash := range hashes {
				if _, hit := cached[hash]; hit {
					continue
				}
				if target, ok := bySource[strings.TrimSpace(items[index].Source)]; ok && strings.TrimSpace(target) != "" {
					cached[hash] = target
				}
			}
		}
	}
	missingHashes := make([]string, 0, len(items))
	missingItems := make([]translate.Item, 0, len(items))
	seen := map[string]bool{}
	for index, hash := range hashes {
		if _, hit := cached[hash]; hit {
			continue
		}
		if seen[hash] {
			continue
		}
		seen[hash] = true
		missingHashes = append(missingHashes, hash)
		missingItems = append(missingItems, items[index])
	}
	if len(missingItems) > 0 {
		if cachedOnly {
			// Leave uncached targets empty; LeePDF's background importer will
			// persist them and the next reader poll will pick them up.
		} else {
			if configErr != nil {
				return nil, configErr
			}
			if !config.Ready() {
				return nil, errors.New("还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
			}
			translationCtx, cancel := context.WithTimeout(ctx, translate.Budget(len(missingItems)))
			result, err := translate.Translate(translationCtx, ai.NewClient(config), missingItems, translate.Options{BestEffort: true})
			cancel()
			if err != nil {
				return nil, fmt.Errorf("翻译 OCR 段落失败: %w", err)
			}
			sources := make([]string, len(missingItems))
			for index := range missingItems {
				sources[index] = missingItems[index].Source
			}
			if err := s.saveTranslations(ctx, key, missingHashes, sources, result.Targets); err != nil {
				return nil, err
			}
			for index, hash := range missingHashes {
				if index < len(result.Targets) && strings.TrimSpace(result.Targets[index]) != "" {
					cached[hash] = result.Targets[index]
				}
			}
		}
	}
	targets := make([]string, len(items))
	for index, hash := range hashes {
		targets[index] = cached[hash]
	}
	return targets, nil
}
