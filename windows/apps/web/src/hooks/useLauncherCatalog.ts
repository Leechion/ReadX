import { useEffect, useRef } from 'react';
import type { DocumentSummary, LauncherCatalog, LauncherGroup, LauncherTarget, LauncherWorkspace } from '@cbct/shared';
import { api } from '../api/client';
import { listItems } from '../components/slack/db';
import type { WorkbenchData } from '../lib/researchWorkbench';

export function useLauncherCatalog({ current, documents, workbench, onNavigate, enabled }: {
  current: LauncherWorkspace; documents: DocumentSummary[]; workbench: WorkbenchData;
  onNavigate: (target: LauncherTarget) => void;
  enabled: boolean;
}) {
  const latest = useRef({ current, documents, workbench, onNavigate });
  latest.current = { current, documents, workbench, onNavigate };
  const extra = useRef<LauncherGroup[]>([]);
  const publish = () => {
    const { current: active, documents: docs, workbench: data } = latest.current;
    const papers = [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(doc => ({
      id: doc.id, title: doc.translatedTitle || doc.title || '未命名文献', subtitle: doc.authors.slice(0, 2).join('、'),
    }));
    const catalog: LauncherCatalog = { current: active, groups: [
      { workspace: 'library', projects: papers },
      { workspace: 'research', projects: [
        ...data.todos.filter(todo => !todo.done).map(todo => ({ id: `todo:${todo.id}`, title: todo.title, subtitle: todo.due ? `截止 ${todo.due}` : '研究任务' })),
        { id: 'tab:daily', title: '科研日常', subtitle: '任务与专注' },
        { id: 'tab:academics', title: '学业看板', subtitle: '培养与成果' },
        { id: 'tab:news', title: '资讯追踪', subtitle: '研究动态' },
      ] },
      { workspace: 'presentation', projects: papers.map(paper => ({ ...paper, subtitle: '打开论文演示稿' })) },
      ...extra.current,
    ] };
    window.__READX_LAUNCHER__?.publish(catalog);
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;
  useEffect(() => { if (enabled) publishRef.current(); }, [current, documents, workbench, enabled]);
  useEffect(() => {
    const bridge = window.__READX_LAUNCHER__;
    if (!bridge || !enabled) return;
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      publishRef.current();
      const results = await Promise.allSettled([api.latexProjects(), listItems()]);
      if (disposed || request !== revision) return;
      const [latex, slack] = results;
      extra.current = [
        latex.status === 'fulfilled'
          ? { workspace: 'latex', projects: [...latex.value.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => ({ id: project.id, title: project.title, subtitle: project.mainFile })) }
          : { workspace: 'latex', projects: [], error: 'LaTeX 项目读取失败，下次呼出时重试' },
        slack.status === 'fulfilled'
          ? { workspace: 'slack', projects: [
            ...[...slack.value].sort((a, b) => b.openedAt - a.openedAt).map(item => ({ id: item.id, title: item.title, subtitle: item.kind === 'comic' ? '漫画' : '小说' })),
            { id: 'section:game', title: '小游戏', subtitle: '2048 等 10 款 · 休息一下' },
            { id: 'section:find', title: '找点书看', subtitle: '发现新书' },
          ] }
          : { workspace: 'slack', projects: [], error: '摸鱼文库读取失败，下次呼出时重试' },
      ];
      publishRef.current();
    };
    const offRequest = bridge.onRequestCatalog(() => { void refresh(); });
    const offNavigate = bridge.onNavigate(target => latest.current.onNavigate(target));
    void refresh();
    return () => { disposed = true; offRequest(); offNavigate(); };
  }, [enabled]);
}
