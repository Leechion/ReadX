package translate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Lee-compatible document term pre-scan constants. Batching is based on OCR
// translation blocks, not PDF pages, so page count and paragraph count cannot
// be confused by the import progress UI.
const (
	PrescanPromptVersion       = "term-prescan-v1"
	PrescanSegmentationVersion = "prescan-segments-v1"
	PrescanBatchMaxTokens      = 600
	PrescanBatchMaxSegments    = 12
)

type PrescanTerm struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"`
}

type PrescanBatchStore interface {
	LoadBatch(context.Context, string, string) ([]PrescanTerm, bool, error)
	SaveBatch(context.Context, string, string, []PrescanTerm) error
}

type prescanBatch struct{ items []Item }

type termPrescanStructuredGenerator interface {
	GenerateStructured(context.Context, string, string, float64, any) (string, error)
}
type termPrescanTimedStructuredGenerator interface {
	GenerateStructuredWithTimeout(context.Context, string, string, float64, time.Duration, any) (string, error)
}

var (
	preScanDisplayRE   = regexp.MustCompile(`(?s)\$\$.+?\$\$`)
	preScanMathChars   = regexp.MustCompile(`[$\\^_{}=<>|~∑∫√±×÷∂∇≈≠≤≥]`)
	preScanFunction    = regexp.MustCompile(`^[A-Za-z]{1,3}\s*\(.*\)$`)
	preScanVariable    = regexp.MustCompile(`^[a-z][A-Za-z0-9]?$`)
	preScanCrossRef    = regexp.MustCompile(`(?i)^(fig(ure)?s?|eqs?|equations?|tables?|sections?|sec|chapters?|ch|refs?|appendix)\.?\s*[\d(\[]`)
	preScanArticle     = regexp.MustCompile(`(?i)^(the|a|an)\s+`)
	preScanCJK         = regexp.MustCompile(`[㐀-鿿豈-﫿]`)
	preScanASCIIWord   = regexp.MustCompile(`[A-Za-z0-9]`)
	preScanLatinLetter = regexp.MustCompile(`[A-Za-z]`)
	preScanGeneric     = map[string]bool{}
	preScanGreek       = map[string]bool{}
	preScanStopKey     = map[string]bool{"or": true, "and": true, "the": true, "from": true, "with": true, "for": true, "this": true, "that": true}
)

func init() {
	for _, word := range strings.Fields("analysis answer appendix approach approaches article aspect assumption case cases chapter conclusion conclusions condition conditions data definition discussion effect effects equation equations example examples experiment experiments expression fact factor figure figures form formula function functions introduction literature method methods model models number numbers order paper parameter parameters part point problem problems process property properties quantity question reference references relation research result results section sections set solution solutions study studies summary system systems table tables term terms theory type types value values variable variables way work") {
		preScanGeneric[word] = true
	}
	for _, word := range strings.Fields("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega") {
		preScanGreek[word] = true
	}
}

// PrepareDocumentTerms follows LeePDF's terms preparation: mask math, batch
// contiguous OCR prose by deterministic token estimate, validate model output,
// vote once per batch, and keep user glossary decisions authoritative. A failed
// batch is skipped so an optional preparation step never blocks translation.
func PrepareDocumentTerms(ctx context.Context, generator Generator, items []Item, userTerms []Term, targetLanguage string) ([]Term, error) {
	return PrepareDocumentTermsWithStore(ctx, generator, items, userTerms, targetLanguage, "", "", nil)
}

// PrepareDocumentTermsWithStore adds LeePDF-style per-batch checkpoints.
// requestIdentity binds cached batches to the provider/model/config identity;
// each batch digest additionally includes its actual prompt and source text.
func PrepareDocumentTermsWithStore(ctx context.Context, generator Generator, items []Item, userTerms []Term, targetLanguage, domain, requestIdentity string, store PrescanBatchStore) ([]Term, error) {
	segments := collectPrescanSegments(items)
	batches := makePrescanBatches(segments)
	if len(batches) == 0 {
		return nil, nil
	}
	schema := map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "term_prescan_response", "strict": true, "schema": map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{"terms": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]any{"source": map[string]string{"type": "string"}, "target": map[string]string{"type": "string"}, "kind": map[string]string{"type": "string"}}, "required": []string{"source", "target", "kind"}}}}, "required": []string{"terms"}}}}
	system := strings.ReplaceAll(`你是学术图书翻译项目的术语编辑。任务是在正式翻译之前，从原文片段里抽出需要全书统一译法的术语，并给出 <<TARGET_LANGUAGE>> 译法。

只抽两类：
- 专有名词：人名、机构名、地名、学派、命名的定理/定律/方程/效应/方法/算法、软件、数据集、仪器型号等。
- 领域名词短语：本学科的专业概念，通常是 1–5 个词的名词短语，例如 "harmonic oscillator"、"convolutional neural network"。

一律不抽：
- 数学符号、变量、公式片段、上下标、单个字母、希腊字母、数字、单位、编号（例如 x、x_i、\alpha、f(x)、Eq. 5、Figure 3.2）。原文里的 [math] 是被移除的公式，忽略它。
- 泛学术词和日常词：method、result、analysis、approach、example、problem、model、system、data、paper、chapter、section 之类。
- 整句或从句；以及原文里没有逐字出现的词。

译法要求：
- 采用该学科通行的规范译名（优先全国科学技术名词审定委员会公布的名词）。
- 软件名、代码、变量名、数据集名、编程语言名保持原文，target 填原文本身。
- 外国人名用通行译名，名与姓之间用间隔号「·」；没有通行译名时 target 填原文。
- locked_terms 里给出的是已锁定术语，必须原样沿用其译法，不要另起译名，也不必重复返回。

只返回严格 JSON：{"terms": [{"source": "原文中逐字出现的术语", "target": "译法", "kind": "proper_noun 或 domain_term"}]}。没有可抽的术语时返回 {"terms": []}。不要输出 markdown、代码块或解释。`, "<<TARGET_LANGUAGE>>", targetLanguage)
	type vote struct {
		target, surface, kind string
		batch                 int
	}
	votes := map[string][]vote{}
	type batchResult struct {
		terms []PrescanTerm
		err   error
	}
	results := make([]batchResult, len(batches))
	semaphore := make(chan struct{}, 8)
	var workers sync.WaitGroup
	for batchIndex, batch := range batches {
		workers.Add(1)
		go func(batchIndex int, batch prescanBatch) {
			defer workers.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				results[batchIndex].err = ctx.Err()
				return
			}
			payload := map[string]any{"task": "从 segments 里的原文片段抽取术语。source 必须与原文逐字一致，大小写按原文首次出现的形式。每个术语只返回一次。", "domain": domain, "locked_terms": matchedLockedTerms(userTerms, batch.items), "segments": make([]map[string]string, 0, len(batch.items))}
			for itemIndex, item := range batch.items {
				segmentID := strings.TrimSpace(item.ItemID)
				if segmentID == "" {
					segmentID = fmt.Sprintf("%d", itemIndex)
				}
				payload["segments"] = append(payload["segments"].([]map[string]string), map[string]string{"id": segmentID, "text": item.Source})
			}
			body, _ := json.Marshal(payload)
			fingerprintBody, _ := json.Marshal(struct {
				Identity            string          `json:"identity"`
				PromptVersion       string          `json:"promptVersion"`
				System              string          `json:"system"`
				SegmentationVersion string          `json:"segmentationVersion"`
				TargetLanguage      string          `json:"targetLanguage"`
				Payload             json.RawMessage `json:"payload"`
			}{requestIdentity, PrescanPromptVersion, system, PrescanSegmentationVersion, targetLanguage, body})
			batchSum := sha256.Sum256(fingerprintBody)
			batchFingerprint := hex.EncodeToString(batchSum[:])
			batchID := fmt.Sprintf("b%05d", batchIndex)
			if store != nil {
				cached, ok, cacheErr := store.LoadBatch(ctx, batchID, batchFingerprint)
				if cacheErr == nil && ok {
					results[batchIndex].terms = cached
					return
				}
			}
			content := ""
			var err error
			for attempt := 0; attempt < 2; attempt++ {
				if timed, ok := generator.(termPrescanTimedStructuredGenerator); ok {
					content, err = timed.GenerateStructuredWithTimeout(ctx, system, string(body), 0, 60*time.Second, schema)
				} else if structured, ok := generator.(termPrescanStructuredGenerator); ok {
					content, err = structured.GenerateStructured(ctx, system, string(body), 0, schema)
				} else {
					content, err = generator.Generate(ctx, system, string(body), 0)
				}
				if err != nil {
					continue
				}
				var parsed struct {
					Terms []PrescanTerm `json:"terms"`
				}
				if err = parseStructuredJSON(content, &parsed); err == nil {
					seenTerms := map[string]bool{}
					for _, candidate := range parsed.Terms {
						candidate.Source = cleanPrescanTerm(candidate.Source)
						candidate.Target = cleanPrescanTerm(candidate.Target)
						key := strings.ToLower(candidate.Source)
						if seenTerms[key] {
							continue
						}
						if acceptablePrescanTerm(candidate, batch.items, targetLanguage, userTerms) {
							seenTerms[key] = true
							if candidate.Kind != "proper_noun" && candidate.Kind != "domain_term" {
								candidate.Kind = "domain_term"
							}
							results[batchIndex].terms = append(results[batchIndex].terms, candidate)
						}
					}
					if store != nil {
						if saveErr := store.SaveBatch(ctx, batchID, batchFingerprint, results[batchIndex].terms); saveErr != nil {
							results[batchIndex].err = saveErr
						}
					}
					break
				}
			}
			if err != nil && results[batchIndex].err == nil {
				results[batchIndex].err = err
			}
		}(batchIndex, batch)
	}
	workers.Wait()
	var firstErr error
	for batchIndex, result := range results {
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		for _, candidate := range result.terms {
			if candidate.Kind != "proper_noun" && candidate.Kind != "domain_term" {
				candidate.Kind = "domain_term"
			}
			key := strings.ToLower(candidate.Source)
			votes[key] = append(votes[key], vote{candidate.Target, candidate.Source, candidate.Kind, batchIndex})
		}
	}
	terms := make([]Term, 0, len(votes))
	for _, group := range votes {
		counts := map[string]int{}
		first := map[string]int{}
		surfaces := map[string]int{}
		firstSurface := map[string]int{}
		kinds := map[string]int{}
		firstKind := map[string]int{}
		for _, v := range group {
			counts[v.target]++
			if _, ok := first[v.target]; !ok {
				first[v.target] = v.batch
			}
			surfaces[v.surface]++
			if _, ok := firstSurface[v.surface]; !ok {
				firstSurface[v.surface] = v.batch
			}
			kinds[v.kind]++
			if _, ok := firstKind[v.kind]; !ok {
				firstKind[v.kind] = v.batch
			}
		}
		winner := ""
		for target, count := range counts {
			if winner == "" || count > counts[winner] || count == counts[winner] && (first[target] < first[winner] || first[target] == first[winner] && target < winner) {
				winner = target
			}
		}
		source := mostFrequentInOrder(surfaces, firstSurface)
		kind := mostFrequentInOrder(kinds, firstKind)
		if source == "" || winner == "" || userTermCovers(source, userTerms) {
			continue
		}
		mode := "case_insensitive"
		if allUpperOrDigit(source) {
			mode = "exact"
		}
		conflicts := make([]TermCandidate, 0, len(counts)-1)
		for target, count := range counts {
			if target != winner {
				conflicts = append(conflicts, TermCandidate{Target: target, Votes: count})
			}
		}
		sort.SliceStable(conflicts, func(i, j int) bool {
			if conflicts[i].Votes != conflicts[j].Votes {
				return conflicts[i].Votes > conflicts[j].Votes
			}
			if first[conflicts[i].Target] != first[conflicts[j].Target] {
				return first[conflicts[i].Target] < first[conflicts[j].Target]
			}
			return conflicts[i].Target < conflicts[j].Target
		})
		firstOccurrenceID, firstOccurrencePage := prescanFirstOccurrence(source, mode, segments)
		terms = append(terms, Term{Source: source, Target: winner, Level: "preferred", MatchMode: mode, Note: "document_term_prescan:" + kind, Votes: counts[winner], ConflictCandidates: conflicts, Frequency: prescanFrequency(source, segments), FirstOccurrenceID: firstOccurrenceID, FirstOccurrencePage: firstOccurrencePage})
	}
	sort.SliceStable(terms, func(i, j int) bool {
		left, right := terms[i].Frequency, terms[j].Frequency
		if left != right {
			return left > right
		}
		return strings.ToLower(terms[i].Source) < strings.ToLower(terms[j].Source)
	})
	return terms, firstErr
}

func makePrescanBatches(items []Item) []prescanBatch {
	var out []prescanBatch
	var current []Item
	tokens := 0
	flush := func() {
		if len(current) > 0 {
			out = append(out, prescanBatch{items: current})
			current = nil
			tokens = 0
		}
	}
	for _, item := range items {
		n := estimatePrescanTokens(item.Source)
		if len(current) > 0 && (tokens+n > PrescanBatchMaxTokens || len(current) >= PrescanBatchMaxSegments) {
			flush()
		}
		current = append(current, item)
		tokens += n
	}
	flush()
	return out
}

func estimatePrescanTokens(text string) int {
	cjk := len(preScanCJK.FindAllStringIndex(text, -1))
	other := len([]rune(text)) - cjk
	return cjk + int(math.Ceil(float64(other)/4))
}
func matchedLockedTerms(terms []Term, items []Item) []map[string]string {
	all := joinItemSources(items)
	matched := MatchTerms(all, terms)
	out := make([]map[string]string, 0, len(matched))
	for _, term := range matched {
		target := term.Target
		if term.Level == "preserve" {
			target = term.Source
		}
		out = append(out, map[string]string{"source": term.Source, "target": target})
	}
	return out
}
func joinItemSources(items []Item) string {
	var b strings.Builder
	for _, it := range items {
		b.WriteString(it.Source)
		b.WriteByte('\n')
	}
	return b.String()
}
func acceptablePrescanTerm(t PrescanTerm, batch []Item, language string, locked []Term) bool {
	s := cleanPrescanTerm(t.Source)
	target := cleanPrescanTerm(t.Target)
	if s == "" || target == "" || len(strings.Fields(s)) > 6 || len([]rune(target)) > 40 || strings.ContainsAny(target, "，。；！？!?;") {
		return false
	}
	bare := strings.ToLower(strings.TrimSpace(preScanArticle.ReplaceAllString(s, "")))
	letters, nonspace := 0, 0
	for _, r := range s {
		if !unicode.IsSpace(r) {
			nonspace++
			if unicode.IsLetter(r) {
				letters++
			}
		}
	}
	if len(s) < 2 || preScanStopKey[strings.ToLower(s)] || preScanMathChars.MatchString(s) || strings.Contains(strings.ToLower(s), "[math]") || preScanFunction.MatchString(s) || preScanVariable.MatchString(s) || preScanCrossRef.MatchString(s) || preScanGeneric[bare] || preScanGreek[bare] || letters*2 < nonspace || letters == 0 || strings.Count(s, "(") != strings.Count(s, ")") {
		return false
	}
	if len(strings.Fields(s)) == 1 && len([]rune(s)) < 3 {
		return false
	}
	found := termKeyMatchesSource(s, joinItemSources(batch))
	if !found || userTermCovers(s, locked) {
		return false
	}
	if strings.HasPrefix(strings.ToLower(language), "zh") && !preScanCJK.MatchString(target) && !strings.EqualFold(s, target) {
		return false
	}
	return true
}
func userTermCovers(source string, terms []Term) bool {
	for _, t := range terms {
		if t.MatchMode != "regex" && strings.EqualFold(t.Source, source) {
			return true
		}
		pattern := regexp.QuoteMeta(strings.TrimSpace(t.Source))
		if t.MatchMode == "regex" {
			pattern = t.Source
		} else if t.MatchMode == "case_insensitive" {
			pattern = "(?i)" + pattern
		}
		re, err := regexp.Compile(pattern)
		if err == nil {
			if loc := re.FindStringIndex(source); loc != nil && loc[0] == 0 && loc[1] == len(source) {
				return true
			}
		}
	}
	return false
}

func termKeyMatchesSource(key, source string) bool {
	key = cleanPrescanTerm(key)
	source = strings.Join(strings.Fields(source), " ")
	if key == "" {
		return false
	}
	if !preScanASCIIWord.MatchString(key) {
		return strings.Contains(strings.ToLower(source), strings.ToLower(key))
	}
	parts := strings.Fields(key)
	for index := range parts {
		parts[index] = regexp.QuoteMeta(parts[index])
	}
	re, err := regexp.Compile(`(?i)` + strings.Join(parts, `\s+`))
	if err != nil {
		return false
	}
	for _, loc := range re.FindAllStringIndex(source, -1) {
		left := loc[0] > 0 && isASCIIAlphaNumeric(source[loc[0]-1])
		right := loc[1] < len(source) && isASCIIAlphaNumeric(source[loc[1]])
		if !left && !right {
			return true
		}
	}
	return false
}

func isPrescanCandidate(item Item) bool {
	if !item.PolicyTranslate {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(item.BlockType)) {
	case "formula", "equation", "code", "table", "image", "figure":
		return false
	}
	roles := strings.ToLower(strings.Join([]string{item.SemanticRole, item.StructureRole, item.LayoutRole}, " "))
	return !strings.Contains(roles, "metadata") && !strings.Contains(roles, "reference") && !strings.Contains(roles, "bibliography")
}

func collectPrescanSegments(items []Item) []Item {
	segments := make([]Item, 0, len(items))
	for _, item := range items {
		if !isPrescanCandidate(item) {
			continue
		}
		item.Source = strings.Join(strings.Fields(maskPrescanMath(item.Source)), " ")
		if len(preScanLatinLetter.FindAllStringIndex(item.Source, -1)) < 3 {
			continue
		}
		segments = append(segments, item)
	}
	return segments
}

func maskPrescanMath(text string) string {
	text = preScanDisplayRE.ReplaceAllString(text, " [math] ")
	text = maskPrescanInlineMath(text)
	return strings.Join(strings.Fields(text), " ")
}

func maskPrescanInlineMath(text string) string {
	var out strings.Builder
	cursor := 0
	for open := 0; open < len(text); open++ {
		if text[open] != '$' || open > 0 && text[open-1] == '\\' {
			continue
		}
		close := -1
		for candidate := open + 1; candidate < len(text); candidate++ {
			if text[candidate] == '$' && text[candidate-1] != '\\' {
				close = candidate
				break
			}
		}
		if close < 0 {
			continue
		}
		out.WriteString(text[cursor:open])
		out.WriteString(" [math] ")
		cursor = close + 1
		open = close
	}
	out.WriteString(text[cursor:])
	return out.String()
}

func cleanPrescanTerm(value string) string {
	cleaned := strings.Join(strings.Fields(value), " ")
	cleaned = strings.Trim(cleaned, " ,.;:()[]{}，。；：（）【】")
	runes := []rune(cleaned)
	if len(runes) > 80 {
		cleaned = string(runes[:80])
	}
	return cleaned
}

func isASCIIAlphaNumeric(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9'
}

func mostFrequentInOrder(counts, first map[string]int) string {
	out := ""
	for value, count := range counts {
		if out == "" || count > counts[out] || count == counts[out] && (first[value] < first[out] || first[value] == first[out] && value < out) {
			out = value
		}
	}
	return out
}

func prescanFrequency(source string, items []Item) int {
	pattern := regexp.QuoteMeta(cleanPrescanTerm(source))
	pattern = strings.ReplaceAll(pattern, `\ `, `\s+`)
	re, err := regexp.Compile(`(?i)` + pattern)
	if err != nil {
		return 0
	}
	count := 0
	for _, item := range items {
		for _, loc := range re.FindAllStringIndex(item.Source, -1) {
			left := loc[0] > 0 && isTermWord(item.Source[loc[0]-1])
			right := loc[1] < len(item.Source) && isTermWord(item.Source[loc[1]])
			if !left && !right {
				count++
			}
		}
	}
	return count
}

func prescanFirstOccurrence(source, mode string, items []Item) (string, *int) {
	pattern := regexp.QuoteMeta(cleanPrescanTerm(source))
	pattern = strings.ReplaceAll(pattern, `\ `, `\s+`)
	if mode == "case_insensitive" {
		pattern = `(?i)` + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", nil
	}
	for _, item := range items {
		for _, loc := range re.FindAllStringIndex(item.Source, -1) {
			left := loc[0] > 0 && isTermWord(item.Source[loc[0]-1])
			right := loc[1] < len(item.Source) && isTermWord(item.Source[loc[1]])
			if !left && !right {
				pageIndex := item.PageIndex
				return item.ItemID, &pageIndex
			}
		}
	}
	return "", nil
}
func allUpperOrDigit(s string) bool {
	has := false
	for _, r := range s {
		if unicode.IsLetter(r) {
			has = true
			if unicode.IsLower(r) {
				return false
			}
		}
	}
	return has
}
