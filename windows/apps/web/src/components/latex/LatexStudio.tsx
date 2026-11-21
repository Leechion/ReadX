import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary, LatexProject, LauncherOpenRequest } from '@cbct/shared';
import { api } from '../../api/client';
import { LatexProjectList } from './LatexProjectList';
import { LatexWorkspace } from './LatexWorkspace';

/**
 * LaTeX Studio 工作区入口（与书库、PPT 平级）。
 *
 * 与其它工作区的关系是「并列且互不干扰」：它用自己的数据表与目录，
 * 不读也不写书库里的论文记录；这里不引入任何编译期依赖，编译能力在打开项目后按需加载。
 */
export function LatexStudio({ documents = [], registerBeforeLeave, launchRequest }: {
  documents?: DocumentSummary[];
  registerBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void;
  launchRequest?: LauncherOpenRequest | null;
}) {
  const [open, setOpen] = useState<LatexProject | null>(null);
  const [launchError, setLaunchError] = useState('');
  useEffect(() => {
    if (!launchRequest) return;
    let cancelled = false;
    setLaunchError('');
    if (!launchRequest.id) { setOpen(null); return; }
    void api.latexProject(launchRequest.id).then(project => {
      if (!cancelled) setOpen(project);
    }).catch(error => { if (!cancelled) setLaunchError(error instanceof Error ? error.message : '打开项目失败'); });
    return () => { cancelled = true; };
  }, [launchRequest]);

  const handleOpen = useCallback((project: LatexProject) => setOpen(project), []);
  const handleClose = useCallback(() => setOpen(null), []);

  if (open) {
    return <>
      {launchError && <p role="alert" className="px-6 py-3 text-bad">{launchError}</p>}
      <LatexWorkspace
        key={open.id}
        project={open}
        documents={documents}
        onClose={handleClose}
        onProjectChange={(updated) => setOpen(updated)}
        registerBeforeLeave={registerBeforeLeave}
      />
    </>;
  }
  return <>{launchError && <p role="alert" className="px-6 py-3 text-bad">{launchError}</p>}<LatexProjectList onOpen={handleOpen} /></>;
}
