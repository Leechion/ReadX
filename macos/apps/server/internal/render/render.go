// Package render 把「原 PDF + 每页译文 + 版式」交给 LeePDF 的 rpr 渲染引擎，
// 生成保留排版的译文 PDF。
//
// 引擎本身是 retain-pdf-rendering（MIT，Node.js），随应用放在
// resources/rendering-engine；这里只负责：
//  1. 把 ReadX 的页/块几何转成 rpr_retain_input_v1；
//  2. 用 Electron 自带的 Node（或系统 node）跑 scripts/render-translated-pdf.cjs；
//  3. 读回引擎报告并落到目标文件。
package render

import (
	"cbctv2/server/internal/proctree"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	inputSchema = "rpr_retain_input_v1"
	fontFamily  = "Source Han Serif SC"

	defaultTimeout = 30 * time.Minute
	minBoxSize     = 8.0
	minFitFont     = 4.8
)

// Block 是一个要重排的译文块。Box 使用 PDF 页面坐标（pt，左上角原点，y 向下），
// 与 ReadX 的 PDFLayout 完全一致。
type Block struct {
	ID       string
	Text     string
	Box      [4]float64
	FontSize float64
	Role     string
	Align    string
	// Background 是覆盖原文的底色；默认白色。
	Background [3]float64
}

// Page 是一页的渲染输入。
type Page struct {
	Index  int
	Width  float64
	Height float64
	Blocks []Block
}

// Report 是渲染结果的摘要。
type Report struct {
	Pages        int            `json:"pages"`
	Blocks       int            `json:"blocks"`
	Overflow     int            `json:"overflow"`
	Collisions   int            `json:"collisions"`
	FailedMath   int            `json:"failedMath"`
	Timings      map[string]any `json:"timings,omitempty"`
	EngineName   string         `json:"engineName,omitempty"`
	EngineVer    string         `json:"engineVersion,omitempty"`
	EngineCommit string         `json:"engineCommit,omitempty"`
}

// Renderer 定位并调用渲染引擎。
type Renderer struct {
	DataRoot string
	Timeout  time.Duration
}

func New(dataRoot string) *Renderer {
	return &Renderer{DataRoot: dataRoot, Timeout: defaultTimeout}
}

// Available 判断当前安装是否具备渲染资源（引擎、字体、Node、脚本）。
func (r *Renderer) Available() error {
	_, _, _, err := r.resolve()
	return err
}

func (r *Renderer) resolve() (engineDir, fontDir, script string, err error) {
	engineDir = os.Getenv("CBCT_RENDER_ENGINE_DIR")
	if engineDir == "" {
		candidates := []string{}
		if root := os.Getenv("READX_WORKSPACE_DIR"); root != "" {
			candidates = append(candidates, filepath.Join(root, "resources", "rendering-engine"))
		}
		if r.DataRoot != "" {
			candidates = append(candidates, filepath.Join(r.DataRoot, "windows", "resources", "rendering-engine"))
			candidates = append(candidates, filepath.Join(r.DataRoot, "resources", "rendering-engine"))
		}
		if executable, lookErr := os.Executable(); lookErr == nil {
			base := filepath.Dir(executable)
			candidates = append(candidates,
				filepath.Join(base, "..", "resources", "rendering-engine"),
				filepath.Join(base, "resources", "rendering-engine"),
			)
		}
		if cwd, cwdErr := os.Getwd(); cwdErr == nil {
			candidates = append(candidates, filepath.Join(cwd, "resources", "rendering-engine"))
		}
		for _, candidate := range candidates {
			if fileExists(filepath.Join(candidate, "engine", "src", "retain", "run.js")) {
				engineDir = candidate
				break
			}
		}
	}
	if engineDir == "" || !fileExists(filepath.Join(engineDir, "engine", "src", "retain", "run.js")) {
		return "", "", "", errors.New("未找到排版引擎：请确认 resources/rendering-engine 已随应用安装")
	}

	fontDir = os.Getenv("CBCT_TRANSLATED_PDF_FONT_DIR")
	if fontDir == "" {
		fontDir = filepath.Join(filepath.Dir(engineDir), "fonts")
	}
	if !fileExists(filepath.Join(fontDir, "SourceHanSerifSC-Regular.otf")) {
		return "", "", "", errors.New("未找到排版字体：请确认 resources/fonts/SourceHanSerifSC-Regular.otf 已安装")
	}

	script = os.Getenv("CBCT_RENDER_SCRIPT")
	if script == "" {
		candidates := []string{}
		if root := os.Getenv("READX_WORKSPACE_DIR"); root != "" {
			candidates = append(candidates, filepath.Join(root, "scripts", "render-translated-pdf.cjs"))
		}
		if r.DataRoot != "" {
			candidates = append(candidates, filepath.Join(r.DataRoot, "windows", "scripts", "render-translated-pdf.cjs"))
		}
		candidates = append(candidates, filepath.Join(filepath.Dir(fontDir), "..", "scripts", "render-translated-pdf.cjs"))
		if executable, lookErr := os.Executable(); lookErr == nil {
			candidates = append(candidates, filepath.Join(filepath.Dir(executable), "..", "scripts", "render-translated-pdf.cjs"))
		}
		for _, candidate := range candidates {
			if fileExists(candidate) {
				script = candidate
				break
			}
		}
	}
	if script == "" || !fileExists(script) {
		return "", "", "", errors.New("未找到渲染脚本 render-translated-pdf.cjs")
	}

	if _, lookErr := r.nodeBinary(); lookErr != nil {
		return "", "", "", lookErr
	}
	if missing := r.missingNodeModules(); len(missing) > 0 {
		return "", "", "", fmt.Errorf("渲染引擎缺少依赖 %s：请在对应平台工程目录运行 npm install", strings.Join(missing, "、"))
	}
	return engineDir, fontDir, script, nil
}

func (r *Renderer) nodeBinary() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("CBCT_NODE_BIN")); configured != "" {
		if !fileExists(configured) {
			return "", fmt.Errorf("CBCT_NODE_BIN 指向的文件不存在：%s", configured)
		}
		return configured, nil
	}
	node, err := exec.LookPath("node")
	if err != nil {
		return "", errors.New("找不到 node：打包环境请用 CBCT_NODE_BIN 指定 Electron 可执行文件")
	}
	return node, nil
}

// missingNodeModules 检查脚本工作目录下能不能解析到运行时依赖。
func (r *Renderer) missingNodeModules() []string {
	roots := []string{}
	if root := os.Getenv("READX_WORKSPACE_DIR"); root != "" {
		roots = append(roots, filepath.Join(root, "node_modules"))
	}
	if r.DataRoot != "" {
		roots = append(roots, filepath.Join(r.DataRoot, "windows", "node_modules"))
	}
	if executable, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Join(filepath.Dir(executable), "..", "node_modules"))
	}
	if configured := strings.TrimSpace(os.Getenv("CBCT_RENDER_ENGINE_DIR")); configured != "" {
		roots = append(roots, filepath.Join(filepath.Dir(configured), "node_modules"), filepath.Join(filepath.Dir(filepath.Dir(configured)), "node_modules"))
	}
	if cwd, err := os.Getwd(); err == nil {
		roots = append(roots, filepath.Join(cwd, "node_modules"))
		roots = append(roots, filepath.Join(cwd, "..", "node_modules"))
	}
	missing := []string{}
	for _, dependency := range []string{"fontkit", "mathjax-full", "pdf-lib"} {
		found := false
		for _, root := range roots {
			if dirExists(filepath.Join(root, dependency)) {
				found = true
				break
			}
		}
		if !found {
			missing = append(missing, dependency)
		}
	}
	return missing
}

// Render 生成译文 PDF。
func (r *Renderer) Render(ctx context.Context, sourcePDF []byte, pages []Page, outputPath string) (Report, error) {
	return r.render(ctx, sourcePDF, pages, outputPath, 0, false)
}

// RenderPage 只重排原 PDF 的一页，输出也只含这一页：阅读器按页取排版结果时用，
// 不必为了一页生成整本。pageNumber 从 1 开始。
func (r *Renderer) RenderPage(ctx context.Context, sourcePDF []byte, pageNumber int, page Page, outputPath string) (Report, error) {
	if pageNumber < 1 {
		return Report{}, errors.New("页码必须从 1 开始")
	}
	page.Index = 0
	return r.render(ctx, sourcePDF, []Page{page}, outputPath, pageNumber, false)
}

// AssemblePages joins already-rendered single-page PDFs in source order. Empty
// entries keep the corresponding original PDF page; a complete set gives the
// import worker a final document without rendering finished pages a second time.
func (r *Renderer) AssemblePages(ctx context.Context, sourcePath string, pagePaths []string, outputPath string) error {
	_, _, script, err := r.resolve()
	if err != nil {
		return err
	}
	if strings.TrimSpace(sourcePath) == "" || len(pagePaths) == 0 {
		return errors.New("组装译文 PDF 缺少原文或页面")
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return fmt.Errorf("创建译文目录失败: %w", err)
	}
	workDir, err := os.MkdirTemp(filepath.Dir(outputPath), ".assemble-*")
	if err != nil {
		return fmt.Errorf("创建 PDF 组装临时目录失败: %w", err)
	}
	defer os.RemoveAll(workDir)
	manifestPath := filepath.Join(workDir, "pages.json")
	manifest, err := json.Marshal(struct {
		Pages []string `json:"pages"`
	}{Pages: pagePaths})
	if err != nil {
		return err
	}
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(outputPath), ".translated-assemble-*.pdf")
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		os.Remove(tempPath)
		return err
	}
	_ = os.Remove(tempPath)
	node, err := r.nodeBinary()
	if err != nil {
		return err
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, node, script,
		"--source", sourcePath,
		"--output", tempPath,
		"--pagesManifest", manifestPath,
		"--assemble", "1",
	)
	proctree.Configure(command)
	env := os.Environ()
	if strings.TrimSpace(os.Getenv("CBCT_ELECTRON_AS_NODE")) != "" {
		env = append(env, "ELECTRON_RUN_AS_NODE=1")
	}
	command.Env = env
	output, runErr := command.CombinedOutput()
	if runErr != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("PDF 组装超时（%s）", timeout)
		}
		return fmt.Errorf("PDF 组装失败: %s", engineError(output, runErr))
	}
	if err := os.Rename(tempPath, outputPath); err != nil {
		return fmt.Errorf("保存组装后的译文 PDF 失败: %w", err)
	}
	return nil
}

// ExtractPage 原样抽出一页（不跑排版引擎）：整页没有可译正文时，阅读器仍拿到
// 一个合法的单页 PDF，用来显示「保留原页」。
func (r *Renderer) ExtractPage(ctx context.Context, sourcePDF []byte, pageNumber int, outputPath string) (Report, error) {
	if pageNumber < 1 {
		return Report{}, errors.New("页码必须从 1 开始")
	}
	return r.render(ctx, sourcePDF, nil, outputPath, pageNumber, true)
}

func (r *Renderer) render(ctx context.Context, sourcePDF []byte, pages []Page, outputPath string, sourcePage int, extract bool) (Report, error) {
	engineDir, fontDir, script, err := r.resolve()
	if err != nil {
		return Report{}, err
	}
	if len(pages) == 0 && !extract {
		return Report{}, errors.New("没有可渲染的页面")
	}
	if len(sourcePDF) == 0 {
		return Report{}, errors.New("原 PDF 为空")
	}
	var input []byte
	if extract {
		input = []byte(`{"schema":"rpr_retain_input_v1","font":{"family":"Source Han Serif SC"},"pages":[]}`)
	} else {
		input, _, err = buildInput(pages)
		if err != nil {
			return Report{}, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return Report{}, fmt.Errorf("创建译文目录失败: %w", err)
	}
	workDir, err := os.MkdirTemp(filepath.Dir(outputPath), ".rpr-*")
	if err != nil {
		return Report{}, fmt.Errorf("创建渲染临时目录失败: %w", err)
	}
	defer os.RemoveAll(workDir)
	sourcePath := filepath.Join(workDir, "source.pdf")
	inputPath := filepath.Join(workDir, "input.json")
	reportPath := filepath.Join(workDir, "report.json")
	targetPath := filepath.Join(workDir, "translated.pdf")
	if err := os.WriteFile(sourcePath, sourcePDF, 0o600); err != nil {
		return Report{}, fmt.Errorf("写入原 PDF 失败: %w", err)
	}
	if err := os.WriteFile(inputPath, input, 0o600); err != nil {
		return Report{}, fmt.Errorf("写入排版输入失败: %w", err)
	}

	node, err := r.nodeBinary()
	if err != nil {
		return Report{}, err
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, node, script,
		"--engine", engineDir,
		"--input", inputPath,
		"--source", sourcePath,
		"--output", targetPath,
		"--fonts", fontDir,
		"--report", reportPath,
	)
	proctree.Configure(command)
	if sourcePage > 0 {
		command.Args = append(command.Args, "--page", strconv.Itoa(sourcePage))
	}
	if extract {
		command.Args = append(command.Args, "--extract", "1")
	}
	env := os.Environ()
	if strings.TrimSpace(os.Getenv("CBCT_ELECTRON_AS_NODE")) != "" {
		env = append(env, "ELECTRON_RUN_AS_NODE=1")
	}
	command.Env = env
	output, runErr := command.CombinedOutput()
	if runErr != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return Report{}, fmt.Errorf("排版超时（%s）", timeout)
		}
		return Report{}, fmt.Errorf("排版引擎失败: %s", engineError(output, runErr))
	}
	var engineReport struct {
		Engine struct {
			Name    string `json:"name"`
			Version string `json:"version"`
			Commit  string `json:"commit"`
		} `json:"engine"`
		Pages  []any `json:"pages"`
		Blocks []struct {
			Overflow bool `json:"overflow"`
		} `json:"blocks"`
		Collisions []any `json:"collisions"`
		Math       struct {
			Failed []any `json:"failed"`
		} `json:"math"`
		Timings map[string]any `json:"timings"`
	}
	reportBytes, readErr := os.ReadFile(reportPath)
	if readErr != nil {
		return Report{}, fmt.Errorf("排版引擎没有产出报告: %w", readErr)
	}
	if err := json.Unmarshal(reportBytes, &engineReport); err != nil {
		return Report{}, fmt.Errorf("排版报告不是合法 JSON: %w", err)
	}
	if err := replaceFile(targetPath, outputPath); err != nil {
		return Report{}, fmt.Errorf("保存译文 PDF 失败: %w", err)
	}
	overflow := 0
	for _, block := range engineReport.Blocks {
		if block.Overflow {
			overflow++
		}
	}
	return Report{
		Pages:        len(engineReport.Pages),
		Blocks:       len(engineReport.Blocks),
		Overflow:     overflow,
		Collisions:   len(engineReport.Collisions),
		FailedMath:   len(engineReport.Math.Failed),
		Timings:      engineReport.Timings,
		EngineName:   engineReport.Engine.Name,
		EngineVer:    engineReport.Engine.Version,
		EngineCommit: engineReport.Engine.Commit,
	}, nil
}

type inputPage struct {
	Index     int             `json:"index"`
	Width     float64         `json:"width"`
	Height    float64         `json:"height"`
	Blocks    []inputBlock    `json:"blocks"`
	Obstacles []inputObstacle `json:"obstacles,omitempty"`
}

type inputBlock struct {
	ID                string     `json:"id"`
	ItemID            string     `json:"item_id"`
	ContentBox        [4]float64 `json:"content_box"`
	CoverBox          [4]float64 `json:"cover_box"`
	CoverFill         []float64  `json:"cover_fill"`
	TextColor         []float64  `json:"text_color"`
	Text              string     `json:"text"`
	FontWeight        string     `json:"font_weight"`
	Align             string     `json:"align"`
	FirstLineIndentPt float64    `json:"first_line_indent_pt"`
	InsetTopPt        float64    `json:"inset_top_pt"`
	InsetBottomPt     float64    `json:"inset_bottom_pt"`
	ShiftUpPt         float64    `json:"shift_up_pt"`
	FontSizePt        float64    `json:"font_size_pt"`
	LeadingEm         float64    `json:"leading_em"`
	Fit               inputFit   `json:"fit"`
}

type inputFit struct {
	Mode           string   `json:"mode"`
	MinFontSizePt  float64  `json:"min_font_size_pt"`
	MaxFontSizePt  float64  `json:"max_font_size_pt"`
	MinLeadingEm   float64  `json:"min_leading_em"`
	MaxHeightPt    float64  `json:"max_height_pt"`
	TargetWidthPt  *float64 `json:"target_width_pt"`
	TargetHeightPt *float64 `json:"target_height_pt"`
}

type inputObstacle struct {
	ID   string     `json:"id"`
	Box  [4]float64 `json:"box"`
	Kind string     `json:"kind"`
}

type inputPayload struct {
	Schema string      `json:"schema"`
	Font   inputFont   `json:"font"`
	Pages  []inputPage `json:"pages"`
}

type inputFont struct {
	Family string `json:"family"`
}

func buildInput(pages []Page) ([]byte, inputPayload, error) {
	payload := inputPayload{Schema: inputSchema, Font: inputFont{Family: fontFamily}}
	usedIDs := map[string]bool{}
	blockCount := 0
	for pageIndex, page := range pages {
		if page.Width <= 0 || page.Height <= 0 {
			return nil, inputPayload{}, fmt.Errorf("第 %d 页尺寸无效", pageIndex+1)
		}
		entry := inputPage{Index: pageIndex, Width: round(page.Width), Height: round(page.Height)}
		for blockIndex, block := range page.Blocks {
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			box := block.Box
			if err := validBox(box); err != nil {
				return nil, inputPayload{}, fmt.Errorf("第 %d 页第 %d 块：%w", pageIndex+1, blockIndex+1, err)
			}
			box = clampBox(box, page.Width, page.Height)
			if box[2]-box[0] < minBoxSize {
				box[2] = math.Min(page.Width, box[0]+minBoxSize)
			}
			if box[3]-box[1] < minBoxSize {
				box[3] = math.Min(page.Height, box[1]+minBoxSize)
			}
			fontSize := block.FontSize
			if fontSize <= 0 {
				fontSize = 10
			}
			fontSize = math.Max(5, math.Min(fontSize, box[3]-box[1]))
			id := fmt.Sprintf("p%d-b%d", pageIndex+1, blockIndex+1)
			for usedIDs[id] {
				id += "x"
			}
			usedIDs[id] = true
			fill := block.Background
			if fill == [3]float64{} {
				fill = [3]float64{1, 1, 1}
			}
			align := strings.TrimSpace(block.Align)
			if align == "" {
				if block.Role == "body" && box[2]-box[0] > page.Width*0.25 {
					align = "justify"
				} else {
					align = "left"
				}
			}
			leading := 1.25
			if block.Role == "title" {
				leading = 1.18
			} else if block.Role == "caption" || block.Role == "note" {
				leading = 1.3
			}
			entry.Blocks = append(entry.Blocks, inputBlock{
				ID:         id,
				ItemID:     id,
				ContentBox: box,
				CoverBox:   box,
				CoverFill:  []float64{round(fill[0]), round(fill[1]), round(fill[2])},
				TextColor:  []float64{0.07, 0.07, 0.07},
				Text:       text,
				FontWeight: "regular",
				Align:      align,
				FontSizePt: round(fontSize),
				LeadingEm:  leading,
				Fit: inputFit{
					Mode:          "box_overlay",
					MinFontSizePt: round(math.Max(minFitFont, fontSize*0.55)),
					MaxFontSizePt: round(fontSize),
					MinLeadingEm:  0.9,
					MaxHeightPt:   round(box[3] - box[1]),
				},
			})
			blockCount++
		}
		payload.Pages = append(payload.Pages, entry)
	}
	if blockCount == 0 {
		return nil, inputPayload{}, errors.New("没有可渲染的译文块")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, inputPayload{}, err
	}
	return encoded, payload, nil
}

func validBox(box [4]float64) error {
	for _, value := range box {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return errors.New("坐标不是有限数值")
		}
	}
	if box[2] <= box[0] || box[3] <= box[1] {
		return errors.New("坐标框宽高必须为正")
	}
	return nil
}

func clampBox(box [4]float64, width, height float64) [4]float64 {
	box[0] = math.Max(0, math.Min(box[0], width-minBoxSize))
	box[1] = math.Max(0, math.Min(box[1], height-minBoxSize))
	box[2] = math.Max(box[0]+minBoxSize, math.Min(box[2], width))
	box[3] = math.Max(box[1]+minBoxSize, math.Min(box[3], height))
	return box
}

func round(value float64) float64 {
	return math.Round(value*1000) / 1000
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func engineError(output []byte, runErr error) string {
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var payload struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &payload); err == nil && payload.Error != "" {
			return payload.Error
		}
	}
	if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
		return strings.TrimSpace(lines[len(lines)-1])
	}
	return runErr.Error()
}

// replaceFile 先写临时文件再改名，避免中途失败留下半个 PDF。
func replaceFile(source, target string) error {
	if err := os.Rename(source, target); err == nil {
		return nil
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	temporary := target + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}
