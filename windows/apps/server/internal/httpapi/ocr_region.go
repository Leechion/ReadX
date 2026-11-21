package httpapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
)

const maxRegionImageBytes = 4 << 20

var pngMagicHeader = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

type ocrRegionRequest struct {
	ImageBase64 string `json:"imageBase64"`
	Target      string `json:"target,omitempty"` // "auto" | "formula" | "table"
}

type ocrRegionResult struct {
	DetectedKind string `json:"detectedKind"`
	Latex        string `json:"latex"`
	Markdown     string `json:"markdown"`
}

func (s *Server) handleOCRRegion(w http.ResponseWriter, r *http.Request) {
	var body ocrRegionRequest
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "截图识别请求无效或图片过大（上限 4 MiB）")
		return
	}
	target := strings.ToLower(strings.TrimSpace(body.Target))
	if target == "" {
		target = "auto"
	}
	if target != "auto" && target != "formula" && target != "table" {
		writeError(w, http.StatusBadRequest, "target 只能是 auto / formula / table")
		return
	}

	rawB64 := strings.TrimSpace(body.ImageBase64)
	if idx := strings.Index(rawB64, "base64,"); idx >= 0 {
		rawB64 = rawB64[idx+len("base64,"):]
	}
	pngBytes, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil || len(pngBytes) < 16 || len(pngBytes) > maxRegionImageBytes || !bytes.HasPrefix(pngBytes, pngMagicHeader) {
		writeError(w, http.StatusBadRequest, "请提供有效的 PNG 截图数据（不超过 4 MiB）")
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

	system := "你是学术论文公式与表格识别引擎。请严格按图片中的真实内容转写为可编译的 LaTeX 与 Markdown，不要补写图片里没有的符号或数字。" +
		"只返回单个 JSON 对象：{\"detectedKind\":\"formula|table|text\",\"latex\":\"...\",\"markdown\":\"...\"}，不要输出 Markdown 代码围栏或额外说明。"
	prompt := "识别这张论文局部截图：\n"
	switch target {
	case "formula":
		prompt += "这是数学公式区域。请在 latex 字段给出干净的数学公式（如 $$...$$ 或多行 align 环境），在 markdown 字段给出对应 $$/$$ 表达式。"
	case "table":
		prompt += "这是论文表格区域。请在 latex 字段给出完整可编译的 LaTeX table/tabular（优先 booktabs 三线表），在 markdown 字段给出等价的 Markdown 表格。"
	default:
		prompt += "自动判断属于公式、表格还是文本段落：若为公式则在 latex/markdown 均输出 LaTeX 公式；若为表格则在 latex 输出 tabular/booktabs、markdown 输出 Markdown 表格；若为文字则保留行内公式。"
	}

	raw, err := ai.NewClient(config).GenerateWithImage(r.Context(), system, prompt, pngBytes, 0.1, 2*time.Minute)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	parsed := parseOCRRegionJSON(raw, target)
	writeJSON(w, http.StatusOK, parsed)
}

func parseOCRRegionJSON(raw, fallbackTarget string) ocrRegionResult {
	trimmed := strings.TrimSpace(raw)
	if start := strings.IndexByte(trimmed, '{'); start >= 0 {
		if end := strings.LastIndexByte(trimmed, '}'); end > start {
			var decoded ocrRegionResult
			if json.Unmarshal([]byte(trimmed[start:end+1]), &decoded) == nil {
				if decoded.DetectedKind == "" {
					decoded.DetectedKind = fallbackTarget
				}
				return decoded
			}
		}
	}
	return ocrRegionResult{
		DetectedKind: fallbackTarget,
		Latex:        trimmed,
		Markdown:     trimmed,
	}
}
