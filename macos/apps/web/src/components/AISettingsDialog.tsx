import { useEffect, useRef, useState } from 'react';
import { api, type AISettings, type CodexModel, type OCRSettings, type WorkflowAISettingInput, type WorkflowKind } from '../api/client';
import type { InterfaceDensity, ReadingFont, ThemeChoice } from '../hooks/useTheme';
import { reasoningOptionsForSelection } from './AIModelControls';
import { ProviderLogo } from './providerLogos';
import { AppDialog } from './AppDialog';
import { ProcessingPolicySettings } from './ProcessingPolicySettings';
import { SyncSettingsPane } from './SyncSettingsDialog';
import { Icon } from './ui/Icon';
import { Button, Segmented } from './ui/Primitives';

/**
 * 服务商预设：点一下即填好「渠道 + 地址 + 建议模型」，仍然只落一份配置。
 *
 * 多数云服务与本地模型使用「OpenAI 兼容」渠道，差异在服务地址与建议模型；
 * Anthropic 和本机登录渠道使用各自的接入方式。logo 指向 providerLogos 里的品牌标识。
 */
interface ProviderPreset {
  id: string;
  name: string;
  kind: 'openai' | 'anthropic' | 'codex' | 'claude' | 'kimi' | 'workbuddy';
  baseURL?: string;
  model?: string;
  local?: boolean;
  logo?: string;
  /**
   * 自定义服务商：不预设地址与模型，由用户自己填。
   * 它的 baseURL 为空，所以 presetOf 必须显式跳过，否则任何自填地址都会被它"认领"。
   */
  custom?: boolean;
}

const PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'kimi', name: 'Kimi', kind: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'qwen', name: '通义千问', kind: 'openai', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'glm', name: '智谱 GLM', kind: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' },
  { id: 'siliconflow', name: '硅基流动', kind: 'openai', baseURL: 'https://api.siliconflow.cn/v1' },
  { id: 'volcengine', name: '火山方舟', kind: 'openai', baseURL: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'qianfan', name: '百度千帆', kind: 'openai', baseURL: 'https://qianfan.baidubce.com/v2', model: 'deepseek-r1' },
  { id: 'tokenhub', name: '腾讯 TokenHub', kind: 'openai', baseURL: 'https://tokenhub.tencentmaas.com/v1', model: 'hy3' },
  { id: 'hunyuan', name: '腾讯混元（原平台）', kind: 'openai', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { id: 'xai', name: 'xAI / Grok', kind: 'openai', baseURL: 'https://api.x.ai/v1', model: 'grok-4.7' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
  { id: 'mistral', name: 'Mistral AI', kind: 'openai', baseURL: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  { id: 'deepinfra', name: 'DeepInfra', kind: 'openai', baseURL: 'https://api.deepinfra.com/v1/openai', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseURL: 'https://openrouter.ai/api/v1' },
  { id: 'ollama', name: '本机 Ollama', kind: 'openai', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', local: true },
  { id: 'lmstudio', name: '本机 LM Studio', kind: 'openai', baseURL: 'http://127.0.0.1:1234/v1', local: true },
  { id: 'codex', name: 'Codex Desktop / CLI', kind: 'codex', logo: 'openai' },
    { id: 'workbuddy', name: 'WorkBuddy 国内版', kind: 'workbuddy', logo: 'workbuddy' },
  { id: 'claude-cli', name: 'Claude Code CLI', kind: 'claude', logo: 'claude' },
  { id: 'kimi-cli', name: 'Kimi Code CLI', kind: 'kimi', logo: 'kimi' },
  // 自定义放最后：它是个"空模板"，不是某家厂商。
  { id: 'custom', name: '自定义服务商', kind: 'openai', custom: true },
];

/** 用「渠道 + 地址」反推当前是哪家预设，供标题与徽标显示。 */
function presetOf(provider: string, baseURL: string): ProviderPreset | undefined {
  const normalized = baseURL.trim().replace(/\/+$/, '').toLowerCase();
  return PRESETS.find((item) => {
    // 自定义没有固定地址，永远不该被"反推"命中——否则自填的任何地址都会显示成它。
    if (item.custom) return false;
    if (item.kind !== provider) return false;
    if (!item.baseURL) return !normalized;
    return item.baseURL.replace(/\/+$/, '').toLowerCase() === normalized;
  });
}

const WORKFLOW_ROWS: ReadonlyArray<{ kind: WorkflowKind; label: string }> = [
  { kind: 'translation', label: '翻译' },
  { kind: 'qa', label: '论文问答' },
  { kind: 'reading', label: '精读五重奏' },
];

function capEffort(effort: string): string {
  if (!effort) return '';
  if (effort.toLowerCase() === 'xhigh') return 'XHigh';
  return effort.charAt(0).toUpperCase() + effort.slice(1).toLowerCase();
}

function defaultWorkflows(): Record<WorkflowKind, WorkflowAISettingInput> {
  return {
    translation: { followGlobal: true },
    qa: { followGlobal: true },
    reading: { followGlobal: true },
  };
}

function workflowChannelLabel(wf: WorkflowAISettingInput): string {
  if (wf.followGlobal || !wf.provider) return '跟随全局';
  const preset = presetOf(wf.provider, wf.baseURL ?? '');
  const baseName =
    wf.provider === 'claude' ? 'Claude Code'
      : wf.provider === 'codex' ? 'Codex'
        : wf.provider === 'kimi' ? 'Kimi Code'
          : wf.provider === 'workbuddy' ? 'WorkBuddy'
            : (preset?.name ?? (wf.baseURL ? (() => { try { return new URL(wf.baseURL).host; } catch { return wf.baseURL; } })() : wf.provider));
  const parts = [baseName];
  if (wf.model) parts.push(wf.model);
  if (wf.reasoningEffort) parts.push(capEffort(wf.reasoningEffort));
  return parts.join(' · ');
}

function workflowKeyOf(wf: WorkflowAISettingInput): string {
  if (wf.followGlobal || !wf.provider) return 'follow';
  return `${wf.provider}|${(wf.baseURL ?? '').replace(/\/+$/, '')}|${wf.model ?? ''}|${(wf.reasoningEffort ?? '').toLowerCase()}`;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';
type SettingsTab = 'ai' | 'sync' | 'policy' | 'appearance' | 'shortcuts';

export interface AppearanceProps {
  theme: ThemeChoice;
  onThemeChange: (next: ThemeChoice) => void;
  density: InterfaceDensity;
  readingFont: ReadingFont;
  readingSize: number;
  onAppearanceChange: (patch: Partial<{ density: InterfaceDensity; readingFont: ReadingFont; readingSize: number }>) => void;
}

const SHORTCUTS: ReadonlyArray<{ keys: string[]; title: string; desc: string }> = [
  { keys: ['Ctrl', 'K'], title: '全局命令面板', desc: '快速跳转工作区、切换主题、创建备份' },
  { keys: ['Ctrl', '1–9'], title: '切换主工作区', desc: '按左侧活动栏顺序快速切换到对应屏幕' },
  { keys: ['Ctrl', '\\'], title: '开关左侧上下文栏', desc: '扩展或收起目录树、筛选与论文选择侧栏' },
  { keys: ['Ctrl', '.'], title: '开关右侧检查器', desc: '展开或收起详情、AI 伴读、证据检查面板' },
  { keys: ['Ctrl', 'Shift', 'M'], title: '摸鱼安全切换', desc: '在休闲角落与学术主界面之间一键切换' },
  { keys: ['Esc'], title: '分层关闭浮层', desc: '依次关闭命令面板、下弹窗及辅助抽屉' },
];

export function AISettingsDialog({
  onClose,
  appearance,
  initialTab = 'ai',
}: {
  onClose: () => void;
  appearance?: AppearanceProps;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [showKey, setShowKey] = useState(false);
  const [showOCRToken, setShowOCRToken] = useState(false);
  const [syncProvider, setSyncProvider] = useState<'folder' | 'jianguoyun'>('folder');
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [ocrSettings, setOCRSettings] = useState<OCRSettings | null>(null);
  const [ocrProvider, setOCRProvider] = useState<'paddle' | 'mineru'>('paddle');
  const [ocrToken, setOCRToken] = useState('');
  const [ocrBaseURL, setOCRBaseURL] = useState('');
  const [ocrModel, setOCRModel] = useState('');
  const [clearOCRToken, setClearOCRToken] = useState(false);
  const [savingOCR, setSavingOCR] = useState(false);
  const [ocrNotice, setOCRNotice] = useState('');
  const ocrLabel = ocrProvider === 'mineru' ? 'MinerU' : 'PaddleOCR';
  const ocrConfigured = ocrSettings?.providers?.[ocrProvider]?.configured
    ?? (ocrSettings?.provider === ocrProvider && ocrSettings.configured);
  const [provider, setProvider] = useState('openai');
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [translationPreparation, setTranslationPreparation] = useState<'off' | 'artifacts_only' | 'terms' | 'terms+style' | 'editorial'>('off');
  const [workflows, setWorkflows] = useState<Record<WorkflowKind, WorkflowAISettingInput>>(defaultWorkflows);
  const [editingWorkflow, setEditingWorkflow] = useState<WorkflowKind | null>(null);
  const [catalog, setCatalog] = useState<CodexModel[]>([]);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<{ state: TestState; detail: string; latencyMs?: number }>({ state: 'idle', detail: '' });
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [workBuddyLoginURL, setWorkBuddyLoginURL] = useState('');
  const [workBuddyLoginPending, setWorkBuddyLoginPending] = useState(false);
  const modelRequest = useRef(0);
  const saveLock = useRef(false);
  const testLock = useRef(false);
  /**
   * 是否处于「自定义服务商」。
   *
   * presetOf 是靠地址反推的，而自定义没有固定地址，所以它推不出来——
   * 必须单独记一个标记，否则点了自定义之后按钮不会亮、标题也会显示成别家。
   */
  const [customMode, setCustomMode] = useState(false);
  const modelBox = useRef<HTMLDivElement>(null);
  const filteredModels = modelQuery.trim()
    ? models.filter((item) => item.toLowerCase().includes(modelQuery.trim().toLowerCase()))
    : models;

  // 点面板外部或按 Esc 收起：自绘下拉必须自己管关闭，否则会一直浮在卡片上。
  useEffect(() => {
    if (!modelOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!modelBox.current?.contains(event.target as Node)) setModelOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [modelOpen]);
  const cli = ['codex', 'claude', 'kimi'].includes(provider);
  const active = presetOf(provider, baseURL);
  const currentConnectionHasKey = settings?.keyConfigured && settings.provider === provider
    && settings.baseURL.trim().replace(/\/+$/, '').toLowerCase() === baseURL.trim().replace(/\/+$/, '').toLowerCase();
  /** 界面统一用这个判断"当前是哪家"：自定义优先，否则靠地址反推。 */
  const activeId = customMode ? 'custom' : active?.id;
  /**
   * 标题：认识的服务商显示名字；不认识的地址**显示地址本身**，
   * 而不是硬套一个"自定义服务商"——后者会让人以为配置被改了。
   */
  const activeName = customMode ? '自定义服务商' : (active?.name ?? (cli ? provider.toUpperCase() : null));

  useEffect(() => {
    let alive = true;
    void api
      .settings()
      .then((value) => {
        if (!alive) return;
        setSettings(value);
        if (value.workbuddy?.login?.pending) {
          setWorkBuddyLoginURL(value.workbuddy.login.url ?? '');
          setWorkBuddyLoginPending(true);
        }
        setProvider(value.provider);
        setBaseURL(value.baseURL);
        setModel(value.model);
        setReasoningEffort(value.reasoningEffort ?? '');
        setTranslationPreparation(value.translationPreparation === 'editorial' ? 'editorial' : value.translationPreparation === 'terms+style' ? 'terms+style' : value.translationPreparation === 'terms' ? 'terms' : value.translationPreparation === 'artifacts_only' ? 'artifacts_only' : 'off');
        if (value.workflows) {
          setWorkflows({
            translation: value.workflows.translation?.followGlobal === false ? { followGlobal: false, provider: value.workflows.translation.provider, baseURL: value.workflows.translation.baseURL, model: value.workflows.translation.model, reasoningEffort: value.workflows.translation.reasoningEffort ?? '' } : { followGlobal: true },
            qa: value.workflows.qa?.followGlobal === false ? { followGlobal: false, provider: value.workflows.qa.provider, baseURL: value.workflows.qa.baseURL, model: value.workflows.qa.model, reasoningEffort: value.workflows.qa.reasoningEffort ?? '' } : { followGlobal: true },
            reading: value.workflows.reading?.followGlobal === false ? { followGlobal: false, provider: value.workflows.reading.provider, baseURL: value.workflows.reading.baseURL, model: value.workflows.reading.model, reasoningEffort: value.workflows.reading.reasoningEffort ?? '' } : { followGlobal: true },
          });
        }
        /*
         * 刻意不靠"地址对不上预设"来推断自定义。
         * 任何 OpenAI 兼容地址都是合法配置（例如网关 https://api.llm.ustc.edu.cn，
         * 它不带 /v1，本来就不该匹配 deepseek 等预设），把它标成"自定义服务商"
         * 是在对用户的意图瞎猜，还会让内置服务商看起来被换掉了。
         * 只有用户自己点了自定义、并且还没保存过时，才算自定义态。
         */
        setCustomMode(false);
      })
      .catch((cause) => {
        if (alive) setNotice(String(cause));
      });
    void api.ocrSettings().then((value) => {
      if (!alive) return;
      setOCRSettings(value);
      setOCRProvider(value.provider === 'mineru' ? 'mineru' : 'paddle');
      setOCRBaseURL(value.baseURL);
      setOCRModel(value.model);
    }).catch((cause) => {
      if (alive) setOCRNotice(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const sequence = ++modelRequest.current;
    setModels([]); setCatalog([]); setModelError(''); setModelOpen(false);
    setLoadingModels(false);
    if (provider !== 'codex' && !(provider === 'workbuddy' && settings?.workbuddy?.authenticated)) return;
    let alive = true;
    setLoadingModels(true);
    void api.listModels({ provider, baseURL: '' }).then((result) => {
      if (alive && sequence === modelRequest.current) {
        setModels(result.models);
        setCatalog(result.catalog ?? []);
        if (provider === 'workbuddy' && !settings?.model?.trim()) setModel(result.models[0] ?? '');
      }
    }).catch((cause) => { if (alive && sequence === modelRequest.current) setModelError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (alive && sequence === modelRequest.current) setLoadingModels(false); });
    return () => { alive = false; ++modelRequest.current; };
  }, [provider, baseURL, settings?.workbuddy?.authenticated, settings?.model]);
  const selectedCodexModel = catalog.find((item) => model ? item.model === model || item.id === model : item.isDefault);
  const selectedCodexEfforts = reasoningOptionsForSelection(catalog, model, selectedCodexModel);

  const pick = (preset: ProviderPreset) => {
    setReasoningEffort('');
    setProvider(preset.kind);
    setCustomMode(Boolean(preset.custom));
    setClearKey(false);
    setNotice('');
    setTest({ state: 'idle', detail: '' });
    setKey('');
    // 自定义保留用户已填的地址与模型：切过去常常是为了改一个字段，
    // 清空会让人白填一遍。其余预设照旧用它的默认值。
    if (!preset.custom) {
      setBaseURL(preset.baseURL ?? '');
      setModel(preset.model ?? '');
    }
  };

  const save = async () => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setBusy(true);
    setNotice('');
    try {
      const value = await api.saveSettings({
        provider,
        baseURL,
        model,
        reasoningEffort,
        translationPreparation,
        apiKey: key,
        clearKey,
        workflows,
      });
      setSettings(value);
      if (value.workflows) {
        setWorkflows({
          translation: value.workflows.translation?.followGlobal === false ? { followGlobal: false, provider: value.workflows.translation.provider, baseURL: value.workflows.translation.baseURL, model: value.workflows.translation.model, reasoningEffort: value.workflows.translation.reasoningEffort ?? '' } : { followGlobal: true },
          qa: value.workflows.qa?.followGlobal === false ? { followGlobal: false, provider: value.workflows.qa.provider, baseURL: value.workflows.qa.baseURL, model: value.workflows.qa.model, reasoningEffort: value.workflows.qa.reasoningEffort ?? '' } : { followGlobal: true },
          reading: value.workflows.reading?.followGlobal === false ? { followGlobal: false, provider: value.workflows.reading.provider, baseURL: value.workflows.reading.baseURL, model: value.workflows.reading.model, reasoningEffort: value.workflows.reading.reasoningEffort ?? '' } : { followGlobal: true },
        });
      }
      setKey('');
      setClearKey(false);
      setNotice('已保存');
      window.dispatchEvent(new CustomEvent('cbct-ai-settings', { detail: { settings: value } }));
      return true;
    } catch (cause) {
      setNotice(String(cause));
      return false;
    } finally {
      saveLock.current = false;
      setBusy(false);
    }
  };

  const selectOCRProvider = (selected: 'paddle' | 'mineru') => {
    const profile = ocrSettings?.providers?.[selected];
    setOCRProvider(selected);
    setOCRBaseURL(profile?.baseURL ?? (selected === 'mineru' ? 'https://mineru.net' : 'https://paddleocr.aistudio-app.com'));
    setOCRModel(profile?.model ?? (selected === 'mineru' ? 'vlm' : 'PaddleOCR-VL-1.6'));
    setOCRToken('');
    setClearOCRToken(false);
    setOCRNotice('');
  };

  const saveOCR = async () => {
    if (savingOCR) return;
    setSavingOCR(true);
    setOCRNotice('');
    try {
      const value = await api.saveOCRSettings({
        provider: ocrProvider,
        token: ocrToken,
        clearToken: clearOCRToken,
        baseURL: ocrBaseURL,
        model: ocrModel,
      });
      setOCRSettings(value);
      setOCRBaseURL(value.baseURL);
      setOCRModel(value.model);
      setOCRToken('');
      setClearOCRToken(false);
      setOCRNotice(`${ocrLabel} 设置已保存在本机。${value.configured ? '' : '尚未配置访问令牌。'}`);
    } catch (cause) {
      setOCRNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingOCR(false);
    }
  };

  // 与参考实现一致：测试前先把当前输入（含 Key）保存，测完给出明确状态与耗时（ms）。
  const runTest = async () => {
    if (testLock.current) return;
    testLock.current = true;
    if (!(await save())) {
      testLock.current = false;
      setTest({ state: 'fail', detail: '保存失败，请先修正上方提示' });
      return;
    }
    setTest({ state: 'testing', detail: '' });
    setNotice('');
    const t0 = performance.now();
    try {
      const result = await api.testAI();
      const latencyMs = typeof result.latencyMs === 'number' ? result.latencyMs : Math.round(performance.now() - t0);
      setTest({ state: 'ok', detail: result.answer.slice(0, 120), latencyMs });
    } catch (cause) {
      setTest({ state: 'fail', detail: String(cause) });
    } finally {
      testLock.current = false;
    }
  };

  // 获取当前地址的模型列表：用刚输入的 Key（未保存也能先看），服务端会回落到该地址已保存的 Key。
  const loadModels = async () => {
    const sequence = ++modelRequest.current;
    setLoadingModels(true);
    setModelError('');
    try {
      const result = await api.listModels({ provider, baseURL, apiKey: key });
      if (sequence !== modelRequest.current) return;
      setModels(result.models);
      setCatalog(result.catalog ?? []);
      if (!result.models.length) setModelError('该地址没有返回任何模型，请确认地址与权限。');
      else if (!model.trim() && provider !== 'codex') setModel(result.models[0] ?? '');
    } catch (cause) {
      if (sequence !== modelRequest.current) return;
      setModels([]);
      setModelError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence === modelRequest.current) setLoadingModels(false);
    }
  };

  const startWorkBuddyLogin = async () => {
    setNotice('');
    try {
      const result = await api.workbuddyLogin();
      setWorkBuddyLoginURL(result.url);
      setWorkBuddyLoginPending(true);
      window.open(result.url, '_blank', 'noopener,noreferrer');
      setNotice('已打开 WorkBuddy 国内版登录页；完成登录后 ReadX 会自动获取模型目录。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!workBuddyLoginPending) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let consecutiveErrors = 0;
    const poll = async () => {
      try {
        const value = await api.workbuddyLoginStatus(controller.signal);
        if (controller.signal.aborted) return;
        consecutiveErrors = 0;
        if (!value.login?.pending) {
          setSettings(previous => previous ? { ...previous, workbuddy: value } : previous);
          setWorkBuddyLoginURL('');
          setNotice(value.login?.error ?? (value.authenticated ? 'WorkBuddy 国内版已登录。' : '登录已结束，请重新打开扫码页。'));
          setWorkBuddyLoginPending(false);
          return;
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (++consecutiveErrors >= 3) {
          setNotice(`读取 WorkBuddy 登录状态失败：${cause instanceof Error ? cause.message : String(cause)}。请重试。`);
          setWorkBuddyLoginPending(false);
          return;
        }
      }
      timer = window.setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [workBuddyLoginPending]);

  const tabMeta: Record<SettingsTab, { label: string; icon: 'chat' | 'sync' | 'sliders' | 'sun' | 'key'; desc: string }> = {
    ai: { label: 'AI 服务', icon: 'chat', desc: '大模型对话渠道、模型目录与 OCR 解析令牌' },
    sync: { label: '同步与备份', icon: 'sync', desc: '坚果云 WebDAV、本地同步目录、跨设备批注合并与完整快照' },
    policy: { label: '处理策略', icon: 'sliders', desc: '全文翻译与精读流水线的默认执行方式' },
    appearance: { label: '外观', icon: 'sun', desc: '主题色彩、界面密度与译文阅读排版参数' },
    shortcuts: { label: '快捷键', icon: 'key', desc: '键盘导航与全局命令速查' },
  };

  return (
    <AppDialog
      open
      onClose={onClose}
      className="ai-settings rx-settings"
      onCancel={(event) => {
        // 模型下拉展开时按 Esc 只想收起下拉：原生 dialog 的 cancel 会顺带关掉整个
        // 设置弹窗，把还没保存的地址/Key/模型输入一起丢掉。
        if (modelOpen) {
          event.preventDefault();
          setModelOpen(false);
          return;
        }
        onClose();
      }}
    >
      <header className="rx-settings-dh">
        <div className="flex items-center gap-2.5 min-w-0">
          <h2>设置</h2>
          <span className={`rx-chip${settings?.status.configured ? ' good' : ''}`}>
            <Icon name={settings?.status.configured ? 'check' : 'alert'} size={12} />
            <span>{settings?.status.configured ? (activeName || model || '已配置') : '待配置'}</span>
          </span>
          {tab === 'sync' ? (
            <span className={`rx-chip${syncProvider === 'jianguoyun' ? ' good' : ''}`}>
              {syncProvider === 'jianguoyun' ? '坚果云' : '本地目录'}
            </span>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭设置">
          <Icon name="x" size={16} />
        </Button>
      </header>

      <div className="rx-settings-grid">
        <nav className="rx-settings-nav" aria-label="设置分类">
          {(Object.keys(tabMeta) as SettingsTab[]).map((keyId) => {
            const item = tabMeta[keyId];
            return (
              <button
                key={keyId}
                type="button"
                className={`rx-settings-tab${tab === keyId ? ' active' : ''}`}
                aria-current={tab === keyId ? 'page' : undefined}
                onClick={() => setTab(keyId)}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="rx-settings-pane">
          {tab === 'ai' ? (
            <>
              <div>
                <h5>AI 服务</h5>
                <div className="rx-settings-sub">翻译、问答、精读默认都用这里的配置，下方也可设置文档识别（OCR）引擎。</div>
              </div>

              <div className="rx-prov-grid" role="group" aria-label="常用服务商">
                {PRESETS.map((preset) => {
                  const on = preset.id === activeId;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={busy}
                      aria-pressed={on}
                      onClick={() => pick(preset)}
                      className="rx-prov"
                      title={
                        preset.custom
                          ? '自己填服务地址与模型（OpenAI 兼容接口）'
                          : preset.local
                            ? `${preset.baseURL}（本机服务）`
                            : preset.id === 'codex'
                              ? '自动识别 Codex Desktop、ChatGPT 内置 CLI 或本机 CLI，使用已有登录'
                              : preset.baseURL ?? '使用本机 CLI 已登录的账户'
                      }
                    >
                      <span className="lo">
                        <ProviderLogo id={preset.custom ? 'custom' : (preset.logo ?? preset.id)} size={15} />
                      </span>
                      <span>{preset.name}</span>
                    </button>
                  );
                })}
              </div>

              {cli ? (
                <div className="rx-field">
                  <label>{provider === 'codex' ? '连接 Codex' : '本机 CLI'}</label>
                  <p className="ai-hint" style={{ margin: 0 }}>
                    {provider === 'codex' ? (
                      <>
                        {settings?.codex?.message ?? '自动查找 Codex Desktop 自带程序或独立 CLI。请先在 Codex Desktop 登录，再重新打开设置。'}
                        {' '}无需另外安装 CLI；连接时使用 Codex 自身的登录凭据。
                      </>
                    ) : (
                      <>
                        {settings?.cli[provider] ? '已检测到 CLI。' : '未检测到 CLI，请安装后重新打开设置。'}
                        请先在终端执行 <code>{provider} {provider === 'claude' ? 'auth login' : 'login'}</code>。
                      </>
                    )}
                    {' '}调用在临时目录中进行，并关闭文档工具访问。
                  </p>
                </div>
              ) : provider === 'workbuddy' ? (
                <div className="rx-field">
                  <label>连接 WorkBuddy 国内版</label>
                  <p className="ai-hint" style={{ margin: 0 }}>使用腾讯国内版 CodeBuddy 账号登录，ReadX 会同步账号可用模型。登录令牌保存在本机，不需要填写 API Key。</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {settings?.workbuddy?.authenticated ? (
                      <span className="rx-chip good">
                        <Icon name="check" size={12} />
                        已登录{settings.workbuddy.nickname ? ` · ${settings.workbuddy.nickname}` : ''}
                      </span>
                    ) : null}
                    <Button variant="secondary" size="sm" disabled={workBuddyLoginPending || busy} onClick={() => void startWorkBuddyLogin()}>
                      {workBuddyLoginPending ? '等待登录…' : settings?.workbuddy?.authenticated ? '重新登录' : '登录 WorkBuddy 国内版'}
                    </Button>
                    {settings?.workbuddy?.authenticated ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || workBuddyLoginPending}
                        onClick={() => void api.workbuddyLogout().then(() => api.settings()).then(setSettings).then(() => { setModels([]); setNotice('已退出 WorkBuddy 国内版。'); })}
                      >
                        退出登录
                      </Button>
                    ) : null}
                    {workBuddyLoginURL ? <a className="text-[12px] text-accent" href={workBuddyLoginURL} target="_blank" rel="noreferrer">如果登录页未自动打开，点击这里继续</a> : null}
                  </div>
                </div>
              ) : (
                <div className="rx-field-row">
                  <div className="rx-field">
                    <label htmlFor="rx-ai-base-url">API 地址</label>
                    <input
                      id="rx-ai-base-url"
                      value={baseURL}
                      disabled={busy}
                      onChange={(event) => setBaseURL(event.target.value)}
                      placeholder="https://api.example.invalid/v1"
                    />
                    <small>
                      {customMode
                        ? 'OpenAI 兼容地址（通常以 /v1 结尾）'
                        : provider === 'anthropic'
                          ? 'Anthropic Messages API 地址'
                          : 'OpenAI 兼容端点；本机模型填回环地址'}
                    </small>
                  </div>

                  <div className="rx-field">
                    <label htmlFor="rx-ai-api-key">API 密钥</label>
                    <div className="rx-secret-wrap">
                      <input
                        id="rx-ai-api-key"
                        type={showKey ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={key}
                        disabled={busy}
                        onChange={(event) => setKey(event.target.value)}
                        placeholder={currentConnectionHasKey ? 'sk-••••••••••••••••（已保存，留空不变）' : '填写服务商提供的密钥'}
                      />
                      <button
                        type="button"
                        className="rx-secret-toggle"
                        onClick={() => setShowKey((prev) => !prev)}
                        aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                        title={showKey ? '隐藏密钥' : '显示密钥'}
                      >
                        <Icon name={showKey ? 'eyeOff' : 'eye'} size={15} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <small>只保存在本机，不会同步到其他设备</small>
                      <label className="checkbox-label" style={{ margin: 0, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={clearKey}
                          onChange={(event) => setClearKey(event.target.checked)}
                          disabled={busy}
                        />
                        清除
                      </label>
                    </div>
                  </div>
                </div>
              )}

              <div className="rx-field-row">
                <div className="rx-field">
                  <label htmlFor="rx-ai-model">模型</label>
                  <div className="ai-model-row" ref={modelBox}>
                    <input
                      id="rx-ai-model"
                      value={model}
                      disabled={busy}
                      onChange={(event) => {
                        setModel(event.target.value);
                        if (provider === 'codex') setReasoningEffort('');
                      }}
                      onFocus={() => setModelOpen(true)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setModelOpen(false);
                      }}
                      placeholder={
                        cli ? '留空使用 CLI 默认模型' : provider === 'anthropic' ? '例如 claude-sonnet-4-5' : '填写或获取模型名'
                      }
                      aria-expanded={modelOpen}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || (cli && provider !== 'codex') || (provider === 'workbuddy' && !settings?.workbuddy?.authenticated) || loadingModels}
                      onClick={() => void loadModels()}
                      title={provider === 'codex' ? '读取本机 Codex 模型和推理强度目录' : provider === 'workbuddy' ? '读取已登录 WorkBuddy 国内版账号的模型目录' : cli ? 'CLI 渠道使用默认模型' : '读取当前地址的可用模型'}
                    >
                      {loadingModels ? '获取中…' : '获取列表'}
                    </Button>
                    {models.length ? (
                      <button
                        type="button"
                        className="ai-model-caret"
                        onClick={() => setModelOpen((value) => !value)}
                        aria-label="展开模型列表"
                        aria-expanded={modelOpen}
                        title={`共 ${models.length} 个模型`}
                      >
                        <Icon name="down" size={14} />
                      </button>
                    ) : null}
                    {modelOpen && models.length ? (
                      <div className="ai-model-menu">
                        <input
                          className="ai-model-search"
                          value={modelQuery}
                          onChange={(event) => setModelQuery(event.target.value)}
                          placeholder={`筛选 ${models.length} 个模型`}
                          aria-label="筛选模型名"
                          autoFocus
                        />
                        <div className="ai-model-scroll" role="listbox" aria-label="模型列表">
                          {filteredModels.map((item) => (
                            <button
                              key={item}
                              type="button"
                              role="option"
                              aria-selected={item === model}
                              className={`ai-model-item${item === model ? ' active' : ''}`}
                              onClick={() => {
                                setModel(item);
                                if (provider === 'codex') setReasoningEffort('');
                                setModelOpen(false);
                                setModelQuery('');
                              }}
                            >
                              {item}
                            </button>
                          ))}
                          {filteredModels.length === 0 ? <p className="ai-model-empty">没有匹配的模型名</p> : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {modelError ? (
                    <small className="text-bad">{modelError}</small>
                  ) : models.length ? (
                    <small>已获取 {models.length} 个模型，点击列表或输入筛选。</small>
                  ) : null}
                </div>

                <div className="rx-field">
                  <label>推理强度</label>
                  <Segmented<string>
                    ariaLabel="推理强度"
                    value={reasoningEffort}
                    onChange={(next) => {
                      if (busy) return;
                      setReasoningEffort((prev) => (prev === next ? '' : next));
                    }}
                    options={
                      provider === 'codex' && selectedCodexEfforts.length > 0
                        ? selectedCodexEfforts.map((opt) => ({
                            value: opt.reasoningEffort,
                            label: capEffort(opt.reasoningEffort),
                          }))
                        : [
                            { value: 'low', label: 'Low' },
                            { value: 'medium', label: 'Medium' },
                            { value: 'high', label: 'High' },
                          ]
                    }
                  />
                  {provider === 'codex' && !selectedCodexModel ? (
                    <small>当前为 Codex 全局选项，或点击左侧获取目录。</small>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <Button variant="secondary" size="sm" disabled={busy || test.state === 'testing' || !settings} onClick={() => void runTest()}>
                  <Icon name="link" size={14} />
                  <span>{test.state === 'testing' ? '正在测试…' : '测试连接'}</span>
                </Button>
                <span className={`rx-chip${test.state === 'ok' ? ' good' : test.state === 'fail' ? ' bad' : ''}`}>
                  <Icon name={test.state === 'ok' ? 'check' : test.state === 'fail' ? 'alert' : 'queue'} size={12} />
                  <span>
                    {test.state === 'testing'
                      ? '测试中…'
                      : test.state === 'ok'
                        ? `已连接${typeof test.latencyMs === 'number' ? ` · ${test.latencyMs} ms` : ''}`
                        : test.state === 'fail'
                          ? '连接失败'
                          : '待测试'}
                  </span>
                </span>
                {test.state === 'fail' && test.detail ? <span className="text-[12px] text-bad">{test.detail}</span> : null}
              </div>

              {/* 按流程指定（翻译 / 论文问答 / 精读五重奏） */}
              <div className="pt-4 border-t border-line">
                <div className="text-[13px] font-medium text-ink-soft mb-1">按流程指定</div>
                <table className="rx-flow" aria-label="按流程指定模型">
                  <tbody>
                    {WORKFLOW_ROWS.map(({ kind, label }) => {
                      const wf = workflows[kind];
                      const currentKey = workflowKeyOf(wf);
                      const savedChannels = settings?.savedChannels ?? [];
                      const presetValues = new Set<string>([
                        'follow',
                        'codex||low',
                        'codex||medium',
                        'codex||high',
                        'claude||low',
                        'claude||medium',
                        'claude||high',
                        'kimi||',
                        'workbuddy||',
                      ]);
                      const savedOptions = savedChannels.map((ch) => {
                        const preset = presetOf(ch.provider, ch.baseURL);
                        const defaultModel = preset?.model ?? '';
                        const optKey = `${ch.provider}|${ch.baseURL.replace(/\/+$/, '')}|${defaultModel}|`;
                        presetValues.add(optKey);
                        return {
                          key: optKey,
                          label: `${preset?.name ?? ch.host ?? ch.baseURL}${defaultModel ? ` · ${defaultModel}` : ''}`,
                          input: {
                            followGlobal: false,
                            provider: ch.provider,
                            baseURL: ch.baseURL,
                            model: defaultModel,
                            reasoningEffort: '',
                          } satisfies WorkflowAISettingInput,
                        };
                      });
                      const isCustomValue = currentKey !== 'follow' && !presetValues.has(currentKey);

                      const handleSelectWorkflow = (val: string) => {
                        if (val === 'follow') {
                          setWorkflows((prev) => ({ ...prev, [kind]: { followGlobal: true } }));
                          if (editingWorkflow === kind) setEditingWorkflow(null);
                          return;
                        }
                        if (val === '__custom__') {
                          setWorkflows((prev) => ({
                            ...prev,
                            [kind]: prev[kind].followGlobal
                              ? { followGlobal: false, provider, baseURL, model, reasoningEffort }
                              : prev[kind],
                          }));
                          setEditingWorkflow((prev) => (prev === kind ? null : kind));
                          return;
                        }
                        const matchedSaved = savedOptions.find((item) => item.key === val);
                        if (matchedSaved) {
                          setWorkflows((prev) => ({ ...prev, [kind]: matchedSaved.input }));
                          if (editingWorkflow === kind) setEditingWorkflow(null);
                          return;
                        }
                        const [p = '', b = '', m = '', e = ''] = val.split('|');
                        if (p) {
                          setWorkflows((prev) => ({
                            ...prev,
                            [kind]: { followGlobal: false, provider: p, baseURL: b, model: m, reasoningEffort: e },
                          }));
                          if (editingWorkflow === kind) setEditingWorkflow(null);
                        }
                      };

                      return (
                        <tr key={kind}>
                          <td colSpan={editingWorkflow === kind ? 2 : 1}>
                            {editingWorkflow === kind ? (
                              <>
                                <div className="flex items-center justify-between gap-2">
                                  <span>{label}</span>
                                  <div className="flex items-center gap-1.5">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setEditingWorkflow(null)}
                                    >
                                      收起
                                    </Button>
                                  </div>
                                </div>
                                <div className="rx-flow-edit">
                                  <label>
                                    <span>渠道</span>
                                    <select
                                      aria-label={`${label}渠道`}
                                      value={wf.provider || 'openai'}
                                      disabled={busy}
                                      onChange={(ev) => {
                                        const nextProv = ev.target.value;
                                        setWorkflows((prev) => ({
                                          ...prev,
                                          [kind]: {
                                            ...prev[kind],
                                            followGlobal: false,
                                            provider: nextProv,
                                            baseURL: nextProv === 'openai' || nextProv === 'anthropic'
                                              ? (prev[kind].baseURL || baseURL || 'https://api.openai.com/v1')
                                              : '',
                                          },
                                        }));
                                      }}
                                    >
                                      <option value="openai">OpenAI 兼容</option>
                                      <option value="anthropic">Anthropic</option>
                                      <option value="claude">Claude Code</option>
                                      <option value="codex">Codex</option>
                                      <option value="kimi">Kimi Code</option>
                                      <option value="workbuddy">WorkBuddy</option>
                                    </select>
                                  </label>
                                  {(wf.provider === 'openai' || wf.provider === 'anthropic' || !wf.provider) ? (
                                    <label>
                                      <span>API 地址</span>
                                      <input
                                        aria-label={`${label} API 地址`}
                                        value={wf.baseURL ?? ''}
                                        disabled={busy}
                                        placeholder="https://api.example.com/v1"
                                        onChange={(ev) => setWorkflows((prev) => ({
                                          ...prev,
                                          [kind]: { ...prev[kind], followGlobal: false, baseURL: ev.target.value },
                                        }))}
                                      />
                                    </label>
                                  ) : (
                                    <label>
                                      <span>推理强度</span>
                                      <select
                                        aria-label={`${label}推理强度`}
                                        value={wf.reasoningEffort ?? ''}
                                        disabled={busy}
                                        onChange={(ev) => setWorkflows((prev) => ({
                                          ...prev,
                                          [kind]: { ...prev[kind], followGlobal: false, reasoningEffort: ev.target.value },
                                        }))}
                                      >
                                        <option value="">默认</option>
                                        <option value="low">Low</option>
                                        <option value="medium">Medium</option>
                                        <option value="high">High</option>
                                      </select>
                                    </label>
                                  )}
                                  <label>
                                    <span>模型名</span>
                                    <input
                                      aria-label={`${label}模型名`}
                                      value={wf.model ?? ''}
                                      disabled={busy}
                                      placeholder={wf.provider === 'claude' || wf.provider === 'codex' || wf.provider === 'kimi' ? '留空用 CLI 默认' : '例如 deepseek-chat'}
                                      onChange={(ev) => setWorkflows((prev) => ({
                                        ...prev,
                                        [kind]: { ...prev[kind], followGlobal: false, model: ev.target.value },
                                      }))}
                                    />
                                  </label>
                                  {(wf.provider === 'openai' || wf.provider === 'anthropic' || !wf.provider) ? (
                                    <label>
                                      <span>推理强度</span>
                                      <select
                                        aria-label={`${label}推理强度`}
                                        value={wf.reasoningEffort ?? ''}
                                        disabled={busy}
                                        onChange={(ev) => setWorkflows((prev) => ({
                                          ...prev,
                                          [kind]: { ...prev[kind], followGlobal: false, reasoningEffort: ev.target.value },
                                        }))}
                                      >
                                        <option value="">默认</option>
                                        <option value="low">Low</option>
                                        <option value="medium">Medium</option>
                                        <option value="high">High</option>
                                      </select>
                                    </label>
                                  ) : null}
                                </div>
                              </>
                            ) : (
                              label
                            )}
                          </td>
                          {editingWorkflow === kind ? null : (
                            <td>
                              <div className="inline-flex items-center justify-end gap-1 max-w-full">
                                <select
                                  aria-label={`${label}模型`}
                                  className="rx-flow-select"
                                  value={currentKey}
                                  disabled={busy}
                                  onChange={(ev) => handleSelectWorkflow(ev.target.value)}
                                >
                                  <option value="follow">跟随全局</option>
                                  {isCustomValue ? (
                                    <option value={currentKey}>{workflowChannelLabel(wf)}</option>
                                  ) : null}
                                  <optgroup label="本机 CLI / 账号">
                                    <option value="claude||high">Claude Code · High</option>
                                    <option value="claude||medium">Claude Code · Medium</option>
                                    <option value="claude||low">Claude Code · Low</option>
                                    <option value="codex||high">Codex · High</option>
                                    <option value="codex||medium">Codex · Medium</option>
                                    <option value="codex||low">Codex · Low</option>
                                    <option value="kimi||">Kimi Code</option>
                                    <option value="workbuddy||">WorkBuddy 国内版</option>
                                  </optgroup>
                                  {savedOptions.length ? (
                                    <optgroup label="已保存连接">
                                      {savedOptions.map((opt) => (
                                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                                      ))}
                                    </optgroup>
                                  ) : null}
                                  <option value="__custom__">自定义模型与渠道…</option>
                                </select>
                                {!wf.followGlobal ? (
                                  <button
                                    type="button"
                                    className="rx-btn rx-btn-icon rx-btn-ghost"
                                    title={`编辑${label}指定模型`}
                                    aria-label={`编辑${label}指定模型`}
                                    onClick={() => setEditingWorkflow(kind)}
                                    style={{ width: 24, height: 24 }}
                                  >
                                    <Icon name="sliders" size={12} />
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="pt-4 border-t border-line">
                <div className="text-[13px] font-medium text-ink-soft mb-1">翻译预处理流程</div>
                <table className="rx-flow">
                  <tbody>
                    <tr>
                      <td>译前准备模式</td>
                      <td>
                        <select
                          aria-label="译前准备模式"
                          className="rx-flow-select"
                          value={translationPreparation}
                          disabled={busy}
                          onChange={(event) => setTranslationPreparation(
                            event.target.value === 'editorial' ? 'editorial'
                              : event.target.value === 'terms+style' ? 'terms+style'
                                : event.target.value === 'terms' ? 'terms'
                                  : event.target.value === 'artifacts_only' ? 'artifacts_only'
                                    : 'off',
                          )}
                        >
                          <option value="off">关闭（LeePDF 默认）</option>
                          <option value="artifacts_only">仅生成术语库与风格指南</option>
                          <option value="terms">术语预扫（terms）</option>
                          <option value="terms+style">术语预扫与风格指南（terms+style）</option>
                          <option value="editorial">术语预扫、审定与风格指南（editorial）</option>
                        </select>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="pt-4 border-t border-line flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h5 style={{ fontSize: 15 }}>文档识别（OCR）</h5>
                    <div className="rx-settings-sub">LeePDF 全篇识别引擎；{ocrProvider === 'mineru' ? 'MinerU 单份限制 200 MB / 200 页。' : '实际限制由 PaddleOCR 服务决定。'}</div>
                  </div>
                  <span className={`rx-chip${ocrConfigured ? ' good' : ''}`}>
                    <Icon name={ocrConfigured ? 'check' : 'queue'} size={12} />
                    <span>{ocrConfigured ? '已配置' : ocrSettings ? '未配置' : '读取中'}</span>
                  </span>
                </div>

                <div className="rx-field-row">
                  <div className="rx-field">
                    <label htmlFor="rx-ocr-provider">OCR 服务</label>
                    <select id="rx-ocr-provider" value={ocrProvider} disabled={savingOCR || !ocrSettings} onChange={(event) => selectOCRProvider(event.target.value as 'paddle' | 'mineru')}>
                      <option value="paddle">PaddleOCR</option>
                      <option value="mineru">MinerU</option>
                    </select>
                  </div>
                  <div className="rx-field">
                    <label htmlFor="rx-ocr-token">{ocrLabel} 访问令牌</label>
                    <div className="rx-secret-wrap">
                      <input
                        id="rx-ocr-token"
                        type={showOCRToken ? 'text' : 'password'}
                        autoComplete="new-password"
                        value={ocrToken}
                        disabled={savingOCR}
                        onChange={(event) => { setOCRToken(event.target.value); setClearOCRToken(false); }}
                        placeholder={ocrConfigured ? '已保存；留空保持不变' : `填写 ${ocrLabel} 访问令牌`}
                      />
                      <button
                        type="button"
                        className="rx-secret-toggle"
                        onClick={() => setShowOCRToken((prev) => !prev)}
                        aria-label={showOCRToken ? '隐藏 OCR 令牌' : '显示 OCR 令牌'}
                      >
                        <Icon name={showOCRToken ? 'eyeOff' : 'eye'} size={15} />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rx-field-row">
                  <div className="rx-field">
                    <label htmlFor="rx-ocr-url">服务地址</label>
                    <input id="rx-ocr-url" value={ocrBaseURL} disabled={savingOCR} onChange={(event) => setOCRBaseURL(event.target.value)} />
                  </div>
                  <div className="rx-field">
                    <label htmlFor="rx-ocr-model">识别模型</label>
                    {ocrProvider === 'mineru' ? (
                      <select id="rx-ocr-model" value={ocrModel} disabled={savingOCR} onChange={(event) => setOCRModel(event.target.value)}>
                        <option value="vlm">vlm（视觉语言模型）</option>
                        <option value="pipeline">pipeline（传统解析模型）</option>
                      </select>
                    ) : <input id="rx-ocr-model" value={ocrModel} disabled={savingOCR} onChange={(event) => setOCRModel(event.target.value)} />}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3 text-[12px] text-ink-faint">
                    {ocrConfigured ? (
                      <label className="checkbox-label" style={{ margin: 0 }}>
                        <input type="checkbox" checked={clearOCRToken} disabled={savingOCR} onChange={(event) => setClearOCRToken(event.target.checked)} />
                        清除已保存的 {ocrLabel} 令牌
                      </label>
                    ) : null}
                    {ocrProvider === 'mineru' ? <a href="https://mineru.net/apiManage/docs" target="_blank" rel="noopener noreferrer" className="text-accent">MinerU 官方文档 ↗</a> : null}
                  </div>
                  <Button variant="secondary" size="sm" disabled={savingOCR || !ocrSettings} onClick={() => void saveOCR()}>
                    {savingOCR ? '保存中…' : '保存 OCR 设置'}
                  </Button>
                </div>
                {ocrNotice ? <p role="status" className={`ai-result${ocrConfigured ? ' ok' : ''}`}>{ocrNotice}</p> : null}
              </div>

              {notice ? <p role="status" className="ai-result">{notice}</p> : null}
            </>
          ) : null}

          {tab === 'sync' ? (
            <>
              <div>
                <h5>跨设备同步与备份</h5>
                <div className="rx-settings-sub">{tabMeta.sync.desc}</div>
              </div>
              <SyncSettingsPane
                onProviderChange={setSyncProvider}
                onBusyChange={setBusy}
                onSyncComplete={() => window.dispatchEvent(new Event('readx-sync-complete'))}
              />
            </>
          ) : null}

          {tab === 'policy' ? (
            <>
              <div>
                <h5>处理策略</h5>
                <div className="rx-settings-sub">{tabMeta.policy.desc}</div>
              </div>
              <ProcessingPolicySettings />
              <p className="ai-hint">控制上传新论文或书籍后是否自动启动 OCR、译前准备、双语全文翻译与精读流水线。</p>
            </>
          ) : null}

          {tab === 'appearance' ? (
            <>
              <div>
                <h5>外观与阅读排版</h5>
                <div className="rx-settings-sub">{tabMeta.appearance.desc}</div>
              </div>
              <div>
                <div className="rx-setting-row">
                  <div className="rx-setting-label">
                    <strong>主题外观</strong>
                    <span>支持浅色、深色与护眼纸质暖色主题</span>
                  </div>
                  <Segmented
                    ariaLabel="主题外观"
                    value={appearance?.theme ?? 'system'}
                    onChange={(next) => appearance?.onThemeChange(next)}
                    options={[
                      { value: 'system', label: '跟随系统' },
                      { value: 'light', label: '浅色' },
                      { value: 'paper', label: '纸质' },
                      { value: 'dark', label: '深色' },
                    ]}
                  />
                </div>
                <div className="rx-setting-row">
                  <div className="rx-setting-label">
                    <strong>界面密度</strong>
                    <span>调整书库列表行高、侧栏内距与控件留白</span>
                  </div>
                  <Segmented
                    ariaLabel="界面密度"
                    value={appearance?.density ?? 'comfortable'}
                    onChange={(next) => appearance?.onAppearanceChange({ density: next })}
                    options={[
                      { value: 'comfortable', label: '舒适' },
                      { value: 'compact', label: '紧凑' },
                    ]}
                  />
                </div>
                <div className="rx-setting-row">
                  <div className="rx-setting-label">
                    <strong>阅读正文字体</strong>
                    <span>应用于译文正文、精读笔记与 AI 回答排版</span>
                  </div>
                  <Segmented
                    ariaLabel="阅读正文字体"
                    value={appearance?.readingFont ?? 'sans'}
                    onChange={(next) => appearance?.onAppearanceChange({ readingFont: next })}
                    options={[
                      { value: 'sans', label: '无衬线' },
                      { value: 'serif', label: '衬线体' },
                    ]}
                  />
                </div>
                <div className="rx-setting-row">
                  <div className="rx-setting-label">
                    <strong>阅读基准字号</strong>
                    <span>调整文档精读与伴读正文显示大小</span>
                  </div>
                  <div className="rx-size-picker" role="group" aria-label="阅读基准字号">
                    {[14, 15, 16, 17, 18].map((px) => (
                      <button
                        key={px}
                        type="button"
                        className={`rx-size-btn${(appearance?.readingSize ?? 15) === px ? ' active' : ''}`}
                        onClick={() => appearance?.onAppearanceChange({ readingSize: px })}
                      >
                        {px}px
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {tab === 'shortcuts' ? (
            <>
              <div>
                <h5>键盘快捷键</h5>
                <div className="rx-settings-sub">{tabMeta.shortcuts.desc}</div>
              </div>
              <div className="rx-shortcut-list">
                {SHORTCUTS.map((item) => (
                  <div key={item.title} className="rx-shortcut-row">
                    <div className="rx-shortcut-desc">
                      <strong>{item.title}</strong>
                      <small>{item.desc}</small>
                    </div>
                    <div className="rx-shortcut-keys">
                      {item.keys.map((k) => <span key={k} className="rx-kbd">{k}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <footer className="rx-settings-df">
        {tab === 'ai' ? (
          <>
            <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
            <Button
              variant="primary"
              disabled={busy || !settings}
              onClick={() => void save().then((saved) => { if (saved) onClose(); })}
            >
              {busy ? '保存中…' : '保存'}
            </Button>
          </>
        ) : (
          <Button variant="primary" disabled={busy} onClick={onClose}>
            完成
          </Button>
        )}
      </footer>
    </AppDialog>
  );
}
