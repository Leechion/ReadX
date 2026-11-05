package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"cbctv2/server/internal/booksources"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/publication"
	"cbctv2/server/internal/sseio"
	"cbctv2/server/internal/translate"
)

const maxPublicationBytes = ocr.MaxPDFBytes
const maxPublicationUploadBytes = maxPublicationBytes*16 + (16 << 20)

type importResult struct {
	Document *DocumentSummary `json:"document,omitempty"`
	Name     string           `json:"name"`
	Existing bool             `json:"existing"`
	Error    string           `json:"error,omitempty"`
	Warning  string           `json:"warning,omitempty"`
}

type publicationMetadataHint struct {
	LocalOnly bool                  `json:"localOnly"`
	Title     string                `json:"title"`
	Author    string                `json:"author"`
	Authors   []string              `json:"authors"`
	Venue     string                `json:"venue"`
	Year      int                   `json:"year"`
	DOI       string                `json:"doi"`
	Arxiv     string                `json:"arxiv"`
	FirstPage string                `json:"firstPage"`
	Source    string                `json:"source"`
	Pages     []publicationPageHint `json:"pages"`
}

type recognizedPaperMetadata struct {
	Title           string
	TranslatedTitle string
	Pages           []publicationPageHint
	Translations    []translateSegment
	OCRPages        []ocr.Page
	// LayoutPages 是导入时 OCR 识别出的段落坐标：阅读器据此按原版式渲染译文页。
	LayoutPages       []layoutPage
	Untranslated      int
	TranslationQA     *translate.NumericQAReport
	Authors           []string
	DOI               string
	Venue             string
	Year              int
	LeeTranslatedPath string
	MetadataWarning   string
}

func (s *Server) importPublication(ctx context.Context, name, source string, data []byte, metadata ...recognizedPaperMetadata) (importResult, error) {
	result := importResult{Name: name}
	format := "pdf"
	var book publication.Book
	if limit := s.publicationByteLimit(); isPDFData(data) && int64(len(data)) > limit {
		return result, fmt.Errorf("单个 PDF 超过 OCR 处理上限 %d MB", limit>>20)
	}
	if !isPDFData(data) {
		format = "epub"
		var err error
		book, err = publication.ParseEPUB(data)
		if err != nil {
			return result, fmt.Errorf("文件必须是有效的 PDF 或 EPUB: %w", err)
		}
	}
	sum := sha256.Sum256(data)
	key := "doc-" + hex.EncodeToString(sum[:16])
	if existing, err := s.loadDocument(ctx, key); err == nil {
		existing, err = s.restoreDocumentFromTrash(ctx, key)
		if err != nil {
			return result, err
		}
		result.Document = &existing
		result.Existing = true
		return result, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	title := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	authors := []string{}
	if format == "epub" {
		if book.Title != "" {
			title = book.Title
		}
		authors = book.Authors
	}
	recognized := recognizedPaperMetadata{}
	if format == "pdf" && len(metadata) > 0 {
		recognized = metadata[0]
		if recognized.Title != "" {
			title = recognized.Title
		}
		authors = recognized.Authors
	}
	if authors == nil {
		authors = []string{}
	}
	if title == "" {
		title = "未命名文档"
	}
	dir := legacy.NewPaths(s.cfg.DataRoot).LibraryDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return result, err
	}
	target := filepath.Join(dir, key+"."+format)
	f, err := os.CreateTemp(dir, ".import-*")
	if err != nil {
		return result, err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return result, err
	}
	if err = f.Close(); err != nil {
		return result, err
	}
	if err = os.Rename(tmp, target); err != nil {
		// A concurrent identical import may already have created the same immutable file.
		prior, readErr := os.ReadFile(target)
		if readErr != nil || sha256.Sum256(prior) != sum {
			return result, err
		}
	}
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	authorJSON, _ := json.Marshal(authors)
	stamp := nowStamp()
	var year any
	if recognized.Year > 0 {
		year = recognized.Year
	}
	_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO documents(id,key,title,authors,url,pdf_path,added_at,updated_at,format,doi,venue,year,translated_title) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, key, key, title, string(authorJSON), source, target, stamp, stamp, format, recognized.DOI, recognized.Venue, year, recognized.TranslatedTitle)
	if err != nil {
		return result, err
	}
	for _, section := range book.Sections {
		blocks, _ := json.Marshal(section.Blocks)
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO document_sections(document_id,ordinal,href,title,blocks_json,text) VALUES(?,?,?,?,?,?)`, key, section.Index, section.Href, section.Title, string(blocks), section.Text); err != nil {
			return result, err
		}
	}
	if err = saveImportText(ctx, tx, key, stamp, recognized); err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	doc, err := s.loadDocument(ctx, key)
	result.Document = &doc
	if recognized.Untranslated > 0 {
		result.Warning = fmt.Sprintf("%d 段文本暂未获得有效译文；论文原文已入库，可稍后重试翻译", recognized.Untranslated)
	}
	if recognized.MetadataWarning != "" {
		result.Warning = strings.Trim(strings.Join([]string{result.Warning, recognized.MetadataWarning}, "；"), "；")
	}
	return result, err
}

func isPDFData(data []byte) bool {
	return strings.HasPrefix(string(data[:min(len(data), 1024)]), "%PDF-")
}

func (s *Server) handlePublicationUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxPublicationUploadBytes)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "单次上传总量超过 528 MB")
		} else {
			writeError(w, http.StatusBadRequest, "multipart 表单无效")
		}
		return
	}
	defer r.MultipartForm.RemoveAll()
	files := r.MultipartForm.File["files"]
	if len(files) == 0 || len(files) > 16 {
		writeError(w, 400, "每次请选择 1–16 个 PDF / EPUB 文件（单个 PDF 不超过 50 MB；单次上传总量不超过 816 MB）")
		return
	}
	var hints []publicationMetadataHint
	if raw := r.MultipartForm.Value["metadata"]; len(raw) > 0 && strings.TrimSpace(raw[0]) != "" {
		if err := json.Unmarshal([]byte(raw[0]), &hints); err != nil || len(hints) != len(files) {
			writeError(w, http.StatusBadRequest, "PDF 元数据提示与上传文件数量不匹配")
			return
		}
	}
	results := make([]importResult, len(files))
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r = r.WithContext(ctx)
	report, finish, stop := importEvents(w, r, cancel)
	defer stop()
	semaphore := make(chan struct{}, 14)
	var workers sync.WaitGroup
	for index := range files {
		if r.Context().Err() != nil {
			break
		}
		semaphore <- struct{}{}
		workers.Add(1)
		go func(index int) {
			file := files[index]
			defer workers.Done()
			defer func() { <-semaphore }()
			update := func(stage, message string, completed, total int) {
				report(importProgress{Stage: stage, Message: message, Name: file.Filename, File: index + 1, Files: len(files), Completed: completed, Total: total})
			}
			update("received", "上传已接收，正在检查文件", 0, 0)
			func() {
				result := importResult{Name: file.Filename}
				defer func() {
					result.Name = file.Filename
					results[index] = result
				}()
				f, err := file.Open()
				if err != nil {
					result.Error = err.Error()
					return
				}
				defer f.Close()
				limit := s.publicationByteLimit()
				data, err := io.ReadAll(io.LimitReader(f, limit+1))
				if err == nil && int64(len(data)) > limit {
					err = fmt.Errorf("单个文件超过 %d MB", limit>>20)
				}
				if err == nil {
					if isPDFData(data) {
						hint := publicationMetadataHint{}
						if index < len(hints) {
							hint = hints[index]
						}
						if hint.LocalOnly {
							metadata := recognizedPaperMetadata{Title: strings.TrimSpace(hint.Title), DOI: strings.TrimSpace(hint.DOI), Authors: hint.Authors, Venue: strings.TrimSpace(hint.Venue), Year: hint.Year}
							if len(metadata.Authors) == 0 && strings.TrimSpace(hint.Author) != "" {
								metadata.Authors = []string{strings.TrimSpace(hint.Author)}
							}
							update("saving", "正在保存原文，不调用 AI 或 OCR", 0, 1)
							result, err = s.importPublication(ctx, file.Filename, hint.Source, data, metadata)
							if err != nil {
								result.Error = err.Error()
							}
							return
						}
						sum := sha256.Sum256(data)
						jobKey := "doc-" + hex.EncodeToString(sum[:16])
						if _, lookupErr := s.loadDocument(ctx, jobKey); lookupErr == nil {
							doc, restoreErr := s.restoreDocumentFromTrash(ctx, jobKey)
							if restoreErr != nil {
								result.Error = restoreErr.Error()
								return
							}
							update("metadata", "论文已在库中，正在联网补齐缺失的出版信息", 0, 1)
							doc, result.Warning, restoreErr = s.completeExistingPDFMetadata(ctx, file.Filename, doc)
							if restoreErr != nil {
								result.Error = restoreErr.Error()
								return
							}
							result.Document = &doc
							result.Existing = true
							update("saving", "已恢复书库中的论文，复用原有处理结果", 1, 1)
							return
						} else if !errors.Is(lookupErr, sql.ErrNoRows) {
							result.Error = lookupErr.Error()
							return
						}
						jobCtx, jobCancel := context.WithCancel(ctx)
						defer jobCancel()
						if s.beginImportJob(jobKey, file.Filename, len(hint.Pages), jobCancel) == nil {
							result.Error = "相同论文已有导入任务正在运行，请查看处理进度"
							return
						}
						// 先把这个 key 告知前端：文件刚进篮筐就能打开任务面板并轮询进度。
						report(importProgress{Stage: "ocr", Message: "任务已创建，等待 OCR", Name: file.Filename, File: index + 1, Files: len(files), JobKey: jobKey})
						s.jobStage(jobKey, "ocr", "running", "正在执行 OCR 与段落整理", 0, len(hint.Pages))
						update("ocr", "正在识别论文并整理段落", 0, 0)
						metadata := recognizedPaperMetadata{Title: strings.TrimSpace(hint.Title), DOI: strings.TrimSpace(hint.DOI), Authors: hint.Authors, Venue: strings.TrimSpace(hint.Venue), Year: hint.Year}
						if author := strings.TrimSpace(hint.Author); len(metadata.Authors) == 0 && author != "" {
							metadata.Authors = []string{author}
						}
						sizes, _ := importPageSizes(hint.Pages)
						var processErr error
						result, processErr = s.runLocalPDFImport(jobCtx, file.Filename, hint.Source, data, sizes, &metadata, func(stage, message string, completed, total int) {
							update(stage, message, completed, total)
						})
						if processErr != nil {
							result.Error = processErr.Error()
							status := importFailureStatus(jobCtx, processErr)
							message := processErr.Error()
							if status == "cancelled" {
								message = "已取消"
							}
							s.finishImportJob(jobKey, status, message)
							return
						}
						if result.Document != nil {
							update("saving", "原文与 OCR 段落译文已保存", 1, 1)
							if err = s.saveRecognizedPDFMetadata(jobCtx, result.Document.ID, strings.TrimSuffix(filepath.Base(file.Filename), filepath.Ext(file.Filename)), metadata); err == nil {
								updated, loadErr := s.loadDocument(jobCtx, result.Document.Key)
								if loadErr != nil {
									err = loadErr
								} else {
									result.Document = &updated
								}
							}
							if err != nil {
								result.Error = err.Error()
								status := importFailureStatus(jobCtx, err)
								message := err.Error()
								if status == "cancelled" {
									message = "已取消"
								}
								s.finishImportJob(jobKey, status, message)
							} else if len(metadata.LayoutPages) == 0 {
								result.Error = "OCR 没有保存可供排版的段落"
								s.finishImportJob(jobKey, "failed", result.Error)
							} else {
								// OCR 入库后后台翻译/排版仍在运行；由后台 worker 收尾任务。
							}
						}
					} else {
						sum := sha256.Sum256(data)
						jobKey := "doc-" + hex.EncodeToString(sum[:16])
						jobCtx, jobCancel := context.WithCancel(ctx)
						defer jobCancel()
						if s.beginImportJob(jobKey, file.Filename, 0, jobCancel) == nil {
							result.Error = "相同文档已有导入任务正在运行"
							return
						}
						s.jobStage(jobKey, "ocr", "skipped", "EPUB 使用章节结构，无需 OCR", -1, -1)
						s.jobStage(jobKey, "translate", "skipped", "当前 EPUB 导入流程不执行 PDF 段落翻译", -1, -1)
						s.jobStage(jobKey, "render", "skipped", "EPUB 按原章节结构阅读，无需 PDF 渲染", -1, -1)
						s.jobStage(jobKey, "memory", "skipped", "EPUB 使用章节正文，不需要 PDF 论文记忆", -1, -1)
						report(importProgress{Stage: "saving", Message: "正在解析 EPUB 章节并保存到书库", Name: file.Filename, File: index + 1, Files: len(files), JobKey: jobKey})
						update("saving", "正在解析 EPUB 章节并保存到书库", 0, 0)
						source := ""
						if index < len(hints) {
							source = hints[index].Source
						}
						result, err = s.importPublication(jobCtx, file.Filename, source, data)
						if err != nil {
							s.finishImportJob(jobKey, importFailureStatus(jobCtx, err), err.Error())
						} else {
							s.finishImportJob(jobKey, "done", "")
						}
					}
				}
				if err != nil {
					result.Error = err.Error()
				}
			}()
			last := results[index]
			if last.Error != "" {
				update("failed", last.Error, 0, 0)
			} else {
				update("done", "该文件已完成导入", 1, 1)
			}
		}(index)
	}
	workers.Wait()
	if r.Context().Err() != nil {
		return
	}
	finish(results)
}

// runLocalPDFImport keeps ReadX as the upload entry point and delegates PDF
// recognition, translation, and rendering to the vendored LeePDF pipeline.
func (s *Server) runLocalPDFImport(
	ctx context.Context,
	name, source string,
	pdf []byte,
	sizes []ocr.Size,
	metadata *recognizedPaperMetadata,
	progress func(stage, message string, completed, total int),
) (importResult, error) {
	if metadata == nil {
		metadata = &recognizedPaperMetadata{}
	}
	_ = sizes // Lee reads page count and exact geometry directly from the PDF.
	if progress != nil {
		progress("ocr", "Lee 正在识别并处理论文", 0, 0)
	}
	contentHash := sha256.Sum256(pdf)
	jobKey := "doc-" + hex.EncodeToString(contentHash[:16])
	// URL imports acquire their content identity only after download. Recheck the
	// document rule before OCR or metadata completion can send this content out.
	policy, policyErr := s.processingPolicy(ctx)
	if policyErr != nil {
		return importResult{Name: name}, policyErr
	}
	mode, modeErr := s.processingDocumentMode(ctx, policy, jobKey)
	if modeErr != nil {
		return importResult{Name: name}, modeErr
	}
	if mode == "deny" {
		return importResult{Name: name}, fmt.Errorf("该论文或书库禁止外部处理，未提交 OCR／题录补全")
	}
	if _, lookupErr := s.loadDocument(ctx, jobKey); lookupErr == nil {
		doc, restoreErr := s.restoreDocumentFromTrash(ctx, jobKey)
		if restoreErr != nil {
			return importResult{Name: name}, restoreErr
		}
		result := importResult{Name: name, Document: &doc, Existing: true}
		if progress != nil {
			progress("metadata", "论文已在库中，正在联网补齐缺失的出版信息", 0, 1)
		}
		doc, result.Warning, restoreErr = s.completeExistingPDFMetadata(ctx, name, doc)
		if restoreErr != nil {
			return result, restoreErr
		}
		result.Document = &doc
		if progress != nil {
			progress("saving", "已恢复书库中的论文，复用原有处理结果", 1, 1)
		}
		return result, nil
	} else if !errors.Is(lookupErr, sql.ErrNoRows) {
		return importResult{Name: name}, lookupErr
	}
	_, err := s.runLeePDFImport(ctx, jobKey, name, pdf, metadata)
	if err != nil {
		return importResult{Name: name}, err
	}
	if err := ctx.Err(); err != nil {
		return importResult{Name: name}, err
	}
	result, err := s.importPublication(ctx, name, source, pdf, *metadata)
	if err != nil {
		return result, err
	}
	if result.Document != nil {
		s.linkImportJobDocument(jobKey, result.Document.Key)
		s.jobStage(jobKey, "memory", "running", "论文原文已入库，正在后台准备论文记忆", 0, 1)
		memoryCtx, cancelMemory := s.processingBackground(ctx, 6*time.Hour)
		go func() {
			defer cancelMemory()
			_ = s.preparePaperMemoryDuringImport(memoryCtx, result.Document.Key, jobKey, nil)
		}()
		backgroundCtx, cancelBackground := s.processingBackground(ctx, 24*time.Hour)
		s.setJobCancel(jobKey, cancelBackground)
		pages := append([]ocr.Page(nil), metadata.OCRPages...)
		go func() {
			defer cancelBackground()
			s.runLeeTranslationInBackground(backgroundCtx, jobKey, result.Document.Key, name, pages, false)
		}()
	}
	if progress != nil {
		progress("saving", "原文与 OCR 段落已入库，可立即阅读；全文翻译在后台继续", 1, 1)
	}
	return result, nil
}

// Public-only dialing applies again to redirects and DNS results, avoiding a URL import
// becoming a way to read loopback services or private network files.
func publicHTTPClient() *http.Client {
	// 拨号防护共享 booksources 的实现：此前这里缺 CGNAT 100.64.0.0/10 与
	// TEST-NET/240.0.0.0/4 等保留网段，https 起始的重定向链还允许降级到 http。
	transport := &http.Transport{
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		DialContext:           booksources.DialPublicGuard(15*time.Second, nil),
	}
	return &http.Client{
		Transport: transport,
		Timeout:   90 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return publicRedirectCheck(via, req)
		},
	}
}

// publicRedirectCheck 重定向逐跳复检 URL 策略，且 https 起始的请求链不得降级到
// http（此前允许）。http 起始的既有导入行为保持不变。
func publicRedirectCheck(via []*http.Request, next *http.Request) error {
	if len(via) > 5 {
		return fmt.Errorf("重定向过多")
	}
	if err := validateRemoteURL(next.URL); err != nil {
		return err
	}
	if len(via) > 0 && via[0].URL.Scheme == "https" && next.URL.Scheme == "http" {
		return fmt.Errorf("重定向不得降级到 http")
	}
	return nil
}
func validateRemoteURL(u *url.URL) error {
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return fmt.Errorf("请输入公开的 http/https 地址")
	}
	return nil
}
func fetchPublic(ctx context.Context, raw string, limit int64) ([]byte, string, error) {
	return fetchPublicProgress(ctx, raw, limit, nil)
}
func fetchPublicProgress(ctx context.Context, raw string, limit int64, progress func(int64, int64)) ([]byte, string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	if err = validateRemoteURL(u); err != nil {
		return nil, "", err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "CBCT-Reader/2 (local document import)")
	client := publicHTTPClient()
	if limit > 4<<20 {
		client.Timeout = 15 * time.Minute
	}
	defer client.CloseIdleConnections()
	res, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if res.ContentLength > limit {
		return nil, "", fmt.Errorf("远程文件超过大小上限")
	}
	if res.StatusCode != 200 {
		return nil, "", fmt.Errorf("下载返回 HTTP %d", res.StatusCode)
	}
	b, err := readPublicationDownload(res.Body, limit, res.ContentLength, progress)
	if int64(len(b)) > limit {
		return nil, "", fmt.Errorf("远程文件超过大小上限")
	}
	return b, res.Request.URL.String(), err
}
func readPublicationDownload(reader io.Reader, limit, total int64, progress func(int64, int64)) ([]byte, error) {
	var data []byte
	buffer := make([]byte, 64<<10)
	last := time.Time{}
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			if int64(len(data)+n) > limit {
				return nil, fmt.Errorf("远程文件超过大小上限")
			}
			data = append(data, buffer[:n]...)
			if progress != nil && time.Since(last) > 250*time.Millisecond {
				progress(int64(len(data)), total)
				last = time.Now()
			}
		}
		if err == io.EOF {
			if progress != nil {
				progress(int64(len(data)), total)
			}
			return data, nil
		}
		if err != nil {
			return nil, err
		}
	}
}

var arxivID = regexp.MustCompile(`^(?:\d{4}\.\d{4,5}|[a-zA-Z.-]+/\d{7})(?:v\d+)?$`)

func remotePublicationURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, "arXiv:")
	if arxivID.MatchString(value) {
		return "https://arxiv.org/pdf/" + value, nil
	}
	u, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	if strings.EqualFold(u.Hostname(), "arxiv.org") {
		id := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(u.Path, "/abs/"), "/pdf/"), ".pdf")
		if arxivID.MatchString(id) {
			return "https://arxiv.org/pdf/" + id, nil
		}
	}
	if err = validateRemoteURL(u); err != nil {
		return "", err
	}
	return value, nil
}

type paperCandidate struct {
	Title   string   `json:"title"`
	DOI     string   `json:"doi"`
	URL     string   `json:"url"`
	Authors []string `json:"authors"`
	Venue   string   `json:"venue,omitempty"`
	Year    int      `json:"year,omitempty"`
	Arxiv   string   `json:"arxiv,omitempty"`
}

func lookupOpenAlex(ctx context.Context, q string) ([]paperCandidate, error) {
	endpoint := "https://api.openalex.org/works?per-page=8&search=" + url.QueryEscape(q)
	doi := strings.TrimPrefix(strings.TrimPrefix(q, "https://doi.org/"), "doi:")
	single := strings.HasPrefix(doi, "10.")
	if single {
		endpoint = "https://api.openalex.org/works/https://doi.org/" + url.PathEscape(doi)
	}
	b, _, err := fetchPublic(ctx, endpoint, 4<<20)
	if err != nil {
		return nil, err
	}
	type work struct {
		Title           string `json:"title"`
		DOI             string `json:"doi"`
		Year            int    `json:"publication_year"`
		PrimaryLocation *struct {
			Source *struct {
				Name string `json:"display_name"`
			} `json:"source"`
		} `json:"primary_location"`
		HostVenue *struct {
			Name string `json:"display_name"`
		} `json:"host_venue"`
		IDs struct {
			Arxiv string `json:"arxiv"`
		} `json:"ids"`
		OA struct {
			URL string `json:"oa_url"`
		} `json:"open_access"`
		Best *struct {
			PDF string `json:"pdf_url"`
		} `json:"best_oa_location"`
		Authorships []struct {
			Author struct {
				Name string `json:"display_name"`
			} `json:"author"`
		} `json:"authorships"`
	}
	var works []work
	if single {
		var item work
		if err = json.Unmarshal(b, &item); err != nil {
			return nil, err
		}
		works = append(works, item)
	} else {
		var response struct {
			Results []work `json:"results"`
		}
		if err = json.Unmarshal(b, &response); err != nil {
			return nil, err
		}
		works = response.Results
	}
	out := []paperCandidate{}
	for _, item := range works {
		link := ""
		if item.Best != nil {
			link = item.Best.PDF
		}
		if link == "" {
			link = item.OA.URL
		}
		authors := []string{}
		for _, a := range item.Authorships {
			authors = append(authors, a.Author.Name)
		}
		venue := ""
		if item.PrimaryLocation != nil && item.PrimaryLocation.Source != nil {
			venue = item.PrimaryLocation.Source.Name
		}
		if venue == "" && item.HostVenue != nil {
			venue = item.HostVenue.Name
		}
		out = append(out, paperCandidate{Title: item.Title, DOI: item.DOI, URL: link, Authors: authors, Venue: venue, Year: item.Year, Arxiv: item.IDs.Arxiv})
	}
	return out, nil
}
func (s *Server) handleImportSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 1000 {
		writeError(w, 400, "请输入 DOI 或论文标题")
		return
	}
	items, err := lookupPapers(r.Context(), q)
	if err != nil {
		writeError(w, 502, "查找论文失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"results": items})
}

// handleDocumentArxivPDF downloads a title-matched arXiv PDF into the existing
// library record, preserving its key, notes, status, and other reading data.
func (s *Server) handleDocumentArxivPDF(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Arxiv string `json:"arxiv"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	id := normalizeArxiv(body.Arxiv)
	if !arxivID.MatchString(id) {
		writeError(w, http.StatusBadRequest, "arXiv 编号无效")
		return
	}
	document, err := s.loadDocument(r.Context(), key)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "书库中没有这篇论文")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if document.HasPDF {
		writeError(w, http.StatusConflict, "这篇论文已经有 PDF")
		return
	}

	out := sseio.Begin(w)
	emit := out.Send

	link := "https://arxiv.org/pdf/" + id
	emit(map[string]any{"progress": map[string]any{"stage": "download", "message": "正在从 arXiv 下载论文 PDF", "received": 0, "total": 0}})
	download := s.downloadPublication
	if download == nil {
		download = fetchPublicProgress
	}
	data, _, err := download(r.Context(), link, s.publicationByteLimit(), func(received, total int64) {
		emit(map[string]any{"progress": map[string]any{"stage": "download", "message": "正在下载 arXiv PDF", "received": received, "total": total}})
	})
	if err != nil && r.Context().Err() == nil {
		fallback := strings.Replace(link, "https://arxiv.org", "https://export.arxiv.org", 1)
		data, _, err = download(r.Context(), fallback, s.publicationByteLimit(), nil)
	}
	if err != nil {
		emit(map[string]any{"error": "arXiv 下载失败: " + err.Error()})
		return
	}
	if !bytes.HasPrefix(data, []byte("%PDF-")) {
		emit(map[string]any{"error": "arXiv 返回的内容不是有效 PDF"})
		return
	}
	processCtx, timeoutCancel := context.WithTimeout(r.Context(), 6*time.Hour)
	defer timeoutCancel()
	jobCtx, jobCancel := context.WithCancel(processCtx)
	defer jobCancel()
	name := strings.TrimSpace(document.Title)
	if name == "" {
		name = id
	}
	if !strings.HasSuffix(strings.ToLower(name), ".pdf") {
		name += ".pdf"
	}
	if s.beginImportJob(key, name, 0, jobCancel) == nil {
		emit(map[string]any{"error": "这篇论文已有导入任务正在运行"})
		return
	}
	metadata := recognizedPaperMetadata{Title: document.Title, TranslatedTitle: document.TranslatedTitle, DOI: document.DOI, Authors: document.Authors, Venue: document.Venue}
	if document.Year != nil {
		metadata.Year = *document.Year
	}
	emit(map[string]any{"progress": map[string]any{"stage": "ocr", "message": "Lee 正在识别并处理论文", "completed": 0, "total": 0}})
	_, err = s.runLeePDFImport(jobCtx, key, name, data, &metadata)
	if err != nil {
		s.finishImportJob(key, importFailureStatus(jobCtx, err), err.Error())
		emit(map[string]any{"error": "论文 OCR 与翻译失败: " + err.Error()})
		return
	}
	emit(map[string]any{"progress": map[string]any{"stage": "saving", "message": "正在保存 Lee 处理结果", "completed": 0, "total": 1}})

	paths := legacy.NewPaths(s.cfg.DataRoot)
	dir := paths.LibraryDir()
	if err = os.MkdirAll(dir, 0755); err != nil {
		emit(map[string]any{"error": "无法创建书库文件夹: " + err.Error()})
		return
	}
	target := filepath.Join(dir, key+".pdf")
	if _, statErr := os.Stat(target); statErr == nil {
		emit(map[string]any{"error": "书库中已存在该文件，未覆盖"})
		return
	} else if !errors.Is(statErr, os.ErrNotExist) {
		emit(map[string]any{"error": "无法检查书库文件: " + statErr.Error()})
		return
	}
	tmp, err := os.CreateTemp(dir, ".arxiv-download-*")
	if err != nil {
		emit(map[string]any{"error": "无法创建临时文件: " + err.Error()})
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		emit(map[string]any{"error": "保存 PDF 失败: " + err.Error()})
		return
	}
	if err = os.Rename(tmpName, target); err != nil {
		emit(map[string]any{"error": "移动 PDF 到书库失败: " + err.Error()})
		return
	}
	// 关联失败时不能无条件删文件：并发请求 B 可能已经把这个 target 写进另一条
	// documents 行（同一篇的论文只有一行，但双击/重试会让两个请求都走到这里）。
	// 只有确认没有任何行引用它，才清理这个孤儿文件。
	tx, err := s.handle.BeginTx(r.Context(), nil)
	if err != nil {
		s.removeUnreferencedLibraryFile(r.Context(), target)
		emit(map[string]any{"error": "PDF 已下载，但无法开启书库事务: " + err.Error()})
		return
	}
	defer tx.Rollback()
	stamp := nowStamp()
	update, err := tx.ExecContext(r.Context(), `UPDATE documents SET pdf_path=?,url=?,format='pdf',updated_at=? WHERE id=? AND pdf_path=?`, target, "https://arxiv.org/abs/"+id, stamp, key, document.PDFPath)
	if err != nil {
		tx.Rollback()
		s.removeUnreferencedLibraryFile(r.Context(), target)
		emit(map[string]any{"error": "PDF 已下载，但关联书库条目失败: " + err.Error()})
		return
	}
	if err = saveImportText(r.Context(), tx, key, stamp, metadata); err != nil {
		tx.Rollback()
		s.removeUnreferencedLibraryFile(r.Context(), target)
		emit(map[string]any{"error": "PDF 已下载，但保存 OCR 译文失败: " + err.Error()})
		return
	}
	if changed, _ := update.RowsAffected(); changed != 1 {
		tx.Rollback()
		s.removeUnreferencedLibraryFile(r.Context(), target)
		emit(map[string]any{"error": "书库条目已被其他操作更新，请刷新后重试"})
		return
	}
	if err = tx.Commit(); err != nil {
		s.removeUnreferencedLibraryFile(r.Context(), target)
		emit(map[string]any{"error": "提交论文 OCR 译文失败: " + err.Error()})
		return
	}
	if err = s.saveRecognizedPDFMetadata(r.Context(), key, document.Title, metadata); err != nil {
		emit(map[string]any{"error": "PDF 已关联，但保存补齐的出版信息失败: " + err.Error()})
		return
	}
	s.linkImportJobDocument(key, key)
	s.jobStage(key, "memory", "running", "论文原文已入库，正在后台准备论文记忆", 0, 1)
	memoryCtx, cancelMemory := s.processingBackground(r.Context(), 6*time.Hour)
	go func() {
		defer cancelMemory()
		_ = s.preparePaperMemoryDuringImport(memoryCtx, key, key, nil)
	}()
	backgroundCtx, cancelBackground := s.processingBackground(r.Context(), 24*time.Hour)
	s.setJobCancel(key, cancelBackground)
	ocrPages := append([]ocr.Page(nil), metadata.OCRPages...)
	go func() {
		defer cancelBackground()
		s.runLeeTranslationInBackground(backgroundCtx, key, key, name, ocrPages, false)
	}()
	updated, err := s.loadDocument(r.Context(), key)
	if err != nil {
		emit(map[string]any{"error": "PDF 已关联，但刷新书目信息失败: " + err.Error()})
		return
	}
	emit(map[string]any{"result": map[string]any{"document": updated, "name": document.Title, "existing": false, "warning": metadata.MetadataWarning}})
}

// removeUnreferencedLibraryFile 只清理由 ReadX library 目录管理、且不再被 documents 引用的普通文件。
// 用于「文件已写入但关联失败」的清理：若并发请求已经把它写进另一条行，文件归对方所有。
func (s *Server) removeUnreferencedLibraryFile(ctx context.Context, target string) bool {
	target, ok := managedLibraryFilePath(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), target)
	if !ok {
		return false
	}
	var refs int
	if err := s.handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM documents WHERE pdf_path = ?`, target).Scan(&refs); err != nil || refs > 0 {
		return false
	}
	info, err := os.Lstat(target)
	if err != nil || info.IsDir() {
		return false
	}
	return os.Remove(target) == nil
}

func (s *Server) handlePublicationURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Value        string   `json:"value"`
		DownloadOnly bool     `json:"downloadOnly"`
		Title        string   `json:"title"`
		DOI          string   `json:"doi"`
		Authors      []string `json:"authors"`
		Venue        string   `json:"venue"`
		Year         int      `json:"year"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	value := strings.TrimSpace(body.Value)
	if strings.HasPrefix(value, "10.") || strings.HasPrefix(value, "doi:") || strings.Contains(value, "doi.org/") {
		items, err := lookupPapers(r.Context(), value)
		if err != nil || len(items) == 0 || items[0].URL == "" {
			writeError(w, 422, "没有找到公开全文，请选择本地文件")
			return
		}
		value = items[0].URL
		body.Title = items[0].Title
		body.DOI = items[0].DOI
		body.Authors = items[0].Authors
		body.Venue = items[0].Venue
		body.Year = items[0].Year
	}
	link, err := remotePublicationURL(value)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	stream := !body.DownloadOnly && strings.Contains(r.Header.Get("Accept"), "text/event-stream")
	// JSON 模式不发 SSE 头；emit 保持为空函数，与原实现「只在 stream 分支写帧」一致。
	var out *sseio.Writer
	emit := func(any) {}
	if stream {
		out = sseio.Begin(w)
		emit = out.Send
		emit(map[string]any{"progress": map[string]int64{"received": 0, "total": 0}})
	}
	fail := func(status int, message string) {
		if stream {
			emit(map[string]any{"error": message})
		} else {
			writeError(w, status, message)
		}
	}
	var progress func(int64, int64)
	if stream {
		progress = func(received, total int64) {
			emit(map[string]any{"progress": map[string]int64{"received": received, "total": total}})
		}
	}
	download := s.downloadPublication
	if download == nil {
		download = fetchPublicProgress
	}
	data, final, err := download(r.Context(), link, s.publicationByteLimit(), progress)
	if err != nil && r.Context().Err() == nil {
		u, _ := url.Parse(link)
		if u != nil && u.Hostname() == "arxiv.org" {
			u.Host = "export.arxiv.org"
			data, final, err = download(r.Context(), u.String(), s.publicationByteLimit(), progress)
		}
	}
	if err != nil {
		fail(502, "下载失败: "+err.Error())
		return
	}
	name := body.Title
	if name == "" {
		u, _ := url.Parse(final)
		name = filepath.Base(u.Path)
	}
	if !strings.HasSuffix(strings.ToLower(name), ".pdf") && !strings.HasSuffix(strings.ToLower(name), ".epub") {
		name += ".pdf"
	}
	if body.DownloadOnly {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.Header().Set("X-Publication-Name", url.QueryEscape(name))
		w.Header().Set("X-Publication-Source", url.QueryEscape(final))
		w.Write(data)
		return
	}
	var result importResult
	if bytes.HasPrefix(data, []byte("%PDF-")) {
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Hour)
		defer cancel()
		metadata := recognizedPaperMetadata{
			Title:   strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(body.Title), ".pdf"), ".PDF"),
			DOI:     strings.TrimPrefix(strings.TrimSpace(body.DOI), "https://doi.org/"),
			Authors: body.Authors, Venue: body.Venue, Year: body.Year,
		}
		result, err = s.runLocalPDFImport(ctx, name, final, data, nil, &metadata, func(stage, message string, completed, total int) {
			if stream {
				emit(map[string]any{"progress": map[string]any{"stage": stage, "message": message, "completed": completed, "total": total}})
			}
		})
		if err != nil {
			fail(http.StatusBadGateway, "论文 OCR 与翻译失败："+err.Error())
			return
		}
	} else {
		result, err = s.importPublication(r.Context(), name, final, data)
	}
	if err != nil {
		fail(422, "链接未返回可读 PDF/EPUB；可能需要登录或是网页: "+err.Error())
		return
	}
	if stream {
		emit(map[string]any{"result": result})
	} else {
		writeJSON(w, 200, result)
	}
}
func (s *Server) listSections(ctx context.Context, key string) ([]publication.Section, error) {
	rows, err := s.handle.QueryContext(ctx, `SELECT ordinal,href,title FROM document_sections WHERE document_id=? ORDER BY ordinal`, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []publication.Section{}
	for rows.Next() {
		var item publication.Section
		if err = rows.Scan(&item.Index, &item.Href, &item.Title); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
func (s *Server) handleSection(w http.ResponseWriter, r *http.Request) {
	key, num, ok := pathKeyAndPage(w, r)
	if !ok {
		return
	}
	var item publication.Section
	var raw string
	err := s.handle.QueryRowContext(r.Context(), `SELECT ordinal,href,title,blocks_json,text FROM document_sections WHERE document_id=? AND ordinal=?`, key, num).Scan(&item.Index, &item.Href, &item.Title, &raw, &item.Text)
	if err != nil {
		writeError(w, 404, "没有该章节")
		return
	}
	if err = json.Unmarshal([]byte(raw), &item.Blocks); err != nil {
		writeError(w, 500, "章节内容损坏")
		return
	}
	writeJSON(w, 200, item)
}
func (s *Server) handlePublicationFile(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if err != nil {
		writeError(w, 404, "文档不存在")
		return
	}
	file := doc.PDFPath
	if doc.Format == "epub" {
		file = filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+".epub")
	}
	if doc.Format == "pdf" {
		var found bool
		file, found = legacy.NewPaths(s.cfg.DataRoot).PDFFile(key)
		if !found {
			writeError(w, 404, "没有原文件")
			return
		}
	}
	resolved, err := resolveUnderLibrary(legacy.NewPaths(s.cfg.DataRoot), file)
	if err != nil {
		writeError(w, 403, err.Error())
		return
	}
	if doc.Format == "pdf" {
		w.Header().Set("Content-Type", "application/pdf")
	} else {
		w.Header().Set("Content-Type", "application/epub+zip")
	}
	http.ServeFile(w, r, resolved)
}
func (s *Server) handleEPUBResource(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if err != nil || doc.Format != "epub" {
		writeError(w, 404, "没有该 EPUB")
		return
	}
	file, err := resolveUnderLibrary(legacy.NewPaths(s.cfg.DataRoot), filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+".epub"))
	if err != nil {
		writeError(w, 403, err.Error())
		return
	}
	// 只流式读取压缩包的中央目录：整本 EPUB 可能有几十 MB，而这里每次只要一张图。
	// （导入路径仍用内存里的 Archive，体积由上传上限约束。）
	handle, err := os.Open(file)
	if err != nil {
		writeError(w, 404, "原文件不存在")
		return
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		writeError(w, 404, "原文件不存在")
		return
	}
	z, err := publication.OpenArchive(handle, info.Size())
	if err != nil {
		writeError(w, 422, err.Error())
		return
	}
	resource, err := publication.ReadResource(z, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, 404, "资源不存在")
		return
	}
	mime := http.DetectContentType(resource)
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/gif" && mime != "image/webp" {
		writeError(w, 415, "仅展示文档内的静态图片")
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Write(resource)
}
func (s *Server) handleLocation(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if r.Method == "GET" {
		var raw string
		err := s.handle.QueryRowContext(r.Context(), `SELECT location_json FROM reading_locations WHERE document_id=?`, key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, 200, map[string]any{"location": nil})
			return
		}
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"location": json.RawMessage(raw)})
		return
	}
	var body struct {
		Kind  string `json:"kind"`
		Page  int    `json:"page,omitempty"`
		Href  string `json:"href,omitempty"`
		Index int    `json:"index,omitempty"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if err != nil {
		writeError(w, 404, "文档不存在")
		return
	}
	if (doc.Format == "pdf" && (body.Kind != "pdf" || body.Page < 1 || body.Page > 5000)) || (doc.Format == "epub" && (body.Kind != "epub" || body.Href == "" || body.Index < 1)) {
		writeError(w, 400, "阅读位置无效")
		return
	}
	if doc.Format == "epub" {
		var count int
		if err = s.handle.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM document_sections WHERE document_id=? AND ordinal=? AND href=?`, key, body.Index, body.Href).Scan(&count); err != nil || count != 1 {
			writeError(w, 400, "阅读章节不存在")
			return
		}
	}
	raw, _ := json.Marshal(body)
	_, err = s.handle.ExecContext(r.Context(), `INSERT INTO reading_locations VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET location_json=excluded.location_json,updated_at=excluded.updated_at`, key, string(raw), nowStamp())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"saved": true})
}
