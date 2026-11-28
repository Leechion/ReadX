import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamChat, type AgentTaskStep, type AgentToolTrace, type ChatChunk, type LatexAIEditProposal } from '../api/client';
import { STORAGE_KEYS } from '../lib/storage';

type ChatTransport = (
  request: { key: string; mode?: string; question: string; scope?: string; history?: Array<{ role: string; text: string }>; images?: string[]; agentMode?: string },
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
) => Promise<void>;

export interface ChatEditRequest {
  proposal: LatexAIEditProposal;
  proposals?: LatexAIEditProposal[];
  status: 'pending' | 'applying' | 'applied' | 'rejected';
  notice?: string;
  autoApplied?: boolean;
  snapshotId?: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'ai';
  text: string;
  error?: string;
  completed?: boolean;
  scope?: { included: number; total: number; unit?: string };
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  edit?: ChatEditRequest;
  agentMode?: string;
  agentRole?: string;
  thinking?: string;
  taskPlan?: AgentTaskStep[];
  toolCalls?: AgentToolTrace[];
}
interface Conversation { id: string; title: string; updatedAt: string; turns: ChatTurn[] }
const fresh = (): Conversation => ({ id: crypto.randomUUID(), title: '新对话', updatedAt: new Date().toISOString(), turns: [] });
const storageKey = (key: string) => STORAGE_KEYS.chatSessions(key);
function load(key: string | null): { conversations: Conversation[]; active: string } {
  try {
    const parsed = key ? JSON.parse(localStorage.getItem(storageKey(key)) ?? 'null') : null;
    if (parsed && Array.isArray(parsed.conversations)) {
      const conversations = parsed.conversations.filter((c: Conversation) => c && typeof c.id === 'string' && typeof c.title === 'string' && Array.isArray(c.turns) && c.turns.every((t) => t && typeof t.id === 'string' && ['user', 'ai'].includes(t.role) && typeof t.text === 'string')) as Conversation[];
      if (conversations.length) return { conversations, active: conversations.some((c) => c.id === parsed.active) ? parsed.active : conversations[0]!.id };
    }
  } catch { /* A damaged local record must not prevent reading a paper. */ }
  const conversation = fresh();
  return { conversations: [conversation], active: conversation.id };
}

export function useChat(key: string | null, transport: ChatTransport = streamChat, trackDocumentStatus = true) {
  const [data, setData] = useState(() => load(key));
  const [dataKey, setDataKey] = useState(key);
  const dataRef = useRef(data);
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [deleted, setDeleted] = useState<Conversation | null>(null);
  const controller = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const documentRef = useRef(key);
  const commit = useCallback((next: typeof data) => { dataRef.current = next; setData(next); }, []);
  const flush = useCallback(() => {
    const currentKey = documentRef.current;
    if (!currentKey) return;
    const snapshot = { ...dataRef.current, conversations: dataRef.current.conversations.map(c => ({ ...c,
      turns: c.turns.map(turn => turn.role === 'ai' && !turn.completed && !turn.error
        ? { ...turn, completed: false, error: '已停止；这条回答不进入后续上下文。' } : turn),
    })) };
    try { localStorage.setItem(storageKey(currentKey), JSON.stringify(snapshot)); }
    catch { console.warn('本机聊天历史保存失败，请检查存储空间。'); }
  }, []);
  useEffect(() => {
    documentRef.current = key;
    ++epoch.current;
    controller.current?.abort(); controller.current = null;
    commit(load(key)); setDataKey(key); setBusy(false); setStorageError(''); setDeleted(null);
    return () => { flush(); ++epoch.current; controller.current?.abort(); controller.current = null; };
  }, [key, commit, flush]);
  const hasConversationHistory = data.conversations.some((conversation) =>
    conversation.turns.some((turn) => turn.role === 'user' && !!turn.text.trim()),
  );
  useEffect(() => {
    if (!trackDocumentStatus || !key || dataKey !== key) return;
    void api.setStatus(key, hasConversationHistory ? 'reading' : 'queue').catch(() => {});
  }, [key, dataKey, hasConversationHistory, trackDocumentStatus]);
  useEffect(() => {
    if (!key || dataKey !== key || documentRef.current !== key || busy) return;
    try { localStorage.setItem(storageKey(key), JSON.stringify(data)); setStorageError(''); }
    catch { setStorageError('本机历史保存失败；请及时复制需要保留的回答。'); }
  }, [data, dataKey, busy, key]);

  const send = useCallback(async (question: string, mode = '', regenerate = false, images: string[] = [], agentMode?: string) => {
    if (!key || controller.current || !question.trim()) return;
    const snapshot = dataRef.current;
    const conversation = snapshot.conversations.find((c) => c.id === snapshot.active)!;
    let previous = conversation.turns;
    if (regenerate) {
      const lastUser = previous.map((t) => t.role).lastIndexOf('user');
      if (lastUser < 0) return;
      question = previous[lastUser]!.text;
      previous = previous.slice(0, lastUser);
    }
    const history = previous.flatMap((turn, i) => turn.role === 'user' && previous[i + 1]?.role === 'ai' && previous[i + 1]?.completed && !previous[i + 1]?.error
      ? [{ role: 'user', text: turn.text }, { role: 'ai', text: previous[i + 1]!.text }] : []);
    const requestEpoch = epoch.current;
    const requestID = crypto.randomUUID();
    const abort = new AbortController();
    controller.current = abort; setBusy(true);
    const update = (turns: ChatTurn[]) => {
      if (epoch.current !== requestEpoch) return;
      const current = dataRef.current;
      commit({ ...current, conversations: current.conversations.map((c) => c.id === conversation.id ? { ...c, turns, title: c.turns.length > 0 ? c.title : question.replace(/\s+/g, ' ').slice(0, 48), updatedAt: new Date().toISOString() } : c) });
    };
    let turns: ChatTurn[] = [...previous, { id: crypto.randomUUID(), role: 'user', text: question }, { id: requestID, role: 'ai', text: '' }];
    const patch = (changes: Partial<ChatTurn>) => { turns = turns.map((t) => t.id === requestID ? { ...t, ...changes } : t); update(turns); };
    update(turns);
    let streaming = '';
    let finished = false;
    let toolCalls: AgentToolTrace[] = [];
    try {
      await transport({ key, question, mode, history, images: images.length ? images : undefined, agentMode }, (chunk) => {
        if (epoch.current !== requestEpoch) return;
        if (chunk.meta) patch({ scope: { included: chunk.meta.included, total: chunk.meta.total, unit: chunk.meta.unit }, provider: chunk.meta.provider, model: chunk.meta.model, reasoningEffort: chunk.meta.reasoningEffort });
        if (chunk.agentMode || chunk.agentRole) {
          const nextMeta: Partial<ChatTurn> = {};
          if (chunk.agentMode) nextMeta.agentMode = chunk.agentMode;
          if (chunk.agentRole) nextMeta.agentRole = chunk.agentRole;
          patch(nextMeta);
        }
        if (chunk.taskPlan) {
          patch({ taskPlan: chunk.taskPlan });
        }
        if (chunk.thinking) {
          patch({ thinking: chunk.thinking });
        }
        if (chunk.toolCall) {
          const incoming = chunk.toolCall;
          const idx = toolCalls.findIndex((item) => item.id === incoming.id);
          if (idx >= 0) {
            toolCalls = toolCalls.map((item, i) => (i === idx ? incoming : item));
          } else {
            toolCalls = [...toolCalls, incoming];
          }
          patch({ toolCalls });
        }
        if (chunk.delta) { streaming += chunk.delta; patch({ text: streaming }); }
        if (chunk.done) {
          finished = true;
          streaming = chunk.text ?? streaming;
          const proposals = chunk.edits && chunk.edits.length > 0 ? chunk.edits : chunk.edit ? [chunk.edit] : undefined;
          const primaryProposal = chunk.edit ?? proposals?.[0];
          const editReq: ChatEditRequest | undefined = primaryProposal
            ? {
                proposal: primaryProposal,
                proposals,
                status: chunk.autoApplied ? 'applied' : 'pending',
                autoApplied: chunk.autoApplied,
                snapshotId: chunk.snapshotId,
                notice: chunk.autoApplied
                  ? `智能体已直接写入并保存 ${proposals?.length ?? 1} 个文件（写前快照已自动保存）`
                  : undefined,
              }
            : undefined;
          patch({
            text: streaming,
            completed: !!streaming,
            edit: editReq,
            ...(chunk.agentMode ? { agentMode: chunk.agentMode } : {}),
          });
        }
        if (chunk.error) { finished = true; patch({ text: chunk.partial ?? streaming, error: chunk.error, completed: false }); }
      }, abort.signal);
      if (!finished || !streaming) patch({ error: '连接结束，未收到完整回答。可重新回答。', completed: false });
    } catch (cause) {
      patch({ error: abort.signal.aborted ? '已停止；这条回答不进入后续上下文。' : cause instanceof Error ? cause.message : String(cause), completed: false });
    } finally {
      if (epoch.current === requestEpoch) { controller.current = null; setBusy(false); }
    }
  }, [key, commit, transport]);
  const approveEdit = useCallback(async (
    turnID: string,
    apply: (proposal: LatexAIEditProposal, signal?: AbortSignal) => Promise<string>,
  ) => {
    if (controller.current) return;
    const snapshot = dataRef.current;
    const conversation = snapshot.conversations.find((item) => item.id === snapshot.active);
    const turn = conversation?.turns.find((item) => item.id === turnID);
    if (!conversation || !turn?.edit || turn.edit.status !== 'pending') return;
    const requestEpoch = epoch.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    const updateEdit = (edit: ChatEditRequest, receipt = '') => {
      if (epoch.current !== requestEpoch) return;
      const current = dataRef.current;
      commit({ ...current, conversations: current.conversations.map((item) => item.id === conversation.id
        ? { ...item, updatedAt: new Date().toISOString(), turns: item.turns.map((candidate) => candidate.id === turnID
          ? { ...candidate, edit, text: receipt ? `${turn.text}\n\n${receipt}` : candidate.text }
          : candidate) }
        : item) });
    };
    updateEdit({ ...turn.edit, status: 'applying', notice: '' });
    try {
      const targets = turn.edit.proposals && turn.edit.proposals.length > 0 ? turn.edit.proposals : [turn.edit.proposal];
      const notices: string[] = [];
      let allSaved = true;
      for (const proposal of targets) {
        const notice = await apply(proposal, abort.signal);
        notices.push(notice);
        if (!notice.startsWith('已应用并保存')) {
          allSaved = false;
          break;
        }
      }
      const combinedNotice = notices.join('；');
      updateEdit({ ...turn.edit, status: allSaved ? 'applied' : 'pending', notice: combinedNotice }, allSaved ? combinedNotice : '');
    } catch (cause) {
      updateEdit({ ...turn.edit, status: 'pending', notice: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      if (epoch.current === requestEpoch) { controller.current = null; setBusy(false); }
    }
  }, [commit]);
  const rejectEdit = useCallback((turnID: string) => {
    if (controller.current) return;
    const current = dataRef.current;
    commit({ ...current, conversations: current.conversations.map((conversation) => conversation.id === current.active
      ? { ...conversation, turns: conversation.turns.map((turn) => turn.id === turnID && turn.edit?.status === 'pending'
        ? { ...turn, text: `${turn.text}\n\n用户已取消本次修改，文件未保存。`, edit: { ...turn.edit, status: 'rejected' as const, notice: '' } }
        : turn) }
      : conversation) });
  }, [commit]);
  const stop = useCallback(() => { flush(); controller.current?.abort(); }, [flush]);
  const newConversation = () => {
    if (controller.current) return;
    const current = dataRef.current;
    const existing = current.conversations.find((c) => !c.turns.length);
    const next = existing ?? fresh();
    commit({ active: next.id, conversations: existing ? current.conversations : [next, ...current.conversations] });
  };
  const selectConversation = (id: string) => {
    if (!controller.current && dataRef.current.conversations.some((c) => c.id === id)) commit({ ...dataRef.current, active: id });
  };
  const deleteConversation = (id: string) => {
    if (controller.current) return;
    setDeleted(dataRef.current.conversations.find((c) => c.id === id) ?? null);
    let conversations = dataRef.current.conversations.filter((c) => c.id !== id);
    if (!conversations.length) conversations = [fresh()];
    commit({ conversations, active: dataRef.current.active === id ? conversations[0]!.id : dataRef.current.active });
  };
  const undoDelete = () => {
    if (!deleted || controller.current) return;
    const current = dataRef.current;
    commit({ conversations: [deleted, ...current.conversations.filter((c) => c.id !== deleted.id)], active: deleted.id }); setDeleted(null);
  };
  return { turns: data.conversations.find((c) => c.id === data.active)?.turns ?? [], conversations: data.conversations, active: data.active, busy, send, stop, approveEdit, rejectEdit, newConversation, selectConversation, deleteConversation, undoDelete, canUndo: !!deleted, storageError };
}
