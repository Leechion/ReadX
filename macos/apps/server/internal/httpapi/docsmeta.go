// docsmeta.go：论文库的附加元数据（收藏、用户标签、回收站）。
//
// 存 app_state('documents.meta') 的键值 JSON，与 documents.status 覆盖同一套路数：
// 旧版把 status/favorite/tags 都放在 library.json 里，v2 导入时已整份留档到
// app_state('legacy.library')；这里维护的是 v2 自己的可写副本，导入不覆盖它。
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
)

const maxDocumentTags = 16

// maxDocumentCategories 单篇的彩色分类数上限。分类是「少量、稳定」的组织维度，
// 放任数量会让左栏与表格视图失去可读性。
const maxDocumentCategories = 8

// DocumentMeta 与 web 侧 DocumentMeta 一一对应。
type DocumentMeta struct {
	Key        string   `json:"key"`
	Favorite   bool     `json:"favorite"`
	Tags       []string `json:"tags"`
	Categories []string `json:"categories"`
	Deleted    bool     `json:"deleted"`
	Updated    string   `json:"updatedAt"`
}

func emptyMeta(key string) DocumentMeta {
	return DocumentMeta{Key: key, Tags: []string{}, Categories: []string{}}
}

// Category 是彩色分类的定义：名字 + 颜色 + 排序。与参考实现「彩色分类」一致，
// 分类定义是库级的一份，论文只引用分类名（改色不需要回写每篇论文）。
type Category struct {
	Name  string `json:"name"`
	Color string `json:"color"`
	Order int    `json:"order"`
}

// categoryColors 与批注同一套暖色调色板：整个应用只有一份颜色语义，
// 用户不必学两套「哪个颜色代表什么」。
var categoryColors = map[string]bool{
	"amber": true, "rose": true, "sky": true, "green": true, "violet": true, "slate": true,
}

// handleCategoryList 返回库级分类定义（按 order 排序）。
func (s *Server) handleCategoryList(w http.ResponseWriter, r *http.Request) {
	categories, err := s.loadCategories(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": categories, "total": len(categories)})
}

// handleCategoryUpsert 新建或改色/重排一个分类（按名字 upsert）。
// 读-改-写在 mutateCategories 的每 key 锁内原子完成。
func (s *Server) handleCategoryUpsert(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Color string `json:"color"`
		Order *int   `json:"order"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "分类名不能为空")
		return
	}
	if len([]rune(name)) > 24 {
		writeError(w, http.StatusBadRequest, "分类名过长（上限 24 字）")
		return
	}
	if strings.ContainsAny(name, "\n\r\t") {
		writeError(w, http.StatusBadRequest, "分类名不能含换行")
		return
	}
	color := strings.ToLower(strings.TrimSpace(body.Color))
	if color == "" {
		color = "slate"
	}
	if !categoryColors[color] {
		writeError(w, http.StatusBadRequest, "不支持的分类颜色")
		return
	}
	updated := false
	categories, err := s.mutateCategoriesResult(r.Context(), func(categories []Category) ([]Category, error) {
		updated = false // A conditional write may retry against a newer list.
		for index := range categories {
			if categories[index].Name == name {
				categories[index].Color = color
				if body.Order != nil {
					categories[index].Order = *body.Order
				}
				updated = true
				break
			}
		}
		if !updated {
			order := len(categories)
			if body.Order != nil {
				order = *body.Order
			}
			categories = append(categories, Category{Name: name, Color: color, Order: order})
		}
		sortCategories(categories) // 排序在写回前完成，响应与落盘一致
		return categories, nil
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存分类失败: "+err.Error())
		return
	}
	status := http.StatusCreated
	if updated {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"categories": categories, "updated": updated})
}

// handleCategoryDelete 删除分类定义，并从所有论文上摘掉该分类引用（不留悬空名）。
// 分类键与元数据键各自经 appStateStore 的每 key 锁原子更新。
func (s *Server) handleCategoryDelete(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.PathValue("name"))
	if name == "" {
		writeError(w, http.StatusBadRequest, "分类名不能为空")
		return
	}
	kept, err := s.mutateCategoriesResult(r.Context(), func(categories []Category) ([]Category, error) {
		kept := categories[:0]
		for _, item := range categories {
			if item.Name == name {
				continue
			}
			kept = append(kept, item)
		}
		if len(kept) == len(categories) {
			return nil, errCategoryNotFound
		}
		return kept, nil
	})
	if err != nil {
		if errors.Is(err, errCategoryNotFound) {
			writeError(w, http.StatusNotFound, errCategoryNotFound.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "删除分类失败: "+err.Error())
		return
	}
	// 摘掉论文上的引用：分类名是弱引用，定义没了就不该继续挂在论文上。
	// 整个循环收进一次 mutateAllMeta（原先逐篇 saveMeta，N 次读改写）。
	if err := s.mutateAllMeta(r.Context(), func(all map[string]DocumentMeta) (map[string]DocumentMeta, error) {
		for key, meta := range all {
			filtered := meta.Categories[:0]
			for _, item := range meta.Categories {
				if item != name {
					filtered = append(filtered, item)
				}
			}
			if len(filtered) != len(meta.Categories) {
				meta.Categories = filtered
				all[key] = meta
			}
		}
		return all, nil
	}); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": kept, "deleted": true})
}

// handleMetaList 返回全部论文库元数据，供左栏筛选/表格视图与回收站使用。
func (s *Server) handleDocumentMetaList(w http.ResponseWriter, r *http.Request) {
	all, err := s.loadAllMeta(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	items := make([]DocumentMeta, 0, len(all))
	for _, item := range all {
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{"meta": items, "total": len(items)})
}

// handleDocumentMetaPatch 合并式更新单篇的收藏/标签/回收站标记。
//
// 只接受白名单字段：未提供（null）的字段保持不变，避免「改标签顺手清掉收藏」这类意外。
// 读-改-写在 mutateAllMeta 的每 key 锁内原子完成。
func (s *Server) handleDocumentMetaPatch(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Favorite   *bool     `json:"favorite"`
		Tags       *[]string `json:"tags"`
		Categories *[]string `json:"categories"`
		Deleted    *bool     `json:"deleted"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	s.documentLifecycleMu.Lock()
	defer s.documentLifecycleMu.Unlock()
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if body.Tags != nil {
		tags, err := normalizeTags(*body.Tags)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if len(tags) > maxDocumentTags {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("标签数量上限 %d", maxDocumentTags))
			return
		}
	}
	if body.Categories != nil {
		names, err := normalizeCategoryNames(*body.Categories)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if len(names) > maxDocumentCategories {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("分类数量上限 %d", maxDocumentCategories))
			return
		}
	}

	current := emptyMeta(key)
	if err := s.mutateAllMeta(r.Context(), func(all map[string]DocumentMeta) (map[string]DocumentMeta, error) {
		current = emptyMeta(key)
		if item, ok := all[key]; ok {
			current = item
		}
		if body.Favorite != nil {
			current.Favorite = *body.Favorite
		}
		if body.Tags != nil {
			current.Tags, _ = normalizeTags(*body.Tags)
			if current.Tags == nil {
				current.Tags = []string{}
			}
		}
		if body.Categories != nil {
			current.Categories, _ = normalizeCategoryNames(*body.Categories)
			if current.Categories == nil {
				current.Categories = []string{}
			}
		}
		if body.Deleted != nil {
			current.Deleted = *body.Deleted
		}
		current.Key = key
		current.Updated = nowStamp()
		all[key] = current
		return all, nil
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "保存论文元数据失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, current)
}

// handleTagList 汇总库里出现过的所有用户标签（去重、排序），供筛选器与补全使用。
func (s *Server) handleTagList(w http.ResponseWriter, r *http.Request) {
	all, err := s.loadAllMeta(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seen := map[string]bool{}
	tags := []string{}
	for _, item := range all {
		for _, tag := range item.Tags {
			if !seen[tag] {
				seen[tag] = true
				tags = append(tags, tag)
			}
		}
	}
	sortStringsLocal(tags)
	if tags == nil {
		tags = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags, "total": len(tags)})
}

// ---- 数据访问 ----
// appStateStore 提供每 key 原子更新；涉及文档存亡的操作（清空回收站）见 trash.go
// 的说明——documentLifecycleMu 覆盖存亡检查与文件操作，元数据合并仍走每 key 锁。

// errCategoryNotFound 是 mutateCategories 闭包里的 404 哨兵。
var errCategoryNotFound = errors.New("没有这个分类")

// parseAllMeta 反序列化并补全 documents.meta（损坏明确报错，绝不静默回空：
// 回空会让下一次写入覆盖用户数据）。供 mutateAllMeta 在锁内解析现有值。
func parseAllMeta(body []byte) (map[string]DocumentMeta, error) {
	raw := map[string]DocumentMeta{}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, fmt.Errorf("论文元数据已损坏（app_state.documents.meta 不是 JSON 对象）: %w", err)
	}
	for key, item := range raw {
		if item.Tags == nil {
			item.Tags = []string{}
		}
		if item.Categories == nil {
			item.Categories = []string{}
		}
		item.Key = key
		raw[key] = item
	}
	return raw, nil
}

func (s *Server) loadAllMeta(ctx context.Context) (map[string]DocumentMeta, error) {
	all, exists, err := appstate.Load[map[string]DocumentMeta](ctx, s.appStateStore, "documents.meta")
	if err != nil {
		if exists {
			return nil, fmt.Errorf("论文元数据已损坏（app_state.documents.meta 不是 JSON 对象）: %w", err)
		}
		return nil, fmt.Errorf("读取论文元数据失败: %w", err)
	}
	if !exists || all == nil {
		return map[string]DocumentMeta{}, nil
	}
	for key, item := range all {
		if item.Tags == nil {
			item.Tags = []string{}
		}
		if item.Categories == nil {
			item.Categories = []string{}
		}
		item.Key = key
		all[key] = item
	}
	return all, nil
}

// mutateAllMeta 在 documents.meta 键的每 key 锁内做原子读-改-写；
// fn 返回错误即放弃写回。
func (s *Server) mutateAllMeta(ctx context.Context, fn func(all map[string]DocumentMeta) (map[string]DocumentMeta, error)) error {
	return s.appStateStore.Update(ctx, "documents.meta", func(cur []byte, exists bool) ([]byte, error) {
		all := map[string]DocumentMeta{}
		if exists {
			parsed, err := parseAllMeta(cur)
			if err != nil {
				return nil, err
			}
			all = parsed
		}
		next, err := fn(all)
		if err != nil || next == nil {
			return nil, err
		}
		return json.Marshal(next)
	})
}

func (s *Server) loadMeta(ctx context.Context, key string) (DocumentMeta, error) {
	all, err := s.loadAllMeta(ctx)
	if err != nil {
		return DocumentMeta{}, err
	}
	if item, ok := all[key]; ok {
		return item, nil
	}
	return emptyMeta(key), nil
}

// saveMeta 是单次原子读-改-写：调用方先 loadMeta 再 saveMeta 的两步写法不会
// 丢并发更新（后写者的读改写基于锁内最新值；同篇冲突以最后一次为准）。
func (s *Server) saveMeta(ctx context.Context, key string, meta DocumentMeta) error {
	return s.mutateAllMeta(ctx, func(all map[string]DocumentMeta) (map[string]DocumentMeta, error) {
		all[key] = meta
		return all, nil
	})
}

// restoreDocumentFromTrash makes re-importing a soft-deleted document restore the
// existing library entry instead of creating a new OCR/translation run.
// 清除 Deleted 是单次原子读-改-写：闭包内基于锁内最新值改字段，并发 PATCH
// 的其它字段（如 favorite）不会被覆盖。与清空回收站的竞争窗口由 trash 侧的
// documentLifecycleMu 覆盖 Deleted 预检到删除文件的完整过程。
func (s *Server) restoreDocumentFromTrash(ctx context.Context, key string) (DocumentSummary, error) {
	s.documentLifecycleMu.Lock()
	defer s.documentLifecycleMu.Unlock()
	if _, err := s.loadDocument(ctx, key); err != nil {
		return DocumentSummary{}, err
	}
	if err := s.mutateAllMeta(ctx, func(all map[string]DocumentMeta) (map[string]DocumentMeta, error) {
		if meta, ok := all[key]; ok && meta.Deleted {
			meta.Deleted = false
			meta.Updated = nowStamp()
			all[key] = meta
		}
		return all, nil
	}); err != nil {
		return DocumentSummary{}, err
	}
	return s.loadDocument(ctx, key)
}

func sortStringsLocal(items []string) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && strings.Compare(items[j], items[j-1]) < 0; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}

// normalizeCategoryNames 去空白、去重，并拒绝控制字符。分类名会进 CSS 类名与导出，
// 不能放任换行等字符。
func normalizeCategoryNames(names []string) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		if len([]rune(trimmed)) > 24 {
			return nil, fmt.Errorf("分类名「%s」过长（上限 24 字）", trimmed)
		}
		if strings.ContainsAny(trimmed, "\n\r\t") {
			return nil, fmt.Errorf("分类名不能含换行")
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out, nil
}

func sortCategories(categories []Category) {
	for i := 1; i < len(categories); i++ {
		for j := i; j > 0; j-- {
			left, right := categories[j-1], categories[j]
			if left.Order < right.Order || (left.Order == right.Order && left.Name <= right.Name) {
				break
			}
			categories[j-1], categories[j] = right, left
		}
	}
}

func (s *Server) loadCategories(ctx context.Context) ([]Category, error) {
	categories, exists, err := appstate.Load[[]Category](ctx, s.appStateStore, "library.categories")
	if err != nil {
		if exists {
			return nil, fmt.Errorf("分类定义已损坏（app_state.library.categories 不是 JSON 数组）: %w", err)
		}
		return nil, fmt.Errorf("读取分类定义失败: %w", err)
	}
	if !exists || categories == nil {
		return []Category{}, nil
	}
	return categories, nil
}

// mutateCategories 在 library.categories 键的每 key 锁内做原子读-改-写。
func (s *Server) mutateCategories(ctx context.Context, fn func(categories []Category) ([]Category, error)) error {
	_, err := s.mutateCategoriesResult(ctx, fn)
	return err
}

// mutateCategoriesResult 同 mutateCategories，并把写回的列表带给响应方。
func (s *Server) mutateCategoriesResult(ctx context.Context, fn func(categories []Category) ([]Category, error)) ([]Category, error) {
	var result []Category
	err := s.appStateStore.Update(ctx, "library.categories", func(cur []byte, exists bool) ([]byte, error) {
		categories := []Category{}
		if exists {
			if err := json.Unmarshal(cur, &categories); err != nil {
				return nil, fmt.Errorf("分类定义已损坏（app_state.library.categories 不是 JSON 数组）: %w", err)
			}
		}
		next, err := fn(categories)
		if err != nil {
			return nil, err
		}
		result = next
		return json.Marshal(next)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Server) saveCategories(ctx context.Context, categories []Category) error {
	return appstate.Save(ctx, s.appStateStore, "library.categories", categories)
}
