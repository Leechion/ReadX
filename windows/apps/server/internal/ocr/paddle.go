// Package ocr 接入 LeePDF 使用的 PaddleOCR 文档解析服务，把扫描版 PDF 变成
// 「页 + 文本块 + 坐标」，供排版渲染使用。
//
// 这不是本地 OCR 模型：LeePDF 的 Paddle/MinerU 两条路也都是远程服务。ReadX 只
// 内置同一套调用与结果映射，用户需要提供 PaddleOCR 的访问令牌。
package ocr

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultBaseURL 是 PaddleOCR 的官方服务地址（与 LeePDF 默认一致）。
	DefaultBaseURL = "https://paddleocr.aistudio-app.com"
	// DefaultModel 是 LeePDF 默认的文档解析模型。
	DefaultModel = "PaddleOCR-VL-1.6"
	// MaxPDFBytes / MaxPDFPages 跟随 PaddleOCR 本地文件上传规格。
	MaxPDFBytes = 50 << 20
	MaxPDFPages = 1000

	submitPath = "/api/v2/ocr/jobs"
	pollEvery  = 3 * time.Second
)

var (
	latexFormulaRE    = regexp.MustCompile(`(\\[A-Za-z]+|[A-Za-z])(\s*(_\s*\{[^{}]*\}|\^\s*\{[^{}]*\}|_\s*[A-Za-z0-9]|\^\s*[A-Za-z0-9]|\{[^{}]*\}|\([^()]*\)|\[[^\[\]]*\]|[=+−*/<>.,-]|[A-Za-z0-9]|\\[A-Za-z]+))+`)
	greekRunRE        = regexp.MustCompile(`(\\[A-Za-z]+|[α-ωΑ-Ωωγβμφαζη∂])(\s*(_\s*\{[^{}]*\}|\^\s*\{[^{}]*\}|[A-Za-z0-9]|\\[A-Za-z]+))*`)
	proseWordRE       = regexp.MustCompile(`[A-Za-z]{3,}`)
	commandRE         = regexp.MustCompile(`\\[A-Za-z]+`)
	stripDisplayRE    = regexp.MustCompile(`\\(mathrm|mathit|mathbf|mathcal|text)\s*\{\s*([^{}]+?)\s*\}`)
	greekPairRE       = regexp.MustCompile(`(?i)^(\\alpha|α)\s*(\{\s*,\s*\}|,)\s*(\\beta|β)(\s*-\s*[A-Za-z]+)?$`)
	standaloneGreekRE = regexp.MustCompile(`^(\\[A-Za-z]+|[α-ωΑ-Ωωγβμφαζη∂])$`)
	shortBondRE       = regexp.MustCompile(`^[A-Za-z]{1,3}-[A-Za-z]{1,3}$`)
	citationListRE    = regexp.MustCompile(`^(\d+\s*[A-Za-z]|[A-Za-z])(\s*,\s*(\d+\s*[A-Za-z]|[A-Za-z])){2,}$`)
)

// Size 是 PDF 页面的实际尺寸（pt）。
type Size struct {
	Width  float64
	Height float64
}

// Block 是 OCR 结果里的一个块。Kind 是按 LeePDF 的 document.v1 词汇归一后的
// 块类型（body/heading/title/caption/…）；Translatable 为 false 的块（公式、表格、
// 图片、页眉页脚、参考文献）保持原样，不覆盖、不翻译。
type Block struct {
	ID                        string
	SourceOrder               int
	HasSourceOrder            bool
	ProviderBlockID           string
	RawGroupID                string
	RawGlobalGroupID          string
	RawBlockOrder             int
	HasRawBlockOrder          bool
	Label                     string
	Kind                      string
	Text                      string
	Box                       [4]float64
	Translatable              bool
	LayoutRole                string
	SemanticRole              string
	StructureRole             string
	PolicyReason              string
	Segments                  []Segment
	Lines                     []Line
	LineTexts                 []string
	LayoutMode                string
	LayoutSplitX              float64
	LayoutZone                string
	LayoutZoneRank            int
	LayoutZoneSize            int
	BoundaryRole              string
	ColumnLayoutMode          string
	ColumnIndexGuess          string
	CrossColumnMergeSuspected bool
	ReadingOrderUnreliable    bool
	StructureUnreliable       bool
	TextMissingButBBoxPresent bool
	PeerBlockAbsorbedText     bool
	SuspectedPeerBlockID      string
	ContinuationGroup         string
	ContinuationSignature     string
	ContinuationDecision      string
	ContinuationPrevious      string
	ContinuationNext          string
	ProviderContinuationRole  string
	ProviderContinuationScope string
	ProviderContinuationOrder int
	ProviderContinuationScore float64
	ProviderContinuationSkip  string
	LeeMetadata               map[string]any
	LeeContent                map[string]any
}

// Segment 保留 LeePDF document.v1 的正文/公式片段边界。Paddle 不提供
// glyph 级文本框，因此无明确 inline_formula 匹配时仍使用块级 bbox。
type Segment struct {
	Type         string     `json:"type"`
	RawType      string     `json:"rawType"`
	Text         string     `json:"text"`
	Box          [4]float64 `json:"box"`
	BoxPrecision string     `json:"boxPrecision,omitempty"`
	Score        *float64   `json:"score,omitempty"`
}

// Line mirrors normalized document.v1 line records. When Paddle gives no line
// OCR, a single block-fallback line keeps downstream rendering structure stable.
type Line struct {
	Box       [4]float64 `json:"box"`
	Precision string     `json:"bboxPrecision"`
	Spans     []Segment  `json:"spans"`
}

// Page 是一页 OCR 结果。
type Page struct {
	Index            int
	Width            float64
	Height           float64
	ColumnLayoutMode string
	ColumnSplitX     float64
	Blocks           []Block
}

// Client 是 PaddleOCR 客户端。
type Client struct {
	Provider     string
	BaseURL      string
	Token        string
	Model        string
	HTTP         *http.Client
	PollInterval time.Duration
	// OnState 可选：任务提交与轮询时回调服务端状态（queued/running/done…），
	// 供导入任务面板显示「Paddle 已接收任务，等待排队」这类信息。
	OnState func(state string)
}

func New(baseURL, token, model string) *Client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	if strings.TrimSpace(model) == "" {
		model = DefaultModel
	}
	return &Client{
		Provider:     "paddle",
		BaseURL:      strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		Token:        strings.TrimSpace(token),
		Model:        strings.TrimSpace(model),
		HTTP:         &http.Client{Timeout: 5 * time.Minute},
		PollInterval: pollEvery,
	}
}

// Extract 上传整份 PDF，轮询到完成后再下载 JSONL 结果。
func (c *Client) Extract(ctx context.Context, pdf []byte, filename string, sizes []Size) ([]Page, error) {
	layouts, err := c.Layouts(ctx, pdf, filename)
	if err != nil {
		return nil, err
	}
	return c.MapLayouts(ctx, layouts, sizes)
}

// Layouts 只负责提交、轮询、下载，返回原始的 layoutParsingResults：
// 页面坐标的换算依赖调用方给的 PDF 页尺寸，所以把「取结果」和「换算」分开，
// 便于缓存原始结果、按需换算。
func (c *Client) Layouts(ctx context.Context, pdf []byte, filename string) ([]json.RawMessage, error) {
	if c.Provider == "mineru" {
		return c.mineruLayouts(ctx, pdf, filename)
	}
	if len(pdf) == 0 {
		return nil, errors.New("PDF 为空")
	}
	if len(pdf) > MaxPDFBytes {
		return nil, errors.New("PDF 超过 PaddleOCR 本地上传上限 50 MB")
	}
	jobID, err := c.submit(ctx, pdf, filename)
	if err != nil {
		return nil, err
	}
	jsonURL, err := c.poll(ctx, jobID)
	if err != nil {
		return nil, err
	}
	return c.download(ctx, jsonURL)
}

func (c *Client) submit(ctx context.Context, pdf []byte, filename string) (string, error) {
	if c.Token == "" {
		return "", errors.New("尚未配置 PaddleOCR 令牌")
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("model", c.Model); err != nil {
		return "", err
	}
	payload, _ := json.Marshal(map[string]any{
		"max_num_input_imgs":        999,
		"mergeLayoutBlocks":         false,
		"markdownIgnoreLabels":      []string{"header", "header_image", "footer", "footer_image", "number", "footnote", "aside_text"},
		"useDocOrientationClassify": false,
		"useDocUnwarping":           false,
		"useLayoutDetection":        true,
		"useChartRecognition":       false,
		"useSealRecognition":        true,
		"useOcrForImageBlock":       false,
		"mergeTables":               true,
		"relevelTitles":             true,
		"layoutShapeMode":           "auto",
		"promptLabel":               "ocr",
		"repetitionPenalty":         1,
		"temperature":               0,
		"topP":                      1,
		"minPixels":                 147384,
		"maxPixels":                 2822400,
		"layoutNms":                 true,
		"restructurePages":          true,
		"visualize":                 false,
	})
	if err := writer.WriteField("optionalPayload", string(payload)); err != nil {
		return "", err
	}
	if strings.TrimSpace(filename) == "" {
		filename = "document.pdf"
	}
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(pdf); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+submitPath, &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "bearer "+c.Token)
	response, err := c.HTTP.Do(request)
	if err != nil {
		return "", fmt.Errorf("提交 OCR 任务失败: %w", err)
	}
	defer response.Body.Close()
	decoded, err := decodeEnvelope(response.Body)
	if err != nil {
		return "", err
	}
	if decoded.ErrorCode != 0 {
		return "", fmt.Errorf("提交 OCR 任务失败（%d）：%s", decoded.ErrorCode, decoded.ErrorMsg)
	}
	jobID := strings.TrimSpace(decoded.Data.JobID)
	if jobID == "" {
		return "", errors.New("OCR 服务没有返回 jobId")
	}
	c.notifyState("submitted")
	return jobID, nil
}

func (c *Client) notifyState(state string) {
	if c.OnState != nil {
		c.OnState(state)
	}
}

func (c *Client) poll(ctx context.Context, jobID string) (string, error) {
	var lastErr error
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		response, err := c.get(ctx, c.BaseURL+submitPath+"/"+jobID)
		if err != nil {
			lastErr = err
		} else {
			decoded, decodeErr := decodeEnvelope(response.Body)
			response.Body.Close()
			if decodeErr != nil {
				lastErr = decodeErr
			} else if decoded.ErrorCode != 0 {
				return "", fmt.Errorf("查询 OCR 任务失败（%d）：%s", decoded.ErrorCode, decoded.ErrorMsg)
			} else {
				state := strings.ToLower(strings.TrimSpace(decoded.Data.State))
				c.notifyState(state)
				switch state {
				case "done", "finished", "succeeded", "success":
					url := strings.TrimSpace(decoded.Data.ResultURL.JSONURL)
					if url == "" {
						return "", errors.New("OCR 任务完成但没有结果地址")
					}
					return url, nil
				case "failed", "error", "cancelled", "canceled":
					message := strings.TrimSpace(decoded.Data.ErrorMsg)
					if message == "" {
						message = "未知错误"
					}
					return "", fmt.Errorf("OCR 任务失败：%s", message)
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(c.pollInterval()):
		}
		if lastErr != nil {
			// 单次网络抖动不结束任务，继续轮询；连续失败由上下文超时兜底。
			lastErr = nil
		}
	}
}

func (c *Client) pollInterval() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return pollEvery
}

func (c *Client) download(ctx context.Context, url string) ([]json.RawMessage, error) {
	response, err := c.getResult(ctx, url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("下载 OCR 结果失败（%d）：%s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	layouts := []json.RawMessage{}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var payload struct {
			Result struct {
				LayoutParsingResults []json.RawMessage `json:"layoutParsingResults"`
			} `json:"result"`
		}
		if err := json.Unmarshal([]byte(line), &payload); err != nil {
			continue
		}
		layouts = append(layouts, payload.Result.LayoutParsingResults...)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取 OCR 结果失败: %w", err)
	}
	if len(layouts) == 0 {
		return nil, errors.New("OCR 结果里没有页面")
	}
	return layouts, nil
}

func (c *Client) get(ctx context.Context, url string) (*http.Response, error) {
	return c.getURL(ctx, url, true)
}

// getResult 下载 Paddle 返回的 BOS 结果地址。该地址不需要 Paddle API 令牌；
// 令牌只用于提交和轮询，避免把凭据发送给结果存储服务。
func (c *Client) getResult(ctx context.Context, rawURL string) (*http.Response, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil {
		return nil, errors.New("OCR 结果地址无效")
	}
	return c.getURL(ctx, rawURL, false)
}

func (c *Client) getURL(ctx context.Context, url string, authenticated bool) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if authenticated {
		request.Header.Set("Authorization", "bearer "+c.Token)
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("请求 OCR 服务失败: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return nil, fmt.Errorf("OCR 服务返回 %d：%s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	return response, nil
}

type envelope struct {
	ErrorCode flexInt `json:"errorCode"`
	ErrorMsg  string  `json:"errorMsg"`
	LogID     string  `json:"logId"`
	Data      struct {
		JobID     string `json:"jobId"`
		State     string `json:"state"`
		ErrorMsg  string `json:"errorMsg"`
		ResultURL struct {
			JSONURL string `json:"jsonUrl"`
		} `json:"resultUrl"`
	} `json:"data"`
}

// flexInt 兼容服务端把错误码写成数字或字符串。
type flexInt int

func (value *flexInt) UnmarshalJSON(data []byte) error {
	var number int
	if err := json.Unmarshal(data, &number); err == nil {
		*value = flexInt(number)
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	if strings.TrimSpace(text) == "" {
		*value = 0
		return nil
	}
	parsed, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		return err
	}
	*value = flexInt(parsed)
	return nil
}

func decodeEnvelope(reader io.Reader) (envelope, error) {
	var decoded envelope
	if err := json.NewDecoder(reader).Decode(&decoded); err != nil {
		return envelope{}, fmt.Errorf("OCR 服务返回的不是合法 JSON: %w", err)
	}
	return decoded, nil
}

// MapLayouts 把原始 layoutParsingResults 换算成页/块。sizes 是目标 PDF 页尺寸：
// 缺失（或为 0）的页按 OCR 结果自身的像素尺寸保留。
func MapLayouts(raw []json.RawMessage, sizes []Size) ([]Page, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return MapLayoutsContext(ctx, raw, sizes)
}

// MapLayoutsContext runs LeePDF's document.v1 adapter and Paddle text-
// geometry normalization before projecting the canonical blocks into ReadX.
func MapLayoutsContext(ctx context.Context, raw []json.RawMessage, sizes []Size) ([]Page, error) {
	if len(sizes) > 0 && len(raw) != len(sizes) {
		return nil, fmt.Errorf("OCR 返回 %d 页，原 PDF 有 %d 页，无法可靠对齐页面；请检查 PDF 后重试", len(raw), len(sizes))
	}
	document, err := normalizeWithLee(ctx, raw, sizes)
	if err != nil {
		return nil, err
	}
	return projectLeeDocument(document)
}

func BuildTextSegments(text, rawLabel string) []Segment {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if rawLabel == "display_formula" || rawLabel == "formula" {
		return []Segment{{Type: "formula", RawType: rawLabel, Text: text}}
	}
	if rawLabel == "inline_formula" {
		return []Segment{{Type: "inline_formula", RawType: rawLabel, Text: text}}
	}
	segments := make([]Segment, 0, 3)
	if spans := dollarFormulaSpans(text); len(spans) > 0 {
		segments = segmentsFromFormulaSpans(text, rawLabel, spans, true)
	} else {
		segments = segmentsFromFormulaSpans(text, rawLabel, detectedFormulaSpans(text), false)
	}
	if len(segments) == 0 {
		return []Segment{{Type: "text", RawType: rawLabel, Text: text}}
	}
	return segments
}

type formulaSpan struct{ start, end int }

func dollarFormulaSpans(text string) []formulaSpan {
	spans := []formulaSpan{}
	for cursor := 0; cursor < len(text); {
		start, end := nextDollarFormula(text[cursor:])
		if start < 0 {
			break
		}
		spans = append(spans, formulaSpan{cursor + start, cursor + end})
		cursor += end
	}
	return spans
}

func detectedFormulaSpans(text string) []formulaSpan {
	spans := []formulaSpan{}
	for _, pattern := range []*regexp.Regexp{latexFormulaRE, greekRunRE} {
		for _, match := range pattern.FindAllStringIndex(text, -1) {
			value := strings.TrimSpace(text[match[0]:match[1]])
			if !strings.ContainsAny(value, `\\_^{}αβγμφζη∂`) || skipFormulaCandidate(value) {
				continue
			}
			spans = append(spans, formulaSpan{match[0], match[1]})
		}
	}
	sort.SliceStable(spans, func(i, j int) bool {
		if spans[i].start != spans[j].start {
			return spans[i].start < spans[j].start
		}
		return spans[i].end > spans[j].end
	})
	selected := spans[:0]
	cursor := 0
	for _, span := range spans {
		if span.start < cursor {
			continue
		}
		selected = append(selected, span)
		cursor = span.end
	}
	return selected
}

func segmentsFromFormulaSpans(text, rawLabel string, spans []formulaSpan, dollarDelimited bool) []Segment {
	segments := make([]Segment, 0, len(spans)*2+1)
	cursor := 0
	for _, span := range spans {
		if span.start > cursor {
			appendTextSegment(&segments, text[cursor:span.start], rawLabel)
		}
		formula := strings.TrimSpace(text[span.start:span.end])
		if dollarDelimited {
			if strings.HasPrefix(formula, "$$") && strings.HasSuffix(formula, "$$") && len(formula) >= 4 {
				formula = strings.TrimSpace(formula[2 : len(formula)-2])
			} else if strings.HasPrefix(formula, "$") && strings.HasSuffix(formula, "$") && len(formula) >= 2 {
				formula = strings.TrimSpace(formula[1 : len(formula)-1])
			}
		}
		if formula != "" {
			segments = append(segments, Segment{Type: "inline_formula", RawType: rawLabel, Text: formula})
		}
		cursor = span.end
	}
	if cursor < len(text) {
		appendTextSegment(&segments, text[cursor:], rawLabel)
	}
	return segments
}

func skipFormulaCandidate(value string) bool {
	normalized := stripDisplayRE.ReplaceAllString(value, "$2")
	normalized = strings.NewReplacer("{", "", "}", "").Replace(normalized)
	normalized = strings.Join(strings.Fields(normalized), " ")
	if greekPairRE.MatchString(normalized) || standaloneGreekRE.MatchString(normalized) || shortBondRE.MatchString(strings.ReplaceAll(normalized, " ", "")) || citationListRE.MatchString(normalized) {
		return true
	}
	commandStripped := commandRE.ReplaceAllString(value, " ")
	words := proseWordRE.FindAllString(commandStripped, -1)
	lowercaseWords := 0
	for _, word := range words {
		if strings.ToUpper(word) != word {
			lowercaseWords++
		}
	}
	return len(words) >= 4 && lowercaseWords >= 3
}

func nextDollarFormula(text string) (int, int) {
	for start := 0; start < len(text); start++ {
		if text[start] != '$' || (start > 0 && text[start-1] == '\\') {
			continue
		}
		delimiter := "$"
		if strings.HasPrefix(text[start:], "$$") {
			delimiter = "$$"
		}
		if end := strings.Index(text[start+len(delimiter):], delimiter); end >= 0 {
			return start, start + len(delimiter) + end + len(delimiter)
		}
	}
	return -1, -1
}

func appendTextSegment(segments *[]Segment, text, rawLabel string) {
	text = strings.TrimSpace(text)
	if text != "" {
		*segments = append(*segments, Segment{Type: "text", RawType: rawLabel, Text: text})
	}
}

// KindForLabel 把 Paddle 的原始标签映射成 LeePDF document.v1 的块类型
// （见上游 provider_adapters/paddle/label_catalog.py 与 roles.py）。
//
// 返回空串表示「非文本块」：公式、表格、图片、图表、印章、代码块等。
func KindForLabel(label string) string {
	switch strings.ToLower(strings.TrimSpace(label)) {
	case "text", "vertical_text":
		return "body"
	case "paragraph_title":
		return "heading"
	case "doc_title":
		return "title"
	case "abstract":
		return "abstract"
	case "content":
		return "toc"
	case "figure_title":
		return "figure_caption"
	case "table_title", "table_caption":
		// Paddle 的标签表没有 table_title，但历史响应里出现过；按图注同样处理。
		return "table_caption"
	case "vision_footnote", "table_footnote", "image_footnote":
		return "vision_footnote"
	case "footnote":
		return "footnote"
	case "reference", "reference_content":
		return "reference_entry"
	case "header", "footer", "number", "metadata":
		return "metadata"
	case "formula_number":
		return "formula_number"
	case "display_formula", "inline_formula", "formula":
		return "formula"
	case "table":
		return "table"
	case "image", "figure", "chart", "seal", "header_image", "footer_image":
		return "image"
	case "algorithm":
		return "code"
	default:
		return ""
	}
}

// translatable 复刻上游的翻译策略（provider_adapters/paddle/translation_policy.py）：
// 只翻译正文、标题、摘要、目录、图注/表注和 vision footnote；参考文献、脚注、
// 页眉页脚、页码与所有非文本块一律保留原样。
func translatable(label string) bool {
	switch KindForLabel(label) {
	case "body", "heading", "title", "abstract", "toc",
		"figure_caption", "table_caption", "vision_footnote":
		return true
	default:
		return false
	}
}
