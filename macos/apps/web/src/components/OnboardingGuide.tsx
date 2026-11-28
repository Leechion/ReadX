import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AISettings, type OCRSettings } from '../api/client';
import { readJSON, STORAGE_KEYS, writeJSON } from '../lib/storage';
import type { SettingsTab } from './AISettingsDialog';
import { Icon } from './ui/Icon';
import { Button } from './ui/Primitives';

interface OnboardingState {
  collapsed: boolean;
  dismissed: boolean;
  step: number;
  reviewedPrefs: boolean;
}

const STEP_LABELS = ['AI 模型', 'OCR 识别', '偏好策略', '导入论文'] as const;

function sanitizeState(raw: unknown): OnboardingState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  return {
    collapsed: typeof obj.collapsed === 'boolean' ? obj.collapsed : false,
    dismissed: typeof obj.dismissed === 'boolean' ? obj.dismissed : false,
    step: typeof obj.step === 'number' && obj.step >= 0 && obj.step < STEP_LABELS.length ? obj.step : 0,
    reviewedPrefs: typeof obj.reviewedPrefs === 'boolean' ? obj.reviewedPrefs : false,
  };
}

function formatAIProvider(settings: AISettings | null): string {
  if (!settings?.status?.configured) return '待配置';
  const p = settings.provider;
  const label = p === 'claude' ? 'Claude Code'
    : p === 'codex' ? 'Codex'
      : p === 'kimi' ? 'Kimi Code'
        : p === 'workbuddy' ? 'WorkBuddy'
          : p === 'anthropic' ? 'Anthropic'
            : settings.model || p.toUpperCase();
  return settings.model && label !== settings.model ? `${label} · ${settings.model}` : label;
}

export function OnboardingGuide({
  documentCount,
  hidden,
  reopenNonce,
  onOpenSettings,
  onOpenImport,
}: {
  documentCount: number;
  hidden: boolean;
  reopenNonce: number;
  onOpenSettings: (tab: SettingsTab, focusSection?: 'ocr') => void;
  onOpenImport: () => void;
}) {
  const [storedState, setStoredState] = useState<OnboardingState | null>(() =>
    sanitizeState(readJSON<unknown>(STORAGE_KEYS.onboardingGuide, null)),
  );
  const [aiSettings, setAISettings] = useState<AISettings | null>(null);
  const [ocrSettings, setOCRSettings] = useState<OCRSettings | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const prevHidden = useRef(hidden);
  const prevReopenNonce = useRef(reopenNonce);

  const refreshStatus = useCallback(async () => {
    const [aiResult, ocrResult] = await Promise.allSettled([
      api.settings(),
      api.ocrSettings(),
    ]);
    const nextAI = aiResult.status === 'fulfilled' ? aiResult.value : null;
    const nextOCR = ocrResult.status === 'fulfilled' ? ocrResult.value : null;
    if (nextAI) setAISettings(nextAI);
    if (nextOCR) setOCRSettings(nextOCR);
    return { nextAI, nextOCR };
  }, []);

  useEffect(() => {
    let alive = true;
    void refreshStatus().then(({ nextAI, nextOCR }) => {
      if (!alive) return;
      setHydrated(true);
      setStoredState((prev) => {
        if (prev) return prev;
        const aiReady = Boolean(nextAI?.status?.configured);
        const ocrReady = Boolean(nextOCR?.configured);
        const docsReady = documentCount > 0;
        const firstIncomplete = !aiReady ? 0 : !ocrReady ? 1 : !docsReady ? 3 : 0;
        const initial: OnboardingState = {
          collapsed: aiReady && ocrReady && docsReady,
          dismissed: false,
          step: firstIncomplete,
          reviewedPrefs: aiReady && ocrReady && docsReady,
        };
        writeJSON(STORAGE_KEYS.onboardingGuide, initial);
        return initial;
      });
    });
    return () => { alive = false; };
  }, [refreshStatus, documentCount]);

  // 当设置弹窗关闭或组件重新可见时刷新配置状态
  useEffect(() => {
    if (prevHidden.current && !hidden) {
      void refreshStatus();
    }
    prevHidden.current = hidden;
  }, [hidden, refreshStatus]);

  useEffect(() => {
    const onAI = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: AISettings }>).detail;
      if (detail?.settings) setAISettings(detail.settings);
      else void refreshStatus();
    };
    const onOCR = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: OCRSettings }>).detail;
      if (detail?.settings) setOCRSettings(detail.settings);
      else void refreshStatus();
    };
    window.addEventListener('cbct-ai-settings', onAI);
    window.addEventListener('readx-ocr-settings', onOCR);
    return () => {
      window.removeEventListener('cbct-ai-settings', onAI);
      window.removeEventListener('readx-ocr-settings', onOCR);
    };
  }, [refreshStatus]);

  const updateState = useCallback((updater: (prev: OnboardingState) => OnboardingState) => {
    setStoredState((prev) => {
      const base: OnboardingState = prev ?? { collapsed: false, dismissed: false, step: 0, reviewedPrefs: false };
      const next = updater(base);
      writeJSON(STORAGE_KEYS.onboardingGuide, next);
      return next;
    });
  }, []);

  // 从命令面板重新打开新手引导
  useEffect(() => {
    if (reopenNonce === prevReopenNonce.current) return;
    prevReopenNonce.current = reopenNonce;
    void refreshStatus();
    updateState((prev) => ({
      ...prev,
      dismissed: false,
      collapsed: false,
    }));
  }, [reopenNonce, refreshStatus, updateState]);

  if (!hydrated || !storedState || storedState.dismissed || hidden) return null;

  const aiReady = Boolean(aiSettings?.status?.configured);
  const ocrReady = Boolean(ocrSettings?.configured);
  const prefsReady = storedState.reviewedPrefs;
  const importReady = documentCount > 0;
  const doneFlags = [aiReady, ocrReady, prefsReady, importReady];
  const doneCount = doneFlags.filter(Boolean).length;
  const allDone = doneCount === STEP_LABELS.length;
  const step = storedState.step;

  const ocrLabel = ocrSettings?.provider === 'mineru' ? 'MinerU' : 'PaddleOCR';

  if (storedState.collapsed) {
    return (
      <div className="rx-onboarding-pill-wrap" role="region" aria-label="新手配置引导">
        <button
          type="button"
          className="rx-onboarding-pill"
          onClick={() => updateState((prev) => ({ ...prev, collapsed: false }))}
          title="展开新手配置引导"
        >
          <span className="rx-onboarding-pill-icon">
            <Icon name={allDone ? 'check' : 'help'} size={14} />
          </span>
          <span className="rx-onboarding-pill-title">新手引导</span>
          <span className={`rx-chip${allDone ? ' good' : ''}`}>
            {allDone ? '已完成' : `${doneCount}/4`}
          </span>
        </button>
        <button
          type="button"
          className="rx-onboarding-pill-close"
          aria-label="隐藏新手引导"
          title="隐藏（可在 Ctrl+K 命令面板重新打开）"
          onClick={() => updateState((prev) => ({ ...prev, dismissed: true }))}
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    );
  }

  return (
    <aside className="rx-onboarding-card" role="region" aria-label="新手配置引导">
      <header className="rx-onboarding-head">
        <div className="flex items-center gap-2 min-w-0">
          <span className="rx-onboarding-badge">
            <Icon name="help" size={14} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <strong className="text-[13px] font-semibold text-ink">新手配置引导</strong>
              <span className={`rx-chip${allDone ? ' good' : ''}`}>
                {allDone ? '全部就绪' : `${doneCount} / 4`}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rx-onboarding-icon-btn"
            aria-label="收起新手引导"
            title="收起到右下角"
            onClick={() => updateState((prev) => ({ ...prev, collapsed: true }))}
          >
            <Icon name="minus" size={14} />
          </button>
          <button
            type="button"
            className="rx-onboarding-icon-btn"
            aria-label="关闭新手引导"
            title="关闭引导（按 Ctrl+K 可重新打开）"
            onClick={() => updateState((prev) => ({ ...prev, dismissed: true }))}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </header>

      <div className="rx-onboarding-steps" role="tablist" aria-label="配置步骤">
        {STEP_LABELS.map((label, idx) => {
          const done = doneFlags[idx];
          const active = step === idx;
          return (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={active}
              className={`rx-onboarding-step${active ? ' active' : ''}${done ? ' done' : ''}`}
              onClick={() => updateState((prev) => ({ ...prev, step: idx }))}
            >
              <span className="rx-onboarding-step-num">
                {done ? <Icon name="check" size={11} /> : idx + 1}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <div className="rx-onboarding-body">
        {step === 0 ? (
          <>
            <div className="rx-onboarding-status-row">
              <h6>1. 连接你的大模型（必需）</h6>
              <span className={`rx-chip${aiReady ? ' good' : ''}`}>
                <Icon name={aiReady ? 'check' : 'alert'} size={11} />
                <span>{formatAIProvider(aiSettings)}</span>
              </span>
            </div>
            <p className="rx-onboarding-desc">
              翻译、论文问答、精读五重奏与 PPT 生成默认共用这里的模型。支持三种接入方式：
            </p>
            <ul className="rx-onboarding-list">
              <li><strong>云端 API</strong>：DeepSeek、OpenAI、通义千问、硅基流动等，填 Key 后点「获取列表」</li>
              <li><strong>本机离线模型</strong>：直接选用 Ollama / LM Studio，数据不出本机</li>
              <li><strong>免 Key 直连</strong>：已登录 Codex Desktop、Claude / Kimi CLI 或 WorkBuddy</li>
            </ul>
            <div className="rx-onboarding-actions">
              <Button variant="primary" size="sm" onClick={() => onOpenSettings('ai')}>
                <Icon name="chat" size={13} />
                <span>{aiReady ? '修改 AI 配置' : '去配置 AI 模型'}</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => updateState((prev) => ({ ...prev, step: 1 }))}>
                <span>下一步</span>
                <Icon name="right" size={13} />
              </Button>
            </div>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="rx-onboarding-status-row">
              <h6>2. 配置文档识别（OCR）</h6>
              <span className={`rx-chip${ocrReady ? ' good' : ''}`}>
                <Icon name={ocrReady ? 'check' : 'queue'} size={11} />
                <span>{ocrReady ? `${ocrLabel} 已配置` : '未配置'}</span>
              </span>
            </div>
            <p className="rx-onboarding-desc">
              导入扫描版 PDF 与执行全文双语排版翻译时，需要先配置 <strong>PaddleOCR</strong> 或 <strong>MinerU</strong> 的访问令牌。
            </p>
            <ul className="rx-onboarding-list">
              <li><strong>MinerU</strong>：官方远程接口，单份限制 200 MB / 200 页，可选 <code>vlm</code> 或 <code>pipeline</code></li>
              <li><strong>仅看原文可跳过</strong>：带文本层的 PDF 可先不配 OCR，直接浏览和批注</li>
            </ul>
            <div className="rx-onboarding-actions">
              <Button variant="primary" size="sm" onClick={() => onOpenSettings('ai', 'ocr')}>
                <Icon name="sliders" size={13} />
                <span>{ocrReady ? '查看 OCR 设置' : '去配置 OCR'}</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => updateState((prev) => ({ ...prev, step: 2 }))}>
                <span>{ocrReady ? '下一步' : '暂不配置，下一步'}</span>
                <Icon name="right" size={13} />
              </Button>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="rx-onboarding-status-row">
              <h6>3. 隐私策略、同步与交互偏好</h6>
              <span className={`rx-chip${prefsReady ? ' good' : ''}`}>
                <Icon name={prefsReady ? 'check' : 'queue'} size={11} />
                <span>{prefsReady ? '已确认' : '按需设置'}</span>
              </span>
            </div>
            <p className="rx-onboarding-desc">
              按你的使用习惯快速核对这三项常用配置（均可随时调整）：
            </p>
            <div className="rx-onboarding-quick-links">
              <button
                type="button"
                className="rx-onboarding-link-item"
                onClick={() => {
                  updateState((prev) => ({ ...prev, reviewedPrefs: true }));
                  onOpenSettings('policy');
                }}
              >
                <Icon name="sliders" size={14} />
                <div>
                  <strong>外发权限策略</strong>
                  <small>默认每次确认；未公开手稿可按书架/单篇禁止外发</small>
                </div>
                <Icon name="right" size={13} />
              </button>
              <button
                type="button"
                className="rx-onboarding-link-item"
                onClick={() => {
                  updateState((prev) => ({ ...prev, reviewedPrefs: true }));
                  onOpenSettings('sync');
                }}
              >
                <Icon name="sync" size={14} />
                <div>
                  <strong>跨设备同步与完整备份</strong>
                  <small>连接坚果云 WebDAV、本地网盘目录或备份整库</small>
                </div>
                <Icon name="right" size={13} />
              </button>
              <button
                type="button"
                className="rx-onboarding-link-item"
                onClick={() => {
                  updateState((prev) => ({ ...prev, reviewedPrefs: true }));
                  onOpenSettings('appearance');
                }}
              >
                <Icon name="sun" size={14} />
                <div>
                  <strong>主题排版与快速轮盘</strong>
                  <small>调节浅色/纸质/深色主题，开关长按 Alt 快速轮盘</small>
                </div>
                <Icon name="right" size={13} />
              </button>
            </div>
            <div className="rx-onboarding-actions">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateState((prev) => ({ ...prev, reviewedPrefs: true, step: 3 }))}
              >
                <Icon name="check" size={13} />
                <span>已了解，下一步</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => updateState((prev) => ({ ...prev, step: 1 }))}>
                <Icon name="left" size={13} />
                <span>上一步</span>
              </Button>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="rx-onboarding-status-row">
              <h6>4. 导入你的第一篇论文</h6>
              <span className={`rx-chip${importReady ? ' good' : ''}`}>
                <Icon name={importReady ? 'check' : 'queue'} size={11} />
                <span>{importReady ? `已有 ${documentCount} 篇` : '书库为空'}</span>
              </span>
            </div>
            <p className="rx-onboarding-desc">
              把 PDF / EPUB 直接拖入窗口，或点击导入按 <strong>arXiv / DOI / URL</strong> 拉取论文（也支持 Zotero 7+）。
            </p>
            <ul className="rx-onboarding-list">
              <li>暂未配置 AI 时，可在导入窗勾选 <strong>「仅保存原文」</strong> 直接批注阅读</li>
              <li>需要写 LaTeX 或语音朗读时，本机安装 TeX Live / MiKTeX 或启动 VoiceStudio 即可</li>
            </ul>
            <div className="rx-onboarding-actions">
              <Button variant="primary" size="sm" onClick={onOpenImport}>
                <Icon name="import" size={13} />
                <span>立即导入论文</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => updateState((prev) => ({ ...prev, reviewedPrefs: true, collapsed: true }))}
              >
                <Icon name="check" size={13} />
                <span>完成并收起</span>
              </Button>
            </div>
          </>
        ) : null}
      </div>

      <footer className="rx-onboarding-foot">
        <span>按 <kbd>Ctrl+K</kbd> 搜功能与论文 · <kbd>Ctrl+Shift+M</kbd> 摸鱼切换</span>
      </footer>
    </aside>
  );
}
