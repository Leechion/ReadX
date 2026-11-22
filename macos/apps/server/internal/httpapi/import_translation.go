package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"cbctv2/server/internal/ocr"
)

type publicationPageHint struct {
	Page     int      `json:"page"`
	Text     string   `json:"text"`
	Segments []string `json:"segments"`
	// Width/Height 是该页的 PDF 尺寸（pt）。前端从 PDF.js 的 viewport（scale=1）读出；
	// 缺失时直接用 OCR 自身的页面尺寸，叠加层会按原页缩放。
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// requireImportProviders 是 PDF 导入的硬前提：本地处理链需要 PaddleOCR 与翻译模型。
// 缺任何一个都直接失败，不再退回文本层分段翻译。
func (s *Server) requireImportProviders() error {
	config, err := s.workflowAIConfig(WorkflowTranslation)
	if err != nil {
		return fmt.Errorf("导入需要先配置 AI 助教：%w", err)
	}
	if !config.Ready() {
		return fmt.Errorf("导入需要先配置 AI 助教的 API Key（识别题录并翻译 OCR 段落）")
	}
	if _, err := s.ocrClient(); err != nil {
		return fmt.Errorf("导入需要配置 OCR 服务令牌：%w", err)
	}
	return nil
}

// prepareImportTranslations 是 PDF 导入唯一的翻译入口：OCR 识别段落 → 逐页翻译 →
// 记录块坐标。文本层分段与旧翻译接口已删除，不再提供任何回退路径。
func (s *Server) prepareImportTranslations(ctx context.Context, data []byte, pages []publicationPageHint, metadata *recognizedPaperMetadata, progress ...func(completed, total, start, end, cached, untranslated int)) error {
	if len(pages) == 0 {
		return fmt.Errorf("导入需要页面数据：请使用最新版客户端")
	}
	config, err := s.loadOCRConfig()
	if err != nil {
		return err
	}
	maxPages := ocr.MaxPDFPages
	if config.Provider == "mineru" {
		maxPages = ocr.MinerUMaxPDFPages
	}
	if len(pages) > maxPages {
		return fmt.Errorf("PDF 超过 %s 单次处理上限 %d 页，请拆分后导入", config.label(), maxPages)
	}
	if err := s.requireImportProviders(); err != nil {
		return err
	}
	sizes, _ := importPageSizes(pages)
	handled, err := s.prepareOCRLayoutTranslations(ctx, data, sizes, metadata, progress...)
	if err != nil {
		return err
	}
	if !handled {
		return fmt.Errorf("OCR 没有返回可翻译的段落")
	}
	return nil
}

func saveImportText(ctx context.Context, tx *sql.Tx, key, stamp string, metadata recognizedPaperMetadata) error {
	for _, page := range metadata.Pages {
		sum := sha256.Sum256([]byte(page.Text))
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO document_pages(document_id,page,text,hash,updated_at) VALUES(?,?,?,?,?)`, key, page.Page, page.Text, hex.EncodeToString(sum[:]), stamp); err != nil {
			return err
		}
	}
	for _, segment := range metadata.Translations {
		if segment.Target == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO translations(document_id,para_hash,source,target,updated_at) VALUES(?,?,?,?,?)`, key, segment.Hash, segment.Source, segment.Target, stamp); err != nil {
			return err
		}
	}
	// 导入时用 OCR 识别出的段落坐标：与文档同事务写入，提交成功后才对阅读器可见。
	if err := saveLayoutTx(ctx, tx, key, metadata.LayoutPages); err != nil {
		return err
	}
	if metadata.TranslationQA != nil {
		encoded, err := json.Marshal(metadata.TranslationQA)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
			ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`, translationQAKey(key), string(encoded), stamp); err != nil {
			return err
		}
	}
	return nil
}
