package latex

import (
	"bufio"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// SyncTeXBox 是 PDF 页面坐标（pt，左上角原点，y 向下）里的一个同步高亮区域。
type SyncTeXBox struct {
	Page   int     `json:"page"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// SyncTeXForwardResult 是「源码位置 → PDF 位置」的解析结果。
type SyncTeXForwardResult struct {
	File  string       `json:"file"`
	Line  int          `json:"line"`
	Page  int          `json:"page"`
	Exact bool         `json:"exact"`
	Boxes []SyncTeXBox `json:"boxes"`
}

// SyncTeXLocation 是「PDF 点击坐标 → 源码文件与行号」的反向定位结果。
type SyncTeXLocation struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Page   int    `json:"page"`
}

type syncTeXNode struct {
	kind   byte // '[', '(', 'h', 'v', 'x', 'k', 'g', '$'
	file   string
	line   int
	column int
	page   int
	x      float64
	y      float64 // top in PDF pt (top-left origin)
	width  float64
	height float64
}

type syncTeXBoxFrame struct {
	kind   byte
	y      float64
	height float64
}

type syncTeXData struct {
	nodes []syncTeXNode
}

const maxSyncTeXBytes = 64 << 20

// BuildSyncTeXPath 返回某次编译对应的 .synctex.gz（或未压缩 .synctex）路径。
func (s *Service) BuildSyncTeXPath(ctx context.Context, buildID string) (string, *Build, error) {
	build, err := s.Build(ctx, buildID)
	if err != nil {
		return "", nil, err
	}
	buildDir, err := s.BuildDir(build.ProjectID, build.ID)
	if err != nil {
		return "", nil, err
	}
	jobName := strings.TrimSuffix(filepath.Base(build.MainFile), filepath.Ext(build.MainFile))
	for _, candidate := range []string{
		filepath.Join(buildDir, jobName+".synctex.gz"),
		filepath.Join(buildDir, jobName+".synctex"),
	} {
		if fileExists(candidate) {
			return candidate, build, nil
		}
	}
	return "", build, fmt.Errorf("%w: 这次编译没有生成 SyncTeX 索引，请先重新编译一次", ErrNotFound)
}

// ForwardSync 把项目内的「文件:行号」映射到 PDF 页码与矩形框。
func (s *Service) ForwardSync(ctx context.Context, buildID, relativeFile string, line int) (*SyncTeXForwardResult, error) {
	if line < 1 {
		line = 1
	}
	normalized, err := NormalizeRelative(relativeFile)
	if err != nil {
		return nil, err
	}
	syncPath, build, err := s.BuildSyncTeXPath(ctx, buildID)
	if err != nil {
		return nil, err
	}
	srcDir, err := s.SrcDir(build.ProjectID)
	if err != nil {
		return nil, err
	}
	data, err := parseSyncTeXFile(syncPath, srcDir)
	if err != nil {
		return nil, err
	}
	return forwardSyncFromData(data, normalized, line)
}

// ReverseSync 把 PDF 页码和点选坐标（PDF pt，左上角原点）反查回项目内源码位置。
func (s *Service) ReverseSync(ctx context.Context, buildID string, page int, x, y float64) (*SyncTeXLocation, error) {
	if page < 1 {
		return nil, errors.New("页码必须大于等于 1")
	}
	syncPath, build, err := s.BuildSyncTeXPath(ctx, buildID)
	if err != nil {
		return nil, err
	}
	srcDir, err := s.SrcDir(build.ProjectID)
	if err != nil {
		return nil, err
	}
	data, err := parseSyncTeXFile(syncPath, srcDir)
	if err != nil {
		return nil, err
	}
	return reverseSyncFromData(data, page, x, y)
}

func parseSyncTeXFile(syncPath, srcDir string) (*syncTeXData, error) {
	file, err := os.Open(syncPath)
	if err != nil {
		return nil, fmt.Errorf("打开 SyncTeX 文件失败: %w", err)
	}
	defer file.Close()

	var reader io.Reader = file
	if strings.HasSuffix(strings.ToLower(syncPath), ".gz") {
		gz, gzErr := gzip.NewReader(file)
		if gzErr != nil {
			return nil, fmt.Errorf("解压 SyncTeX 文件失败: %w", gzErr)
		}
		defer gz.Close()
		reader = gz
	}
	return parseSyncTeX(io.LimitReader(reader, maxSyncTeXBytes), srcDir)
}

func parseSyncTeX(reader io.Reader, srcDir string) (*syncTeXData, error) {
	inputs := map[int]string{}
	unit := int64(1)
	magnification := int64(1000)
	xOffset := int64(0)
	yOffset := int64(0)

	absSrcDir := ""
	if srcDir != "" {
		if abs, err := filepath.Abs(srcDir); err == nil {
			if realDir, linkErr := filepath.EvalSymlinks(abs); linkErr == nil {
				absSrcDir = realDir
			} else {
				absSrcDir = abs
			}
		}
	}

	inContent := false
	currentPage := 0
	var stack []syncTeXBoxFrame
	nodes := make([]syncTeXNode, 0, 512)

	factor := func() float64 {
		return (float64(unit) * float64(magnification) / 1000.0) * 72.0 / (65536.0 * 72.27)
	}

	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !inContent {
			switch {
			case strings.HasPrefix(line, "Input:"):
				rest := strings.TrimPrefix(line, "Input:")
				colon := strings.IndexByte(rest, ':')
				if colon <= 0 {
					continue
				}
				tag, err := strconv.Atoi(rest[:colon])
				if err != nil {
					continue
				}
				rawPath := rest[colon+1:]
				if rel := mapSyncTeXInputPath(absSrcDir, rawPath); rel != "" {
					inputs[tag] = rel
				}
			case strings.HasPrefix(line, "Unit:"):
				if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "Unit:")), 10, 64); err == nil && v > 0 {
					unit = v
				}
			case strings.HasPrefix(line, "Magnification:"):
				if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "Magnification:")), 10, 64); err == nil && v > 0 {
					magnification = v
				}
			case strings.HasPrefix(line, "X Offset:"):
				if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "X Offset:")), 10, 64); err == nil {
					xOffset = v
				}
			case strings.HasPrefix(line, "Y Offset:"):
				if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "Y Offset:")), 10, 64); err == nil {
					yOffset = v
				}
			case line == "Content:":
				inContent = true
			}
			continue
		}

		if strings.HasPrefix(line, "Postamble:") {
			break
		}
		if line[0] == '{' {
			if page, err := strconv.Atoi(line[1:]); err == nil && page > 0 {
				currentPage = page
				stack = stack[:0]
			}
			continue
		}
		if line[0] == '}' {
			currentPage = 0
			stack = stack[:0]
			continue
		}
		if currentPage == 0 {
			continue
		}
		if line[0] == ']' || line[0] == ')' {
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
			continue
		}

		kind := line[0]
		switch kind {
		case '[', '(', 'h', 'v', 'x', 'k', 'g', '$':
		default:
			continue
		}
		node, ok := parseSyncTeXRecord(kind, line[1:], currentPage, inputs, factor(), float64(xOffset)*factor(), float64(yOffset)*factor(), stack)
		if kind == '[' || kind == '(' {
			if ok {
				stack = append(stack, syncTeXBoxFrame{kind: kind, y: node.y, height: node.height})
			} else {
				stack = append(stack, syncTeXBoxFrame{kind: kind})
			}
		}
		if ok && node.file != "" && node.line > 0 {
			nodes = append(nodes, node)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("读取 SyncTeX 内容失败: %w", err)
	}
	return &syncTeXData{nodes: nodes}, nil
}

func parseSyncTeXRecord(kind byte, body string, page int, inputs map[int]string, f, xOff, yOff float64, stack []syncTeXBoxFrame) (syncTeXNode, bool) {
	parts := strings.Split(body, ":")
	if len(parts) < 2 {
		return syncTeXNode{}, false
	}
	tagLineCol := strings.Split(parts[0], ",")
	if len(tagLineCol) < 2 {
		return syncTeXNode{}, false
	}
	tag, err := strconv.Atoi(tagLineCol[0])
	if err != nil {
		return syncTeXNode{}, false
	}
	lineNum, err := strconv.Atoi(tagLineCol[1])
	if err != nil {
		return syncTeXNode{}, false
	}
	colNum := 0
	if len(tagLineCol) >= 3 {
		if c, cErr := strconv.Atoi(tagLineCol[2]); cErr == nil && c > 0 {
			colNum = c
		}
	}

	coords := strings.Split(parts[1], ",")
	if len(coords) < 2 {
		return syncTeXNode{}, false
	}
	hRaw, err := strconv.ParseInt(coords[0], 10, 64)
	if err != nil {
		return syncTeXNode{}, false
	}
	vRaw, err := strconv.ParseInt(coords[1], 10, 64)
	if err != nil {
		return syncTeXNode{}, false
	}
	xPt := float64(hRaw)*f + xOff
	vPt := float64(vRaw)*f + yOff

	var wPt, hPt, dPt float64
	if len(parts) >= 3 {
		dims := strings.Split(parts[2], ",")
		if len(dims) >= 1 {
			if wRaw, wErr := strconv.ParseInt(dims[0], 10, 64); wErr == nil {
				wPt = math.Max(0, float64(wRaw)*f)
			}
		}
		if len(dims) >= 2 {
			if hDimRaw, hErr := strconv.ParseInt(dims[1], 10, 64); hErr == nil {
				hPt = math.Max(0, float64(hDimRaw)*f)
			}
		}
		if len(dims) >= 3 {
			if dRaw, dErr := strconv.ParseInt(dims[2], 10, 64); dErr == nil {
				dPt = math.Max(0, float64(dRaw)*f)
			}
		}
	}

	topPt := vPt - hPt
	totalH := hPt + dPt
	if kind != '[' && kind != '(' && kind != 'h' && kind != 'v' {
		// 点记录（x/k/g/$）没有自己的高度：沿用最近 hbox 的高度让高亮与点击命中更准。
		if totalH <= 0 {
			for i := len(stack) - 1; i >= 0; i-- {
				if stack[i].kind == '(' && stack[i].height > 0 {
					topPt = stack[i].y
					totalH = stack[i].height
					break
				}
			}
		}
		if totalH <= 0 {
			totalH = 11
			topPt = vPt - 9
		}
		if wPt <= 0 {
			wPt = 18
		}
	}

	return syncTeXNode{
		kind:   kind,
		file:   inputs[tag],
		line:   lineNum,
		column: colNum,
		page:   page,
		x:      xPt,
		y:      topPt,
		width:  wPt,
		height: totalH,
	}, true
}

func mapSyncTeXInputPath(absSrcDir, rawPath string) string {
	cleaned := strings.TrimSpace(rawPath)
	if cleaned == "" {
		return ""
	}
	// TeX 经常产出诸如 `src/./sec/intro.tex` 这样的路径；统一清理后再校验边界。
	if absSrcDir != "" && isPlatformAbs(cleaned) {
		native := filepath.Clean(cleaned)
		rel, err := filepath.Rel(absSrcDir, native)
		if err != nil && runtime.GOOS == "windows" {
			// Windows 上盘符大小写可能不一致，做一次小写前缀回退。
			lowerSrc := strings.ToLower(absSrcDir)
			lowerTarget := strings.ToLower(native)
			if strings.HasPrefix(lowerTarget, lowerSrc+string(filepath.Separator)) {
				rel = native[len(absSrcDir)+1:]
				err = nil
			}
		}
		if err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			if normalized, normErr := NormalizeRelative(rel); normErr == nil {
				return normalized
			}
		}
		return ""
	}
	if normalized, err := NormalizeRelative(cleaned); err == nil {
		if absSrcDir != "" {
			if _, statErr := os.Stat(filepath.Join(absSrcDir, filepath.FromSlash(normalized))); statErr != nil {
				return ""
			}
		}
		return normalized
	}
	return ""
}

func isPlatformAbs(value string) bool {
	if filepath.IsAbs(value) || strings.HasPrefix(value, "/") {
		return true
	}
	return len(value) >= 2 && value[1] == ':'
}

func forwardSyncFromData(data *syncTeXData, file string, line int) (*SyncTeXForwardResult, error) {
	if len(data.nodes) == 0 {
		return nil, errors.New("SyncTeX 索引里没有可映射的源码位置")
	}
	var fileNodes []syncTeXNode
	for _, n := range data.nodes {
		if n.file == file {
			fileNodes = append(fileNodes, n)
		}
	}
	if len(fileNodes) == 0 {
		return nil, fmt.Errorf("这次编译的 SyncTeX 记录中没有包含「%s」", file)
	}

	bestLine := -1
	bestDiff := math.MaxInt
	for _, n := range fileNodes {
		diff := n.line - line
		if diff < 0 {
			diff = -diff
		}
		if diff < bestDiff || (diff == bestDiff && n.line > line && bestLine < line) {
			bestDiff = diff
			bestLine = n.line
		}
	}

	var matched []syncTeXNode
	for _, n := range fileNodes {
		if n.line == bestLine {
			matched = append(matched, n)
		}
	}

	// 同行可能跨页：优先挑选含盒子的第一页，或者出现次数最多的页。
	pageScore := map[int]int{}
	for _, n := range matched {
		weight := 1
		if n.kind == '(' || n.kind == 'h' {
			weight = 3
		}
		pageScore[n.page] += weight
	}
	targetPage := matched[0].page
	bestScore := -1
	for p, score := range pageScore {
		if score > bestScore || (score == bestScore && p < targetPage) {
			bestScore = score
			targetPage = p
		}
	}

	boxes := make([]SyncTeXBox, 0, len(matched))
	fallback := make([]SyncTeXBox, 0, len(matched))
	for _, n := range matched {
		if n.page != targetPage {
			continue
		}
		box := SyncTeXBox{
			Page:   n.page,
			X:      n.x,
			Y:      n.y,
			Width:  math.Max(n.width, 14),
			Height: math.Max(n.height, 9),
		}
		if n.kind == '(' || n.kind == 'h' {
			if box.Width > 0 && box.Height > 0 {
				boxes = append(boxes, box)
			}
		} else if n.kind != '[' {
			fallback = append(fallback, box)
		}
	}
	if len(boxes) == 0 {
		boxes = fallback
	}
	if len(boxes) == 0 {
		for _, n := range matched {
			if n.page == targetPage {
				boxes = append(boxes, SyncTeXBox{
					Page:   n.page,
					X:      n.x,
					Y:      n.y,
					Width:  math.Max(n.width, 40),
					Height: math.Max(n.height, 12),
				})
				break
			}
		}
	}
	boxes = mergeSyncBoxes(boxes)
	return &SyncTeXForwardResult{
		File:  file,
		Line:  bestLine,
		Page:  targetPage,
		Exact: bestLine == line,
		Boxes: boxes,
	}, nil
}

func mergeSyncBoxes(boxes []SyncTeXBox) []SyncTeXBox {
	if len(boxes) <= 1 {
		return boxes
	}
	sort.Slice(boxes, func(i, j int) bool {
		if math.Abs(boxes[i].Y-boxes[j].Y) > 4 {
			return boxes[i].Y < boxes[j].Y
		}
		return boxes[i].X < boxes[j].X
	})
	merged := []SyncTeXBox{boxes[0]}
	for _, b := range boxes[1:] {
		last := &merged[len(merged)-1]
		sameBand := math.Abs(b.Y-last.Y) <= 5 && math.Abs((b.Y+b.Height)-(last.Y+last.Height)) <= 6
		closeX := b.X <= last.X+last.Width+14 && last.X <= b.X+b.Width+14
		if sameBand && closeX {
			minX := math.Min(last.X, b.X)
			minY := math.Min(last.Y, b.Y)
			maxX := math.Max(last.X+last.Width, b.X+b.Width)
			maxY := math.Max(last.Y+last.Height, b.Y+b.Height)
			last.X = minX
			last.Y = minY
			last.Width = maxX - minX
			last.Height = maxY - minY
			continue
		}
		merged = append(merged, b)
	}
	return merged
}

func reverseSyncFromData(data *syncTeXData, page int, x, y float64) (*SyncTeXLocation, error) {
	bestFound := false
	bestDist := math.MaxFloat64
	bestArea := math.MaxFloat64
	bestRank := 99
	var bestNode syncTeXNode

	for _, n := range data.nodes {
		if n.page != page || n.file == "" || n.line <= 0 {
			continue
		}
		dist := pointBoxDistance(x, y, n.x, n.y, n.width, n.height)
		area := n.width * n.height
		if area <= 0 {
			area = 1
		}
		rank := syncNodeRank(n.kind)

		better := false
		if !bestFound {
			better = true
		} else if dist+1.5 < bestDist {
			better = true
		} else if math.Abs(dist-bestDist) <= 1.5 {
			if dist == 0 {
				// 点在多个嵌套盒子里时：最小的非容器盒（hbox / 点节点）最精确。
				if rank != bestRank && (n.kind == '[' || bestNode.kind == '[') {
					better = rank < bestRank
				} else if area+1 < bestArea {
					better = true
				} else if math.Abs(area-bestArea) <= 1 && rank < bestRank {
					better = true
				}
			} else if rank < bestRank || (rank == bestRank && area < bestArea) {
				better = true
			}
		}
		if better {
			bestFound = true
			bestDist = dist
			bestArea = area
			bestRank = rank
			bestNode = n
		}
	}
	if !bestFound {
		return nil, fmt.Errorf("第 %d 页没有找到可对应的项目源码位置", page)
	}
	return &SyncTeXLocation{
		File:   bestNode.file,
		Line:   bestNode.line,
		Column: bestNode.column,
		Page:   page,
	}, nil
}

func syncNodeRank(kind byte) int {
	switch kind {
	case 'x', '$', 'k', 'g':
		return 1
	case 'h', '(':
		return 2
	case 'v':
		return 3
	default:
		return 4
	}
}

func pointBoxDistance(px, py, bx, by, bw, bh float64) float64 {
	dx := 0.0
	if px < bx {
		dx = bx - px
	} else if px > bx+bw {
		dx = px - (bx + bw)
	}
	dy := 0.0
	if py < by {
		dy = by - py
	} else if py > by+bh {
		dy = py - (by + bh)
	}
	return math.Hypot(dx, dy)
}
