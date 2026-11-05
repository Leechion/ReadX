package httpapi

import (
	"cbctv2/server/internal/proctree"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/ocr"
)

// leeImportOptions 让「导入新论文」与「对已在库论文重新识别」共用同一条识别阶段。
// 识别本身完全一样，不该有两份实现；差别只在措辞与题录核对。
type leeImportOptions struct {
	// SkipMetadataCompletion：重新识别时不再联网核对题录。题录早已入库，
	// 再查一次既慢，又会把「题录核对未完成」的提示混进重新识别的任务里。
	SkipMetadataCompletion bool
}

// runLeePDFImport runs only LeePDF's OCR and document.v1 normalization stage.
// ReadX stores the recognized PDF in the library immediately; translation and
// rendering continue in a cancellable background task.
//
// jobKey 是**任务**编号（识别产物落在 retain/jobs/<jobKey>），与文档 key 是两件事：
// 导入时两者常相同，重新识别时任务编号是 retranslate-<id>，文档 key 才是书库里的那篇。
func (s *Server) runLeePDFImport(ctx context.Context, jobKey, name string, pdf []byte, metadata *recognizedPaperMetadata, options ...leeImportOptions) (string, error) {
	var opts leeImportOptions
	if len(options) > 0 {
		opts = options[0]
	}
	if metadata == nil {
		return "", errors.New("导入元数据不可用")
	}
	aiConfig, err := s.aiConfig()
	if err != nil || !aiConfig.Ready() {
		return "", errors.New("请先在 AI 助手设置中配置可用的模型")
	}
	ocrConfig, err := s.loadOCRConfig()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(ocrConfig.Token) == "" {
		return "", fmt.Errorf("请先在 AI 助手设置中配置 %s 令牌", ocrConfig.label())
	}
	if ocrConfig.Provider == "mineru" && len(pdf) > ocr.MinerUMaxPDFBytes {
		return "", errors.New("PDF 超过 MinerU 上传上限 200 MB")
	}

	jobRoot := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).DataDir(), "retain", "jobs", jobKey)
	sourceDir := filepath.Join(jobRoot, "source")
	for _, dir := range []string{
		jobRoot,
		sourceDir,
		filepath.Join(jobRoot, "ocr"),
		filepath.Join(jobRoot, "translated"),
		filepath.Join(jobRoot, "rendered"),
		filepath.Join(jobRoot, "rendered", "typst"),
		filepath.Join(jobRoot, "artifacts"),
		filepath.Join(jobRoot, "logs"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("创建 Lee 导入目录失败: %w", err)
		}
	}
	sourcePath := filepath.Join(sourceDir, filepath.Base(name))
	if !strings.EqualFold(filepath.Ext(sourcePath), ".pdf") {
		sourcePath = filepath.Join(sourceDir, "source.pdf")
	}
	if err := os.WriteFile(sourcePath, pdf, 0o600); err != nil {
		return "", fmt.Errorf("保存 Lee 输入 PDF 失败: %w", err)
	}

	translationBaseURL := strings.TrimSpace(aiConfig.PublicBaseURL())
	translationAPIKey := aiConfig.APIKey
	translationProtocol := "openai"
	if aiConfig.ProviderName() == "anthropic" {
		translationProtocol = "anthropic"
	}
	var bridge *leeAICompatBridge
	if aiConfig.IsCLI() || aiConfig.ProviderName() == "workbuddy" {
		bridge, err = newLeeAICompatBridge(ai.NewClient(aiConfig))
		if err != nil {
			return "", fmt.Errorf("连接 ReadX AI 助手失败: %w", err)
		}
		defer bridge.Close()
		translationBaseURL = bridge.BaseURL
		translationAPIKey = bridge.Token
		translationProtocol = "openai"
	}
	if translationBaseURL == "" {
		return "", errors.New("AI 助手设置中缺少模型服务地址")
	}

	py, prefix, sitePackages, err := leePipelinePython(s.cfg.DataRoot)
	if err != nil {
		return "", err
	}
	backendRoot := filepath.Join(leeWorkspaceRoot(s.cfg.DataRoot), "vendor", "retainpdf", "backend")
	if resourcesRoot := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resourcesRoot != "" {
		candidate := filepath.Join(resourcesRoot, "vendor", "retainpdf", "backend")
		if _, statErr := os.Stat(filepath.Join(candidate, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); statErr == nil {
			backendRoot = candidate
		}
	}
	if _, err := os.Stat(filepath.Join(backendRoot, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); err != nil {
		// Development and installed desktop layouts have different app roots.
		if executable, exeErr := os.Executable(); exeErr == nil {
			base := filepath.Dir(executable)
			for _, candidate := range []string{
				filepath.Join(base, "..", "vendor", "retainpdf", "backend"),
				filepath.Join(base, "..", "..", "vendor", "retainpdf", "backend"),
			} {
				if _, statErr := os.Stat(filepath.Join(candidate, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); statErr == nil {
					backendRoot = candidate
					break
				}
			}
		}
		if sourceRoot := leeSourceRoot(); sourceRoot != "" {
			candidate := filepath.Join(sourceRoot, "vendor", "retainpdf", "backend")
			if _, statErr := os.Stat(filepath.Join(candidate, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); statErr == nil {
				backendRoot = candidate
			}
		}
	}
	if _, err := os.Stat(filepath.Join(backendRoot, "pipeline", "retainpdf_pipeline", "entrypoints", "console.py")); err != nil {
		return "", errors.New("没有找到随 ReadX 提供的 LeePDF pipeline")
	}

	jobID, err := randomLeeJobID()
	if err != nil {
		return "", err
	}
	spec := map[string]any{
		"schema_version": "provider.stage.v1",
		"stage":          "provider",
		"job":            map[string]any{"job_id": jobID, "job_root": jobRoot, "workflow": "ocr"},
		"source":         map[string]any{"file_path": sourcePath},
		"ocr":            ocrConfig.leeStageOptions(),
		"translation": map[string]any{
			// Translate several independent batches at once. Four workers is a
			// conservative default that improves latency without flooding provider
			// rate limits; Lee's adaptive scheduler can still reduce concurrency.
			"start_page": 0, "end_page": -1, "batch_size": 8, "workers": 4,
			"mode": "sci", "math_mode": "direct_typst", "skip_title_translation": false,
			"classify_batch_size": 12, "rule_profile_name": "general_sci",
			"context_mode": "needed", "glossary_mode": "matched", "memory_mode": "matched",
			"model": aiConfig.ModelName(), "base_url": translationBaseURL,
			"provider":       aiConfig.ProviderName(),
			"credential_ref": "env:READX_RETAIN_TRANSLATION_API_KEY",
			"api_protocol":   translationProtocol, "thinking": aiConfig.ReasoningEffort,
		},
		"render": map[string]any{
			"render_mode": "auto", "engine": "rpr_fit", "translated_pdf_name": "readx-translated.pdf",
			"font_unify_mode": "role_min", "source_cleanup_strategy": "pikepdf_text_strip",
		},
	}
	specPath := filepath.Join(jobRoot, "provider.stage.json")
	encoded, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(specPath, encoded, 0o600); err != nil {
		return "", fmt.Errorf("写入 Lee pipeline 参数失败: %w", err)
	}

	args := append(prefix, "-m", "retainpdf_pipeline.entrypoints.console", "provider-case", "--spec", specPath)
	cmd := exec.CommandContext(ctx, py, args...)
	proctree.Configure(cmd)
	cmd.Dir = jobRoot
	env := os.Environ()
	pythonPaths := []string{
		filepath.Join(backendRoot, "pipeline"), filepath.Join(backendRoot, "translation"),
		filepath.Join(backendRoot, "base"), filepath.Join(backendRoot, "math"),
	}
	if prior := os.Getenv("PYTHONPATH"); prior != "" {
		pythonPaths = append(pythonPaths, prior)
	}
	if sitePackages != "" {
		pythonPaths = append(pythonPaths, sitePackages)
	}
	env = setEnv(env, "PYTHONPATH", strings.Join(pythonPaths, string(os.PathListSeparator)))
	// Python's Windows console encoding can otherwise write CP936 to this log;
	// Go later reads it as UTF-8, corrupting provider progress and error details.
	env = setEnv(env, "PYTHONUTF8", "1")
	env = setEnv(env, "PYTHONIOENCODING", "utf-8")
	env = setEnv(env, ocrConfig.tokenEnvironment(), ocrConfig.Token)
	if ocrConfig.Provider == "mineru" {
		env = setEnv(env, "RETAIN_MINERU_API_URL", ocrConfig.BaseURL)
	}
	env = setEnv(env, "READX_RETAIN_TRANSLATION_API_KEY", translationAPIKey)
	resourceRoot := filepath.Join(leeWorkspaceRoot(s.cfg.DataRoot), "resources")
	if resources := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resources != "" {
		if _, statErr := os.Stat(filepath.Join(resources, "rendering-engine", "engine", "bin", "rpr-retain.js")); statErr == nil {
			resourceRoot = resources
		}
	}
	if _, err := os.Stat(filepath.Join(resourceRoot, "rendering-engine", "engine", "bin", "rpr-retain.js")); err != nil {
		if sourceRoot := leeSourceRoot(); sourceRoot != "" {
			resourceRoot = filepath.Join(sourceRoot, "resources")
		}
	}
	env = setEnv(env, "RETAIN_RPR_ENGINE_DIR", filepath.Join(resourceRoot, "rendering-engine"))
	if node := os.Getenv("CBCT_NODE_BIN"); node != "" {
		env = setEnv(env, "RETAINPDF_NODE_BIN", node)
		env = setEnv(env, "ELECTRON_RUN_AS_NODE", "1")
	}
	{
		nodeModules := filepath.Join(leeWorkspaceRoot(s.cfg.DataRoot), "node_modules")
		if resources := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resources != "" {
			candidate := filepath.Join(resources, "node_modules")
			if _, statErr := os.Stat(candidate); statErr == nil {
				nodeModules = candidate
			}
		}
		if _, err := os.Stat(nodeModules); err != nil {
			if sourceRoot := leeSourceRoot(); sourceRoot != "" {
				nodeModules = filepath.Join(sourceRoot, "node_modules")
			}
		}
		env = setEnv(env, "RETAIN_RPR_NODE_MODULES_DIR", nodeModules)
	}
	env = setEnv(env, "RETAIN_PDF_FONTS_DIR", filepath.Join(resourceRoot, "fonts"))
	cmd.Env = env
	logPath := filepath.Join(jobRoot, "retain-import.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return "", fmt.Errorf("创建 Lee 日志失败: %w", err)
	}
	defer logFile.Close()
	logWriter := &leeImportLogWriter{sink: logFile, observe: func(event leeStageObservation) {
		s.leeImportObservation(jobKey, event)
	}}
	cmd.Stdout, cmd.Stderr = logWriter, logWriter
	s.jobStage(jobKey, "ocr", "running", "Lee 正在识别并整理论文", 0, -1)
	s.jobStage(jobKey, "translate", "pending", "等待 OCR 完成", 0, -1)
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("启动 Lee pipeline 失败: %w", err)
	}
	waitErr := cmd.Wait()
	logWriter.flush()
	if err := waitErr; err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		detail := logWriter.failure
		if detail == "" {
			detail = tailTextFile(logPath, 6000)
		}
		if detail == "" {
			detail = err.Error()
		}
		s.updateImportJob(jobKey, func(job *DocumentJob) {
			if job.Status == "running" {
				for i := range job.Stages {
					if job.Stages[i].Status == "running" {
						job.Stages[i].Status, job.Stages[i].Message = "failed", detail
					}
				}
			}
		})
		return "", fmt.Errorf("Lee 导入处理失败: %s", detail)
	}

	documentPath := filepath.Join(jobRoot, "ocr", "normalized", "document.v1.json")
	documentJSON, err := os.ReadFile(documentPath)
	if err != nil {
		return "", fmt.Errorf("Lee 未生成 document.v1: %w", err)
	}
	pages, err := ocr.ProjectNormalizedDocument(documentJSON)
	if err != nil {
		return "", err
	}
	metadata.OCRPages = pages
	if err := leeOutputToReadXMetadata(pages, nil, aiConfig, metadata); err != nil {
		return "", err
	}
	// OCR completes before translation starts; this is not a failed-translation
	// warning because the document is now readable and the worker is queued.
	metadata.Untranslated = 0
	translationUnits := countLeeTranslationUnits(pages)
	if opts.SkipMetadataCompletion {
		// 重新识别：题录早已入库，不再联网核对，措辞也不再提「已入库」。
		s.jobStage(jobKey, "ocr", "done", fmt.Sprintf("重新识别完成，共 %d 页", len(pages)), len(pages), len(pages))
		s.jobStage(jobKey, "translate", "pending", "识别结果已更新，等待后台重新翻译", 0, translationUnits)
		s.jobStage(jobKey, "render", "pending", "等待全文翻译完成后排版", 0, len(pages))
		s.updateImportJob(jobKey, func(job *DocumentJob) { job.Pages = len(pages) })
		return "", nil
	}
	s.jobStage(jobKey, "ocr", "running", "OCR 已完成，AI 助手正在联网核对出版来源与年份", len(pages), len(pages))
	if err := s.completeImportedPDFMetadata(ctx, name, metadata); err != nil {
		log.Printf("导入题录联网补齐未完成: %v", err)
		metadata.MetadataWarning = "出版信息联网核对未完成：" + err.Error() + "；已保留原文与已有题录"
	}
	metadataMessage := "OCR 与题录核对已结束，原文已可阅读"
	if metadata.MetadataWarning != "" {
		metadataMessage += "；" + metadata.MetadataWarning
	}
	s.jobStage(jobKey, "ocr", "done", metadataMessage, len(pages), len(pages))
	s.jobStage(jobKey, "translate", "pending", "已入库，阅读时后台逐页翻译", 0, translationUnits)
	s.jobStage(jobKey, "render", "pending", "等待全文翻译完成后排版", 0, len(pages))
	s.updateImportJob(jobKey, func(job *DocumentJob) { job.Pages = len(pages) })
	return "", nil
}

func countLeeTranslationUnits(pages []ocr.Page) int {
	total := 0
	for pageIndex, page := range pages {
		var before, after *ocr.Page
		if pageIndex > 0 {
			before = &pages[pageIndex-1]
		}
		if pageIndex+1 < len(pages) {
			after = &pages[pageIndex+1]
		}
		items, _, _ := pageTranslationItems(page, before, after)
		total += len(items)
	}
	return total
}

type leePageTranslation struct {
	PageIndex int
	Source    string
	Target    string
}

func loadLeeTranslations(dir string) ([]leePageTranslation, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读取 Lee 翻译产物失败: %w", err)
	}
	var records []leePageTranslation
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "page-") || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		var page []struct {
			PageIndex int    `json:"page_idx"`
			Source    string `json:"source_text"`
			Target    string `json:"translated_text"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("解析 Lee 翻译页 %s 失败: %w", entry.Name(), err)
		}
		for _, item := range page {
			if strings.TrimSpace(item.Source) != "" && strings.TrimSpace(item.Target) != "" {
				records = append(records, leePageTranslation{PageIndex: item.PageIndex, Source: strings.TrimSpace(item.Source), Target: strings.TrimSpace(item.Target)})
			}
		}
	}
	if len(records) == 0 {
		return nil, errors.New("Lee 没有生成可用的段落译文")
	}
	return records, nil
}

func leeOutputToReadXMetadata(pages []ocr.Page, translated []leePageTranslation, cfg ai.Config, metadata *recognizedPaperMetadata) error {
	targets := map[string][]string{}
	for _, item := range translated {
		if strings.TrimSpace(item.Target) == "" {
			continue
		}
		key := fmt.Sprintf("%d\x00%s", item.PageIndex, item.Source)
		targets[key] = append(targets[key], item.Target)
	}
	metadata.LayoutPages = make([]layoutPage, 0, len(pages))
	metadata.Pages = make([]publicationPageHint, 0, len(pages))
	metadata.Translations = nil
	metadata.Untranslated = 0
	for pageIndex, page := range pages {
		layout := layoutPage{Page: page.Index + 1, Width: page.Width, Height: page.Height}
		segments := []string{}
		var before, after *ocr.Page
		if pageIndex > 0 {
			before = &pages[pageIndex-1]
		}
		if pageIndex+1 < len(pages) {
			after = &pages[pageIndex+1]
		}
		items, owners, _ := pageTranslationItems(page, before, after)
		for _, block := range page.Blocks {
			// 版式是 OCR 页的持久化形态：**凡是从页重建 item / 渲染要用到的字段都必须存下来**。
			// 漏掉续接字段的代价特别大——译文缓存的指纹包含续接签名与上下文，
			// 读取端拿落库版式重建时算出的指纹就和写入端不同，后台明明已入库的译文永远查不中
			// （现象：阅读器一直显示「本页译文 0 / N 段」）。
			layout.Blocks = append(layout.Blocks, layoutBlock{
				Kind: block.Kind, SourceOrder: block.SourceOrder, HasSourceOrder: block.HasSourceOrder,
				ProviderBlockID: block.ProviderBlockID, RawGroupID: block.RawGroupID, RawGlobalGroupID: block.RawGlobalGroupID,
				RawBlockOrder: block.RawBlockOrder, HasRawBlockOrder: block.HasRawBlockOrder, Text: block.Text, Box: block.Box,
				LayoutRole: block.LayoutRole, SemanticRole: block.SemanticRole, StructureRole: block.StructureRole,
				PolicyReason: block.PolicyReason, NotTranslatable: !block.Translatable,
				Segments: block.Segments, Lines: block.Lines, LineTexts: block.LineTexts,
				ColumnLayoutMode: block.ColumnLayoutMode, ColumnIndexGuess: block.ColumnIndexGuess,
				CrossColumnMergeSuspected: block.CrossColumnMergeSuspected, ReadingOrderUnreliable: block.ReadingOrderUnreliable,
				StructureUnreliable: block.StructureUnreliable, TextMissingButBBoxPresent: block.TextMissingButBBoxPresent,
				PeerBlockAbsorbedText: block.PeerBlockAbsorbedText, SuspectedPeerBlockID: block.SuspectedPeerBlockID,
				LayoutMode: block.LayoutMode, LayoutSplitX: block.LayoutSplitX, LayoutZone: block.LayoutZone,
				LayoutZoneRank: block.LayoutZoneRank, LayoutZoneSize: block.LayoutZoneSize, BoundaryRole: block.BoundaryRole,
				ContinuationGroup: block.ContinuationGroup, ContinuationSignature: block.ContinuationSignature,
				ContinuationDecision: block.ContinuationDecision, ContinuationPrevious: block.ContinuationPrevious,
				ContinuationNext:         block.ContinuationNext,
				ProviderContinuationRole: block.ProviderContinuationRole, ProviderContinuationScope: block.ProviderContinuationScope,
				ProviderContinuationOrder: block.ProviderContinuationOrder, ProviderContinuationScore: block.ProviderContinuationScore,
				ProviderContinuationSkip: block.ProviderContinuationSkip,
				LeeMetadata:              block.LeeMetadata, LeeContent: block.LeeContent,
			})
			if block.Translatable && strings.TrimSpace(block.Text) != "" {
				segments = append(segments, block.Text)
			}
		}
		metadata.LayoutPages = append(metadata.LayoutPages, layout)
		metadata.Pages = append(metadata.Pages, publicationPageHint{Page: page.Index + 1, Text: strings.Join(segments, "\n"), Segments: segments, Width: page.Width, Height: page.Height})
		for itemIndex, item := range items {
			if itemIndex >= len(owners) {
				continue
			}
			blockIndex := owners[itemIndex]
			if blockIndex < 0 || blockIndex >= len(page.Blocks) {
				continue
			}
			block := page.Blocks[blockIndex]
			key := fmt.Sprintf("%d\x00%s", page.Index, strings.TrimSpace(block.Text))
			matches := targets[key]
			if len(matches) == 0 {
				metadata.Untranslated++
				continue
			}
			target := matches[0]
			targets[key] = matches[1:]
			metadata.Translations = append(metadata.Translations, translateSegment{Hash: translationCacheHash(item, &cfg), Source: item.Source, Target: target})
		}
	}
	return nil
}

func leePipelinePython(dataRoot string) (string, []string, string, error) {
	if configured := strings.TrimSpace(os.Getenv("READX_PYTHON")); configured != "" {
		path, err := exec.LookPath(configured)
		if err != nil {
			return "", nil, "", fmt.Errorf("READX_PYTHON 指定的 Python 不可用: %w", err)
		}
		sitePackages := ""
		if runtime.GOOS == "windows" {
			// The desktop/dev launcher may explicitly provide the bundled venv
			// interpreter. Resolve it to its base Python too: launching the venv
			// executable from a low-integrity workspace can lose permission to
			// create the provider logs under the user's temp directory.
			path, sitePackages = venvBasePython(path)
		}
		if resourcesRoot := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resourcesRoot != "" {
			candidate := filepath.Join(resourcesRoot, "python", "Lib", "site-packages")
			if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
				sitePackages = candidate
			}
		}
		return path, nil, sitePackages, nil
	}
	venvParts := []string{".retain-runtime", "bin", "python3"}
	if runtime.GOOS == "windows" {
		venvParts = []string{".retain-runtime", "Scripts", "python.exe"}
	}
	candidates := []string{
		filepath.Join(append([]string{leeWorkspaceRoot(dataRoot)}, venvParts...)...),
		filepath.Join(append([]string{dataRoot}, venvParts...)...),
	}
	if sourceRoot := leeSourceRoot(); sourceRoot != "" {
		candidates = append(candidates, filepath.Join(append([]string{sourceRoot}, venvParts...)...))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			// 直接执行 venv 里的 python.exe 时，进程会继承该文件所在目录的完整性级别；
			// 仓库位于低完整性盘（例如沙箱里的 E:\CODE）时，它无法写 %TEMP% 等中完整性
			// 目录，日志创建会 EACCES。改用 venv 指向的基础解释器，并把 site-packages
			// 加进 PYTHONPATH，既保留依赖又避免低完整性限制。
			if runtime.GOOS == "windows" {
				base, site := venvBasePython(candidate)
				return base, nil, site, nil
			}
			return candidate, nil, "", nil
		}
	}
	if resourcesRoot := strings.TrimSpace(os.Getenv("READX_RESOURCES_DIR")); resourcesRoot != "" {
		candidate := filepath.Join(resourcesRoot, "python", "python.exe")
		if runtime.GOOS != "windows" {
			candidate = filepath.Join(resourcesRoot, "python", "bin", "python3")
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil, filepath.Join(resourcesRoot, "python", "Lib", "site-packages"), nil
		}
	}
	if runtime.GOOS == "windows" {
		if path, err := exec.LookPath("py"); err == nil {
			for _, version := range []string{"3.12", "3.11"} {
				probe := exec.Command(path, "-"+version, "-c", "import sys; print(sys.executable)")
				if output, probeErr := probe.Output(); probeErr == nil {
					return strings.TrimSpace(string(output)), nil, "", nil
				}
			}
		}
	}
	for _, candidate := range []string{"python", "python3"} {
		if path, err := exec.LookPath(candidate); err == nil {
			probe := exec.Command(path, "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
			if output, probeErr := probe.Output(); probeErr == nil {
				version := strings.TrimSpace(string(output))
				if version == "3.11" || version == "3.12" {
					return path, nil, "", nil
				}
			}
		}
	}
	return "", nil, "", errors.New("LeePDF 需要 Python 3.11 或 3.12；可设置 READX_PYTHON 指向已安装 Lee 依赖的 Python 解释器")
}

// venvBasePython 读取 pyvenv.cfg 的 home，返回 venv 背后的基础解释器与 site-packages。
func venvBasePython(venvPython string) (string, string) {
	venvRoot := filepath.Dir(filepath.Dir(venvPython))
	site := filepath.Join(venvRoot, "Lib", "site-packages")
	if info, err := os.Stat(site); err != nil || !info.IsDir() {
		site = ""
	}
	raw, err := os.ReadFile(filepath.Join(venvRoot, "pyvenv.cfg"))
	if err != nil {
		return venvPython, site
	}
	home := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "home") {
			if index := strings.Index(line, "="); index >= 0 {
				home = strings.TrimSpace(line[index+1:])
			}
			break
		}
	}
	if home == "" {
		return venvPython, site
	}
	base := filepath.Join(home, "python.exe")
	if info, err := os.Stat(base); err == nil && !info.IsDir() {
		return base, site
	}
	return venvPython, site
}

// Resolve from the binary first: -trimpath removes absolute source filenames.
func leeWorkspaceRoot(dataRoot string) string {
	if configured := strings.TrimSpace(os.Getenv("READX_WORKSPACE_DIR")); configured != "" {
		return configured
	}
	if executable, err := os.Executable(); err == nil {
		candidate := filepath.Clean(filepath.Join(filepath.Dir(executable), "..", "..", ".."))
		if _, err := os.Stat(filepath.Join(candidate, "vendor", "retainpdf", "backend")); err == nil {
			return candidate
		}
	}
	platform := "windows"
	if runtime.GOOS == "darwin" {
		platform = "macos"
	}
	for _, candidate := range []string{filepath.Join(dataRoot, platform), dataRoot, leeSourceRoot()} {
		if _, err := os.Stat(filepath.Join(candidate, "vendor", "retainpdf", "backend")); err == nil {
			return candidate
		}
	}
	return filepath.Join(dataRoot, platform)
}

func leeSourceRoot() string {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok || sourceFile == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "..", "..", "..", ".."))
}

func randomLeeJobID() (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "readx-" + hex.EncodeToString(raw[:]), nil
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, item := range env {
		if strings.HasPrefix(strings.ToUpper(item), strings.ToUpper(prefix)) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func tailTextFile(path string, limit int) string {
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	text := strings.TrimSpace(string(body))
	if len(text) > limit {
		text = text[len(text)-limit:]
	}
	return text
}

func (s *Server) adoptLeeTranslatedPDF(jobKey, documentKey, source string, pages int) error {
	if strings.TrimSpace(source) == "" {
		return errors.New("Lee 译文 PDF 路径为空")
	}
	target := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), documentKey+"-translated.pdf")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("打开 Lee 译文 PDF 失败: %w", err)
	}
	defer input.Close()
	temporary, err := os.CreateTemp(filepath.Dir(target), ".retain-translated-*.pdf")
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	defer os.Remove(tempPath)
	if _, err = io.Copy(temporary, input); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if err = os.Rename(tempPath, target); err != nil {
		return fmt.Errorf("保存 Lee 译文 PDF 失败: %w", err)
	}
	s.updateImportJob(jobKey, func(job *DocumentJob) {
		job.setStage("render", "done", fmt.Sprintf("Lee 已排版 %d 页译文", pages), pages, pages)
		if stage := job.stage("render"); stage != nil {
			stage.Unit, stage.Substage = "页", ""
		}
	})
	return nil
}

type leeAICompatBridge struct {
	BaseURL string
	Token   string
	server  *http.Server
}

func existingFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func newLeeAICompatBridge(client *ai.Client) (*leeAICompatBridge, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		listener.Close()
		return nil, err
	}
	token := hex.EncodeToString(secret[:])
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		defer r.Body.Close()
		var request struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			Temperature    float64         `json:"temperature"`
			Stream         bool            `json:"stream"`
			ResponseFormat json.RawMessage `json:"response_format"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 24<<20)
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		var system, user strings.Builder
		for _, message := range request.Messages {
			if message.Role == "system" || message.Role == "developer" {
				system.WriteString(message.Content + "\n\n")
			} else if message.Role == "user" {
				user.WriteString(message.Content + "\n\n")
			} else if message.Content != "" {
				user.WriteString("[" + message.Role + "]\n" + message.Content + "\n\n")
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		var response string
		var callErr error
		if len(request.ResponseFormat) > 0 && strings.TrimSpace(string(request.ResponseFormat)) != "null" {
			var format any
			if json.Unmarshal(request.ResponseFormat, &format) == nil {
				response, callErr = client.GenerateStructuredWithTimeout(ctx, system.String(), user.String(), request.Temperature, 10*time.Minute, format)
			}
		} else {
			response, callErr = client.GenerateWithTimeout(ctx, system.String(), user.String(), request.Temperature, 10*time.Minute)
		}
		if callErr != nil {
			http.Error(w, callErr.Error(), http.StatusBadGateway)
			return
		}
		if request.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			flusher, _ := w.(http.Flusher)
			for start := 0; start < len(response); {
				end := min(start+256, len(response))
				for end < len(response) && end > start && response[end]&0xC0 == 0x80 {
					end--
				}
				if end == start {
					end = min(start+1, len(response))
				}
				chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]string{"content": response[start:end]}}}})
				_, _ = fmt.Fprintf(w, "data: %s\n\n", chunk)
				if flusher != nil {
					flusher.Flush()
				}
				start = end
			}
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"role": "assistant", "content": response}, "finish_reason": "stop"}}})
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	return &leeAICompatBridge{BaseURL: "http://" + listener.Addr().String() + "/v1", Token: token, server: server}, nil
}

func (b *leeAICompatBridge) Close() {
	if b == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = b.server.Shutdown(ctx)
}
