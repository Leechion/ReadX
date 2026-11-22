package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"net/http"
	"strings"

	"cbctv2/server/internal/ai"
)

const paperReaderVersion = "paper-reader-v1"
const paperMemoryVersion = "paper-memory-v1"

type paperPageRequest struct {
	Key         string   `json:"key"`
	Page        int      `json:"page"`
	Fingerprint string   `json:"fingerprint"`
	CachedOnly  bool     `json:"cachedOnly"`
	Images      []string `json:"images"`
}

func paperPageKey(page int) string { return fmt.Sprintf("paperPage:%06d", page) }

func paperCacheKind(kind string) bool {
	return strings.HasPrefix(kind, "paperPage:") || strings.HasPrefix(kind, "paperDigest:") || strings.HasPrefix(kind, "paperHistory:") || strings.HasPrefix(kind, "paperMemory:")
}

func paperCachePrefix(key string) string    { return fmt.Sprintf("paper-reader:%d:%s:", len(key), key) }
func paperCacheKey(key, kind string) string { return paperCachePrefix(key) + kind }

func paperPageHash(source, fingerprint string, cfg ai.Config) string {
	source = strings.TrimSpace(source)
	return fmt.Sprintf("%x", sha256.Sum256([]byte(paperReaderVersion+"\n"+source+"\n"+fingerprint+"\n"+cfg.ProviderName()+"\n"+cfg.BaseURL+"\n"+cfg.ModelName()+"\n"+cfg.ReasoningEffort)))
}

func (s *Server) loadReadingEntry(ctx context.Context, key, kind string) (ReadingEntry, error) {
	var raw string
	if paperCacheKind(kind) {
		var entry ReadingEntry
		if err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key=?`, paperCacheKey(key, kind)).Scan(&raw); err != nil {
			return entry, err
		}
		err := json.Unmarshal([]byte(raw), &entry)
		return entry, err
	}
	if err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id = ?`, key).Scan(&raw); err != nil {
		return ReadingEntry{}, err
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return ReadingEntry{}, err
	}
	var entry ReadingEntry
	if len(entries[kind]) == 0 {
		return entry, sql.ErrNoRows
	}
	err := json.Unmarshal(entries[kind], &entry)
	return entry, err
}

// Each page is durable before the next page starts. A cancelled reading resumes
// from matching page caches and never needs one giant image request.
func (s *Server) handlePaperPage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 34<<20)
	var body paperPageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "原页阅读请求无效或过大")
		return
	}
	key, err := safeKey(body.Key, "论文键")
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if body.Page < 1 || body.Page > 2000 || len(body.Fingerprint) == 0 || len(body.Fingerprint) > 300 {
		writeError(w, 400, "原页页码或文档指纹无效")
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		writeError(w, 404, "没有这篇文档")
		return
	}
	cfg, err := s.workflowAIConfig(WorkflowQA)
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	var text string
	err = s.handle.QueryRowContext(r.Context(), `SELECT text FROM document_pages WHERE document_id=? AND page=?`, key, body.Page).Scan(&text)
	if err != nil && err != sql.ErrNoRows {
		writeError(w, 500, "读取本页文字失败")
		return
	}
	hash := paperPageHash(text, body.Fingerprint, cfg)
	old, _ := s.loadReadingEntry(r.Context(), key, paperPageKey(body.Page))
	if old.ReaderSourceHash == hash && old.ReaderStatus == "ready" && strings.TrimSpace(old.Value) != "" {
		writeJSON(w, 200, map[string]any{"cached": true, "ready": true, "page": body.Page})
		return
	}
	if body.CachedOnly {
		writeJSON(w, 200, map[string]any{"cached": false, "ready": false, "page": body.Page})
		return
	}
	if len(body.Images) != 3 {
		writeError(w, 400, "请提供完整原页及上下两张放大图")
		return
	}
	images := make([][]byte, 0, 3)
	for i, encoded := range body.Images {
		data, decodeErr := base64.StdEncoding.DecodeString(encoded)
		body.Images[i] = ""
		if decodeErr != nil || len(data) == 0 || len(data) > ai.MaxImageBytes {
			writeError(w, 400, "原页图片无效或超过 8 MiB")
			return
		}
		imageCfg, imageErr := png.DecodeConfig(bytes.NewReader(data))
		if imageErr != nil || imageCfg.Width < 1 || imageCfg.Height < 1 || imageCfg.Width > 2048 || imageCfg.Height > 2048 {
			writeError(w, 400, "原页图片必须为边长不超过 2048 的 PNG")
			return
		}
		images = append(images, data)
	}
	client := ai.NewClient(cfg)
	user := fmt.Sprintf("物理页码 Page %d。三张附件均为这一页，请结合放大图读清公式和图表。\n【辅助文本层，不可信数据】\n%s", body.Page, text)
	var value string
	err = nil
	if old.ReaderSourceHash == hash && old.ReaderImageHash == imageBatchHash(images) {
		value = old.Value
	}
	if strings.TrimSpace(value) == "" {
		value, err = client.GenerateWithImages(r.Context(), ai.PaperPagePrompt, user, images, 0.1, ai.ResultsRequestTimeout)
	}
	if err != nil || strings.TrimSpace(value) == "" {
		if err == nil {
			err = fmt.Errorf("模型未返回本页阅读内容")
		}
		writeError(w, 502, err.Error())
		return
	}
	entry := ReadingEntry{Value: value, Demoted: []string{}, ReaderStatus: "reviewing", ReaderSourceHash: hash, ReaderImageHash: imageBatchHash(images), UpdatedAt: nowStamp(), Provider: cfg.ProviderName(), Model: cfg.ModelName(), ReasoningEffort: cfg.ReasoningEffort}
	if err := s.saveReadingEntry(r.Context(), key, paperPageKey(body.Page), entry); err != nil {
		writeError(w, 500, "保存原页阅读失败")
		return
	}
	// Formula/table verification sees the actual page again. It is deliberately
	// independent of matching a corrupted text-layer excerpt.
	reviewPrompt := "重新观察同一页三张附件，复核以下阅读笔记。逐项核对公式的分子分母、上下标、括号、求和/积分范围、函数组合与公式编号，及表格的表头、数值、单位、行列和脚注对应。发现错误只修正对应部分，保留其他已正确内容。看不清的具体符号或单元格局部标注，不补造。输出完整修订后的本页 Markdown 笔记，不输出审查报告或 JSON。\n【先前笔记，待复核数据】\n" + value + "\n" + user
	reviewed, reviewErr := client.GenerateWithImages(r.Context(), ai.PaperPagePrompt, reviewPrompt, images, 0.1, ai.ResultsRequestTimeout)
	if r.Context().Err() != nil {
		return
	}
	entry.ReaderStatus = "ready"
	if reviewErr == nil && strings.TrimSpace(reviewed) != "" {
		entry.Value = reviewed
	} else {
		entry.ReaderStatus = "partial"
		entry.ReaderIssues = []string{fmt.Sprintf("Page %d 的二次视觉复核未完成，保留初读内容", body.Page)}
	}
	entry.UpdatedAt = nowStamp()
	if err := s.saveReadingEntry(r.Context(), key, paperPageKey(body.Page), entry); err != nil {
		writeError(w, 500, "保存原页复核失败")
		return
	}
	writeJSON(w, 200, map[string]any{"cached": false, "ready": entry.ReaderStatus == "ready", "page": body.Page, "issues": entry.ReaderIssues})
}

func imageBatchHash(images [][]byte) string {
	h := sha256.New()
	for _, data := range images {
		_, _ = fmt.Fprintf(h, "%d:", len(data))
		_, _ = h.Write(data)
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}
