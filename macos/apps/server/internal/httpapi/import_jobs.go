// import_jobs.go：导入任务的持久化进度（OCR → 翻译 → 渲染）。
//
// 对齐 LeePDF 的任务进度面板：一次导入是一条可查询、可取消、可回看的任务，
// 三个阶段分别记录状态、消息与计数；页面刷新或应用重启后仍能从 app_state 读回。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/render"
)

const jobStatePrefix = "import-job:"
const jobDocumentPrefix = "import-job-document:"

// JobStage 是任务里的一个阶段（ocr / translate / render）。
type JobStage struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Status      string `json:"status"` // pending / running / done / failed / skipped
	Message     string `json:"message"`
	Substage    string `json:"substage,omitempty"`
	Completed   int    `json:"completed"`
	Total       int    `json:"total"`
	Unit        string `json:"unit,omitempty"`
	ResultCount int    `json:"resultCount,omitempty"`
	ResultUnit  string `json:"resultUnit,omitempty"`
	// StartedAt/FinishedAt 只由 setStage 盖章，用于「这一步花了多久」的统计。
	// 老任务没有这两个字段：统计里必须把缺失的算成缺失，不能用总耗时去猜。
	StartedAt  string `json:"startedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
}

// JobRun 是一次历史执行的摘要。
type JobRun struct {
	ID         string `json:"id"`
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt,omitempty"`
	Status     string `json:"status"`
	Pages      int    `json:"pages"`
	Error      string `json:"error,omitempty"`
}

// DocumentJob 是一篇文档最近一次导入任务的状态。
type DocumentJob struct {
	Key       string     `json:"key"`
	Name      string     `json:"name"`
	Status    string     `json:"status"` // running / done / failed / cancelled
	StartedAt string     `json:"startedAt"`
	UpdatedAt string     `json:"updatedAt"`
	Error     string     `json:"error,omitempty"`
	Pages     int        `json:"pages"`
	Stages    []JobStage `json:"stages"`
	Runs      []JobRun   `json:"runs"`
}

type jobRuntime struct {
	job      *DocumentJob
	cancel   context.CancelFunc
	stopping bool // Cancellation requested; the worker has not unwound yet.
}

func cloneDocumentJob(job *DocumentJob) DocumentJob {
	copy := *job
	copy.Stages = append([]JobStage(nil), job.Stages...)
	copy.Runs = append([]JobRun(nil), job.Runs...)
	return copy
}

func newDocumentJob(key, name string, pages int) *DocumentJob {
	stamp := nowStamp()
	return &DocumentJob{
		Key:       key,
		Name:      name,
		Status:    "running",
		StartedAt: stamp,
		UpdatedAt: stamp,
		Pages:     pages,
		Stages: []JobStage{
			{Key: "ocr", Label: "OCR", Status: "pending", Unit: "页"},
			{Key: "translate", Label: "翻译", Status: "pending", Unit: "段"},
			{Key: "render", Label: "渲染", Status: "pending", Unit: "页"},
			{Key: "memory", Label: "论文记忆", Status: "pending", Unit: "份"},
		},
		Runs: []JobRun{{ID: stamp, StartedAt: stamp, Status: "running", Pages: pages}},
	}
}

func (job *DocumentJob) stage(key string) *JobStage {
	for index := range job.Stages {
		if job.Stages[index].Key == key {
			return &job.Stages[index]
		}
	}
	return nil
}

// setStage 更新一个阶段；空字段保持不变，避免每次都要重传全部信息。
//
// 阶段耗时只在第一次转 running 时记 StartedAt、第一次进终态时记 FinishedAt：
// 进度回报会反复以 running 调用它，重复盖章会把耗时算成「最后一次回报」。
func (job *DocumentJob) setStage(key, status, message string, completed, total int) {
	stage := job.stage(key)
	if stage == nil {
		return
	}
	if status != "" {
		stage.Status = status
		switch status {
		case "running":
			if stage.StartedAt == "" {
				stage.StartedAt = nowStamp()
			}
		case "done", "failed", "skipped", "cancelled", "interrupted":
			if stage.StartedAt != "" && stage.FinishedAt == "" {
				stage.FinishedAt = nowStamp()
			}
		}
	}
	if message != "" {
		stage.Message = message
	}
	if total >= 0 {
		stage.Total = total
	}
	if completed >= 0 {
		stage.Completed = completed
	}
	job.UpdatedAt = nowStamp()
}

// beginImportJob 为新导入建立任务并登记可取消的上下文。
// An active job is never replaced; nil tells the caller not to start a worker.
func (s *Server) beginImportJob(key, name string, pages int, cancel context.CancelFunc) *DocumentJob {
	previous, _ := s.loadImportJob(context.Background(), key)
	job := newDocumentJob(key, name, pages)
	s.jobsMu.Lock()
	if runtime := s.importJobs[key]; runtime != nil && runtime.job != nil {
		if runtime.job.Status == "running" || runtime.stopping {
			s.jobsMu.Unlock()
			return nil
		}
		previous = runtime.job
	}
	if previous != nil {
		job.Runs = append(append([]JobRun(nil), previous.Runs...), job.Runs...)
		if len(job.Runs) > 10 {
			job.Runs = job.Runs[len(job.Runs)-10:]
		}
	}
	s.importJobs[key] = &jobRuntime{job: job, cancel: cancel}
	snapshot := cloneDocumentJob(job)
	s.jobsMu.Unlock()
	s.persistImportJob(&snapshot)
	return &snapshot
}

// updateImportJob 在锁内改任务，再在锁外落盘，避免持锁做数据库 IO。
func (s *Server) updateImportJob(key string, mutate func(*DocumentJob)) {
	s.jobsMu.Lock()
	runtime := s.importJobs[key]
	if runtime == nil || runtime.job == nil {
		s.jobsMu.Unlock()
		return
	}
	mutate(runtime.job)
	runtime.job.UpdatedAt = nowStamp()
	snapshot := cloneDocumentJob(runtime.job)
	s.jobsMu.Unlock()
	s.persistImportJob(&snapshot)
}

// jobStage 是阶段更新的便捷入口。
func (s *Server) jobStage(key, stage, status, message string, completed, total int) {
	s.updateImportJob(key, func(job *DocumentJob) {
		if job.Status == "cancelled" && status != "cancelled" {
			return
		}
		job.setStage(stage, status, message, completed, total)
	})
}

// finishImportJob 结束当前运行并同步最后一次执行摘要。
func (s *Server) finishImportJob(key, status, message string) {
	s.updateImportJob(key, func(job *DocumentJob) {
		if runtime := s.importJobs[key]; runtime != nil {
			runtime.stopping = false
		}
		// 显式取消已是终态；OCR/翻译库返回 context.Canceled 时不能覆盖成失败。
		if job.Status == "cancelled" && status != "cancelled" {
			return
		}
		job.Status = status
		job.stopActiveStages(status, message)
		if message != "" {
			job.Error = message
		}
		if len(job.Runs) > 0 {
			last := &job.Runs[len(job.Runs)-1]
			last.Status = status
			last.FinishedAt = nowStamp()
			last.Error = job.Error
			last.Pages = job.Pages
		}
	})
}

// Translation and rendering overlap. Ending the job must also stop every active
// stage, preserving any completed stage and the stage that reported the failure.
func (job *DocumentJob) stopActiveStages(status, message string) {
	stageStatus := ""
	switch status {
	case "cancelled", "interrupted":
		stageStatus = status
	case "failed":
		stageStatus = "interrupted"
	default:
		return
	}
	for index := range job.Stages {
		stage := &job.Stages[index]
		if stage.Status == "running" {
			job.setStage(stage.Key, stageStatus, message, -1, -1)
		}
	}
}

func importFailureStatus(ctx context.Context, err error) string {
	if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		return "cancelled"
	}
	return "failed"
}

func (s *Server) persistImportJob(job *DocumentJob) {
	// Serialize each job's writes and snapshot the latest state after acquiring
	// the gate. An older caller must not overwrite newer progress on disk.
	unlock, _ := s.jobPersistLocks.lock(context.Background(), job.Key)
	defer unlock()
	s.jobsMu.Lock()
	if runtime := s.importJobs[job.Key]; runtime != nil && runtime.job != nil {
		snapshot := cloneDocumentJob(runtime.job)
		job = &snapshot
	}
	s.jobsMu.Unlock()
	encoded, err := json.Marshal(job)
	if err != nil {
		return
	}
	_, _ = s.handle.Exec(
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		jobStatePrefix+job.Key, string(encoded), nowStamp())
}

func (s *Server) loadImportJob(ctx context.Context, key string) (*DocumentJob, bool) {
	s.jobsMu.Lock()
	if runtime := s.importJobs[key]; runtime != nil && runtime.job != nil {
		copy := cloneDocumentJob(runtime.job)
		s.jobsMu.Unlock()
		s.reconcileCompletedLeeJob(&copy)
		return &copy, true
	}
	s.jobsMu.Unlock()
	var body string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, jobStatePrefix+key).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false
	}
	if err != nil {
		return nil, false
	}
	var job DocumentJob
	if json.Unmarshal([]byte(body), &job) != nil {
		return nil, false
	}
	reconciled := s.reconcileCompletedLeeJob(&job)
	// 进程重启后没有运行中的句柄：上次没收尾的任务标记为「已中断」，不要一直转圈。
	if job.Status == "running" {
		job.Status = "interrupted"
	}
	interruptedStage := false
	for index := range job.Stages {
		if job.Stages[index].Status == "running" {
			job.Stages[index].Status = "interrupted"
			job.Stages[index].Message = "应用重启时处理被中断，可重新打开任务查看"
			interruptedStage = true
		}
	}
	if interruptedStage || reconciled {
		s.persistImportJob(&job)
	}
	return &job, true
}

// Older retranslation jobs saved the PDF but marked the document's render stage
// instead of the retry job. Reconcile only successful jobs with their own output.
func (s *Server) reconcileCompletedLeeJob(job *DocumentJob) bool {
	if job.Status != "done" || job.Key == "" || filepath.Base(job.Key) != job.Key {
		return false
	}
	root := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).DataDir(), "retain", "jobs", job.Key)
	stage := job.stage("render")
	translation := job.stage("translate")
	fixRender := stage != nil && (stage.Status == "running" || stage.Status == "interrupted")
	fixTranslation := translation != nil && translation.Status == "done" && (translation.Completed < translation.Total || translation.Unit == "页")
	if (!fixRender && !fixTranslation) || !existingFile(filepath.Join(root, "rendered", "readx-translated.pdf")) {
		return false
	}
	changed := false
	if fixRender {
		job.setStage("render", "done", fmt.Sprintf("Lee 已排版 %d 页译文", job.Pages), job.Pages, job.Pages)
		stage.Unit, stage.Substage = "页", ""
		if len(job.Runs) > 0 && job.Runs[len(job.Runs)-1].FinishedAt != "" {
			stage.FinishedAt = job.Runs[len(job.Runs)-1].FinishedAt
		}
		changed = true
	}
	if fixTranslation {
		if outputs, err := loadLeeTranslations(filepath.Join(root, "translated")); err == nil {
			cached := translation.ResultCount
			if cached == 0 {
				cached = translation.Completed
			}
			job.completeLeeTranslation(len(outputs), cached)
			changed = true
		}
	}
	return changed
}

// linkImportJobDocument lets the library address an upload job by the durable
// document key, even when the upload itself was initially keyed by its content hash.
func (s *Server) linkImportJobDocument(jobKey, documentKey string) {
	if strings.TrimSpace(jobKey) == "" || strings.TrimSpace(documentKey) == "" {
		return
	}
	_, _ = s.handle.Exec(
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
		jobDocumentPrefix+documentKey, fmt.Sprintf("%q", jobKey), nowStamp())
}

func (s *Server) loadImportJobForDocument(ctx context.Context, documentKey string) (*DocumentJob, bool) {
	var encoded string
	if err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key=?`, jobDocumentPrefix+documentKey).Scan(&encoded); err == nil {
		var jobKey string
		if json.Unmarshal([]byte(encoded), &jobKey) == nil && strings.TrimSpace(jobKey) != "" {
			if job, found := s.loadImportJob(ctx, jobKey); found {
				return job, true
			}
		}
	}
	return s.loadImportJob(ctx, documentKey)
}

func (s *Server) cancelImportJob(key string) bool {
	s.jobsMu.Lock()
	runtime := s.importJobs[key]
	if runtime == nil || runtime.cancel == nil || runtime.job == nil || runtime.job.Status != "running" {
		s.jobsMu.Unlock()
		return false
	}
	cancel := runtime.cancel
	runtime.stopping = true
	job := runtime.job
	job.Status = "cancelled"
	job.Error = "已取消"
	job.stopActiveStages("cancelled", job.Error)
	job.UpdatedAt = nowStamp()
	if len(job.Runs) > 0 {
		last := &job.Runs[len(job.Runs)-1]
		last.Status = "cancelled"
		last.FinishedAt = job.UpdatedAt
		last.Error = job.Error
		last.Pages = job.Pages
	}
	copy := *job
	copy.Stages = append([]JobStage(nil), job.Stages...)
	copy.Runs = append([]JobRun(nil), job.Runs...)
	s.jobsMu.Unlock()
	// 先持久化终态，再中断运行中的网络或渲染请求，避免 worker 抢先写回 failed。
	s.persistImportJob(&copy)
	cancel()
	return true
}

// setJobCancel 让后台渲染接替导入请求的取消句柄：取消按钮在导入完成后仍有效。
func (s *Server) setJobCancel(key string, cancel context.CancelFunc) {
	s.jobsMu.Lock()
	active := false
	if runtime := s.importJobs[key]; runtime != nil && runtime.job != nil && runtime.job.Status == "running" {
		runtime.cancel = cancel
		active = true
	}
	s.jobsMu.Unlock()
	if !active && cancel != nil {
		cancel()
	}
}

// startDocumentRender 在导入提交后生成完整译文 PDF；任务面板可跟踪并取消渲染。
func (s *Server) startDocumentRender(key, sourcePath string, pages []layoutPage) {
	leeOutput := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+"-translated.pdf")
	if existingFile(leeOutput) {
		s.jobStage(key, "render", "done", "已复用 Lee 排版译文 PDF", len(pages), len(pages))
		s.finishImportJob(key, "done", "")
		return
	}
	renderer := render.New(s.cfg.DataRoot)
	if err := renderer.Available(); err != nil {
		s.jobStage(key, "render", "failed", "渲染不可用："+err.Error(), 0, len(pages))
		s.finishImportJob(key, "failed", err.Error())
		return
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		s.jobStage(key, "render", "failed", "读取原 PDF 失败: "+err.Error(), 0, len(pages))
		s.finishImportJob(key, "failed", err.Error())
		return
	}
	ocrPages := layoutOCRPages(layoutDoc{Pages: pages})
	s.jobStage(key, "render", "running", "正在生成整本排版译文 PDF", 0, len(ocrPages))
	ctx, cancel := context.WithCancel(context.Background())
	s.setJobCancel(key, cancel)
	go func() {
		defer cancel()
		outputPath := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+"-translated.pdf")
		report, renderErr := s.renderTranslatedDocument(ctx, key, source, ocrPages, renderer, outputPath)
		if renderErr != nil {
			status := "failed"
			message := renderErr.Error()
			if ctx.Err() != nil {
				status = "cancelled"
				message = "已取消"
			}
			s.jobStage(key, "render", status, message, 0, len(ocrPages))
			s.finishImportJob(key, status, message)
			return
		}
		message := fmt.Sprintf("已生成译文 PDF（%d 页，%d 个段落）", len(ocrPages), report.Blocks)
		s.jobStage(key, "render", "done", message, len(ocrPages), len(ocrPages))
		s.finishImportJob(key, "done", "")
	}()
}

// handleDocumentJob 返回文档最近一次导入任务（含历史执行摘要）。
func (s *Server) handleDocumentJob(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	job, found := s.loadImportJobForDocument(r.Context(), key)
	if !found {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "job": job})
}

// handleCancelDocumentJob 取消正在运行的任务（导入或后台渲染）。
func (s *Server) handleCancelDocumentJob(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	// The library reopens this panel using the document key, while a retry has
	// its own runtime key. Resolve the same mapping used by the status endpoint.
	if job, found := s.loadImportJobForDocument(r.Context(), key); found {
		key = job.Key
	}
	cancelled := s.cancelImportJob(key)
	writeJSON(w, http.StatusOK, map[string]any{"cancelled": cancelled})
}
