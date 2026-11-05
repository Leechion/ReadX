(() => {
  const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const data = JSON.parse(new TextDecoder().decode(bytes(document.getElementById('share-data').textContent)));
  const main = document.getElementById('content');
  document.getElementById('disclosure').textContent = data.disclosure;
  const add = (parent, tag, text = '') => { const node = document.createElement(tag); node.textContent = text; parent.append(node); return node; };
  const jumpers = new Map();
  const download = (parent, encoded, type, name) => {
    const uri = URL.createObjectURL(new Blob([bytes(encoded)], { type }));
    const link = add(parent, 'a', '下载所附原文件'); link.href = uri; link.download = name;
    return uri;
  };
  for (const doc of data.documents) {
    const article = add(main, 'article');
    add(article, 'h2', doc.title);
    add(article, 'p', [...(doc.authors || []), doc.venue, doc.year, doc.doi].filter(Boolean).join(' · '));
    let frame = null, uri = '';
    const chapters = new Map();
    const jump = (page, locator) => {
      if (frame && page) { frame.src = uri + '#page=' + page; frame.scrollIntoView({ behavior: 'smooth' }); return; }
      const chapter = locator && chapters.get(locator.href);
      if (chapter) {
        for (const part of chapters.values()) for (const node of part.blocks) node.classList.remove('evidence-target');
        const begin = Math.max(0, locator.blockStart || 0), end = Math.min(chapter.blocks.length - 1, locator.blockEnd ?? begin);
        for (let i = begin; i <= end; i++) chapter.blocks[i]?.classList.add('evidence-target');
        (chapter.blocks[begin] || chapter.root).scrollIntoView({ behavior: 'smooth' });
      } else article.scrollIntoView({ behavior: 'smooth' });
    };
    jumpers.set(doc.key, jump);
    if (doc.pdf) {
      uri = download(article, doc.pdf, 'application/pdf', 'paper.pdf');
      frame = add(article, 'iframe'); frame.title = doc.title; frame.src = uri + '#page=1';
      add(article, 'small', 'PDF 预览取决于浏览器；无法预览时可下载原文件。');
    } else if (doc.epub) {
      download(article, doc.epub, 'application/epub+zip', 'book.epub');
      add(article, 'p', '以下为结构化章节原文，保留段落定位；原版式请下载 EPUB 查看。');
      for (const section of doc.sections || []) {
        const root = add(article, 'details'); root.open = true; add(root, 'summary', section.title);
        const blocks = [];
        for (const block of section.blocks) {
          const node = add(root, /^h[1-6]$/.test(block.kind) ? 'h3' : 'p', block.text || '');
          if (block.image) { const img = add(node, 'img'); img.src = block.image; img.alt = block.text || '原文图片'; img.style.maxWidth = '100%'; }
          blocks.push(node);
        }
        chapters.set(section.href, { root, blocks });
      }
    } else add(article, 'p', '未附原文，仅展示已选择的题录和研究材料。');
    for (const note of doc.notes || []) {
      const section = add(article, 'section');
      const loc = note.locator;
      const position = note.page ? 'PDF 页序 ' + note.page : loc?.href ? `章节 ${loc.href} · 段落 ${(loc.blockStart || 0) + 1}–${(loc.blockEnd || 0) + 1} · 文字偏移 ${loc.startOffset || 0}–${loc.endOffset || 0}` : '无定位';
      add(section, 'h3', '个人批注 · ' + position); add(section, 'blockquote', note.quote || ''); add(section, 'pre', note.note || '');
      if (frame || chapters.size) add(section, 'button', '查看原文位置').onclick = () => jump(note.page, loc);
    }
    for (const reading of doc.readings || []) { add(article, 'h3', 'AI 精读 · ' + reading.kind); add(article, 'pre', reading.text); }
  }
  if (data.ideas?.length) {
    const root = add(main, 'section'); add(root, 'h2', '研究想法与证据');
    add(root, 'p', '以下是研究者的判断和假设；证据来源分别标注，不将个人判断视作论文结论。');
    for (const idea of data.ideas) {
      const article = add(root, 'article'); add(article, 'h3', idea.question); add(article, 'p', '状态：' + idea.status);
      for (const [key, label] of [['observation', '观察'], ['hypothesis', '假设'], ['method', '方法设想'], ['experiment', '验证计划']]) if (idea[key]) { add(article, 'h4', label); add(article, 'pre', idea[key]); }
      for (const evidence of idea.evidence) {
        const block = add(article, 'section'); add(block, 'h4', evidence.origin + ' · ' + evidence.paperTitle + (evidence.page ? ' · PDF 页序 ' + evidence.page : ''));
        add(block, 'blockquote', evidence.excerpt);
        if (jumpers.has(evidence.paperKey)) add(block, 'button', '查看来源材料').onclick = () => jumpers.get(evidence.paperKey)(evidence.page);
      }
    }
  }
  if (data.comparisons?.length) {
    const root = add(main, 'section'); add(root, 'h2', '七维对照（已保存抽取）');
    add(root, 'p', '未抽取表示没有可用数据，不能据此认定论文未提及。');
    const table = add(root, 'table'), header = add(table, 'tr'); add(header, 'th', '维度');
    for (const doc of data.comparisons) add(header, 'th', doc.title);
    for (const [group, label] of [['dataset', '研究对象与数据'], ['acquisition', '研究设计与条件'], ['training', '实施流程'], ['loss', '分析方法'], ['baselines', '对照或基线'], ['metrics', '评价标准'], ['results', '结果']]) {
      const row = add(table, 'tr'); add(row, 'th', label);
      for (const doc of data.comparisons) {
        const cell = add(row, 'td'), fields = doc.groups[group];
        if (!fields?.length) { add(cell, 'p', doc.status === '未抽取' ? '未抽取' : '本分组无已保存字段'); continue; }
        for (const field of fields) { add(cell, 'p', field.k + '：' + field.v); if (field.excerpt) add(cell, 'blockquote', field.excerpt); if (field.page && jumpers.has(doc.key)) add(cell, 'button', 'PDF 页序 ' + field.page).onclick = () => jumpers.get(doc.key)(field.page); }
      }
    }
  }
})();
