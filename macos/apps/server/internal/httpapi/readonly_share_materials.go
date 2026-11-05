package httpapi

import (
	"cbctv2/server/internal/publication"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
)

type shareLocator struct {
	Kind        string `json:"kind"`
	Href        string `json:"href,omitempty"`
	BlockStart  int    `json:"blockStart,omitempty"`
	BlockEnd    int    `json:"blockEnd,omitempty"`
	StartOffset int    `json:"startOffset,omitempty"`
	EndOffset   int    `json:"endOffset,omitempty"`
}
type shareBlock struct {
	Kind  string `json:"kind"`
	Text  string `json:"text"`
	Image string `json:"image,omitempty"`
}
type shareSection struct {
	Href   string       `json:"href"`
	Title  string       `json:"title"`
	Blocks []shareBlock `json:"blocks"`
}
type shareEvidence struct {
	PaperKey   string `json:"paperKey"`
	PaperTitle string `json:"paperTitle"`
	Origin     string `json:"origin"`
	Page       *int   `json:"page"`
	Excerpt    string `json:"excerpt"`
}
type shareIdea struct {
	Question    string          `json:"question"`
	Observation string          `json:"observation"`
	Hypothesis  string          `json:"hypothesis"`
	Method      string          `json:"method"`
	Experiment  string          `json:"experiment"`
	Status      string          `json:"status"`
	Evidence    []shareEvidence `json:"evidence"`
}
type shareField struct {
	Key     string `json:"k"`
	Value   string `json:"v"`
	Page    *int   `json:"page,omitempty"`
	Excerpt string `json:"excerpt,omitempty"`
}
type shareComparison struct {
	Key    string                  `json:"key"`
	Title  string                  `json:"title"`
	Status string                  `json:"status"`
	Groups map[string][]shareField `json:"groups"`
}

var shareGroups = []string{"dataset", "acquisition", "training", "loss", "baselines", "metrics", "results"}

func shareExperiment(doc DocumentSummary, raw string) shareComparison {
	item := shareComparison{Key: doc.Key, Title: doc.Title, Status: "未抽取", Groups: map[string][]shareField{}}
	var parsed map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &parsed) != nil {
		return item
	}
	for _, kind := range shareGroups {
		var fields []shareField
		if value, exists := parsed[kind]; exists && json.Unmarshal(value, &fields) == nil {
			item.Groups[kind] = fields
			item.Status = "已有抽取"
		}
	}
	return item
}
func shareSelectedIdeas(ideas []ResearchIdea, selected map[string]bool, documents []shareDocument) []shareIdea {
	titles := map[string]string{}
	for _, doc := range documents {
		titles[doc.Key] = doc.Title
	}
	out := []shareIdea{}
	for _, idea := range ideas {
		evidence := []shareEvidence{}
		for _, source := range idea.Evidence {
			if selected[source.PaperKey] {
				evidence = append(evidence, shareEvidence{PaperKey: source.PaperKey, PaperTitle: titles[source.PaperKey], Origin: source.Origin, Page: source.Page, Excerpt: source.Excerpt})
			}
		}
		if len(evidence) > 0 {
			out = append(out, shareIdea{Question: idea.Question, Observation: idea.Observation, Hypothesis: idea.Hypothesis, Method: idea.Method, Experiment: idea.Experiment, Status: idea.Status, Evidence: evidence})
		}
	}
	return out
}
func shareEPUBSections(data []byte) ([]shareSection, error) {
	book, err := publication.ParseEPUB(data)
	if err != nil {
		return nil, err
	}
	archive, err := publication.Archive(data)
	if err != nil {
		return nil, err
	}
	result := []shareSection{}
	images := map[string]string{}
	total := 0
	for _, section := range book.Sections {
		part := shareSection{Href: section.Href, Title: section.Title, Blocks: []shareBlock{}}
		for _, block := range section.Blocks {
			item := shareBlock{Kind: block.Kind, Text: block.Text}
			total += len(block.Text)
			if block.Kind == "image" && block.Src != "" {
				encoded, exists := images[block.Src]
				if !exists {
					raw, err := publication.ReadResource(archive, block.Src)
					if err != nil {
						return nil, err
					}
					total += len(raw)
					contentType := http.DetectContentType(raw)
					switch contentType {
					case "image/png", "image/jpeg", "image/gif", "image/webp":
						encoded = "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(raw)
					}
					images[block.Src] = encoded
				}
				item.Image = encoded
			}
			if total > 64<<20 {
				return nil, fmt.Errorf("EPUB 章节和图片展开后超过分享上限 64 MiB")
			}
			part.Blocks = append(part.Blocks, item)
		}
		result = append(result, part)
	}
	return result, nil
}
