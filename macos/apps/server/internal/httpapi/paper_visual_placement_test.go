package httpapi

import "testing"

// 图表归属解析决定一张候选图能否进入精读正文：解析失败的图原先整图丢弃
// （五重奏「不稳定」的一个来源）。这里锁定：精确命中、宽松命中、以及
// 归属行不合目录/缺失时的兜底——只要分析内容在，图必须被用上。
func TestParsePaperVisualPlacement(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		step    string
		section string
		dropped bool
	}{
		{
			name:    "精确命中",
			value:   "method|核心机制与分析方法\n\n这张架构图展示了三阶段流水线。",
			step:    "method",
			section: "核心机制与分析方法",
		},
		{
			name:    "宽松命中：中文步骤别名 + 全角竖线与书名号",
			value:   "方法公式 ｜「核心机制与分析方法」。\n\n分析内容。",
			step:    "method",
			section: "核心机制与分析方法",
		},
		{
			name:    "宽松命中：小节名少写了几个字（包含式回退）",
			value:   "method|核心机制与分析\n分析内容。",
			step:    "method",
			section: "核心机制与分析方法",
		},
		{
			name:    "宽松命中：markdown 前缀与句号",
			value:   "## experiment | 研究对象与数据。\n数据集统计见表。",
			step:    "experiment",
			section: "研究对象与数据",
		},
		{
			name:    "步骤写错但分析存在：兜底挂到结果分析首小节",
			value:   "方法|流水线结构\n模型对架构图的分析。",
			step:    "results",
			section: visualSections["results"][0],
		},
		{
			name:    "完全没写归属行：整段当分析并兜底",
			value:   "这张图展示了数据集在不同划分下的样本分布。",
			step:    "results",
			section: visualSections["results"][0],
		},
		{
			name:    "只有归属行没有分析：丢弃（两次重试后如实记 issue）",
			value:   "method|核心机制与分析方法",
			dropped: true,
		},
		{
			name:    "空输出：丢弃",
			value:   "   ",
			dropped: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			step, section, analysis := parsePaperVisualPlacement(tc.value)
			if tc.dropped {
				if analysis != "" {
					t.Fatalf("应丢弃, got (%q,%q,%q)", step, section, analysis)
				}
				return
			}
			if step != tc.step || section != tc.section {
				t.Fatalf("归属 = (%q,%q), want (%q,%q)", step, section, tc.step, tc.section)
			}
			if analysis == "" {
				t.Fatal("分析内容不应为空")
			}
		})
	}
}
