document.getElementById('collect').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const button = document.getElementById('collect'); button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//i.test(tab.url)) throw new Error('请选择 http/https 论文页面或 PDF。');
    let metadata = {};
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const first = name => document.querySelector(`meta[name="${name}"],meta[property="${name}"]`)?.content || '';
        return { title: first('citation_title') || first('og:title') || document.title,
          doi: first('citation_doi') || first('DC.Identifier'),
          pdfUrl: first('citation_pdf_url'),
          authors: Array.from(document.querySelectorAll('meta[name="citation_author"]')).slice(0, 40).map(item => item.content.slice(0, 500)) };
      } });
      metadata = result?.result || {};
    } catch { /* Built-in PDF pages may prohibit script injection; retain URL/title. */ }
    const data = { url: tab.url, title: String(metadata.title || tab.title || '').slice(0, 2000), doi: String(metadata.doi || '').slice(0, 500), authors: metadata.authors || [] };
    if (metadata.pdfUrl) { const pdf = new URL(metadata.pdfUrl, tab.url); if (/^https?:$/.test(pdf.protocol) && !pdf.username && !pdf.password) data.pdfUrl = pdf.href; }
    if (!data.pdfUrl && /\.pdf(?:[?#]|$)/i.test(tab.url)) data.pdfUrl = tab.url;
    const binary = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data)));
    await chrome.tabs.create({ url: 'readx-capture://collect?data=' + encodeURIComponent(btoa(binary)) });
    status.textContent = '已请求打开 ReadX。请在桌面端确认已保存；未安装或未启用接收时，请先完成桌面端设置。';
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { button.disabled = false; }
});
