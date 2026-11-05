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
	"strings"
	"time"

	"cbctv2/server/internal/legacy"
)

type retranslationBackup struct {
	Translations []retranslationCacheEntry `json:"translations"`
}

type retranslationCacheEntry struct {
	Hash      string `json:"hash"`
	Source    string `json:"source"`
	Target    string `json:"target"`
	UpdatedAt string `json:"updatedAt"`
}

// handleRetranslate 重新翻译一篇已在库论文的全文。
//
// 有可复用的识别结果时只重跑翻译阶段（快，不动 OCR）；没有时就**重新识别**再翻译。
// 不能像原先那样让用户「重新导入」：重新导入会丢掉这篇论文的批注、精读笔记与阅读进度，
// 而用户要的只是重新翻译。
//
// 两条路径共用同一套任务机制，响应里的 ocr 字段如实说明走了哪条（reused / rerun）。
func (s *Server) handleRetranslate(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "书库中没有这篇论文")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if doc.Format != "pdf" || !doc.HasPDF {
		writeError(w, http.StatusConflict, "只有已入库的 PDF 可以重新翻译")
		return
	}
	if prior, found := s.loadImportJobForDocument(r.Context(), key); found && prior.Status == "running" {
		writeError(w, http.StatusConflict, "这篇论文已有处理任务正在运行")
		return
	}
	layout, available, err := s.loadLayout(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取已有 OCR 结果失败: "+err.Error())
		return
	}
	normalized := s.reusableOCRDocument(r.Context(), key)
	reuseOCR := available && len(layout.Pages) > 0 && len(normalized) > 0
	if !reuseOCR {
		// 没有可复用的识别结果：改成重新识别。硬前提（模型与 PaddleOCR 令牌）同步查清，
		// 缺什么立刻告诉用户，而不是让任务跑起来才失败。
		if err := s.reidentifyPreflight(); err != nil {
			writeError(w, http.StatusConflict, "这篇论文没有可复用的 OCR 结果，需要重新识别："+err.Error())
			return
		}
	}
	paths := legacy.NewPaths(s.cfg.DataRoot)
	jobID, err := randomLeeJobID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jobKey := "retranslate-" + jobID
	jobRoot := filepath.Join(paths.DataDir(), "retain", "jobs", jobKey)
	for _, dir := range []string{
		filepath.Join(jobRoot, "source"),
		filepath.Join(jobRoot, "ocr", "normalized"),
		filepath.Join(jobRoot, "translated"),
		filepath.Join(jobRoot, "rendered", "typst"),
		filepath.Join(jobRoot, "artifacts"),
		filepath.Join(jobRoot, "logs"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, "创建重新翻译任务目录失败: "+err.Error())
			return
		}
	}
	// 原文用书库目录定位，而不是信 documents.pdf_path 那一列：
	// 旧数据里这列可能为空，但库里的 PDF 是真实存在的（documentHasPDF 也是这么判断的）。
	pdfPath, found := paths.PDFFile(key)
	if !found {
		writeError(w, http.StatusConflict, "书库里找不到这篇论文的 PDF 文件，无法重新翻译")
		return
	}
	pdf, err := os.ReadFile(pdfPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取书库 PDF 失败: "+err.Error())
		return
	}
	sourceName := "source.pdf"
	if base := filepath.Base(doc.Title + ".pdf"); base != ".pdf" && strings.EqualFold(filepath.Ext(base), ".pdf") {
		// 与识别阶段写的文件名保持一致：两边都按「标题.pdf」找原文，避免同一份 PDF 存两份。
		sourceName = base
	}
	if err := os.WriteFile(filepath.Join(jobRoot, "source", sourceName), pdf, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, "复制重新翻译输入 PDF 失败: "+err.Error())
		return
	}
	if reuseOCR {
		if err := os.WriteFile(filepath.Join(jobRoot, "ocr", "normalized", "document.v1.json"), normalized, 0o600); err != nil {
			writeError(w, http.StatusInternalServerError, "复制 Lee OCR 结果失败: "+err.Error())
			return
		}
	}
	backupPath := filepath.Join(jobRoot, "retranslate-backup.json")
	if err := s.backupAndClearTranslations(r.Context(), key, backupPath); err != nil {
		writeError(w, http.StatusInternalServerError, "准备全新翻译缓存失败: "+err.Error())
		return
	}
	previousPDF := filepath.Join(jobRoot, "previous-translated.pdf")
	currentPDF := filepath.Join(paths.LibraryDir(), key+"-translated.pdf")
	if err := os.Rename(currentPDF, previousPDF); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = restoreRetranslateBackup(context.Background(), s, key, backupPath)
		writeError(w, http.StatusInternalServerError, "暂存旧译文 PDF 失败: "+err.Error())
		return
	}
	jobCtx, cancel := s.processingBackground(r.Context(), 24*time.Hour)
	title := doc.Title + "（重新翻译）"
	if !reuseOCR {
		title = doc.Title + "（重新识别并翻译）"
	}
	s.beginImportJob(jobKey, title, len(layout.Pages), cancel)
	s.jobStage(jobKey, "memory", "skipped", "复用书库中已有论文记忆", -1, -1)
	if reuseOCR {
		s.jobStage(jobKey, "ocr", "done", "复用已有 Lee OCR 与段落结构", len(layout.Pages), len(layout.Pages))
		s.jobStage(jobKey, "translate", "running", "正在重新翻译全文（忽略旧译文缓存）", 0, countLeeTranslationUnits(layoutOCRPages(layout)))
		s.linkImportJobDocument(jobKey, key)
		pages := layoutOCRPages(layout)
		go func() {
			defer cancel()
			s.runLeeTranslationInBackground(jobCtx, jobKey, key, sourceName, pages, true)
		}()
		writeJSON(w, http.StatusAccepted, map[string]any{"jobKey": jobKey, "status": "running", "ocr": "reused"})
		return
	}
	s.jobStage(jobKey, "ocr", "running", "没有可复用的 OCR 结果，正在重新识别", 0, -1)
	s.jobStage(jobKey, "translate", "pending", "等待重新识别完成", 0, -1)
	s.linkImportJobDocument(jobKey, key)
	go func() {
		defer cancel()
		metadata := leeMetadataForExistingDocument(doc)
		if _, err := s.runLeePDFImport(jobCtx, jobKey, sourceName, pdf, &metadata, leeImportOptions{SkipMetadataCompletion: true}); err != nil {
			s.abortReidentify(jobCtx, jobKey, key, jobRoot, err)
			return
		}
		if err := s.persistReimportedOCR(jobCtx, key, metadata); err != nil {
			s.abortReidentify(jobCtx, jobKey, key, jobRoot, err)
			return
		}
		s.runLeeTranslationInBackground(jobCtx, jobKey, key, sourceName, metadata.OCRPages, true)
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"jobKey": jobKey, "status": "running", "ocr": "rerun"})
}

// reusableOCRDocument 找出这篇论文上一次识别留下的 document.v1.json。
// 返回空表示没有可复用的识别产物，调用方据此转为重新识别。
func (s *Server) reusableOCRDocument(ctx context.Context, key string) []byte {
	priorJobKey := key
	if prior, found := s.loadImportJobForDocument(ctx, key); found && prior.Key != "" {
		priorJobKey = prior.Key
	}
	// 任务编号会直接拼进路径：拒绝任何带分隔符的值，避免越出 retain/jobs。
	if priorJobKey == "" || filepath.Base(priorJobKey) != priorJobKey {
		return nil
	}
	body, err := os.ReadFile(filepath.Join(
		legacy.NewPaths(s.cfg.DataRoot).DataDir(), "retain", "jobs", priorJobKey, "ocr", "normalized", "document.v1.json"))
	if err != nil {
		return nil
	}
	return body
}

// reidentifyPreflight 是「重新识别」的硬前提，与导入同源但措辞针对重新识别。
func (s *Server) reidentifyPreflight() error {
	config, err := s.aiConfig()
	if err != nil {
		return fmt.Errorf("需要先配置 AI 助手：%w", err)
	}
	if !config.Ready() {
		return errors.New("需要先配置 AI 助手的 API Key（重新识别后要接着重新翻译）")
	}
	if _, err := s.ocrClient(); err != nil {
		return fmt.Errorf("需要先配置 OCR 服务令牌：%w", err)
	}
	return nil
}

// leeMetadataForExistingDocument 用已在库论文的题录当识别结果容器。
func leeMetadataForExistingDocument(doc DocumentSummary) recognizedPaperMetadata {
	metadata := recognizedPaperMetadata{
		Title:           doc.Title,
		TranslatedTitle: doc.TranslatedTitle,
		Authors:         doc.Authors,
		DOI:             doc.DOI,
		Venue:           doc.Venue,
	}
	if doc.Year != nil {
		metadata.Year = *doc.Year
	}
	return metadata
}

// persistReimportedOCR 把重新识别出的逐页文本与版式写回书库。
//
// 必须是覆盖语义：识别结果本身就变了，若沿用导入路径的 INSERT OR IGNORE，
// 旧文本（或空文本）会继续留着，阅读器依旧没有版式，下一次「重新翻译」还是说没有可复用的 OCR。
func (s *Server) persistReimportedOCR(ctx context.Context, key string, metadata recognizedPaperMetadata) error {
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := nowStamp()
	for _, page := range metadata.Pages {
		sum := sha256.Sum256([]byte(page.Text))
		if _, err := tx.ExecContext(ctx, `INSERT INTO document_pages(document_id,page,text,hash,updated_at) VALUES(?,?,?,?,?)
			ON CONFLICT(document_id,page) DO UPDATE SET text=excluded.text, hash=excluded.hash, updated_at=excluded.updated_at`,
			key, page.Page, page.Text, hex.EncodeToString(sum[:]), stamp); err != nil {
			return err
		}
	}
	if len(metadata.Pages) > 0 {
		// 识别出的页数变少时，多出来的旧页文本必须删掉，否则阅读器里会留下已经不存在的页。
		if _, err := tx.ExecContext(ctx, `DELETE FROM document_pages WHERE document_id=? AND page>?`, key, len(metadata.Pages)); err != nil {
			return err
		}
	}
	if err := saveLayoutTx(ctx, tx, key, metadata.LayoutPages); err != nil {
		return err
	}
	return tx.Commit()
}

// abortReidentify 收尾「重新识别」阶段的失败。
//
// 回滚是必须的：开始前我们清空了翻译缓存、把旧译文 PDF 挪走了，
// 识别失败若不还原，用户会既没有新译文、也没有旧译文。
//
// 失败的阶段要标在真正失败的那一步：识别已经完成、倒在写回或后续步骤时，
// 不能把已经成功的识别标成失败（那会让人以为 OCR 又白跑了一遍）。
func (s *Server) abortReidentify(ctx context.Context, jobKey, documentKey, jobRoot string, cause error) {
	status, message := "failed", cause.Error()
	if ctx.Err() != nil {
		status, message = "cancelled", "已取消"
	}
	stageKey := "ocr"
	if job, ok := s.loadImportJob(context.Background(), jobKey); ok {
		if stage := job.stage("ocr"); stage != nil && (stage.Status == "done" || stage.Status == "skipped") {
			stageKey = "translate"
		}
	}
	s.jobStage(jobKey, stageKey, status, message, -1, -1)
	if err := restoreRetranslateBackup(context.Background(), s, documentKey, filepath.Join(jobRoot, "retranslate-backup.json")); err != nil {
		log.Printf("重新识别失败后恢复翻译缓存出错: %v", err)
	}
	if err := restoreRetranslatePDF(s, documentKey, filepath.Join(jobRoot, "previous-translated.pdf")); err != nil {
		log.Printf("重新识别失败后恢复旧译文 PDF 出错: %v", err)
	}
	s.finishImportJob(jobKey, status, message)
}

func (s *Server) backupAndClearTranslations(ctx context.Context, key, backupPath string) error {
	rows, err := s.handle.QueryContext(ctx, `SELECT para_hash, source, target, updated_at FROM translations WHERE document_id=?`, key)
	if err != nil {
		return err
	}
	backup := retranslationBackup{Translations: []retranslationCacheEntry{}}
	for rows.Next() {
		var item retranslationCacheEntry
		if err := rows.Scan(&item.Hash, &item.Source, &item.Target, &item.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		backup.Translations = append(backup.Translations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	encoded, err := json.Marshal(backup)
	if err != nil {
		return err
	}
	if err := os.WriteFile(backupPath, encoded, 0o600); err != nil {
		return err
	}
	_, err = s.handle.ExecContext(ctx, `DELETE FROM translations WHERE document_id=?`, key)
	return err
}

func restoreRetranslateBackup(ctx context.Context, s *Server, key, path string) error {
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var backup retranslationBackup
	if err := json.Unmarshal(encoded, &backup); err != nil {
		return err
	}
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range backup.Translations {
		if _, err := tx.ExecContext(ctx, `INSERT INTO translations(document_id,para_hash,source,target,updated_at) VALUES(?,?,?,?,?)
			ON CONFLICT(document_id,para_hash) DO UPDATE SET source=excluded.source,target=excluded.target,updated_at=excluded.updated_at`,
			key, item.Hash, item.Source, item.Target, item.UpdatedAt); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return os.Remove(path)
}

func restoreRetranslatePDF(s *Server, key, previousPath string) error {
	if _, err := os.Stat(previousPath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	target := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+"-translated.pdf")
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove partial translated PDF: %w", err)
	}
	return os.Rename(previousPath, target)
}
