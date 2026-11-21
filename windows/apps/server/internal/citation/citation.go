// Package citation 把库里的题录渲染成 BibTeX / RIS。
//
// 这里只做纯字符串处理，不读数据库、不碰网络：这样「条目类型怎么判定的」可以逐条写进测试。
//
// 两条纪律：
//  1. **不替作者猜条目类型**。只按会场名里的期刊/会议关键词和已知会议缩写判 @article / @inproceedings；
//     判断不出来就用 @misc + howpublished 原样带出会场名，并把判定依据一并返回给界面披露。
//  2. **不改写作者姓名**。题录里存的是 "Ruyi Zha" 这种原样写法，强行转成 "Zha, Ruyi" 会把
//     "van der Berg" 这类姓名改错，所以按存储原样输出。
package citation

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Kind 是 BibTeX 的条目类型，同时也是 RIS 的 TY 来源。
type Kind string

const (
	KindArticle       Kind = "article"
	KindInProceedings Kind = "inproceedings"
	KindMisc          Kind = "misc"
)

// Work 是一篇论文渲染书目所需的全部字段（其余字段一律不参与输出）。
type Work struct {
	Key      string
	Title    string
	Authors  []string
	Year     int
	Venue    string
	DOI      string
	URL      string
	ArxivID  string
	Keywords []string
}

// Classification 是条目类型的判定结果与依据（依据会写进导出文件的注释并在界面披露）。
type Classification struct {
	Kind  Kind
	Field string // journal / booktitle / howpublished
	Value string
	Basis string
}

// 期刊关键词：命中即 @article。
var journalWords = []string{
	"journal", "transactions", "letters", "review", "magazine", "bulletin",
	"学报", "期刊", "杂志", "nature", "science", "cell", "radiology",
}

// 会议关键词：命中即 @inproceedings。
var conferenceWords = []string{
	"conference", "conf.", "conf", "workshop", "symposium", "meeting",
	"proceedings", "proc.", "congress", "challenge", "会议", "研讨会", "论坛",
}

// 已知会议缩写：会场名常常只写缩写（ECCV 2022），没有 "conference" 字样。
var conferenceAcronyms = []string{
	"cvpr", "iccv", "eccv", "neurips", "nips", "iclr", "icml", "aaai", "ijcai",
	"miccai", "isbi", "ipmi", "ismrm", "spie", "siggraph", "acl", "emnlp", "naacl",
	"kdd", "www", "icdm", "icde", "sigir", "wacv", "3dv", "bmvc", "ismar", "micad",
}

var arxivIDPattern = regexp.MustCompile(`(?i)(?:arxiv\.org/(?:abs|pdf)/|arxiv:)\s*([0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[a-z]{2})?/[0-9]{7})(?:v[0-9]+)?`)
var arxivBarePattern = regexp.MustCompile(`^[0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?$`)
var nonCiteKeyPattern = regexp.MustCompile(`[^a-z0-9]+`)

// ArxivID 从 URL / DOI 里提取 arXiv 号；提取不到返回空串。
func ArxivID(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		if match := arxivIDPattern.FindStringSubmatch(trimmed); match != nil {
			return strings.TrimSuffix(match[1], "/")
		}
		if arxivBarePattern.MatchString(trimmed) {
			return strings.TrimSuffix(trimmed, "/")
		}
	}
	return ""
}

// Classify 判定条目类型。venue 为空且能认出 arXiv 号时按预印本输出。
func Classify(work Work) Classification {
	venue := strings.TrimSpace(work.Venue)
	lowered := strings.ToLower(venue)
	switch {
	case venue == "" && strings.TrimSpace(work.ArxivID) != "":
		return Classification{Kind: KindMisc, Field: "howpublished", Value: "arXiv preprint",
			Basis: "没有会场信息，只有 arXiv 号：按 @misc 输出并写入 eprint"}
	case venue == "":
		return Classification{Kind: KindMisc, Field: "howpublished", Value: "",
			Basis: "题录里没有会场/期刊信息：按 @misc 输出，不推测条目类型"}
	case containsAny(lowered, journalWords):
		return Classification{Kind: KindArticle, Field: "journal", Value: venue,
			Basis: "会场名含期刊关键词：按 @article 输出"}
	case containsAny(lowered, conferenceWords) || containsAny(lowered, conferenceAcronyms):
		return Classification{Kind: KindInProceedings, Field: "booktitle", Value: venue,
			Basis: "会场名含会议关键词或已知会议缩写：按 @inproceedings 输出"}
	default:
		return Classification{Kind: KindMisc, Field: "howpublished", Value: venue,
			Basis: "会场名无法判断是期刊还是会议：按 @misc 输出，原样带出会场名"}
	}
}

func containsAny(value string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

// oneLine 压掉换行：书目字段是逐行的，字段里混进换行会把文件写坏。
func oneLine(value string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(value, "\r", " ")), " ")
}

// escapeBibTeX 只转义会破坏 BibTeX 解析或 LaTeX 渲染的字符。
// 花括号、反斜杠、~、^ 一律原样保留：题录里可能本来就带 LaTeX（如数学符号），
// 二次转义反而会把正确的写法弄坏。
func escapeBibTeX(value string) string {
	replacer := strings.NewReplacer(
		`\`, `\textbackslash{}`,
		`&`, `\&`,
		`%`, `\%`,
		`$`, `\$`,
		`#`, `\#`,
		`_`, `\_`,
	)
	return replacer.Replace(oneLine(value))
}

// CiteKey 生成 bibkey：首作者姓氏 + 年份 + 标题首个实词，冲突时按 BibTeX 惯例加 a/b/c 后缀。
func CiteKey(work Work, used map[string]int) string {
	author := ""
	if len(work.Authors) > 0 {
		author = lastNameToken(work.Authors[0])
	}
	year := ""
	if work.Year > 0 {
		year = fmt.Sprintf("%d", work.Year)
	}
	word := titleWord(work.Title)
	base := nonCiteKeyPattern.ReplaceAllString(strings.ToLower(author+year+word), "")
	if base == "" {
		base = nonCiteKeyPattern.ReplaceAllString(strings.ToLower(work.Key), "")
	}
	if base == "" {
		base = "readx"
	}
	if base[0] >= '0' && base[0] <= '9' {
		base = "readx" + base
	}
	seen := used[base]
	used[base] = seen + 1
	if seen == 0 {
		return base
	}
	suffix := string(rune('a' + (seen-1)%26))
	if seen > 26 {
		suffix = fmt.Sprintf("%c%d", 'a'+(seen-1)%26, (seen-1)/26)
	}
	return base + suffix
}

// lastNameToken 取作者名的最后一个词：多数题录是 "First Last" 形式。
// 非拉丁姓名（中文等）取不到可用的 ASCII 片段时返回空串，由 CiteKey 兜底。
func lastNameToken(author string) string {
	fields := strings.Fields(strings.TrimSpace(author))
	if len(fields) == 0 {
		return ""
	}
	last := fields[len(fields)-1]
	if strings.Contains(last, ",") {
		last = strings.TrimSuffix(last, ",")
	}
	if nonCiteKeyPattern.ReplaceAllString(strings.ToLower(last), "") == "" {
		return ""
	}
	return last
}

var titleStopWords = map[string]bool{
	"a": true, "an": true, "the": true, "on": true, "of": true, "for": true,
	"and": true, "with": true, "to": true, "in": true, "using": true, "towards": true,
	"toward": true, "via": true, "from": true, "at": true, "by": true, "is": true,
}

func titleWord(title string) string {
	// 先按空白与常见分隔符切词，再逐词剥掉非字母数字：直接按「非字母数字」切
	// 会把 R&D 切成 r 和 d，citekey 就成了 lovelace2022r 这种没有辨识度的东西。
	for _, token := range strings.FieldsFunc(strings.ToLower(oneLine(title)), func(r rune) bool {
		switch r {
		case ' ', ':', ';', '-', '–', '/', ',', '.', '(', ')', '[', ']', '{', '}', '"', '\'', '?', '!', '—':
			return true
		}
		return false
	}) {
		word := nonCiteKeyPattern.ReplaceAllString(token, "")
		if word == "" || titleStopWords[word] {
			continue
		}
		return word
	}
	return ""
}

// BibTeX 渲染整套书目。注释里写明导出时间与条目类型的判定方式，
// 免得读者以为这些类型是论文自己声明的。
func BibTeX(works []Work, at time.Time) string {
	var out strings.Builder
	fmt.Fprintf(&out, "%% ReadX 书目导出 · %d 篇 · %s\n", len(works), at.UTC().Format(time.RFC3339))
	out.WriteString("% 条目类型按会场名关键词推断；判断不出来时用 @misc，不替作者猜。\n")
	out.WriteString("% 作者姓名按库中题录原样输出，未做 \"Last, First\" 改写。\n\n")
	used := map[string]int{}
	for _, work := range works {
		out.WriteString(BibTeXEntry(work, CiteKey(work, used)))
		out.WriteString("\n")
	}
	return out.String()
}

// BibTeXEntry 渲染单篇论文的 BibTeX 条目；调用方负责传入已去重的 citeKey。
func BibTeXEntry(work Work, citeKey string) string {
	var out strings.Builder
	class := Classify(work)
	fmt.Fprintf(&out, "@%s{%s,\n", class.Kind, citeKey)
	writeBibField(&out, "author", strings.Join(work.Authors, " and "))
	writeBibField(&out, "title", work.Title)
	if class.Value != "" {
		writeBibField(&out, class.Field, class.Value)
	}
	if work.Year > 0 {
		writeBibField(&out, "year", fmt.Sprintf("%d", work.Year))
	}
	writeBibField(&out, "doi", work.DOI)
	if work.ArxivID != "" {
		writeBibField(&out, "eprint", work.ArxivID)
		writeBibField(&out, "archivePrefix", "arXiv")
	}
	writeBibField(&out, "url", work.URL)
	if len(work.Keywords) > 0 {
		writeBibField(&out, "keywords", strings.Join(work.Keywords, ", "))
	}
	out.WriteString("}\n")
	return out.String()
}

func writeBibField(out *strings.Builder, name, value string) {
	trimmed := oneLine(value)
	if trimmed == "" {
		return
	}
	fmt.Fprintf(out, "  %s = {%s},\n", name, escapeBibTeX(trimmed))
}

// RIS 渲染整套书目。RIS 是逐行格式，字段值里的换行必须压掉，否则记录会被截断。
func RIS(works []Work, at time.Time) string {
	var out strings.Builder
	fmt.Fprintf(&out, "# ReadX 书目导出 · %d 篇 · %s\n", len(works), at.UTC().Format(time.RFC3339))
	for _, work := range works {
		class := Classify(work)
		writeRISLine(&out, "TY", risType(class.Kind))
		for _, author := range work.Authors {
			writeRISLine(&out, "AU", author)
		}
		writeRISLine(&out, "TI", work.Title)
		if work.Year > 0 {
			writeRISLine(&out, "PY", fmt.Sprintf("%d", work.Year))
		}
		if class.Value != "" {
			field := "T2"
			if class.Kind == KindArticle {
				field = "JO"
			}
			writeRISLine(&out, field, class.Value)
		}
		writeRISLine(&out, "DO", work.DOI)
		if work.ArxivID != "" {
			writeRISLine(&out, "AN", "arXiv:"+work.ArxivID)
		}
		writeRISLine(&out, "UR", work.URL)
		for _, keyword := range work.Keywords {
			writeRISLine(&out, "KW", keyword)
		}
		out.WriteString("ER  - \n\n")
	}
	return out.String()
}

func risType(kind Kind) string {
	switch kind {
	case KindArticle:
		return "JOUR"
	case KindInProceedings:
		return "CONF"
	default:
		return "GEN"
	}
}

func writeRISLine(out *strings.Builder, tag, value string) {
	trimmed := oneLine(value)
	if trimmed == "" {
		return
	}
	fmt.Fprintf(out, "%s  - %s\n", tag, trimmed)
}

// SortedKeywords 合并标签与书架名并去重排序：书目的 keywords 要稳定，
// 否则同一批论文每次导出都不一样，diff 起来全是噪声。
func SortedKeywords(values ...[]string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, group := range values {
		for _, value := range group {
			trimmed := strings.TrimSpace(value)
			if trimmed == "" || seen[trimmed] {
				continue
			}
			seen[trimmed] = true
			out = append(out, trimmed)
		}
	}
	sort.Strings(out)
	return out
}
