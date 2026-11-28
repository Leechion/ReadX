import { streamLatexChat, type ChatChunk } from '../../api/client';

/**
 * Send edit proposals or auto-applied agent edits into the conversation turn.
 * - In "review" mode (default): writing requires explicit user approval.
 * - In "agent" mode (autoApplied=true): the backend creates a snapshot and writes
 *   files directly; the terminal chunk reports the applied edits and snapshotId.
 */
export async function runLatexChat(
  request: Parameters<typeof streamLatexChat>[0],
  onChunk: (chunk: ChatChunk) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  let terminal: ChatChunk = {};
  let failed = false;
  await streamLatexChat(request, (chunk) => {
    if (chunk.done) terminal = chunk;
    else {
      if (chunk.error) failed = true;
      onChunk(chunk);
    }
  }, signal);
  if (failed) return;
  signal?.throwIfAborted();
  if (!terminal.done) throw new Error('未收到完整的 LaTeX 助手回答，未保存文件。');
  const edit = terminal.edit;
  const edits = terminal.edits;
  if (!edit && (!edits || !edits.length)) {
    onChunk(terminal);
    return;
  }
  const primary = edit ?? edits?.[0];
  if (!primary) {
    onChunk(terminal);
    return;
  }
  if (terminal.autoApplied) {
    const fileCount = edits?.length ?? 1;
    const summaryText = terminal.text?.trim()
      ? terminal.text
      : `智能体已直接修改并保存 ${fileCount} 个文件（已自动创建修改前源码快照）。`;
    onChunk({
      ...terminal,
      done: true,
      edit: primary,
      edits: edits?.length ? edits : [primary],
      text: summaryText,
    });
    return;
  }
  const allUnchanged = edits?.length
    ? edits.every((item) => item.content === item.original)
    : primary.content === primary.original;
  if (allUnchanged) {
    onChunk({ ...terminal, done: true, edit: undefined, edits: undefined, text: `AI 未生成实际改动：${primary.filePath}，文件未改写。` });
    return;
  }
  onChunk({
    ...terminal,
    done: true,
    edit: primary,
    edits: edits?.length ? edits : [primary],
    text: terminal.text?.trim() ? terminal.text : '修改已准备好，请确认下面的请求。',
  });
}
