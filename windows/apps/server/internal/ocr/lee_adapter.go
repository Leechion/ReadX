package ocr

import (
	"bytes"
	"cbctv2/server/internal/proctree"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// The OCR normalizer is the upstream LeePDF document.v1 implementation.
// Its source and MIT license are embedded so the desktop app does not depend on
// the user's tmp/retain-pdf checkout.
//
// Go embed ignores underscore-prefixed files reached through directory patterns.
// Lee's Python packages depend on these package initializers, so list each
// one explicitly in the embedded FS.
//
//go:embed retain_runtime
//go:embed retain_runtime/retainpdf_base/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/ocr/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/ocr/document_schema/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/ocr/document_schema/provider_adapters/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/ocr/document_schema/provider_adapters/common/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/ocr/document_schema/provider_adapters/mineru/__init__.py
//go:embed retain_runtime/retainpdf_pipeline/ocr/document_schema/provider_adapters/paddle/__init__.py
var leeRuntime embed.FS

var (
	leeRuntimeOnce sync.Once
	leeRuntimePath string
	leeRuntimeErr  error
)

type leePageSize struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type leeNormalizationRequest struct {
	Provider             string            `json:"provider"`
	LayoutParsingResults []json.RawMessage `json:"layoutParsingResults"`
	PageSizes            []leePageSize     `json:"pageSizes"`
	DocumentID           string            `json:"documentId"`
	ProviderVersion      string            `json:"providerVersion"`
}

type leeNormalizationResult struct {
	Document leeDocument    `json:"document"`
	Report   map[string]any `json:"report"`
}

type leeDocument struct {
	Pages []leePage `json:"pages"`
}

// ProjectNormalizedDocument converts LeePDF's canonical document.v1 output
// into the OCR page model used by the ReadX reader. OCR and structural
// normalization stay owned by Lee; this projection is only the app boundary.
func ProjectNormalizedDocument(data []byte) ([]Page, error) {
	var document leeDocument
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("解析 LeePDF document.v1 失败: %w", err)
	}
	if len(document.Pages) == 0 {
		return nil, errors.New("LeePDF document.v1 没有页面")
	}
	return projectLeeDocument(document)
}

type leePage struct {
	PageIndex int            `json:"page_index"`
	Width     float64        `json:"width"`
	Height    float64        `json:"height"`
	Metadata  map[string]any `json:"metadata"`
	Blocks    []leeBlock     `json:"blocks"`
}

type leeBlock struct {
	ID               string         `json:"block_id"`
	PageIndex        int            `json:"page_index"`
	Order            int            `json:"order"`
	Type             string         `json:"type"`
	SubType          string         `json:"sub_type"`
	BBox             []float64      `json:"bbox"`
	Text             string         `json:"text"`
	Lines            []leeLine      `json:"lines"`
	Segments         []leeSegment   `json:"segments"`
	LayoutRole       string         `json:"layout_role"`
	SemanticRole     string         `json:"semantic_role"`
	StructureRole    string         `json:"structure_role"`
	Metadata         map[string]any `json:"metadata"`
	Source           map[string]any `json:"source"`
	Policy           map[string]any `json:"policy"`
	Content          map[string]any `json:"content"`
	ContinuationHint map[string]any `json:"continuation_hint"`
}

type leeLine struct {
	BBox      []float64    `json:"bbox"`
	Precision string       `json:"bbox_precision"`
	Spans     []leeSegment `json:"spans"`
}

type leeSegment struct {
	Type      string    `json:"type"`
	RawType   string    `json:"raw_type"`
	Text      string    `json:"text"`
	BBox      []float64 `json:"bbox"`
	Precision string    `json:"bbox_precision"`
	Score     *float64  `json:"score"`
}

func normalizeWithLee(ctx context.Context, raw []json.RawMessage, sizes []Size) (leeDocument, error) {
	return normalizeWithLeeProvider(ctx, raw, sizes, "paddle", DefaultModel)
}

func normalizeWithLeeProvider(ctx context.Context, raw []json.RawMessage, sizes []Size, provider, model string) (leeDocument, error) {
	if len(raw) == 0 {
		return leeDocument{}, errors.New("LeePDF OCR 归一化没有收到页面")
	}
	root, err := materializeLeeRuntime()
	if err != nil {
		return leeDocument{}, fmt.Errorf("准备 LeePDF OCR 归一化资源失败: %w", err)
	}
	python, prefixArgs, err := leePythonCommand()
	if err != nil {
		return leeDocument{}, err
	}
	pageSizes := make([]leePageSize, len(sizes))
	for index, size := range sizes {
		pageSizes[index] = leePageSize{Width: size.Width, Height: size.Height}
	}
	request := leeNormalizationRequest{
		Provider:             provider,
		LayoutParsingResults: raw,
		PageSizes:            pageSizes,
		DocumentID:           "readx-" + provider + "-ocr",
		ProviderVersion:      model,
	}
	input, err := json.Marshal(request)
	if err != nil {
		return leeDocument{}, fmt.Errorf("准备 LeePDF OCR 输入失败: %w", err)
	}
	script := filepath.Join(root, "normalize.py")
	args := append(prefixArgs, script)
	cmd := exec.CommandContext(ctx, python, args...)
	proctree.Configure(cmd)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(input)
	output, err := cmd.Output()
	if err != nil {
		detail := ""
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			detail = strings.TrimSpace(string(exitErr.Stderr))
		}
		if detail == "" {
			detail = err.Error()
		}
		return leeDocument{}, fmt.Errorf("LeePDF OCR 归一化失败: %s", detail)
	}
	var result leeNormalizationResult
	if err := json.Unmarshal(output, &result); err != nil {
		return leeDocument{}, fmt.Errorf("LeePDF OCR 归一化结果不是合法 JSON: %w", err)
	}
	if len(result.Document.Pages) != len(raw) {
		return leeDocument{}, fmt.Errorf("LeePDF document.v1 返回 %d 页，OCR 返回 %d 页", len(result.Document.Pages), len(raw))
	}
	return result.Document, nil
}

func leePythonCommand() (string, []string, error) {
	if configured := strings.TrimSpace(os.Getenv("READX_PYTHON")); configured != "" {
		path, err := exec.LookPath(configured)
		if err != nil {
			return "", nil, fmt.Errorf("READX_PYTHON 指定的解释器不可用: %w", err)
		}
		return path, nil, nil
	}
	for _, candidate := range []string{"python", "python3"} {
		if path, err := exec.LookPath(candidate); err == nil {
			return path, nil, nil
		}
	}
	if path, err := exec.LookPath("py"); err == nil {
		return path, []string{"-3.11"}, nil
	}
	return "", nil, errors.New("运行 LeePDF OCR 归一化需要 Python 3.11 或更高版本；请安装 Python，或设置 READX_PYTHON 指向 python.exe")
}

func materializeLeeRuntime() (string, error) {
	leeRuntimeOnce.Do(func() {
		root := filepath.Join(os.TempDir(), "readx-retainpdf-document-v1-4.2.6")
		if err := os.MkdirAll(root, 0o700); err != nil {
			leeRuntimeErr = err
			return
		}
		leeRuntimeErr = fs.WalkDir(leeRuntime, "retain_runtime", func(name string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			relative := strings.TrimPrefix(name, "retain_runtime")
			relative = strings.TrimLeft(relative, "/\\")
			if relative == "" {
				return nil
			}
			destination := filepath.Join(root, filepath.FromSlash(filepath.ToSlash(relative)))
			if entry.IsDir() {
				return os.MkdirAll(destination, 0o700)
			}
			contents, err := leeRuntime.ReadFile(name)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
				return err
			}
			return os.WriteFile(destination, contents, 0o600)
		})
		if leeRuntimeErr == nil {
			leeRuntimePath = root
		}
	})
	return leeRuntimePath, leeRuntimeErr
}

func projectLeeDocument(document leeDocument) ([]Page, error) {
	pages := make([]Page, 0, len(document.Pages))
	for pageIndex, sourcePage := range document.Pages {
		if sourcePage.Width <= 0 || sourcePage.Height <= 0 {
			return nil, fmt.Errorf("LeePDF document.v1 第 %d 页缺少有效尺寸", pageIndex+1)
		}
		page := Page{
			Index:            sourcePage.PageIndex,
			Width:            sourcePage.Width,
			Height:           sourcePage.Height,
			ColumnLayoutMode: anyString(sourcePage.Metadata["column_layout_mode"]),
			ColumnSplitX:     anyFloat(sourcePage.Metadata["column_split_x"]),
		}
		for blockIndex, sourceBlock := range sourcePage.Blocks {
			box, ok := boxFromSlice(sourceBlock.BBox)
			if !ok || box[2] <= box[0] || box[3] <= box[1] {
				continue
			}
			label := anyString(sourceBlock.Source["raw_type"])
			kind := leeBlockKind(sourceBlock.Type, sourceBlock.SubType, label)
			block := Block{
				ID:                        sourceBlock.ID,
				SourceOrder:               sourceBlock.Order,
				HasSourceOrder:            true,
				ProviderBlockID:           anyString(sourceBlock.Source["raw_block_id"]),
				RawGroupID:                anyString(sourceBlock.Metadata["raw_group_id"]),
				RawGlobalGroupID:          anyString(sourceBlock.Metadata["raw_global_group_id"]),
				Label:                     label,
				Kind:                      kind,
				Text:                      strings.TrimSpace(sourceBlock.Text),
				Box:                       box,
				Translatable:              anyBool(sourceBlock.Policy["translate"]),
				LayoutRole:                sourceBlock.LayoutRole,
				SemanticRole:              sourceBlock.SemanticRole,
				StructureRole:             sourceBlock.StructureRole,
				PolicyReason:              anyString(sourceBlock.Policy["translate_reason"]),
				Segments:                  projectLeeSegments(sourceBlock.Segments),
				Lines:                     projectLeeLines(sourceBlock.Lines),
				LineTexts:                 leeLineTexts(sourceBlock),
				ColumnLayoutMode:          firstNonEmpty(anyString(sourceBlock.Metadata["column_layout_mode"]), page.ColumnLayoutMode),
				ColumnIndexGuess:          anyString(sourceBlock.Metadata["column_index_guess"]),
				CrossColumnMergeSuspected: anyBool(sourceBlock.Metadata["cross_column_merge_suspected"]),
				ReadingOrderUnreliable:    anyBool(sourceBlock.Metadata["reading_order_unreliable"]),
				StructureUnreliable:       anyBool(sourceBlock.Metadata["structure_unreliable"]),
				TextMissingButBBoxPresent: anyBool(sourceBlock.Metadata["text_missing_but_bbox_present"]),
				PeerBlockAbsorbedText:     anyBool(sourceBlock.Metadata["peer_block_absorbed_text"]),
				SuspectedPeerBlockID:      anyString(sourceBlock.Metadata["body_repair_peer_block_id"]),
				ContinuationGroup:         anyString(sourceBlock.ContinuationHint["group_id"]),
				ProviderContinuationRole:  anyString(sourceBlock.ContinuationHint["role"]),
				ProviderContinuationScope: anyString(sourceBlock.ContinuationHint["scope"]),
				ProviderContinuationOrder: anyInt(sourceBlock.ContinuationHint["reading_order"]),
				ProviderContinuationScore: anyFloat(sourceBlock.ContinuationHint["confidence"]),
				LeeMetadata:               sourceBlock.Metadata,
				LeeContent:                sourceBlock.Content,
			}
			block.RawBlockOrder, block.HasRawBlockOrder = anyIntOK(sourceBlock.Metadata["raw_block_order"])
			if block.ID == "" {
				block.ID = fmt.Sprintf("p%03d-b%04d", pageIndex+1, blockIndex)
			}
			page.Blocks = append(page.Blocks, block)
		}
		pages = append(pages, page)
	}
	return pages, nil
}

func leeBlockKind(blockType, subType, rawLabel string) string {
	subType = strings.ToLower(strings.TrimSpace(subType))
	switch subType {
	case "body", "heading", "title", "abstract", "figure_caption", "table_caption", "reference_entry", "formula_number", "footnote", "metadata", "image_footnote", "table_footnote":
		if subType == "image_footnote" || subType == "table_footnote" {
			return "vision_footnote"
		}
		return subType
	case "table_of_contents":
		return "toc"
	}
	if kind := KindForLabel(rawLabel); kind != "" {
		return kind
	}
	switch strings.ToLower(strings.TrimSpace(blockType)) {
	case "text":
		return "body"
	case "formula", "table", "image", "code":
		return strings.ToLower(strings.TrimSpace(blockType))
	default:
		return ""
	}
}

func projectLeeSegments(values []leeSegment) []Segment {
	segments := make([]Segment, 0, len(values))
	for _, value := range values {
		box, _ := boxFromSlice(value.BBox)
		segments = append(segments, Segment{
			Type: value.Type, RawType: value.RawType, Text: value.Text,
			Box: box, BoxPrecision: value.Precision, Score: value.Score,
		})
	}
	return segments
}

func projectLeeLines(values []leeLine) []Line {
	lines := make([]Line, 0, len(values))
	for _, value := range values {
		box, ok := boxFromSlice(value.BBox)
		if !ok {
			continue
		}
		lines = append(lines, Line{Box: box, Precision: value.Precision, Spans: projectLeeSegments(value.Spans)})
	}
	return lines
}

func leeLineTexts(block leeBlock) []string {
	if values, ok := block.Content["line_texts"].([]any); ok {
		texts := make([]string, 0, len(values))
		for _, value := range values {
			if text := strings.TrimSpace(anyString(value)); text != "" {
				texts = append(texts, text)
			}
		}
		if len(texts) > 0 {
			return texts
		}
	}
	texts := make([]string, 0, len(block.Lines))
	for _, line := range block.Lines {
		var parts []string
		for _, span := range line.Spans {
			if span.Text != "" {
				parts = append(parts, span.Text)
			}
		}
		if text := strings.TrimSpace(strings.Join(parts, "")); text != "" {
			texts = append(texts, text)
		}
	}
	return texts
}

func boxFromSlice(values []float64) ([4]float64, bool) {
	if len(values) != 4 {
		return [4]float64{}, false
	}
	return [4]float64{values[0], values[1], values[2], values[3]}, true
}

func anyString(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func anyBool(value any) bool {
	result, _ := value.(bool)
	return result
}

func anyFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	case string:
		parsed, _ := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed
	default:
		return 0
	}
}

func anyInt(value any) int {
	result, _ := anyIntOK(value)
	return result
}

func anyIntOK(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case float64:
		return int(typed), typed == float64(int(typed))
	case json.Number:
		parsed, err := typed.Int64()
		return int(parsed), err == nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
