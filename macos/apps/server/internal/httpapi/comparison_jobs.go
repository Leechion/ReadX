package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/tasks"
)

// Keep the comparison's structured index separate from the reader's narrative.
const comparisonExperimentKind = "comparisonExperiment"

// 30 分钟超时与原先 runComparisonExperiment 的硬超时一致；并发槽/容量/TTL 采用
// 与书源下载、LaTeX 编译相同的纪律（此前这里无并发槽、无容量、无清理）。
func newComparisonJobRegistry() *tasks.Registry {
	return tasks.New(tasks.Options{
		Kind:      "comparison-experiment",
		MaxActive: 2,
		Capacity:  32,
		TTL:       10 * time.Minute,
		Timeout:   30 * time.Minute,
	}, nil)
}

type comparisonExperimentJob struct {
	Key       string `json:"key"`
	Status    string `json:"status"`
	Percent   int    `json:"percent"`
	Message   string `json:"message"`
	Error     string `json:"error,omitempty"`
	UpdatedAt string `json:"updatedAt"`
}

func comparisonValueValid(value string) bool {
	var groups map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &groups) != nil {
		return false
	}
	for _, key := range []string{"dataset", "acquisition", "training", "loss", "baselines", "metrics", "results"} {
		raw := strings.TrimSpace(string(groups[key]))
		var fields []json.RawMessage
		if strings.HasPrefix(raw, "[") && json.Unmarshal([]byte(raw), &fields) == nil {
			return true
		}
	}
	return false
}

// Read the durable index, including structured records from older clients.
func (s *Server) cachedComparisonExperiment(ctx context.Context, key string) (ReadingEntry, bool, error) {
	var raw string
	if err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id=?`, key).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ReadingEntry{}, false, nil
		}
		return ReadingEntry{}, false, err
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return ReadingEntry{}, false, fmt.Errorf("读取已保存的实验配置失败: %w", err)
	}
	for _, kind := range []string{comparisonExperimentKind, "experiment", "experimentJSON"} {
		var entry ReadingEntry
		if err := json.Unmarshal(entries[kind], &entry); err != nil {
			_ = json.Unmarshal(entries[kind], &entry.Value)
		}
		if comparisonValueValid(entry.Value) {
			if kind != comparisonExperimentKind {
				if err := s.saveReadingEntry(ctx, key, comparisonExperimentKind, entry); err != nil {
					return ReadingEntry{}, false, err
				}
			}
			return entry, true, nil
		}
	}
	return ReadingEntry{}, false, nil
}

// comparisonWireJob 把 Registry 快照映射回既有的前端契约：
// status ∈ idle/running/completed/failed（CompareWorkspace 以 status==='running'
// 决定继续轮询，其余终态）。取消在外层契约里没有对应状态，映射为 failed 并
// 明确注明「已取消」——不影响既有前端，又如实表达终态。
func comparisonWireJob(key string, snap tasks.Snapshot) comparisonExperimentJob {
	job := comparisonExperimentJob{Key: key, UpdatedAt: snap.CreatedAt.Format(time.RFC3339)}
	stamp := snap.CreatedAt
	if !snap.StartedAt.IsZero() {
		stamp = snap.StartedAt
	}
	if !snap.EndedAt.IsZero() {
		stamp = snap.EndedAt
	}
	job.UpdatedAt = stamp.Format(time.RFC3339)
	switch snap.State {
	case tasks.Succeeded:
		job.Status = "completed"
		job.Percent = 100
		job.Message = "实验配置已保存"
	case tasks.Failed:
		job.Status = "failed"
		job.Message = "实验配置生成失败"
		job.Error = snap.Error
	case tasks.Cancelled:
		job.Status = "failed"
		job.Message = "已取消"
		job.Error = "实验配置生成已取消"
	default: // queued / running
		job.Status = "running"
		job.Percent = snap.Percent
		if job.Percent == 0 {
			job.Percent = 2
		}
		job.Message = snap.Progress
		if job.Message == "" {
			job.Message = "后台正在准备实验配置…"
		}
	}
	return job
}

func (s *Server) handleComparisonExperimentJob(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇论文")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	entry, cached, err := s.cachedComparisonExperiment(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if cached {
		writeJSON(w, http.StatusOK, comparisonExperimentJob{Key: key, Status: "completed", Percent: 100, Message: "实验配置已保存", UpdatedAt: entry.UpdatedAt})
		return
	}
	if r.Method == http.MethodDelete {
		// 新增能力：原先没有取消入口，30 分钟的生成只能干等或重启。
		if s.comparisonJobs.Cancel(key) {
			writeJSON(w, http.StatusOK, comparisonExperimentJob{Key: key, Status: "failed", Message: "已取消", Error: "实验配置生成已取消", UpdatedAt: nowStamp()})
		} else {
			writeError(w, http.StatusConflict, "任务已经不在运行中")
		}
		return
	}
	if snap, live := s.comparisonJobs.Get(key); live && !snap.State.Terminal() {
		// 进行中：GET 与 POST 都返回当前快照（原语义：POST 不重复发起）
		writeJSON(w, http.StatusOK, comparisonWireJob(key, snap))
		return
	}
	if r.Method == http.MethodGet {
		if snap, exists := s.comparisonJobs.Get(key); exists {
			writeJSON(w, http.StatusOK, comparisonWireJob(key, snap))
			return
		}
		writeJSON(w, http.StatusOK, comparisonExperimentJob{Key: key, Status: "idle", Message: "尚未生成实验配置"})
		return
	}
	snapshot, err := s.comparisonJobs.Submit(key, func(ctx context.Context, report func(int, string)) error {
		return s.runComparisonExperiment(ctx, key, report)
	})
	if err != nil {
		writeError(w, http.StatusTooManyRequests, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, comparisonWireJob(key, snapshot))
}

func (s *Server) runComparisonExperiment(ctx context.Context, key string, report func(percent int, message string)) error {
	// Recheck after queueing: another reader may have saved a usable index.
	entry, cached, err := s.cachedComparisonExperiment(ctx, key)
	if err != nil {
		return err
	}
	if cached {
		// Freeze a legacy index before later narrative reading replaces it.
		if err := s.saveReadingEntry(ctx, key, comparisonExperimentKind, entry); err != nil {
			return err
		}
		return nil
	}
	cfg, err := s.workflowAIConfig(WorkflowReading)
	if err != nil {
		return err
	}
	if !cfg.Ready() {
		return errors.New("请先配置 AI 助教的模型与 API Key")
	}
	source, err := s.sourceText(ctx, key)
	if err != nil {
		return err
	}
	if strings.TrimSpace(source) == "" {
		return errors.New("还没有该论文的全文缓存，请先完成 PDF 文本抽取")
	}
	material, _, _, err := ai.PrepareMaterial(source, "", "全文")
	if err != nil {
		return err
	}
	saved := false
	failure := ""
	emit := func(payload any) {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return
		}
		var event struct {
			Error  string `json:"error"`
			Result *struct {
				Saved           bool   `json:"saved"`
				ValidationError string `json:"validationError"`
			} `json:"result"`
		}
		if json.Unmarshal(encoded, &event) != nil {
			return
		}
		if event.Error != "" {
			failure = event.Error
		}
		if event.Result != nil {
			saved = event.Result.Saved
			if event.Result.ValidationError != "" {
				failure = event.Result.ValidationError
			}
		}
	}
	s.runReadingGeneration(ctx, key, generateRequest{Key: key, Kind: "experiment"}, source, material, cfg, nil,
		report, emit, comparisonExperimentKind)
	if saved {
		return nil
	}
	if ctx.Err() != nil {
		failure = "后台生成超时，请重试"
	}
	if failure == "" {
		failure = "实验配置未能保存，请重试"
	}
	return errors.New(failure)
}
