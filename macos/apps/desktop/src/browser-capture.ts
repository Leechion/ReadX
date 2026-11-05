export interface BrowserCapture { url: string; pdfUrl?: string; title?: string; doi?: string; authors?: string[] }
export function parseBrowserCapture(value: string): BrowserCapture {
  if (value.length > 64000) throw new Error('采集信息过长');
  const uri = new URL(value);
  if (uri.protocol !== 'readx-capture:' || uri.hostname !== 'collect') throw new Error('采集协议无效');
  const encoded = uri.searchParams.get('data');
  if (!encoded) throw new Error('缺少采集内容');
  const body = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as BrowserCapture;
  const valid = (raw: unknown) => typeof raw === 'string' && raw.length <= 8000 && (() => { try { const u = new URL(raw); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } })();
  if (!valid(body.url) || (body.pdfUrl && !valid(body.pdfUrl)) || (body.title && (typeof body.title !== 'string' || body.title.length > 2000)) || (body.doi && (typeof body.doi !== 'string' || body.doi.length > 500)) || (body.authors && (!Array.isArray(body.authors) || body.authors.length > 40 || body.authors.some(author => typeof author !== 'string' || author.length > 500)))) throw new Error('采集字段无效');
  return { url: body.url, pdfUrl: body.pdfUrl, title: body.title, doi: body.doi, authors: body.authors };
}
