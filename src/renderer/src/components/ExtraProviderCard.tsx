import { AlertTriangle, Plug, RefreshCw, Settings2 } from 'lucide-react';
import type { ExtraProviderState, ExtraProviderWindow, Language } from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatAbsolute, formatCountdown, formatDaily, formatPercent, formatRelative } from '../format';
import { Banner, Chip, IconButton } from './ui';

const ACCENTS: Record<string, string> = {
  codex: 'linear-gradient(145deg,#3f3f46,#0f172a)',
  claude: 'linear-gradient(145deg,#f59e0b,#c2410c)',
  cursor: 'linear-gradient(145deg,#52525b,#18181b)',
  zai: 'linear-gradient(145deg,#2f6bff,#1d4ed8)',
  zcode: 'linear-gradient(145deg,#8b5cf6,#5b21b6)',
};

function providerInitial(name: string): string {
  if (name.startsWith('ZCode')) return 'Z';
  if (name.startsWith('Z.AI')) return 'Z';
  return name.slice(0, 1).toUpperCase();
}

function windowName(window: ExtraProviderWindow, language: Language): string {
  const zh = language === 'zh-CN';
  switch (window.id) {
    case 'session':
      return zh ? '5 小时窗口' : '5-hour window';
    case 'weekly':
      return zh ? '每周窗口' : 'Weekly window';
    case 'monthly':
      return zh ? '每月窗口' : 'Monthly window';
    case 'sonnet':
      return zh ? 'Sonnet 每周' : 'Sonnet weekly';
    case 'on-demand':
      return zh ? '按量使用' : 'On-demand';
    case 'mcp':
      return 'MCP';
    default:
      return window.label;
  }
}

function paceText(window: ExtraProviderWindow, language: Language, t: Translator): string {
  if (window.pace.state === 'insufficient') return t('pace.insufficient');
  if (window.pace.state === 'ahead') {
    const headroom = Math.round(window.pace.headroom ?? 0);
    return `${headroom >= 20 ? t('pace.ahead') : t('pace.aheadWithValue', { value: headroom })} · ${t('pace.sustainable')}`;
  }
  if (window.pace.state === 'behind') return `${t('pace.behind')} · ${t('pace.behindHint')}`;
  let text = `${t('pace.onPace')} · ${t('pace.sustainable')}`;
  if (window.pace.dailyAverage !== null && (window.id === 'weekly' || window.id === 'monthly')) {
    text += ` · ${t('pace.dailyAvg', { value: formatDaily(window.pace.dailyAverage) })}`;
  }
  return text;
}

function errorText(state: ExtraProviderState, language: Language, t: Translator): string {
  switch (state.error?.code) {
    case 'invalid-key':
      return t('error.invalidKey');
    case 'no-subscription':
      return state.error?.message || (language === 'zh-CN' ? '这个 Key 没有可用的套餐额度。' : 'This credential has no available plan quota.');
    case 'network':
      return t('error.network');
    case 'timeout':
      return t('error.timeout');
    case 'rate-limited':
      return t('error.rateLimited');
    case 'malformed':
      return t('error.malformed');
    default:
      return state.error?.message ?? t('error.unknown');
  }
}

function statusOf(state: ExtraProviderState): { tone: 'good' | 'warn' | 'danger' | 'neutral'; label: string } {
  if (state.loading && !state.snapshot) return { tone: 'neutral', label: '···' };
  if (!state.snapshot) return { tone: 'warn', label: '—' };
  if (state.stale) return { tone: 'warn', label: '!' };
  if (state.snapshot.windows.some((window) => window.status === 'rate-limited' || window.remainingPercent <= 5)) {
    return { tone: 'danger', label: '!' };
  }
  if (state.snapshot.windows.some((window) => window.remainingPercent <= 20)) {
    return { tone: 'warn', label: '!' };
  }
  return { tone: 'good', label: 'OK' };
}

export function ExtraProviderCard({
  state,
  now,
  language,
  t,
  onOpenSettings,
  onRefresh,
}: {
  state: ExtraProviderState;
  now: number;
  language: Language;
  t: Translator;
  onOpenSettings: () => void;
  onRefresh: () => void;
}) {
  if (!state.snapshot) {
    if (!state.configured) return null;
    return (
      <div className="glass-card provider-card fade-in" style={{ paddingTop: 16 }}>
        <div className="provider-head" style={{ marginBottom: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 10,
                display: 'grid',
                placeItems: 'center',
                color: '#fff',
                fontWeight: 750,
                fontSize: 12,
                background: ACCENTS[state.providerId] ?? 'var(--accent)',
                flex: '0 0 auto',
              }}
            >
              {providerInitial(state.providerName)}
            </div>
            <div className="provider-title" style={{ fontSize: 17 }}>{state.providerName}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Chip tone="danger">{state.error?.code === 'no-subscription' ? (language === 'zh-CN' ? '无可用套餐' : 'No plan') : t('error.unknown')}</Chip>
            <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={onRefresh} disabled={state.loading} />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <Banner tone="danger" icon={AlertTriangle}>{errorText(state, language, t)}</Banner>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
          <button type="button" className="btn btn-sm" onClick={onOpenSettings}>
            <Settings2 size={12} />
            {t('extra.manage')}
          </button>
        </div>
      </div>
    );
  }
  const snapshot = state.snapshot;
  const status = statusOf(state);
  return (
    <div className="glass-card provider-card fade-in" style={{ paddingTop: 16 }}>
      <div className="provider-head" style={{ marginBottom: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              display: 'grid',
              placeItems: 'center',
              color: '#fff',
              fontWeight: 750,
              fontSize: 12,
              background: ACCENTS[state.providerId] ?? 'var(--accent)',
              boxShadow: '0 6px 16px rgba(0,0,0,.16)',
              flex: '0 0 auto',
            }}
          >
            {providerInitial(state.providerName)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <div className="provider-title" style={{ fontSize: 17 }}>{state.providerName}</div>
              <span className="plan-pill" style={{ height: 22, fontSize: 10 }}>{snapshot.planLabel}</span>
            </div>
            <div className="provider-updated">{formatRelative(snapshot.fetchedAt, now, language)}{state.stale ? ` · ${t('extra.stale')}` : ''}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Chip tone={status.tone === 'neutral' ? 'neutral' : status.tone}>{state.stale ? t('extra.stale') : status.label}</Chip>
          <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={onRefresh} disabled={state.loading} />
        </div>
      </div>

      {state.stale && state.error ? (
        <div style={{ marginTop: 8 }}>
          <Banner tone="warn" icon={AlertTriangle}>{errorText(state, language, t)}</Banner>
        </div>
      ) : null}

      <div>
        {snapshot.windows.map((window) => {
          const remaining = Math.max(0, Math.min(100, window.remainingPercent));
          const tone = window.status === 'rate-limited' || remaining <= 5 ? 'danger' : remaining <= 20 ? 'warn' : 'normal';
          const expectedRemaining = window.pace.headroom === null ? null : Math.max(0, Math.min(100, 100 - window.pace.elapsedRatio * 100));
          return (
            <div className="quota-row" key={window.id}>
              <div className="quota-row-head">
                <div className="quota-label">{windowName(window, language)}</div>
                <div className="quota-remaining mono">{t('provider.remaining')} {Math.round(remaining)}%</div>
              </div>
              <div className="quota-meta">
                <span>{t('provider.used')} {formatPercent(window.usedPercent)}</span>
                <span title={window.resetsAt ? formatAbsolute(window.resetsAt, language) : undefined}>
                  {window.resetsAt ? t('reset.in', { time: formatCountdown(window.resetsAt, now, language) }) : t('reset.unknown')}
                </span>
              </div>
              <div className="quota-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}>
                <div className={`quota-fill ${tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : ''}`} style={{ width: `${remaining}%` }} />
                {expectedRemaining !== null && expectedRemaining > 0 && expectedRemaining < 100 ? (
                  <div className={`quota-pace-tick ${window.pace.state === 'behind' ? 'behind' : ''}`} style={{ left: `${expectedRemaining}%` }} />
                ) : null}
              </div>
              <div className="pace-line">
                <span className={`pace-dot ${window.pace.state}`} />
                <span className="muted">{paceText(window, language, t)}</span>
                {window.status === 'rate-limited' ? <span className="chip danger" style={{ marginLeft: 'auto' }}>{t('status.limited')}</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenSettings}>
          <Settings2 size={12} />
          {t('extra.manage')}
        </button>
      </div>
    </div>
  );
}

export function UnconnectedProviders({
  states,
  t,
  onOpenSettings,
}: {
  states: ExtraProviderState[];
  t: Translator;
  onOpenSettings: () => void;
}) {
  if (states.length === 0) return null;
  return (
    <div className="soft-card" style={{ padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 650 }}>
          <Plug size={14} />
          {t('extra.providers')}
        </div>
        <button type="button" className="btn btn-sm" onClick={onOpenSettings}>{t('extra.manage')}</button>
      </div>
      <div className="hint">{t('extra.connectHint')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
        {states.map((state) => (
          <span className="chip" key={state.providerId}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--faint)' }} />
            {state.providerName} · {t('extra.notConnected')}
          </span>
        ))}
      </div>
    </div>
  );
}
