package httpapi

import (
	"cbctv2/server/internal/proctree"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/render"
)

func (s *Server) runLeeTranslationInBackground(ctx context.Context, jobKey, documentKey, name string, pages []ocr.Page, forceRetranslate bool) {
	jobRoot := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).DataDir(), "retain", "jobs", jobKey)
	backupPath := filepath.Join(jobRoot, "retranslate-backup.json")
	fail := func(err error) {
		status, message := "failed", err.Error()
		if ctx.Err() != nil {
			status, message = "cancelled", "已取消"
		}
		stageKey := "translate"
		if job, ok := s.loadImportJob(context.Background(), jobKey); ok {
			if stage := job.stage("translate"); stage != nil && stage.Status == "done" {
				stageKey = "render"
			}
		}
		s.jobStage(jobKey, stageKey, status, message, -1, -1)
		if forceRetranslate {
			if restoreErr := restoreRetranslateBackup(context.Background(), s, documentKey, backupPath); restoreErr != nil {
				log.Printf("restore prior translations after retranslation failure: %v", restoreErr)
			}
			if restoreErr := restoreRetranslatePDF(s, documentKey, filepath.Join(jobRoot, "previous-translated.pdf")); restoreErr != nil {
				log.Printf("restore prior translated PDF after retranslation failure: %v", restoreErr)
			}
		}
		s.finishImportJob(jobKey, status, message)
	}
	pageRenderDir := filepath.Join(jobRoot, "rendered", "pages")
	if forceRetranslate {
		_ = os.RemoveAll(pageRenderDir)
	}
	if err := os.MkdirAll(pageRenderDir, 0o755); err != nil {
		fail(fmt.Errorf("创建逐页排版目录失败: %w", err))
		return
	}
	renderer := render.New(s.cfg.DataRoot)
	sourcePDF := filepath.Join(jobRoot, "source", filepath.Base(name))
	if !existingFile(sourcePDF) {
		sourcePDF = filepath.Join(jobRoot, "source", "source.pdf")
	}
	sourcePDFBytes, sourceErr := os.ReadFile(sourcePDF)
	if sourceErr != nil {
		fail(fmt.Errorf("读取逐页排版原文失败: %w", sourceErr))
		return
	}
	config, err := s.aiConfig()
	if err != nil || !config.Ready() {
		fail(errors.New("AI 模型配置不可用，原文已入库，可从文库重新翻译"))
		return
	}
	baseURL, apiKey := strings.TrimSpace(config.PublicBaseURL()), config.APIKey
	var bridge *leeAICompatBridge
	if config.IsCLI() || config.ProviderName() == "workbuddy" {
		bridge, err = newLeeAICompatBridge(ai.NewClient(config))
		if err != nil {
			fail(fmt.Errorf("连接 ReadX AI 助手失败: %w", err))
			return
		}
		defer bridge.Close()
		baseURL, apiKey = bridge.BaseURL, bridge.Token
	}
	if baseURL == "" {
		fail(errors.New("AI 助手设置中缺少模型服务地址"))
		return
	}
	sourceJSON := filepath.Join(jobRoot, "ocr", "normalized", "document.v1.json")
	translatedDir := filepath.Join(jobRoot, "translated")
	translationProtocol := "openai"
	if config.ProviderName() == "anthropic" {
		translationProtocol = "anthropic"
	}
	if config.IsCLI() || config.ProviderName() == "workbuddy" {
		translationProtocol = "openai"
	}
	translationSpec := map[string]any{
		"schema_version": "translate.stage.v1", "stage": "translate",
		"job":    map[string]any{"job_id": jobKey, "job_root": jobRoot, "workflow": "readx-library-background"},
		"inputs": map[string]any{"source_json": sourceJSON, "source_pdf": sourcePDF},
		"params": map[string]any{
			"start_page": 0, "end_page": -1, "batch_size": 8, "workers": 4,
			"mode": "sci", "math_mode": "direct_typst", "skip_title_translation": false,
			"classify_batch_size": 12, "rule_profile_name": "general_sci",
			"context_mode": "needed", "glossary_mode": "matched", "memory_mode": "matched",
			"model": config.ModelName(), "base_url": baseURL,
			"provider": config.ProviderName(), "credential_ref": "env:READX_RETAIN_TRANSLATION_API_KEY",
			"api_protocol": translationProtocol, "thinking": config.ReasoningEffort,
		},
	}
	translationSpecPath := filepath.Join(jobRoot, "translate.stage.json")
	if err := writeLeeSpec(translationSpecPath, translationSpec); err != nil {
		fail(err)
		return
	}
	translationUnits := countLeeTranslationUnits(pages)
	s.jobStage(jobKey, "translate", "running", "正在后台逐页翻译；已完成页面会立即显示在阅读器", 0, translationUnits)
	s.jobStage(jobKey, "render", "running", "等待页面译文完成后逐页排版", 0, len(pages))
	renderedPages := map[int]bool{}
	commandDone := make(chan error, 1)
	go func() {
		unitCacheDir := ""
		if forceRetranslate {
			unitCacheDir = filepath.Join(jobRoot, "translation-unit-cache")
		}
		commandDone <- s.runLeeStageCommand(ctx, jobKey, bridge, apiKey, "translate-only", translationSpecPath, unitCacheDir)
	}()
	lastCount := -1
	lastFingerprint := ""
	for {
		translations, readErr := loadLeeTranslationsIfPresent(translatedDir)
		if readErr != nil {
			fail(readErr)
			return
		}
		if len(translations) > 0 {
			encoded, _ := json.Marshal(translations)
			fingerprint := sha256.Sum256(encoded)
			fingerprintHex := hex.EncodeToString(fingerprint[:])
			if fingerprintHex != lastFingerprint {
				metadata := recognizedPaperMetadata{}
				if err := leeOutputToReadXMetadata(pages, translations, config, &metadata); err != nil {
					fail(err)
					return
				}
				if err := s.persistLeeTranslationSegments(ctx, documentKey, metadata.Translations); err != nil {
					fail(err)
					return
				}
				renderedCount, renderErr := s.renderAvailableLeePages(ctx, documentKey, sourcePDFBytes, pages, pageRenderDir, renderer, renderedPages, forceRetranslate, jobKey)
				if renderErr != nil {
					fail(renderErr)
					return
				}
				count := len(metadata.Translations)
				if count != lastCount {
					s.updateImportJob(jobKey, func(job *DocumentJob) {
						stage := job.stage("translate")
						if stage != nil {
							stage.Message = fmt.Sprintf("后台翻译中，已缓存 %d 段可阅读译文", count)
							stage.ResultCount, stage.ResultUnit = count, "段"
						}
					})
					lastCount = count
				}
				if renderedCount > 0 {
					s.jobStage(jobKey, "render", "running", fmt.Sprintf("已逐页排版 %d / %d 页，完成页面可立即查看", renderedCount, len(pages)), renderedCount, len(pages))
				}
				lastFingerprint = fingerprintHex
			}
		}
		select {
		case err := <-commandDone:
			if err != nil {
				fail(err)
				return
			}
			translations, err := loadLeeTranslations(translatedDir)
			if err != nil {
				fail(err)
				return
			}
			metadata := recognizedPaperMetadata{}
			if err := leeOutputToReadXMetadata(pages, translations, config, &metadata); err != nil {
				fail(err)
				return
			}
			if translationUnits > 0 && len(metadata.Translations) == 0 {
				fail(errors.New("未生成可用译文，原文已保留，可重新翻译"))
				return
			}
			if err := s.persistLeeTranslationSegments(ctx, documentKey, metadata.Translations); err != nil {
				fail(err)
				return
			}
			renderedCount, renderErr := s.renderAvailableLeePages(ctx, documentKey, sourcePDFBytes, pages, pageRenderDir, renderer, renderedPages, forceRetranslate, jobKey)
			if renderErr != nil {
				fail(renderErr)
				return
			}
			s.updateImportJob(jobKey, func(job *DocumentJob) {
				job.completeLeeTranslation(len(translations), len(metadata.Translations))
			})
			if renderedCount == len(pages) {
				pagePaths := make([]string, len(pages))
				for index := range pages {
					pagePaths[index] = leeRenderedPagePath(pageRenderDir, index+1)
				}
				rendered := filepath.Join(jobRoot, "rendered", "readx-translated.pdf")
				s.jobStage(jobKey, "render", "running", "逐页排版已完成，正在合并译文 PDF", renderedCount, len(pages))
				if err := renderer.AssemblePages(ctx, sourcePDF, pagePaths, rendered); err != nil {
					// The provider's document-wide renderer remains a fallback if page assembly fails.
					log.Printf("逐页译文合并失败，改用完整排版: %v", err)
					if err := s.runLeeRenderStage(ctx, jobKey, config, bridge, apiKey, baseURL, sourcePDF, sourceJSON, translatedDir); err != nil {
						fail(err)
						return
					}
				}
			} else {
				s.jobStage(jobKey, "render", "running", "全文翻译完成，正在补齐未完成页面并合成译文 PDF", renderedCount, len(pages))
				if err := s.runLeeRenderStage(ctx, jobKey, config, bridge, apiKey, baseURL, sourcePDF, sourceJSON, translatedDir); err != nil {
					fail(err)
					return
				}
			}
			rendered := filepath.Join(jobRoot, "rendered", "readx-translated.pdf")
			if err := s.adoptLeeTranslatedPDF(jobKey, documentKey, rendered, len(pages)); err != nil {
				fail(err)
				return
			}
			s.finishImportJob(jobKey, "done", "")
			if forceRetranslate {
				_ = os.Remove(backupPath)
				_ = os.Remove(filepath.Join(jobRoot, "previous-translated.pdf"))
			}
			return
		case <-ctx.Done():
			fail(ctx.Err())
			return
		case <-time.After(1200 * time.Millisecond):
		}
	}
}

// Lee output blocks and ReadX's matched paragraph cache have different counts.
// Final progress uses output blocks; cached paragraphs remain a separate result.
func (job *DocumentJob) completeLeeTranslation(blocks, cached int) {
	job.setStage("translate", "done", fmt.Sprintf("全文翻译完成，已生成 %d 块译文，缓存 %d 段", blocks, cached), blocks, blocks)
	if stage := job.stage("translate"); stage != nil {
		stage.Unit, stage.Substage = "块", ""
		stage.ResultCount, stage.ResultUnit = cached, "段"
	}
}

func leeRenderedPagePath(dir string, page int) string {
	return filepath.Join(dir, fmt.Sprintf("page-%05d.pdf", page))
}

func (s *Server) renderAvailableLeePages(ctx context.Context, documentKey string, source []byte, pages []ocr.Page, pageDir string, renderer *render.Renderer, rendered map[int]bool, force bool, jobKey string) (int, error) {
	for index, page := range pages {
		pageNumber := index + 1
		if rendered[pageNumber] {
			continue
		}
		pagePath := leeRenderedPagePath(pageDir, pageNumber)
		if !force && existingFile(pagePath) {
			rendered[pageNumber] = true
			continue
		}
		items, _, _ := pageTranslationItems(page, neighbor(pages, index-1), neighbor(pages, index+1))
		targets, err := s.translatePageItemsMode(ctx, documentKey, items, false, true)
		if err != nil {
			return 0, fmt.Errorf("检查第 %d 页译文状态失败: %w", pageNumber, err)
		}
		ready := len(targets) == len(items)
		for _, target := range targets {
			if strings.TrimSpace(target) == "" {
				ready = false
				break
			}
		}
		if !ready {
			continue
		}
		before, after := neighbor(pages, index-1), neighbor(pages, index+1)
		_, data, err := s.renderTranslatedPage(ctx, documentKey, source, pageNumber, page, before, after, false, renderer)
		if err != nil {
			return 0, fmt.Errorf("第 %d 页译文排版失败: %w", pageNumber, err)
		}
		if err := writeLeeRenderedPage(pagePath, data); err != nil {
			return 0, err
		}
		rendered[pageNumber] = true
		count := len(rendered)
		s.jobStage(jobKey, "render", "running", fmt.Sprintf("已逐页排版 %d / %d 页，完成页面可立即查看", count, len(pages)), count, len(pages))
	}
	return len(rendered), nil
}

func writeLeeRenderedPage(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".page-*.pdf")
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	defer os.Remove(tempPath)
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("保存逐页译文失败: %w", err)
	}
	return nil
}

func (s *Server) persistLeeTranslationSegments(ctx context.Context, documentKey string, segments []translateSegment) error {
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stamp := nowStamp()
	for _, segment := range segments {
		if strings.TrimSpace(segment.Source) == "" || strings.TrimSpace(segment.Target) == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO translations(document_id,para_hash,source,target,updated_at) VALUES(?,?,?,?,?)
			ON CONFLICT(document_id,para_hash) DO UPDATE SET source=excluded.source,target=excluded.target,updated_at=excluded.updated_at`,
			documentKey, segment.Hash, segment.Source, segment.Target, stamp); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) runLeeRenderStage(ctx context.Context, jobKey string, config ai.Config, bridge *leeAICompatBridge, apiKey, baseURL, sourcePDF, sourceJSON, translatedDir string) error {
	// sourceJSON is <job>/ocr/normalized/document.v1.json.
	jobRoot := filepath.Clean(filepath.Join(filepath.Dir(sourceJSON), "..", ".."))
	renderSpec := map[string]any{
		"schema_version": "render.stage.v1", "stage": "render",
		"job":    map[string]any{"job_id": jobKey, "job_root": jobRoot, "workflow": "readx-library-background"},
		"inputs": map[string]any{"source_pdf": sourcePDF, "source_json": sourceJSON, "translations_dir": translatedDir, "translation_manifest": filepath.Join(translatedDir, "translation-manifest.json")},
		"params": map[string]any{
			"start_page": 0, "end_page": -1, "render_mode": "auto", "compile_workers": 0,
			"translated_pdf_name": "readx-translated.pdf", "font_unify_mode": "role_min",
			"source_cleanup_strategy": "pikepdf_text_strip", "engine": "rpr_fit",
			"model": config.ModelName(), "base_url": baseURL, "credential_ref": "env:READX_RETAIN_TRANSLATION_API_KEY",
			"api_protocol": "openai", "thinking": config.ReasoningEffort,
		},
	}
	path := filepath.Join(jobRoot, "render.stage.json")
	if err := writeLeeSpec(path, renderSpec); err != nil {
		return err
	}
	return s.runLeeStageCommand(ctx, jobKey, bridge, apiKey, "render-only", path, "")
}

func (s *Server) runLeeStageCommand(ctx context.Context, jobKey string, bridge *leeAICompatBridge, apiKey, command, specPath, translationUnitCacheDir string) error {
	py, prefix, sitePackages, err := leePipelinePython(s.cfg.DataRoot)
	if err != nil {
		return err
	}
	backendRoot := filepath.Join(leeWorkspaceRoot(s.cfg.DataRoot), "vendor", "retainpdf", "backend")
	if resources := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resources != "" {
		candidate := filepath.Join(resources, "vendor", "retainpdf", "backend")
		if existingFile(filepath.Join(candidate, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")) {
			backendRoot = candidate
		}
	}
	if _, err := os.Stat(filepath.Join(backendRoot, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); err != nil {
		if sourceRoot := leeSourceRoot(); sourceRoot != "" {
			backendRoot = filepath.Join(sourceRoot, "vendor", "retainpdf", "backend")
		}
	}
	if _, err := os.Stat(filepath.Join(backendRoot, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); err != nil {
		return errors.New("没有找到随 ReadX 提供的 LeePDF pipeline")
	}
	if bridge != nil {
		apiKey = bridge.Token
	}
	env := os.Environ()
	pythonPaths := []string{filepath.Join(backendRoot, "pipeline"), filepath.Join(backendRoot, "translation"), filepath.Join(backendRoot, "base"), filepath.Join(backendRoot, "math")}
	if prior := os.Getenv("PYTHONPATH"); prior != "" {
		pythonPaths = append(pythonPaths, prior)
	}
	if sitePackages != "" {
		pythonPaths = append(pythonPaths, sitePackages)
	}
	env = setEnv(env, "PYTHONPATH", strings.Join(pythonPaths, string(os.PathListSeparator)))
	env = setEnv(env, "PYTHONUTF8", "1")
	env = setEnv(env, "PYTHONIOENCODING", "utf-8")
	env = setEnv(env, "READX_RETAIN_TRANSLATION_API_KEY", apiKey)
	if translationUnitCacheDir != "" {
		env = setEnv(env, "RETAIN_TRANSLATION_UNIT_CACHE_DIR", translationUnitCacheDir)
	}
	workspace := leeWorkspaceRoot(s.cfg.DataRoot)
	resourceRoot := filepath.Join(workspace, "resources")
	if resources := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resources != "" {
		if _, e := os.Stat(filepath.Join(resources, "rendering-engine", "engine", "bin", "rpr-retain.js")); e == nil {
			resourceRoot = resources
		}
	}
	env = setEnv(env, "RETAIN_RPR_ENGINE_DIR", filepath.Join(resourceRoot, "rendering-engine"))
	if node := os.Getenv("CBCT_NODE_BIN"); node != "" {
		env = setEnv(env, "RETAINPDF_NODE_BIN", node)
		env = setEnv(env, "ELECTRON_RUN_AS_NODE", "1")
	}
	nodeModules := filepath.Join(workspace, "node_modules")
	if resources := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resources != "" {
		if _, e := os.Stat(filepath.Join(resources, "node_modules")); e == nil {
			nodeModules = filepath.Join(resources, "node_modules")
		}
	}
	env = setEnv(env, "RETAIN_RPR_NODE_MODULES_DIR", nodeModules)
	env = setEnv(env, "RETAIN_PDF_FONTS_DIR", filepath.Join(resourceRoot, "fonts"))
	args := append(prefix, "-m", "retainpdf_pipeline.entrypoints.console", command, "--spec", specPath)
	cmd := exec.CommandContext(ctx, py, args...)
	proctree.Configure(cmd)
	cmd.Dir = filepath.Dir(specPath)
	cmd.Env = env
	logPath := filepath.Join(filepath.Dir(specPath), "retain-import.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("创建 Lee 日志失败: %w", err)
	}
	defer logFile.Close()
	writer := &leeImportLogWriter{sink: logFile, observe: func(event leeStageObservation) { s.leeImportObservation(jobKey, event) }}
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 Lee %s 阶段失败: %w", command, err)
	}
	err = cmd.Wait()
	writer.flush()
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		detail := writer.failure
		if detail == "" {
			detail = tailTextFile(logPath, 6000)
		}
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("Lee %s 阶段失败: %s", command, detail)
	}
	return nil
}

func writeLeeSpec(path string, spec map[string]any) error {
	encoded, err := json.Marshal(spec)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		return fmt.Errorf("写入 Lee 阶段参数失败: %w", err)
	}
	return nil
}

func loadLeeTranslationsIfPresent(dir string) ([]leePageTranslation, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	hasPage := false
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "page-") && filepath.Ext(entry.Name()) == ".json" {
			hasPage = true
			break
		}
	}
	if !hasPage {
		return nil, nil
	}
	translations, err := loadLeeTranslations(dir)
	if err == nil {
		return translations, nil
	}
	if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "没有生成可用的段落译文") {
		return nil, nil
	}
	return nil, err
}
