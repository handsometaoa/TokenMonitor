import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AppState, ExtraProviderId } from '../../../shared/types';
import { agentQuotaKey } from '../../../shared/types';
import { EXTRA_PROVIDER_NAMES } from '../../../shared/providers';
import type { Translator } from '../i18n';
import { Toggle } from '../components/ui';

const AGENT_CHOICES: Array<{ key: string; name: string; hint: string }> = [
  {
    key: 'opencode',
    name: 'OpenCode Go',
    hint: '自动读取本机 OpenCode 登录态（~/.local/share/opencode/auth.json），也可稍后粘贴 API Key',
  },
  {
    key: 'codex',
    name: 'Codex / ChatGPT',
    hint: '自动读取 ~/.codex/auth.json 的 OAuth 登录',
  },
  {
    key: 'claude',
    name: 'Claude Code',
    hint: '自动读取 ~/.claude/.credentials.json',
  },
  {
    key: 'cursor',
    name: 'Cursor',
    hint: '需要 Cursor 登录 Cookie（设置中粘贴）',
  },
  {
    key: 'zai',
    name: 'Z.AI / ZCode',
    hint: '自动读取 ~/.zcode 配置或 Z.AI API Key',
  },
];

export function Onboarding({
  state,
  t,
  onOpenSettings,
}: {
  state: AppState;
  t: Translator;
  onOpenSettings: () => void;
}) {
  const zh = state.settings.language === 'zh-CN';
  // Fresh installs start with every agent disabled; the user opts in here.
  const initial = new Set(
    AGENT_CHOICES.filter((choice) => state.settings.quotaVisibility[agentQuotaKey(choice.key)] !== false).map(
      (choice) => choice.key,
    ),
  );
  const [selected, setSelected] = useState<Set<string>>(initial);

  const toggleChoice = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const start = async () => {
    const patch: Record<string, boolean> = {};
    for (const choice of AGENT_CHOICES) patch[agentQuotaKey(choice.key)] = selected.has(choice.key);
    await window.tokenMonitor.updateSettings({
      quotaVisibility: patch,
      onboardingCompleted: true,
    });
  };

  return (
    <div className="onboarding fade-in">
      <div className="onboarding-hero">
        <h1 className="onboarding-title">{zh ? '选择要监控的服务' : 'Choose what to monitor'}</h1>
        <p className="onboarding-sub">
          {zh
            ? 'TokenMonitor 支持多家 Agent 订阅，按需开启即可——开启后自动扫描本机登录态，无需先填 API Key。'
            : 'TokenMonitor monitors many agent subscriptions. Enable what you use — local sign-ins are detected automatically, no API key needed up front.'}
        </p>
      </div>

      <section className="step-card">
        <div className="step-head">
          <span className="step-num">1</span>
          <span className="step-title">{zh ? '选择 Agent' : 'Pick agents'}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
          {AGENT_CHOICES.map((choice) => (
            <div className="switch-row" key={choice.key} style={{ padding: '9px 0' }}>
              <div className="switch-copy">
                <strong>{choice.name}</strong>
                <span>{choice.hint}</span>
              </div>
              <Toggle checked={selected.has(choice.key)} onChange={() => toggleChoice(choice.key)} label={choice.name} />
            </div>
          ))}
        </div>
      </section>

      <section className="step-card">
        <div className="step-head">
          <span className="step-num">2</span>
          <span className="step-title">{zh ? '连接凭证（可选）' : 'Connect credentials (optional)'}</span>
        </div>
        <div className="hint">
          {zh
            ? '开启的 Agent 会自动扫描本机登录态，通常无需手动输入。需要手动粘贴密钥时，随时到「设置 → 常规」或路由控制台「余量页」配置。'
            : 'Enabled agents are auto-scanned from local sign-ins; manual keys can be pasted anytime in Settings or the router console quota page.'}
        </div>
        <div className="hint" style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'flex-start' }}>
          <ShieldCheck size={13} style={{ flex: '0 0 auto', marginTop: 1 }} />
          <span>{t('onboarding.security')}</span>
        </div>
      </section>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void start()}>
          {selected.size > 0
            ? zh
              ? `开始监控（${selected.size} 个 Agent）`
              : `Start monitoring (${selected.size})`
            : zh ? '跳过，稍后配置' : 'Skip for now'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
          {t('common.settings')}
        </button>
      </div>
    </div>
  );
}
