export interface ProcessingDescription {
  action: string; documents: string[]; projects: string[]; materials: string[];
  destinations: string[]; files?: string[]; disclosure: string;
  documentNames?: string[]; projectNames?: string[];
}
export interface ProcessingChallenge { requestId: string; processing: ProcessingDescription }
type Decision = (challenge: ProcessingChallenge, signal?: AbortSignal) => Promise<boolean>;
let decision: Decision | null = null;
export function registerProcessingDecision(handler: Decision): () => void {
  decision = handler;
  return () => { if (decision === handler) decision = null; };
}
export async function approveProcessingChallenge(challenge: ProcessingChallenge, apiBase: string, headers: HeadersInit, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  if (!decision || !await decision(challenge, signal)) throw new DOMException('已取消发送，材料未提交给外部服务', 'AbortError');
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
  const auth = new Headers(headers); auth.set('Content-Type', 'application/json');
  const response = await fetch(apiBase + '/v1/processing/approve', { method: 'POST', headers: auth, credentials: 'omit', signal, body: JSON.stringify({ id: challenge.requestId }) });
  const result = await response.json() as { grant?: string; error?: string };
  if (!response.ok || !result.grant) throw new Error(result.error || '发送计划已失效，请重新操作');
  return result.grant;
}
export async function processingFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 428) return response;
  const challenge = await response.clone().json() as ProcessingChallenge;
  if (!challenge.requestId || !challenge.processing) return response;
  const url = new URL(input, window.location.href);
  const grant = await approveProcessingChallenge(challenge, url.origin, init?.headers ?? {}, init?.signal ?? undefined);
  const headers = new Headers(init?.headers); headers.set('X-ReadX-Processing-Grant', grant);
  return fetch(input, { ...init, headers });
}
