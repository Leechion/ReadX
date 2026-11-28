// reproduction.go：S6 复现任务板。
//
// 逐条对应旧版 windows/src/main/main.ts 的 reproduction:* IPC：
//   - analyze 先 decode + validate（每组 1–4 项、字段不空白、引用的页码真实存在、finding 有证据），
//     再按**内容指纹**归档；指纹按键名排序，模型换字段顺序不会误判成新版分析；
//   - 新分析不继承旧核对结果：任务状态写在指纹对应的 revision 下；
//   - repo-checks 是规则扫描（internal/catalog 的 repo-audit），不执行仓库代码、不发网络请求。
//
// 校验逻辑复用 internal/validate（与 TS parity 背书），服务端只做编排与持久化。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"cbctv2/server/internal/appstate"
	"cbctv2/server/internal/catalog"
	"cbctv2/server/internal/validate"
)

// ReproductionTask 与 TS ReproductionTask 同形。
type ReproductionTask struct {
	Status    string `json:"status"`
	Note      string `json:"note"`
	UpdatedAt string `json:"updatedAt"`
}

// ReproductionChecklist 与 TS ReproductionChecklist 同形：
// 每个分析版本（fingerprint）单独存放核对结果，新版分析不继承旧结果。
type ReproductionChecklist struct {
	Key        string                                 `json:"key"`
	Revisions  map[string]map[string]ReproductionTask `json:"revisions"`
	Analyses   map[string]json.RawMessage             `json:"analyses"`
	RepoChecks map[string]ReproductionTask            `json:"repoChecks"`
}

// reproductionStatuses 与 TS REPRODUCTION_TASK_STATUSES 一致。
var reproductionStatuses = map[string]string{"todo": "待核对", "verified": "已核对", "blocked": "受阻"}

func emptyChecklist(key string) ReproductionChecklist {
	return ReproductionChecklist{
		Key: key, Revisions: map[string]map[string]ReproductionTask{},
		Analyses: map[string]json.RawMessage{}, RepoChecks: map[string]ReproductionTask{},
	}
}

// handleReproductionGet 返回某篇论文的复现核对清单（含全部历史分析版本）。
func (s *Server) handleReproductionGet(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	checklist, err := s.loadReproduction(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "checklist": checklist})
}

// handleReproductionAnalyze 校验并归档一份复现分析。
//
// 与 v1 一致：没有全文缓存就拒绝（无原文依据无法校验）；校验不过不落库，
// 如实回错误而不是让半成品进库。
func (s *Server) handleReproductionAnalyze(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Value string `json:"value"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if strings.TrimSpace(body.Value) == "" {
		writeError(w, http.StatusBadRequest, "value 为空")
		return
	}
	source, err := s.sourceText(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if strings.TrimSpace(source) == "" {
		writeError(w, http.StatusConflict, "这篇论文没有全文缓存，无法校验复现分析的原文依据。")
		return
	}
	analysis, err := validate.DecodeReproductionAnalysis(body.Value)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validate.ValidateReproductionAnalysis(analysis, source); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	revision := validate.Fingerprint(analysis)
	encoded, err := json.Marshal(analysis)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 读-改-写在 reproduction:<key> 的每 key 锁内原子完成（原先靠 appStateMu）。
	if err := s.mutateReproduction(r.Context(), key, func(checklist ReproductionChecklist) (ReproductionChecklist, error) {
		checklist.Analyses[revision] = encoded
		if _, seen := checklist.Revisions[revision]; !seen {
			checklist.Revisions[revision] = map[string]ReproductionTask{}
		}
		return checklist, nil
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "保存复现分析失败: "+err.Error())
		return
	}
	groups := []map[string]any{}
	for _, group := range validate.ReproductionGroups(analysis) {
		groups = append(groups, map[string]any{"id": group.ID, "label": group.Label, "count": len(group.Items)})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "key": key, "revision": revision, "groups": groups,
		"unknownCount": reproductionUnknownCount(analysis),
	})
}

// handleReproductionTask 更新某个核对项的状态/备注。revision 与 id 必须过保留名检查：
// revision="__proto__" 之类会污染内存映射（v1 明确记录过这条 C3 复发路径）。
func (s *Server) handleReproductionTask(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var body struct {
		Revision string  `json:"revision"`
		ItemID   string  `json:"itemId"`
		Status   *string `json:"status"`
		Note     *string `json:"note"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if err := safeObjectKey(body.Revision, "revision"); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := safeObjectKey(body.ItemID, "核对项 id"); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if body.Status != nil {
		if _, known := reproductionStatuses[*body.Status]; !known {
			writeError(w, http.StatusBadRequest, "status 只能是 todo / verified / blocked")
			return
		}
	}
	var updated ReproductionTask
	if err := s.mutateReproduction(r.Context(), key, func(checklist ReproductionChecklist) (ReproductionChecklist, error) {
		if _, seen := checklist.Revisions[body.Revision]; !seen {
			checklist.Revisions[body.Revision] = map[string]ReproductionTask{}
		}
		task := checklist.Revisions[body.Revision][body.ItemID]
		if task.Status == "" {
			task.Status = "todo"
		}
		if body.Status != nil {
			task.Status = *body.Status
		}
		if body.Note != nil {
			task.Note = *body.Note
		}
		task.UpdatedAt = nowStamp()
		checklist.Revisions[body.Revision][body.ItemID] = task
		updated = task
		return checklist, nil
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "保存核对结果失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": updated})
}

// handleRepoChecks 从代码快照提取依赖/数据/权重核对项（规则扫描，纯函数）。
func (s *Server) handleRepoChecks(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Files []catalog.CodeFile `json:"files"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "请求体必须是 {\"files\":[{\"path\":..,\"lines\":[..]}]}")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "checks": catalog.RepoAuditChecks(body.Files)})
}

// ---- 数据访问 ----

// fixReproduction 补全缺省字段——读取路径（无论来自 SQL 还是泛型 Load）共用这一份。
func fixReproduction(checklist ReproductionChecklist, key string) ReproductionChecklist {
	if checklist.Revisions == nil {
		checklist.Revisions = map[string]map[string]ReproductionTask{}
	}
	if checklist.Analyses == nil {
		checklist.Analyses = map[string]json.RawMessage{}
	}
	if checklist.RepoChecks == nil {
		checklist.RepoChecks = map[string]ReproductionTask{}
	}
	checklist.Key = key
	return checklist
}

// parseReproduction 反序列化并补全（损坏明确报错：回空会让下一次写入覆盖已核对的进度）。
func parseReproduction(body []byte, key string) (ReproductionChecklist, error) {
	checklist := emptyChecklist(key)
	if err := json.Unmarshal(body, &checklist); err != nil {
		return ReproductionChecklist{}, fmt.Errorf("复现核对清单已损坏（不是合法 JSON 对象）: %w", err)
	}
	return fixReproduction(checklist, key), nil
}

// loadReproduction 经 appStateStore 读出（SQL 样板收进 internal/appstate）。
func (s *Server) loadReproduction(ctx context.Context, key string) (ReproductionChecklist, error) {
	checklist, exists, err := appstate.Load[ReproductionChecklist](ctx, s.appStateStore, "reproduction:"+key)
	if err != nil {
		if exists {
			return ReproductionChecklist{}, fmt.Errorf("复现核对清单已损坏（不是合法 JSON 对象）: %w", err)
		}
		return ReproductionChecklist{}, fmt.Errorf("读取复现核对清单失败: %w", err)
	}
	if !exists {
		return emptyChecklist(key), nil
	}
	return fixReproduction(checklist, key), nil
}

// mutateReproduction 在 reproduction:<key> 键的每 key 锁内做原子读-改-写，
// 取代原先「appStateMu + load → 改 → save 三步」。
func (s *Server) mutateReproduction(ctx context.Context, key string, fn func(checklist ReproductionChecklist) (ReproductionChecklist, error)) error {
	return s.appStateStore.Update(ctx, "reproduction:"+key, func(cur []byte, exists bool) ([]byte, error) {
		checklist := emptyChecklist(key)
		if exists {
			parsed, err := parseReproduction(cur, key)
			if err != nil {
				return nil, err
			}
			checklist = parsed
		}
		next, err := fn(checklist)
		if err != nil {
			return nil, err
		}
		return json.Marshal(next)
	})
}

// reproductionUnknownCount 未知项仍计入总数：未知是「待核对」，不是「已确认」。
func reproductionUnknownCount(analysis validate.ReproductionAnalysis) int {
	count := 0
	for _, group := range validate.ReproductionGroups(analysis) {
		for _, item := range group.Items {
			if item.Finding.Page == nil {
				count++
			}
		}
	}
	return count
}

// safeObjectKey 挡保留名（__proto__ / constructor / prototype）与空值：
// 它们会污染内存映射或让 JSON 序列化静默丢字段。
func safeObjectKey(value, what string) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("%s 不能为空", what)
	}
	switch trimmed {
	case "__proto__", "constructor", "prototype":
		return fmt.Errorf("非法%s（保留名，已拒绝）", what)
	}
	return nil
}
