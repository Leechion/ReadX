package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"cbctv2/server/internal/appstate"
)

type scholarHit struct {
	paperCandidate
	Source   string   `json:"source"`
	SourceID string   `json:"sourceId"`
	Sources  []string `json:"sources"`
}
type scholarRun struct {
	Source    string `json:"source"`
	Query     string `json:"query"`
	Total     int    `json:"total"`
	Retrieved int    `json:"retrieved"`
	Error     string `json:"error,omitempty"`
}
type scholarSearch struct {
	ID         string       `json:"id"`
	At         string       `json:"at"`
	Page       int          `json:"page"`
	Runs       []scholarRun `json:"runs"`
	Results    []scholarHit `json:"results"`
	Disclosure string       `json:"disclosure"`
}

func scholarIdentity(hit scholarHit) string {
	if doi := normalizePublicationDOI(hit.DOI); doi != "" {
		return "doi:" + strings.ToLower(doi)
	}
	return hit.Source + ":" + hit.SourceID
}
func dedupeScholar(hits []scholarHit) []scholarHit {
	out := []scholarHit{}
	indices := map[string]int{}
	for _, hit := range hits {
		key := scholarIdentity(hit)
		if key == ":" || strings.TrimSpace(hit.Title) == "" {
			continue
		}
		if index, ok := indices[key]; ok {
			for _, source := range append(hit.Sources, hit.Source) {
				found := false
				for _, prior := range out[index].Sources {
					found = found || prior == source
				}
				if source != "" && !found {
					out[index].Sources = append(out[index].Sources, source)
				}
			}
			continue
		}
		indices[key] = len(out)
		if len(hit.Sources) == 0 {
			hit.Sources = []string{hit.Source}
		}
		out = append(out, hit)
	}
	return out
}
func (s *Server) fetchScholarJSON(ctx context.Context, endpoint string, target any) error {
	if strings.Contains(endpoint, "eutils.ncbi.nlm.nih.gov") {
		s.scholarMu.Lock()
		delay := time.Until(s.nextEutils)
		if delay < 0 {
			delay = 0
		}
		s.nextEutils = time.Now().Add(delay + 400*time.Millisecond)
		s.scholarMu.Unlock()
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
	getter := s.scholarFetch
	if getter == nil {
		getter = fetchPublic
	}
	raw, _, err := getter(ctx, endpoint, 8<<20)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}
func (s *Server) searchScholar(ctx context.Context, source, q string, page int) ([]scholarHit, int, error) {
	const size = 20
	switch source {
	case "crossref":
		// Crossref query.bibliographic is not a PubMed Boolean-query translator.
		for _, word := range strings.Fields(q) {
			if word == "AND" || word == "OR" || word == "NOT" {
				return nil, 0, fmt.Errorf("Crossref 首版只支持书目关键词，请填写该来源专用检索词")
			}
		}
		getter := s.scholarFetch
		if getter == nil {
			getter = fetchPublic
		}
		raw, _, err := getter(ctx, "https://api.crossref.org/works?rows=20&offset="+strconv.Itoa((page-1)*size)+"&query.bibliographic="+url.QueryEscape(q), 8<<20)
		if err != nil {
			return nil, 0, err
		}
		candidates, err := crossrefCandidates(raw, false)
		if err != nil {
			return nil, 0, err
		}
		var envelope struct {
			Message struct {
				Total int `json:"total-results"`
			} `json:"message"`
		}
		_ = json.Unmarshal(raw, &envelope)
		hits := []scholarHit{}
		for _, item := range candidates {
			if item.URL == "" {
				item.URL = "https://doi.org/" + item.DOI
			}
			hits = append(hits, scholarHit{paperCandidate: item, Source: source, SourceID: item.DOI})
		}
		return hits, envelope.Message.Total, nil
	case "openalex":
		var response struct {
			Meta struct {
				Count int `json:"count"`
			} `json:"meta"`
			Results []struct {
				ID          string `json:"id"`
				Title       string `json:"title"`
				DOI         string `json:"doi"`
				Year        int    `json:"publication_year"`
				Authorships []struct {
					Author struct {
						Name string `json:"display_name"`
					} `json:"author"`
				} `json:"authorships"`
				Primary struct {
					Source *struct {
						Name string `json:"display_name"`
					} `json:"source"`
				} `json:"primary_location"`
				Best *struct {
					URL string `json:"pdf_url"`
				} `json:"best_oa_location"`
			} `json:"results"`
		}
		err := s.fetchScholarJSON(ctx, "https://api.openalex.org/works?per-page=20&page="+strconv.Itoa(page)+"&search="+url.QueryEscape(q), &response)
		if err != nil {
			return nil, 0, err
		}
		hits := []scholarHit{}
		for _, item := range response.Results {
			authors := []string{}
			for _, a := range item.Authorships {
				authors = append(authors, a.Author.Name)
			}
			venue := ""
			if item.Primary.Source != nil {
				venue = item.Primary.Source.Name
			}
			link := item.ID
			if item.Best != nil && item.Best.URL != "" {
				link = item.Best.URL
			}
			hits = append(hits, scholarHit{paperCandidate: paperCandidate{Title: item.Title, DOI: normalizePublicationDOI(item.DOI), Authors: authors, Venue: venue, Year: item.Year, URL: link}, Source: source, SourceID: item.ID})
		}
		return hits, response.Meta.Count, nil
	case "pubmed":
		var response struct {
			Result struct {
				Count string   `json:"count"`
				IDs   []string `json:"idlist"`
				Error string   `json:"error"`
			} `json:"esearchresult"`
			Error string `json:"error"`
		}
		err := s.fetchScholarJSON(ctx, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=20&retstart="+strconv.Itoa((page-1)*size)+"&term="+url.QueryEscape(q), &response)
		if err != nil {
			return nil, 0, err
		}
		if response.Error != "" || response.Result.Error != "" {
			return nil, 0, fmt.Errorf("PubMed 查询失败：%s%s", response.Error, response.Result.Error)
		}
		total, _ := strconv.Atoi(response.Result.Count)
		if len(response.Result.IDs) == 0 {
			return []scholarHit{}, total, nil
		}
		var summaries struct {
			Result map[string]json.RawMessage `json:"result"`
		}
		err = s.fetchScholarJSON(ctx, "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id="+strings.Join(response.Result.IDs, ","), &summaries)
		if err != nil {
			return nil, 0, err
		}
		hits := []scholarHit{}
		for _, id := range response.Result.IDs {
			var item struct {
				Title   string `json:"title"`
				Venue   string `json:"fulljournalname"`
				Date    string `json:"pubdate"`
				Authors []struct {
					Name string `json:"name"`
				} `json:"authors"`
				IDs []struct {
					Type  string `json:"idtype"`
					Value string `json:"value"`
				} `json:"articleids"`
			}
			if json.Unmarshal(summaries.Result[id], &item) != nil {
				continue
			}
			authors := []string{}
			for _, a := range item.Authors {
				authors = append(authors, a.Name)
			}
			doi := ""
			for _, v := range item.IDs {
				if v.Type == "doi" {
					doi = v.Value
				}
			}
			year := 0
			if len(item.Date) >= 4 {
				year, _ = strconv.Atoi(item.Date[:4])
			}
			hits = append(hits, scholarHit{paperCandidate: paperCandidate{Title: item.Title, Authors: authors, DOI: doi, Venue: item.Venue, Year: year, URL: "https://pubmed.ncbi.nlm.nih.gov/" + id + "/"}, Source: source, SourceID: id})
		}
		return hits, total, nil
	}
	return nil, 0, fmt.Errorf("不支持的检索来源")
}
func (s *Server) handleScholarSearch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Queries map[string]string `json:"queries"`
		Page    int               `json:"page"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if body.Page < 1 {
		body.Page = 1
	}
	if body.Page > 100 || len(body.Queries) < 1 || len(body.Queries) > 3 {
		writeError(w, 400, "请选择 1–3 个来源，页数不超过 100")
		return
	}
	id, err := randomLeeJobID()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	result := scholarSearch{ID: id, At: time.Now().UTC().Format(time.RFC3339), Page: body.Page, Runs: []scholarRun{}, Disclosure: "每源每页最多 20 条；命中总数由来源报告，未抓取页不参与当前去重。语法按各源独立执行。目录命中不代表已取得或核验全文。"}
	sources := []string{}
	for source := range body.Queries {
		if source != "pubmed" && source != "openalex" && source != "crossref" {
			writeError(w, 400, "未知来源")
			return
		}
		sources = append(sources, source)
	}
	sort.Strings(sources)
	ctx, cancel := context.WithTimeout(r.Context(), 70*time.Second)
	defer cancel()
	hits := []scholarHit{}
	for _, source := range sources {
		q := strings.TrimSpace(body.Queries[source])
		if q == "" || len(q) > 4000 {
			writeError(w, 400, "检索式不能为空或超过 4000 字节")
			return
		}
		items, total, e := s.searchScholar(ctx, source, q, body.Page)
		run := scholarRun{Source: source, Query: q, Total: total, Retrieved: len(items)}
		if e != nil {
			run.Error = e.Error()
		}
		result.Runs = append(result.Runs, run)
		hits = append(hits, items...)
	}
	result.Results = dedupeScholar(hits)
	if err := appstate.Save(r.Context(), s.appStateStore, "scholar-search:"+id, result); err != nil {
		writeError(w, 500, "保存检索记录失败："+err.Error())
		return
	}
	writeJSON(w, 200, result)
}
func (s *Server) handleScholarHistory(w http.ResponseWriter, r *http.Request) {
	rows, err := s.handle.QueryContext(r.Context(), `SELECT value_json FROM app_state WHERE key LIKE 'scholar-search:%' ORDER BY updated_at DESC LIMIT 30`)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []scholarSearch{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		var item scholarSearch
		if json.Unmarshal([]byte(raw), &item) == nil {
			out = append(out, item)
		}
	}
	writeJSON(w, 200, map[string]any{"searches": out})
}
func (s *Server) handleScholarQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		rows, _, err := appstate.Load[[]scholarHit](r.Context(), s.appStateStore, "scholar-queue")
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if rows == nil {
			rows = []scholarHit{}
		}
		writeJSON(w, 200, map[string]any{"records": rows})
		return
	}
	var body struct {
		Records []scholarHit `json:"records"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if len(body.Records) > 100 {
		writeError(w, 400, "每次最多保存 100 条题录")
		return
	}
	for _, hit := range body.Records {
		u, e := url.Parse(hit.URL)
		if len(hit.Title) > 2000 || len(hit.SourceID) > 1000 || len(hit.URL) > 8000 || e != nil || u.User != nil || (hit.URL != "" && u.Scheme != "http" && u.Scheme != "https") {
			writeError(w, 400, "题录或来源 URL 无效")
			return
		}
	}
	var saved []scholarHit
	err := s.appStateStore.Update(r.Context(), "scholar-queue", func(raw []byte, exists bool) ([]byte, error) {
		rows := []scholarHit{}
		if exists {
			if e := json.Unmarshal(raw, &rows); e != nil {
				return nil, e
			}
		}
		saved = dedupeScholar(append(rows, body.Records...))
		if len(saved) > 10000 {
			return nil, fmt.Errorf("待读题录超过 10000 条，请先整理")
		}
		return json.Marshal(saved)
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"records": saved, "disclosure": "已保存题录至待读清单；尚未下载或验证全文。"})
}
func (s *Server) handleScholarSnowball(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key       string `json:"key"`
		DOI       string `json:"doi"`
		Direction string `json:"direction"`
		Page      int    `json:"page"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	if body.Direction != "references" && body.Direction != "citations" {
		writeError(w, 400, "方向只能是 references 或 citations")
		return
	}
	if body.Page < 1 {
		body.Page = 1
	}
	if body.Page > 100 {
		writeError(w, 400, "页数不能超过 100")
		return
	}
	if body.Key != "" {
		doc, e := s.loadDocument(r.Context(), body.Key)
		if e != nil {
			writeError(w, 404, "文档不存在")
			return
		}
		body.DOI = doc.DOI
	}
	doi := normalizePublicationDOI(body.DOI)
	if !strings.HasPrefix(doi, "10.") {
		writeError(w, 400, "请提供可靠的 DOI 锚点")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	var seed openAlexWorkRef
	err := s.fetchScholarJSON(ctx, "https://api.openalex.org/works/https://doi.org/"+url.PathEscape(doi)+"?select=id,doi,title,publication_year", &seed)
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	var works []openAlexWorkRef
	total := 0
	if body.Direction == "references" {
		var detail struct {
			ReferencedWorks []string `json:"referenced_works"`
		}
		e := s.fetchScholarJSON(ctx, "https://api.openalex.org/works/"+url.PathEscape(strings.TrimPrefix(seed.ID, "https://openalex.org/"))+"?select=id,referenced_works,cited_by_count", &detail)
		if e != nil {
			writeError(w, 502, e.Error())
			return
		}
		total = len(detail.ReferencedWorks)
		start := (body.Page - 1) * 20
		end := min(start+20, total)
		if start < total {
			ids := []string{}
			for _, id := range detail.ReferencedWorks[start:end] {
				ids = append(ids, strings.TrimPrefix(id, "https://openalex.org/"))
			}
			var response struct {
				Results []openAlexWorkRef `json:"results"`
			}
			err = s.fetchScholarJSON(ctx, "https://api.openalex.org/works?per-page=20&filter="+url.QueryEscape("openalex_id:"+strings.Join(ids, "|")), &response)
			works = response.Results
		}
	} else {
		var response struct {
			Meta struct {
				Count int `json:"count"`
			} `json:"meta"`
			Results []openAlexWorkRef `json:"results"`
		}
		err = s.fetchScholarJSON(ctx, "https://api.openalex.org/works?per-page=20&page="+strconv.Itoa(body.Page)+"&filter=cites:"+url.QueryEscape(strings.TrimPrefix(seed.ID, "https://openalex.org/")), &response)
		works = response.Results
		total = response.Meta.Count
	}
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	hits := []scholarHit{}
	for _, work := range works {
		hits = append(hits, scholarHit{paperCandidate: paperCandidate{Title: work.Title, DOI: normalizePublicationDOI(work.DOI), Year: work.Year, URL: work.ID, Authors: []string{}}, Source: "openalex", SourceID: work.ID})
	}
	id, _ := randomLeeJobID()
	record := scholarSearch{ID: id, At: time.Now().UTC().Format(time.RFC3339), Page: body.Page, Runs: []scholarRun{{Source: "openalex", Query: body.Direction + ":" + doi, Total: total, Retrieved: len(hits)}}, Results: dedupeScholar(hits), Disclosure: "引文关系来自 OpenAlex 目录，不代表支持或反驳；全文未验证。本次仅扩展一层，每页最多 20 条。"}
	if err = appstate.Save(r.Context(), s.appStateStore, "scholar-search:"+id, record); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, record)
}
