package translate

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"cbctv2/server/internal/render"
)

const (
	severityError   = "error"
	severityWarning = "warning"
)

var (
	hanCharRE    = regexp.MustCompile(`\p{Han}`)
	englishWord  = regexp.MustCompile(`[A-Za-z][A-Za-z'\-]+`)
	latexCommand = regexp.MustCompile(`\\([A-Za-z]+)`)
	numberToken  = regexp.MustCompile(`\d+(?:,\d{3})*(?:\.\d+)?`)
	residueSplit = regexp.MustCompile(`[。！？；;\n]+`)
	// mathSpanRE 让数字/英文检查跳过行内公式：公式里的命令与下标不是「残留英文」。
	mathSpanRE                  = regexp.MustCompile(`\$\$[^$]*\$\$|\$[^$\n]+\$`)
	selfCorrectionStartRE       = regexp.MustCompile(`(?im)(?:^|\n)\s*(?:(?:wait|hmm+|actually|oops|correction|scratch that)\s*[—–\-,:：!！.]|(?:等等|稍等|更正|纠正|抱歉)\s*[，,:：—!！])`)
	selfCorrectionPhraseRE      = regexp.MustCompile(`(?i)\b(?:i\s+(?:need|have|should|must)\s+to\s+(?:correct|fix|revise|redo|re-?translate)|let\s+me\s+(?:correct|fix|revise|redo|re-?translate)|correct(?:ing)?\s+(?:it|this|that|my\s+(?:reply|answer|response|translation|output))\b|(?:should|must)\s*(?:not|n't)\s+be\s+translated\s+as|the\s+correct\s+(?:output|translation|answer|reply)\s+is|my\s+(?:previous|earlier|last)\s+(?:reply|answer|response|translation|output)|(?:not|instead\s+of)\s+the\s+source\s+(?:text\s+)?repeated)`)
	selfCorrectionChineseRE     = regexp.MustCompile(`(?:不应|不该|不能)(?:被)?(?:译|翻译)(?:为|成)|(?:上面|上述|刚才)的?(?:译文|翻译|回答)(?:有误|错了|不对)`)
	selfCorrectionTranslationRE = regexp.MustCompile(`译|翻译|改正|纠正|更正|修正`)
)

// Review 对一条译文做确定性质检。
//
// source 是用户看到的原文；protectedSource 是占位符替换后的原文（用来核对
// 占位符清单）；target 是模型原始输出（尚未还原占位符）。顺序不能反：
// 还原后再检查就看不见 token 了。
func Review(source, protectedSource, target string, tokens []Token, itemContext ...Item) []Issue {
	issues := make([]Issue, 0, 4)
	target = strings.TrimSpace(target)
	if target == "" {
		return append(issues, Issue{
			Kind:      "empty_translation",
			Severity:  severityError,
			Message:   "译文为空",
			Retryable: true,
		})
	}
	if looksLikeProtocolShell(target) {
		issues = append(issues, Issue{
			Kind:      "protocol_shell_output",
			Severity:  severityError,
			Message:   "译文里残留了 JSON / 协议壳，只输出正文",
			Retryable: true,
		})
	}
	mathMode := "direct_typst"
	if len(itemContext) > 0 {
		mathMode = itemMathMode(itemContext[0])
	}
	if mathMode != "direct_typst" {
		issues = append(issues, reviewPlaceholders(protectedSource, target, tokens)...)
	}
	if mathMode == "direct_typst" {
		issues = append(issues, reviewMathDelimiters(source, target)...)
		braceIssues := reviewMathBraces(source, target)
		issues = append(issues, braceIssues...)
		if len(braceIssues) == 0 {
			if broken, checked := render.CheckUnrenderableMath(source, target); checked && len(broken) > 0 {
				preview := broken
				if len(preview) > 3 {
					preview = preview[:3]
				}
				parts := make([]string, 0, len(preview))
				for _, formula := range preview {
					parts = append(parts, "$"+formula.Tex+"$（"+formula.Error+"）")
				}
				issues = append(issues, Issue{
					Kind: "math_unrenderable", Severity: severityError,
					Message: "公式渲染器无法排版：" + strings.Join(parts, "；"), Retryable: true,
				})
			}
		}
		issues = append(issues, reviewDroppedLatexCommands(source, target)...)
	}
	if leaked := selfCorrectionLeak(source, target); leaked != "" {
		issues = append(issues, Issue{
			Kind: "self_correction_leak", Severity: severityError,
			Message: "译文里混入了模型的自我纠正话术：" + leaked, Retryable: true,
		})
	}
	// 数字与英文检查用保护后的文本：代码/链接里的数字不属于「必须保留」的正文数字。
	issues = append(issues, reviewNumbers(protectedSource, target)...)
	issues = append(issues, reviewEnglish(protectedSource, target)...)
	issues = append(issues, reviewTruncation(source, target)...)
	if len(itemContext) > 0 {
		item := itemContext[0]
		restoredTarget, _, _ := Restore(target, tokens)
		issues = append(issues, reviewGlossary(source, restoredTarget, item.Terms)...)
		issues = append(issues, reviewContextBorrow(item, source, restoredTarget)...)
	}
	return issues
}

func reviewPlaceholders(source, target string, tokens []Token) []Issue {
	issues := make([]Issue, 0, 2)
	known := make(map[string]bool, len(tokens))
	for _, token := range tokens {
		known[token.Tag] = true
	}
	unexpected := []string{}
	for _, tag := range tokenSequence(target) {
		if !known[tag] {
			unexpected = append(unexpected, tag)
		}
	}
	if len(unexpected) > 0 {
		issues = append(issues, Issue{
			Kind:      "unexpected_placeholder",
			Severity:  severityError,
			Message:   "译文出现了原文没有的占位符：" + strings.Join(dedupe(unexpected), "、"),
			Retryable: true,
		})
	}
	expected := tokenSequence(source)
	actual := tokenSequence(target)
	if !sameMultiset(expected, actual) {
		issues = append(issues, Issue{
			Kind:      "placeholder_mismatch",
			Severity:  severityError,
			Message:   "占位符必须逐字保留且数量一致；请检查代码、链接和术语 token 是否被改写或删除",
			Retryable: true,
		})
	} else if !sameSequence(expected, actual) {
		issues = append(issues, Issue{
			Kind:      "placeholder_order",
			Severity:  severityWarning,
			Message:   "占位符顺序与原文不同；中文语序允许调整，但请确认没有把代码/术语挪到别的语义位置",
			Retryable: false,
		})
	}
	return issues
}

func reviewMathDelimiters(source, target string) []Issue {
	// LeePDF repairs an odd source delimiter count when OCR dropped a `$`;
	// the translated result must be balanced regardless of the source state.
	if dollarCount(target)%2 == 0 {
		return nil
	}
	return []Issue{{
		Kind:      "math_delimiter_unbalanced",
		Severity:  severityError,
		Message:   "译文里的行内公式 $...$ 没有成对闭合",
		Retryable: true,
	}}
}

func reviewMathBraces(source, target string) []Issue {
	sourceUnbalanced := map[string]bool{}
	for _, formula := range mathFormulaSpans(source) {
		if !balancedMathBraces(formula) {
			sourceUnbalanced[compactMath(formula)] = true
		}
	}
	broken := []string{}
	for _, formula := range mathFormulaSpans(target) {
		if !balancedMathBraces(formula) && !sourceUnbalanced[compactMath(formula)] {
			broken = append(broken, formula)
			if len(broken) == 3 {
				break
			}
		}
	}
	if len(broken) == 0 {
		return nil
	}
	return []Issue{{
		Kind:      "math_braces_unbalanced",
		Severity:  severityError,
		Message:   "公式里的花括号不配对，渲染器解析不了：" + strings.Join(broken, "；"),
		Retryable: true,
	}}
}

func mathFormulaSpans(text string) []string {
	spans := []string{}
	for start := 0; start < len(text); {
		if text[start] != '$' || escapedDollarAt(text, start) {
			start++
			continue
		}
		width := 1
		if start+1 < len(text) && text[start+1] == '$' {
			width = 2
		}
		closed := false
		for end := start + width; end < len(text); {
			if text[end] == '$' && !escapedDollarAt(text, end) {
				endWidth := 1
				if end+1 < len(text) && text[end+1] == '$' {
					endWidth = 2
				}
				if endWidth == width {
					formula := strings.TrimSpace(text[start+width : end])
					if formula != "" {
						spans = append(spans, formula)
					}
					start = end + width
					closed = true
					break
				}
			}
			end++
		}
		if !closed {
			// No closing delimiter was found; this matches LeePDF's behavior
			// of excluding unmatched dollars from formula-span validation.
			start++
		}
	}
	return spans
}

func escapedDollarAt(text string, index int) bool {
	return index > 0 && text[index-1] == '\\'
}

func balancedMathBraces(formula string) bool {
	depth := 0
	for index := 0; index < len(formula); index++ {
		if formula[index] == '\\' {
			index++
			continue
		}
		switch formula[index] {
		case '{':
			depth++
		case '}':
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return depth == 0
}

func compactMath(formula string) string {
	return strings.Join(strings.Fields(formula), "")
}

var (
	latexCommandAliases = map[string]string{
		"bf": "mathbf", "rm": "mathrm", "it": "mathit", "sf": "mathsf", "tt": "mathtt", "cal": "mathcal",
	}
	latexCommandsExpectedToDrift = map[string]bool{
		"prime": true, "scriptstyle": true, "scriptscriptstyle": true, "displaystyle": true,
		"textstyle": true, "quad": true, "qquad": true, "big": true, "Big": true,
		"bigg": true, "Bigg": true, "text": true, "textrm": true, "textit": true,
		"textbf": true, "begin": true, "end": true, "label": true, "cite": true,
		"citep": true, "citet": true, "ref": true,
	}
)

func reviewDroppedLatexCommands(source, target string) []Issue {
	countCommands := func(text string) map[string]int {
		counts := map[string]int{}
		for _, match := range latexCommand.FindAllStringSubmatch(text, -1) {
			if len(match) != 2 || latexCommandsExpectedToDrift[match[1]] {
				continue
			}
			name := match[1]
			if alias, ok := latexCommandAliases[name]; ok {
				name = alias
			}
			counts[name]++
		}
		return counts
	}
	sourceCounts, targetCounts := countCommands(source), countCommands(target)
	dropped := []string{}
	for name, count := range sourceCounts {
		if missing := count - targetCounts[name]; missing > 0 {
			dropped = append(dropped, fmt.Sprintf("\\%s×%d", name, missing))
		}
	}
	if len(dropped) == 0 {
		return nil
	}
	sort.Strings(dropped)
	return []Issue{{
		Kind:      "formula_commands_dropped",
		Severity:  severityWarning,
		Message:   "译文可能丢失了原文 LaTeX 命令：" + strings.Join(dropped, "，"),
		Retryable: false,
	}}
}

func reviewNumbers(source, target string) []Issue {
	missing := []string{}
	for _, number := range sourceNumbers(source) {
		if !containsNumber(target, number) {
			missing = append(missing, number)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	preview := missing
	if len(preview) > 3 {
		preview = preview[:3]
	}
	// LeePDF runs semantic numeric QA at document scope, where references,
	// scientific notation, scale words, and OCR noise can be interpreted
	// together. A per-item literal-number mismatch must not trigger a rewrite:
	// that changes the translation path and incorrectly rejects valid Chinese
	// number words or normalized scientific notation.
	return []Issue{{
		Kind:      "number_missing",
		Severity:  severityWarning,
		Message:   "逐段数字检查发现可能缺项；需由全文数值 QA 结合引用和科学计数法复核：" + strings.Join(preview, "、"),
		Retryable: false,
	}}
}

func reviewEnglish(source, target string) []Issue {
	han := len(hanCharRE.FindAllStringIndex(target, -1))
	targetWords := englishWordCount(target)
	if han == 0 && looksLikeEnglishProse(target) && targetWords >= 12 && englishWordCount(source) >= 8 {
		if looksLikeReferenceEntry(source) {
			return nil
		}
		return []Issue{{
			Kind:      "english_residue",
			Severity:  severityError,
			Message:   "译文仍然是整段英文，没有翻译成中文",
			Retryable: true,
		}}
	}
	if han > 0 {
		if span, ok := longCopiedResidue(source, target); ok {
			return []Issue{{
				Kind:      "mixed_english_residue",
				Severity:  severityError,
				Message:   "译文中仍夹着未翻译的整段英文：" + preview(span, 60),
				Retryable: true,
			}}
		}
		if targetWords >= maxInt(14, han/2) {
			return []Issue{{
				Kind:      "english_residue_warning",
				Severity:  severityWarning,
				Message:   "译文里仍有较多英文；若是保留方法名/缩写可忽略，否则建议检查是否漏译",
				Retryable: false,
			}}
		}
	}
	return nil
}

func reviewTruncation(source, target string) []Issue {
	sourceRunes := utf8.RuneCountInString(strings.TrimSpace(source))
	targetRunes := utf8.RuneCountInString(strings.TrimSpace(target))
	if sourceRunes < 200 || targetRunes == 0 {
		return nil
	}
	if float64(targetRunes) >= float64(sourceRunes)*0.15 {
		return nil
	}
	return []Issue{{
		Kind:      "truncated_translation",
		Severity:  severityError,
		Message:   "译文长度不足原文的 15%，疑似被截断或只翻了一部分",
		Retryable: true,
	}}
}

func reviewGlossary(source, target string, terms []Term) []Issue {
	issues := []Issue{}
	folded := strings.ToLower(target)
	for _, term := range MatchTerms(source, terms) {
		expected := term.Target
		if term.Level == "preserve" {
			expected = term.Source
		}
		if expected != "" && strings.Contains(folded, strings.ToLower(expected)) {
			continue
		}
		issues = append(issues, Issue{
			Kind: "glossary_term_missing", Severity: severityWarning,
			Message:   "匹配到的术语表词条没有体现在译文中：" + term.Source,
			Retryable: false,
		})
	}
	return issues
}

var (
	contextEnglishLabel = regexp.MustCompile(`(?i)\b(scheme|figures?|fig\.?|tables?|equations?|eq\.?|sections?|chapters?)\s*\.?\s*(\d{1,3}[a-z]?)`)
	contextChineseLabel = regexp.MustCompile(`(图|表|方案|公式|方程|章节)\s*(\d{1,3}[a-z]?)`)
	contextProperNoun   = regexp.MustCompile(`\b[A-Z][A-Za-z\-]{4,}\b`)
	contextStops        = map[string]bool{
		"about": true, "after": true, "before": true, "between": true, "during": true,
		"these": true, "those": true, "this": true, "that": true, "with": true, "from": true,
		"into": true, "such": true, "when": true, "where": true, "which": true, "while": true,
		"their": true, "there": true, "here": true, "have": true, "been": true, "would": true,
		"could": true, "should": true, "first": true, "second": true, "other": true, "more": true,
		"most": true, "some": true, "many": true, "each": true, "both": true, "through": true,
		"under": true, "over": true, "because": true, "scheme": true, "schemes": true,
		"figure": true, "figures": true, "table": true, "tables": true, "equation": true,
		"equations": true, "section": true, "sections": true, "chapter": true, "chapters": true,
	}
)

func reviewContextBorrow(item Item, source, target string) []Issue {
	context := strings.TrimSpace(item.ContextBefore + " " + item.ContextAfter)
	if context == "" || strings.TrimSpace(target) == "" {
		return nil
	}
	borrowed := []string{}
	seen := map[string]bool{}
	record := func(value string) {
		key := strings.ToLower(value)
		if !seen[key] && len(borrowed) < 5 {
			seen[key] = true
			borrowed = append(borrowed, value)
		}
	}
	for _, pattern := range []*regexp.Regexp{contextEnglishLabel, contextChineseLabel} {
		for _, match := range pattern.FindAllStringSubmatch(context, -1) {
			if len(match) < 3 || match[2] == "" || containsContextNumber(source, match[2]) {
				continue
			}
			kind, number := contextLabelKind(match[1]), match[2]
			if !contextLabelHintPresent(target, kind, number) {
				continue
			}
			record(kind + " " + number)
		}
	}
	glossarySurfaces := map[string]bool{}
	for _, term := range item.Terms {
		glossarySurfaces[strings.ToLower(strings.TrimSpace(term.Source))] = true
		glossarySurfaces[strings.ToLower(strings.TrimSpace(term.Target))] = true
	}
	sourceFolded, targetFolded := strings.ToLower(source), strings.ToLower(target)
	for _, match := range contextProperNoun.FindAllString(context, -1) {
		folded := strings.ToLower(match)
		if len(match) < 5 || contextStops[folded] || strings.Contains(sourceFolded, folded) || glossarySurfaces[folded] || !strings.Contains(targetFolded, folded) {
			continue
		}
		record(match)
	}
	if len(borrowed) == 0 {
		return nil
	}
	return []Issue{{
		Kind: "context_borrow", Severity: severityWarning,
		Message:   "译文中出现了当前原文没有、可能借自相邻上下文的词：" + strings.Join(borrowed, "、"),
		Retryable: true,
	}}
}

func containsContextNumber(source, number string) bool {
	pattern := regexp.MustCompile(regexp.QuoteMeta(number))
	for _, location := range pattern.FindAllStringIndex(source, -1) {
		leftDigit := location[0] > 0 && source[location[0]-1] >= '0' && source[location[0]-1] <= '9'
		rightDigit := location[1] < len(source) && source[location[1]] >= '0' && source[location[1]] <= '9'
		if !leftDigit && !rightDigit {
			return true
		}
	}
	return false
}

func contextLabelKind(raw string) string {
	switch strings.ToLower(strings.TrimSpace(strings.TrimSuffix(raw, "."))) {
	case "fig", "figure", "figures", "图":
		return "figure"
	case "table", "tables", "表":
		return "table"
	case "equation", "equations", "eq", "公式", "方程":
		return "equation"
	case "section", "sections", "chapter", "chapters", "章节":
		return "section"
	default:
		return "scheme"
	}
}

func contextLabelHintPresent(target, kind, number string) bool {
	if !containsContextNumber(target, number) {
		return false
	}
	folded := strings.ToLower(target)
	hints := map[string][]string{
		"scheme": {"scheme", "方案"}, "figure": {"figure", "fig", "图"},
		"table": {"table", "表"}, "equation": {"equation", "eq", "公式", "方程"},
		"section": {"section", "chapter", "节", "章"},
	}
	for _, hint := range hints[kind] {
		if strings.Contains(folded, strings.ToLower(hint)) {
			return true
		}
	}
	return false
}

func selfCorrectionLeak(source, target string) string {
	if strings.TrimSpace(target) == "" || !hanCharRE.MatchString(target) {
		return ""
	}
	positions := []int{}
	for _, location := range selfCorrectionPhraseRE.FindAllStringIndex(target, -1) {
		match := target[location[0]:location[1]]
		if !selfCorrectionPresentInSource(match, source) {
			positions = append(positions, location[0])
			break
		}
	}
	if location := selfCorrectionChineseRE.FindStringIndex(target); location != nil {
		positions = append(positions, location[0])
	}
	for _, location := range selfCorrectionStartRE.FindAllStringIndex(target, -1) {
		match := target[location[0]:location[1]]
		start := location[1] - len(strings.TrimLeftFunc(match, unicode.IsSpace))
		paragraph := target[start:]
		if end := strings.IndexByte(paragraph, '\n'); end >= 0 {
			paragraph = paragraph[:end]
		}
		if selfCorrectionPresentInSource(strings.TrimSpace(match), source) {
			continue
		}
		if (strings.HasPrefix(paragraph, "等等") || strings.HasPrefix(paragraph, "稍等") || strings.HasPrefix(paragraph, "抱歉")) && !selfCorrectionTranslationRE.MatchString(paragraph) {
			continue
		}
		positions = append(positions, start)
		break
	}
	if len(positions) == 0 {
		return ""
	}
	position := positions[0]
	for _, candidate := range positions[1:] {
		if candidate < position {
			position = candidate
		}
	}
	return firstLine(target[strings.LastIndex(target[:position], "\n")+1:])
}

func selfCorrectionPresentInSource(match, source string) bool {
	trimmed := strings.Trim(match, " \t\r\n—–-,:：!！.，")
	needle := strings.ToLower(strings.Join(strings.Fields(trimmed), " "))
	return needle != "" && strings.Contains(strings.ToLower(strings.Join(strings.Fields(source), " ")), needle)
}

func firstLine(value string) string {
	if index := strings.IndexByte(value, '\n'); index >= 0 {
		value = value[:index]
	}
	runes := []rune(strings.TrimSpace(value))
	if len(runes) > 120 {
		return string(runes[:120])
	}
	return string(runes)
}

func looksLikeProtocolShell(target string) bool {
	return strings.Contains(target, `"translated_text"`) ||
		strings.Contains(target, `"item_id"`) ||
		strings.HasPrefix(target, "```json") ||
		strings.HasPrefix(target, "```JSON")
}

func issueScore(issues []Issue) int {
	score := 0
	for _, issue := range issues {
		if issue.Severity == severityError {
			score += 10
		} else {
			score++
		}
	}
	return score
}

// ---- 文本特征 ----

func englishWordCount(text string) int {
	return len(englishWord.FindAllString(stripTokens(text), -1))
}

func looksLikeEnglishProse(text string) bool {
	cleaned := stripTokens(text)
	if cleaned == "" {
		return false
	}
	lower := strings.ToLower(cleaned)
	if strings.Contains(lower, "http://") || strings.Contains(lower, "https://") || strings.Contains(cleaned, "@") {
		return false
	}
	words := englishWord.FindAllString(cleaned, -1)
	if len(words) < 8 {
		return false
	}
	alpha := 0
	for _, char := range cleaned {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') {
			alpha++
		}
	}
	return alpha >= 30
}

func looksLikeReferenceEntry(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, "doi") || strings.Contains(lower, "et al") || strings.Contains(lower, "http://") || strings.Contains(lower, "https://")
}

func stripTokens(text string) string {
	// 公式命令（\mathrm、\frac 等）不是「残留英文」：先整段抹掉再统计，避免把
	// 正常保留的 $...$ 公式误判成漏译。
	return tokenTagRE.ReplaceAllString(mathSpanRE.ReplaceAllString(text, " "), " ")
}

func dataDense(segment string) bool {
	alpha, digits := 0, 0
	for _, char := range segment {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z':
			alpha++
		case char >= '0' && char <= '9':
			digits++
		}
	}
	if alpha == 0 {
		return true
	}
	return digits >= maxInt(6, alpha*35/100)
}

func longCopiedResidue(source, target string) (string, bool) {
	normalizedSource := normalizeForCompare(source)
	if normalizedSource == "" {
		return "", false
	}
	for _, segment := range residueSplit.Split(stripTokens(target), -1) {
		segment = strings.TrimSpace(segment)
		if segment == "" || dataDense(segment) {
			continue
		}
		if len(englishWord.FindAllString(segment, -1)) < 10 {
			continue
		}
		normalizedSegment := normalizeForCompare(segment)
		if len(normalizedSegment) < 40 {
			continue
		}
		if strings.Contains(normalizedSource, normalizedSegment) {
			return segment, true
		}
	}
	return "", false
}

func normalizeForCompare(text string) string {
	lowered := strings.ToLower(stripTokens(text))
	var builder strings.Builder
	previousSpace := true
	for _, char := range lowered {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') {
			builder.WriteRune(char)
			previousSpace = false
			continue
		}
		if !previousSpace {
			builder.WriteByte(' ')
			previousSpace = true
		}
	}
	return strings.TrimSpace(builder.String())
}

func sourceNumbers(source string) []string {
	cleaned := mathSpanRE.ReplaceAllString(source, " ")
	cleaned = stripTokens(cleaned)
	numbers := []string{}
	seen := map[string]bool{}
	for _, raw := range numberToken.FindAllString(cleaned, -1) {
		normalized := strings.ReplaceAll(raw, ",", "")
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		if integersAreSmall(normalized) {
			continue
		}
		numbers = append(numbers, normalized)
	}
	return numbers
}

// integersAreSmall 放过 0–10 的整数：中文译文常用「十次」「三种」这类写法，
// 强行要求阿拉伯数字会制造大量假阳性。
func integersAreSmall(number string) bool {
	if strings.Contains(number, ".") {
		return false
	}
	value := 0
	for _, char := range number {
		if char < '0' || char > '9' {
			return false
		}
		value = value*10 + int(char-'0')
	}
	return value <= 10
}

func containsNumber(text, number string) bool {
	pattern := regexp.MustCompile(`(?:^|[^0-9.])` + regexp.QuoteMeta(number) + `(?:[^0-9.]|$)`)
	if pattern.MatchString(strings.ReplaceAll(text, ",", "")) {
		return true
	}
	return strings.Contains(text, number)
}

func dollarCount(text string) int {
	count := 0
	for index := 0; index < len(text); index++ {
		if text[index] == '$' && !escapedDollarAt(text, index) {
			count++
		}
	}
	return count
}

func sameMultiset(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := map[string]int{}
	for _, value := range a {
		counts[value]++
	}
	for _, value := range b {
		counts[value]--
		if counts[value] < 0 {
			return false
		}
	}
	return true
}

func sameSequence(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func preview(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit]) + "…"
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
