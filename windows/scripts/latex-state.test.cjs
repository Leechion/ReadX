// Deterministic hook/lifecycle regression without a browser or a TeX installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// lib/storage.ts 零依赖，直接加载真实模块：App/useChat 等被挂载的源文件经
// 集中登记表取 localStorage 键，沙箱必须能解析这个 import。
const storageModule = loadModule('apps/web/src/lib/storage.ts', {});

function loadModule(relative, dependencies) {
  const filename = path.join(__dirname, '..', relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const sandbox = { exports: {}, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(source, sandbox, { filename });
  return sandbox.exports;
}

// Model state, refs, dependency changes and effect cleanup; render is explicit so
// each test controls when network replies and autosave/poll timers are delivered.
function mount(relative, exported, api, dependencies = {}, args = ['p'], options = {}) {
  const slots = [];
  const timers = new Map();
  let nextTimer = 0;
  let cursor = 0;
  let effects = [];
  const changed = (previous, next) => !previous || !next || previous.length !== next.length || next.some((item, i) => !Object.is(item, previous[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }];
    },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(create, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { value: create(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      });
    },
    lazy: (loader) => ({ loader }),
    Suspense: 'suspense',
    Activity: 'activity',
  };
  const window_ = {
    location: { search: options.search ?? '' },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    addEventListener() {},
    removeEventListener() {},
  };
  const filename = path.join(__dirname, '..', relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const sandbox = {
    exports: {}, window: window_, document: { documentElement: { dataset: {} } },
    crypto: require('node:crypto'), AbortController, URLSearchParams,
    localStorage: (() => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; })(),
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith('/api/client')) return { api, ApiError };
      if (name.endsWith('/lib/storage')) return storageModule;
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename });
  const render = () => {
    cursor = 0;
    effects = [];
    const current = sandbox.exports[exported](...args);
    for (const effect of effects) effect();
    return current;
  };
  return {
    render, timers,
    async settle() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); render(); } return render(); },
    async fireTimers() {
      const queued = [...timers];
      for (const [id, callback] of queued) { timers.delete(id); callback(); }
      return this.settle();
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function projectApi() {
  const disk = new Map([['main.tex', { path: 'main.tex', content: 'original', revision: 'r0' }]]);
  let revision = 0;
  const api = {
    latexProject: async () => ({ id: 'p', title: 'Paper', mainFile: 'main.tex' }),
    latexTree: async () => ({ nodes: [] }),
    latexIndex: async () => ({ citations: [], labels: [] }),
    latexFile: async (_id, file) => ({ ...disk.get(file) }),
    latexSaveFile: async (_id, file, content, expected) => {
      if (disk.get(file)?.revision !== expected) throw new ApiError('revision conflict', 409);
      const next = `r${++revision}`;
      disk.set(file, { path: file, content, revision: next });
      return { revision: next };
    },
    latexFileOp: async (_id, op) => {
      for (const [file, content] of [...disk]) {
        if (file === op.from || file.startsWith(`${op.from}/`)) {
          const next = op.to + file.slice(op.from.length);
          disk.delete(file);
          disk.set(next, { ...content, path: next });
        }
      }
    },
  };
  return { api, disk };
}

async function openProject(api) {
  const hook = mount('apps/web/src/hooks/useLatexProject.ts', 'useLatexProject', api);
  hook.render();
  await hook.settle();
  await hook.render().openFile('main.tex');
  hook.render();
  return hook;
}

test('leaving during the autosave delay flushes the latest draft', async () => {
  const { api, disk } = projectApi();
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'last paragraph');
  assert.equal(hook.timers.size, 1);
  assert.equal(await hook.render().flushAll(), true);
  hook.unmount();
  assert.equal(hook.timers.size, 0);
  assert.equal(disk.get('main.tex').content, 'last paragraph');
});

test('failed saves block closing, leaving, and renaming without discarding drafts', async () => {
  const { api, disk } = projectApi();
  let operations = 0;
  api.latexSaveFile = async () => { throw new ApiError('external edit', 409); };
  api.latexFileOp = async () => { operations++; };
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'keep this draft');
  assert.equal(await hook.render().closeFile('main.tex'), false);
  assert.equal(await hook.render().flushAll(), false);
  assert.equal(await hook.render().applyOp({ op: 'rename', from: 'main.tex', to: 'paper.tex' }), false);
  const file = hook.render().files[0];
  assert.equal(file.content, 'keep this draft');
  assert.equal(file.dirty, true);
  assert.equal(file.conflict, true);
  assert.equal(disk.get('main.tex').content, 'original');
  assert.equal(operations, 0);
  hook.unmount();
});

test('overlapping saves share a request and retain typing during the request', async () => {
  const { api, disk } = projectApi();
  const gate = deferred();
  const write = api.latexSaveFile;
  let requests = 0;
  api.latexSaveFile = async (...args) => { if (++requests === 1) await gate.promise; return write(...args); };
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'first');
  const first = hook.render().saveFile('main.tex');
  hook.render().updateContent('main.tex', 'newest');
  const second = hook.render().saveFile('main.tex');
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(requests, 2); // Two different contents; never two writes using r0.
  assert.equal(disk.get('main.tex').content, 'newest');
  assert.equal(hook.render().files[0].revision, disk.get('main.tex').revision);
  assert.equal(hook.render().files[0].dirty, false);
  hook.unmount();
});

test('renaming saves first and preserves edits arriving while the move is pending', async () => {
  const { api, disk } = projectApi();
  const gate = deferred();
  const entered = deferred();
  const move = api.latexFileOp;
  api.latexFileOp = async (...args) => {
    assert.equal(disk.get('main.tex').content, 'saved before rename');
    entered.resolve();
    await gate.promise;
    return move(...args);
  };
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'saved before rename');
  const renaming = hook.render().applyOp({ op: 'rename', from: 'main.tex', to: 'paper.tex' });
  await entered.promise;
  hook.render().updateContent('main.tex', 'typed during rename');
  gate.resolve();
  assert.equal(await renaming, true);
  assert.equal(hook.render().files[0].path, 'paper.tex');
  assert.equal(hook.render().files[0].dirty, true);
  await hook.fireTimers();
  assert.equal(disk.get('paper.tex').content, 'typed during rename');
  assert.equal(disk.has('main.tex'), false);
  hook.unmount();
});

test('force save records the new revision and permits the next normal save', async () => {
  const { api, disk } = projectApi();
  const hook = await openProject(api);
  disk.set('main.tex', { path: 'main.tex', content: 'external', revision: 'external-r' });
  hook.render().updateContent('main.tex', 'mine');
  assert.equal(await hook.render().saveFile('main.tex'), false);
  assert.equal(await hook.render().forceSave('main.tex'), true);
  assert.equal(hook.render().files[0].revision, disk.get('main.tex').revision);
  hook.render().updateContent('main.tex', 'mine again');
  assert.equal(await hook.render().saveFile('main.tex'), true);
  assert.equal(disk.get('main.tex').content, 'mine again');
  hook.unmount();
});

test('completion providers dispose with their project and read the next project index', () => {
  const providers = new Set();
  const monaco = { languages: {
    CompletionItemKind: {}, CompletionItemInsertTextRule: {},
    registerCompletionItemProvider(_id, provider) { providers.add(provider); return { dispose: () => providers.delete(provider) }; },
  } };
  const module_ = loadModule('apps/web/src/lib/latex/latexCompletion.ts', {
    '@cbct/shared': { latexCompletionContext: () => 'cite' },
    './latexLanguage': { LATEX_COMMANDS: [], LATEX_ENVIRONMENTS: [], LATEX_LANGUAGE_ID: 'latex' },
  });
  const first = module_.registerLatexCompletion(monaco, () => ({ citations: ['project-a'], labels: [] }));
  first.dispose();
  let index = { citations: ['project-b'], labels: [] };
  const second = module_.registerLatexCompletion(monaco, () => index);
  index = { citations: ['project-b-updated'], labels: [] };
  assert.equal(providers.size, 1);
  const provider = [...providers][0];
  const suggestions = provider.provideCompletionItems({ getValueInRange: () => '', getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }) }, { lineNumber: 1, column: 1 });
  assert.equal(suggestions.suggestions[0].label, 'project-b-updated');
  second.dispose();
  assert.equal(providers.size, 0);
});

test('reopening an active build resumes polling and displays its finished PDF', async () => {
  let current = { id: 'b', status: 'running', hasPdf: false };
  let polls = 0;
  const api = {
    latexToolchains: async () => ({}), latexBuilds: async () => ({ builds: [{ ...current }] }),
    latexBuild: async () => { polls++; return { ...current }; },
  };
  const hook = mount('apps/web/src/hooks/useLatexBuild.ts', 'useLatexBuild', api);
  hook.render();
  await hook.settle();
  assert.ok(polls > 0);
  assert.equal(hook.render().running, true);
  current = { id: 'b', status: 'succeeded', hasPdf: true };
  await hook.fireTimers();
  assert.equal(hook.render().running, false);
  assert.equal(hook.render().build.hasPdf, true);
  assert.equal(hook.timers.size, 0);
  hook.unmount();
});

test('an in-flight build reply cannot restart polling after leaving the project', async () => {
  const gate = deferred();
  const hook = mount('apps/web/src/hooks/useLatexBuild.ts', 'useLatexBuild', {
    latexToolchains: async () => ({}), latexBuilds: async () => ({ builds: [{ id: 'b', status: 'running' }] }),
    latexBuild: () => gate.promise,
  });
  hook.render();
  await hook.settle();
  hook.unmount();
  gate.resolve({ id: 'b', status: 'running' });
  await new Promise(setImmediate);
  assert.equal(hook.timers.size, 0);
});

test('the application keeps LaTeX mounted until its leave guard succeeds', async () => {
  const hook = mount('apps/web/src/App.tsx', 'default', {}, {
    './components/LibraryScreen': { LibraryScreen: 'library' },
    './components/ResearchWorkbench': { ResearchWorkbench: 'research-workbench' },
    './components/research/FocusPendant': { FocusPendant: 'focus-pendant' },
    './components/ActivityRail': { ActivityRail: 'activity-rail', RAIL_ITEMS: [{ id: 'library' }, { id: 'reader' }, { id: 'graph' }, { id: 'compare' }, { id: 'presentation' }, { id: 'latex' }, { id: 'calendar' }, { id: 'reproduction' }, { id: 'research' }] },
    './components/CommandPalette': { CommandPalette: 'command-palette' },
    './components/ui/Icon': { Icon: 'ui-icon' },
    './components/WorkspaceIcon': { WorkspaceIcon: 'icon' },
    './components/slack/ModePendant': { ModePendant: 'pendant' },
    './components/slack/slack.css': {},
    './hooks/useWorkspace': { useWorkspace: () => ({ phase: { kind: 'ready', documents: { documents: [] } }, allDocuments: [], filters: {} }) },
    './hooks/useResearchWorkbench': { useResearchWorkbench: () => ({ data: {}, setData() {} }) },
    './hooks/useLauncherCatalog': { useLauncherCatalog: () => {} },
    './hooks/useDocument': { useDocument: () => ({ phase: { kind: 'idle' } }) },
    './hooks/useAnnotations': { useAnnotations: () => ({}) },
    './hooks/useLibraryMeta': { useLibraryMeta: () => ({ items: {} }) },
    './hooks/useTheme': { useTheme: () => ({ choice: 'light', density: 'comfortable', readingFont: 'sans', readingSize: 15, setTheme() {}, setAppearance() {} }) },
    './api/client': { api: { documentJobs: async () => ({ jobs: [] }), syncSettings: async () => ({ enabled: false }) } },
  }, []);
  const findNode = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return node.map((child) => findNode(child, predicate)).find(Boolean);
    if (predicate(node)) return node;
    return findNode(node.props?.children, predicate);
  };
  const header = () => findNode(hook.render(), (node) => typeof node.props?.onScreen === 'function').props;
  header().onScreen('latex');
  const studio = findNode(hook.render(), (node) => typeof node.props?.registerBeforeLeave === 'function');
  const gate = deferred();
  studio.props.registerBeforeLeave(() => gate.promise);
  header().onScreen('library');
  assert.equal(header().screen, 'latex');
  gate.resolve(false);
  await new Promise(setImmediate);
  assert.equal(header().screen, 'latex');
  studio.props.registerBeforeLeave(async () => true);
  header().onScreen('graph');
  await new Promise(setImmediate);
  assert.equal(header().screen, 'graph');
  hook.unmount();
});

test('reader popups pass the requested page as an explicit citation target', () => {
  const paper = { id: 'paper', key: 'paper', title: 'Paper' };
  const hook = mount('apps/web/src/App.tsx', 'default', {}, {
    './components/LibraryScreen': { LibraryScreen: 'library' },
    './components/ResearchWorkbench': { ResearchWorkbench: 'research-workbench' },
    './components/research/FocusPendant': { FocusPendant: 'focus-pendant' },
    './components/ActivityRail': { ActivityRail: 'activity-rail', RAIL_ITEMS: [{ id: 'library' }, { id: 'reader' }, { id: 'graph' }, { id: 'compare' }, { id: 'presentation' }, { id: 'latex' }, { id: 'calendar' }, { id: 'reproduction' }, { id: 'research' }] },
    './components/CommandPalette': { CommandPalette: 'command-palette' },
    './components/ui/Icon': { Icon: 'ui-icon' },
    './components/WorkspaceIcon': { WorkspaceIcon: 'icon' },
    './components/slack/ModePendant': { ModePendant: 'pendant' },
    './components/slack/slack.css': {},
    './hooks/useWorkspace': { useWorkspace: () => ({ phase: { kind: 'ready', documents: { documents: [paper] } }, allDocuments: [paper], filters: {} }) },
    './hooks/useResearchWorkbench': { useResearchWorkbench: () => ({ data: {}, setData() {} }) },
    './hooks/useLauncherCatalog': { useLauncherCatalog: () => {} },
    './hooks/useDocument': { useDocument: () => ({ phase: { kind: 'ready', detail: { pages: [] } } }) },
    './hooks/useAnnotations': { useAnnotations: () => ({}) },
    './hooks/useLibraryMeta': { useLibraryMeta: () => ({ items: {} }) },
    './hooks/useTheme': { useTheme: () => ({ choice: 'light', density: 'comfortable', readingFont: 'sans', readingSize: 15, setTheme() {}, setAppearance() {} }) },
    './api/client': { api: { documentJobs: async () => ({ jobs: [] }), syncSettings: async () => ({ enabled: false }) } },
  }, [], { search: '?readxWindow=reader&documentId=paper&page=10' });
  const findReader = node => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return node.map(findReader).find(Boolean);
    if (node.props?.onPopout) return node;
    return findReader(node.props?.children);
  };
  const reader = findReader(hook.render());
  assert.equal(reader.props.page, 10);
  assert.equal(reader.props.cite.page, 10);
  hook.unmount();
});

function latexChatWithResult(result) {
  return loadModule('apps/web/src/lib/latex/latexChatTransport.ts', {
    '../../api/client': {
      streamLatexChat: async (_request, emit) => {
        emit({ meta: { provider: 'openai', model: 'project-model', included: 2, total: 2, scope: 'project' } });
        emit({ done: true, ...result });
      },
    },
  }).runLatexChat;
}
const latexChatRequest = { key: 'p', projectId: 'p', projectTitle: 'Paper', filePath: 'main.tex', source: 'original', question: '将 abstract 里的数字删掉' };
const abstractProposal = { filePath: 'sec/0_abstract.tex', original: 'Accuracy is 95 percent.', content: 'Accuracy is measured.', summary: '删除摘要中的数字' };

async function openLatexChat(result) {
  const run = latexChatWithResult(result);
  const transport = (request, emit, signal) => run({ ...latexChatRequest, ...request }, emit, signal);
  const chat = mount('apps/web/src/hooks/useChat.ts', 'useChat', {}, {}, ['latex-project:p', transport, false]);
  chat.render();
  await chat.settle();
  await chat.render().send(latexChatRequest.question);
  await chat.settle();
  return chat;
}

test('sending creates a card and only explicit approval saves the referenced file', async () => {
  const { api, disk } = projectApi();
  disk.set(abstractProposal.filePath, { content: abstractProposal.original, revision: 'a0' });
  const snapshots = [];
  api.latexCreateSnapshot = async () => { snapshots.push(new Map(disk)); };
  const hook = await openProject(api);
  const chat = await openLatexChat({ text: '修改已生成', edit: abstractProposal });
  const turn = chat.render().turns.find((item) => item.role === 'ai');
  assert.equal(turn.edit.status, 'pending');
  assert.equal(disk.get(abstractProposal.filePath).content, abstractProposal.original);
  assert.equal(snapshots.length, 0);
  const apply = (proposal, signal) => hook.render().applyAIEdit(proposal, signal);
  await chat.render().approveEdit(turn.id, apply);
  assert.equal(disk.get(abstractProposal.filePath).content, abstractProposal.content);
  assert.equal(hook.render().activePath, abstractProposal.filePath);
  assert.equal(snapshots[0].get(abstractProposal.filePath).content, abstractProposal.original);
  const saved = chat.render().turns.find((item) => item.id === turn.id);
  assert.match(saved.text, /已应用并保存：sec\/0_abstract.tex/);
  assert.equal(saved.edit.status, 'applied');
  await chat.render().approveEdit(turn.id, apply);
  assert.equal(snapshots.length, 1, 'an approved card cannot be applied twice');
  chat.unmount();
  hook.unmount();
});

test('rejecting a card prevents saving and records the decision in conversation history', async () => {
  const chat = await openLatexChat({ edit: abstractProposal });
  const turn = chat.render().turns.find((item) => item.role === 'ai');
  chat.render().rejectEdit(turn.id);
  await chat.render().approveEdit(turn.id, () => { assert.fail('a rejected edit must not save'); });
  const rejected = chat.render().turns.find((item) => item.id === turn.id);
  assert.equal(rejected.edit.status, 'rejected');
  assert.match(rejected.text, /用户已取消/);
  assert.doesNotMatch(rejected.text, /已应用并保存/);
  chat.unmount();
});

test('chat never reports success when the real file save fails', async () => {
  const { api, disk } = projectApi();
  disk.set(abstractProposal.filePath, { content: abstractProposal.original, revision: 'a0' });
  api.latexCreateSnapshot = async () => {};
  api.latexSaveFile = async () => { throw new ApiError('disk write failed', 500); };
  const hook = await openProject(api);
  const chat = await openLatexChat({ edit: abstractProposal });
  const turn = chat.render().turns.find((item) => item.role === 'ai');
  await chat.render().approveEdit(turn.id, (proposal) => hook.render().applyAIEdit(proposal));
  const failed = chat.render().turns.find((item) => item.id === turn.id);
  assert.match(failed.edit.notice, /保存失败/);
  assert.equal(failed.edit.status, 'pending');
  assert.doesNotMatch(failed.text, /已应用并保存/);
  assert.equal(disk.get(abstractProposal.filePath).content, abstractProposal.original);
  chat.unmount();
  hook.unmount();
});

test('AI edit does not overwrite typing that happens while its snapshot is pending', async () => {
  const { api, disk } = projectApi();
  const gate = deferred();
  api.latexCreateSnapshot = () => gate.promise;
  const hook = await openProject(api);
  const pending = hook.render().applyAIEdit({ filePath: 'main.tex', original: 'original', content: 'AI replacement' });
  await new Promise(setImmediate);
  hook.render().updateContent('main.tex', 'new user typing');
  gate.resolve();
  assert.match(await pending, /创建快照期间发生了变化/);
  assert.equal(hook.render().active.content, 'new user typing');
  assert.equal(disk.get('main.tex').content, 'original');
  hook.unmount();
});

test('stopping chat during snapshot creation prevents the subsequent file write', async () => {
  const { api, disk } = projectApi();
  const gate = deferred();
  api.latexCreateSnapshot = () => gate.promise;
  const hook = await openProject(api);
  const controller = new AbortController();
  const pending = hook.render().applyAIEdit({ filePath: 'main.tex', original: 'original', content: 'AI replacement' }, controller.signal);
  await new Promise(setImmediate);
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(disk.get('main.tex').content, 'original');
  assert.equal(hook.render().active.content, 'original');
  hook.unmount();
});

test('agent workflow records taskPlan, toolCalls, autoApplied multi-file edits, and new-file proposals', async () => {
  const { api, disk } = projectApi();
  const baseLatexFile = api.latexFile;
  api.latexFile = async (id, file) => {
    if (!disk.has(file)) throw new ApiError('not found', 404);
    return baseLatexFile(id, file);
  };
  api.latexCreateSnapshot = async () => ({ id: 'snap-agent-1' });
  api.latexFileOp = async (_id, op) => {
    if (op.op === 'new-file') disk.set(op.to, { path: op.to, content: '', revision: 'new-r0' });
  };
  const runAgent = loadModule('apps/web/src/lib/latex/latexChatTransport.ts', {
    '../../api/client': {
      streamLatexChat: async (_request, emit) => {
        emit({ meta: { provider: 'openai', model: 'agent-model', included: 2, total: 2, scope: 'project' }, agentMode: 'agent', agentRole: '章节撰写专家' });
        emit({ taskPlan: [{ id: 's1', title: '扫描源码', status: 'completed', agent: '章节撰写专家' }, { id: 's2', title: '直接修改并新建章节', status: 'completed', agent: '章节撰写专家' }] });
        emit({ toolCall: { id: 't1', toolName: 'inspect_workspace', label: '扫描项目源码', status: 'completed' } });
        emit({ thinking: '已定位 main.tex 与 sections/method.tex', toolCall: { id: 't2', toolName: 'write_file', label: '已写入 main.tex', status: 'completed', locations: ['main.tex'] } });
        emit({
          done: true,
          autoApplied: true,
          snapshotId: 'snap-agent-1',
          agentMode: 'agent',
          text: '智能体已直接更新 2 个文件。',
          edit: abstractProposal,
          edits: [
            abstractProposal,
            { filePath: 'sections/method.tex', original: '', content: '\\section{Method}', summary: '新建 Method 章节' },
          ],
        });
      },
    },
  }).runLatexChat;

  const transport = (request, emit, signal) => runAgent({ ...latexChatRequest, ...request }, emit, signal);
  const chat = mount('apps/web/src/hooks/useChat.ts', 'useChat', {}, {}, ['latex-project:agent', transport, false]);
  chat.render();
  await chat.settle();
  await chat.render().send('@章节撰写 新建 Method 章节', '', false, [], 'agent');
  await chat.settle();

  const turn = chat.render().turns.find((item) => item.role === 'ai');
  assert.equal(turn.agentRole, '章节撰写专家');
  assert.equal(turn.agentMode, 'agent');
  assert.equal(turn.taskPlan.length, 2);
  assert.equal(turn.toolCalls.length, 2);
  assert.equal(turn.thinking, '已定位 main.tex 与 sections/method.tex');
  assert.equal(turn.edit.status, 'applied');
  assert.equal(turn.edit.autoApplied, true);
  assert.equal(turn.edit.snapshotId, 'snap-agent-1');
  assert.equal(turn.edit.proposals.length, 2);
  chat.unmount();

  // Also test applyAIEdit creating a brand-new file when approved in review mode
  const hook = await openProject(api);
  const res = await hook.render().applyAIEdit({ filePath: 'sections/method.tex', original: '', content: '\\section{Method}' });
  assert.match(res, /已应用并保存：sections\/method\.tex/);
  assert.equal(disk.get('sections/method.tex').content, '\\section{Method}');
  hook.unmount();
});
