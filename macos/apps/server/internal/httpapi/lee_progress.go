package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

type leeStageObservation struct {
	Schema    string `json:"schema"`
	UserStage string `json:"user_stage"`
	Substage  string `json:"substage"`
	Message   string `json:"message"`
	Detail    string `json:"stage_detail"`
	Unit      string `json:"progress_unit"`
	Current   *int   `json:"progress_current"`
	Total     *int   `json:"progress_total"`
}

// Both child streams share this writer, so os/exec serializes Write calls.
// Keep the original log and consume complete observations even when writes
// split a UTF-8 character or combine several records.
type leeImportLogWriter struct {
	sink     io.Writer
	observe  func(leeStageObservation)
	line     []byte
	oversize bool
	failure  string
}

func (w *leeImportLogWriter) Write(p []byte) (int, error) {
	n, err := w.sink.Write(p)
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	for _, part := range bytes.SplitAfter(p[:n], []byte{'\n'}) {
		if len(w.line)+len(part) > 1<<20 {
			w.line = nil
			w.oversize = true
		}
		if !w.oversize {
			w.line = append(w.line, part...)
		}
		if len(part) > 0 && part[len(part)-1] == '\n' {
			if !w.oversize {
				w.consume(w.line)
			}
			w.line = w.line[:0]
			w.oversize = false
		}
	}
	return n, err
}

func (w *leeImportLogWriter) flush() {
	if len(w.line) > 0 && !w.oversize {
		w.consume(w.line)
	}
	w.line = nil
}

func (w *leeImportLogWriter) consume(line []byte) {
	text := strings.TrimSpace(string(line))
	if payload, ok := strings.CutPrefix(text, "structured failure json:"); ok {
		var failure struct {
			Code       string `json:"failure_code"`
			Summary    string `json:"summary"`
			Detail     string `json:"detail"`
			Suggestion string `json:"suggestion"`
		}
		if json.Unmarshal([]byte(payload), &failure) == nil {
			summary, suggestion := strings.TrimSpace(failure.Summary), strings.TrimSpace(failure.Suggestion)
			if failure.Code == "python_unhandled_exception" && strings.TrimSpace(failure.Detail) != "" {
				detail := []rune(strings.TrimSpace(failure.Detail))
				summary = string(detail[:min(len(detail), 500)])
			}
			if summary != "" {
				w.failure = summary
				if suggestion != "" {
					if strings.Contains(suggestion, summary) {
						w.failure = suggestion
					} else {
						w.failure += "；" + suggestion
					}
				}
			}
		}
		return
	}
	var event leeStageObservation
	if json.Unmarshal(line, &event) == nil && event.Schema == "pipeline_stage_observation_v1" && w.observe != nil {
		w.observe(event)
	}
}

func (s *Server) leeImportObservation(key string, event leeStageObservation) {
	stageKey := map[string]string{"ocr": "ocr", "translation": "translate", "render": "render"}[event.UserStage]
	if stageKey == "" {
		return
	}
	s.updateImportJob(key, func(job *DocumentJob) {
		if job.Status != "running" {
			return
		}
		for _, key := range []string{"ocr", "translate", "render"} {
			stage := job.stage(key)
			if stage == nil {
				continue
			}
			if key != stageKey {
				if key == "ocr" && stage.Status == "running" {
					// 走 setStage 而不是直接改字段：阶段耗时的盖章只在 setStage 里发生，
					// 绕过它会让这一步在统计里永远缺 FinishedAt。
					job.setStage(key, "done", "Lee 已完成"+stage.Label, stage.Total, stage.Total)
				}
				continue
			}
			if stage.Status == "done" || stage.Status == "skipped" {
				return
			}
			message := event.Detail
			if message == "" {
				message = event.Message
			}
			job.setStage(key, "running", message, -1, -1)
			unit := leeProgressUnit(event.Unit, event.Substage)
			newSubstage := event.Substage != "" && stage.Substage != event.Substage
			if newSubstage {
				stage.Completed, stage.Total = 0, 0
				stage.Substage = event.Substage
			}
			if unit != "" && (key != "ocr" || unit == "页") && (event.Current != nil || event.Total != nil) {
				if stage.Unit != unit && !newSubstage {
					stage.Completed, stage.Total = 0, 0
				}
				stage.Unit = unit
				if event.Current != nil {
					stage.Completed = max(0, *event.Current)
				}
				if event.Total != nil {
					stage.Total = max(0, *event.Total)
					if key == "ocr" && unit == "页" {
						job.Pages = stage.Total
					}
				}
			}
			return
		}
	})
}

// Retain reports counters in units that can change within one user-facing
// stage. Keep those units distinct so page counts or translation blocks are
// never presented as completed paragraphs.
func leeProgressUnit(unit, substage string) string {
	if mapped := map[string]string{
		"page":    "页",
		"batch":   "批",
		"step":    "步",
		"segment": "段",
		"block":   "块",
	}[strings.TrimSpace(unit)]; mapped != "" {
		return mapped
	}
	switch strings.TrimSpace(substage) {
	case "page_policies", "continuation_review", "garbled_repair", "render_pages":
		return "页"
	case "translation_batches":
		return "块"
	case "translation_tail_retry":
		return "批"
	case "translation_prepare", "domain_inference", "render_prepare", "render_prewarm", "render_compile":
		return "步"
	case "agent_repair", "final_untranslated_recovery":
		return "项"
	default:
		return ""
	}
}
