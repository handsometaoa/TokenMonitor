import { useMemo, useState } from 'react';
import { EyeOff, Gauge, LayoutDashboard, Network, RefreshCw, Settings2, X } from 'lucide-react';
import type { AppState } from '../../../shared/types';
import { agentQuotaKey, routerQuotaIdentity, EXTRA_PROVIDER_IDS } from '../../../shared/types';
import { EXTRA_PROVIDER_NAMES } from '../../../shared/providers';
import { BrandMark } from '../components/Logo';
import { ExtraProviderCard, UnconnectedProviders } from '../components/ExtraProviderCard';
import { ProviderCard } from '../components/ProviderCard';
import { RouterQuotaCard } from '../components/RouterQuotaCard';
import { ServiceStatusCard } from '../components/ServiceStatusCard';
import { IconButton, Spinner } from '../components/ui';
import { createTranslator } from '../i18n';
import { formatRelative } from '../format';
import { useNow } from '../hooks';
import { Home } from './Home';
import { Onboarding } from './Onboarding';

type View = 'home' | 'quota';

function statusOf(state: AppState, zh: boolean): { tone: string; label: string } {
  if (state.demo) return { tone: 'demo', label: zh ? '演示模式' : 'Demo' };

  const openCodeWindows = state.quota.snapshot?.windows ?? [];
  const extraWindows = state.extraProviders.flatMap((provider) => provider.snapshot?.windows ?? []);
  const hasAnyProvider =
    state.credentials.configured ||
    state.extraProviders.some((provider) => provider.configured) ||
    openCodeWindows.length > 0 ||
    extraWindows.length > 0;

  if (!hasAnyProvider) return { tone: 'off', label: zh ? '未配置' : 'Not configured' };
  if (extraWindows.some((window) => window.status === 'rate-limited')) return { tone: 'danger', label: zh ? '已限流' : 'Rate limited' };
  if (openCodeWindows.some((window) => window.status === 'rate-limited')) return { tone: 'danger', label: zh ? '已限流' : 'Rate limited' };
  if (extraWindows.some((window) => window.remainingPercent <= 5) || openCodeWindows.some((window) => window.remainingPercent <= 5)) {
    return { tone: 'danger', label: zh ? '接近上限' : 'Near limit' };
  }
  if (state.serviceStatuses.some((status) => status.indicator === 'major' || status.indicator === 'critical')) {
    return { tone: 'danger', label: zh ? '服务异常' : 'Service issue' };
  }
  if (state.router.service.state === 'error') {
    return { tone: 'warn', label: zh ? '路由异常' : 'Router error' };
  }
  if (state.serviceStatuses.some((status) => status.indicator === 'minor' || status.incidentCount > 0)) {
    return { tone: 'warn', label: zh ? '部分降级' : 'Degraded' };
  }
  if (state.extraProviders.some((provider) => provider.configured && provider.error && !provider.snapshot)) {
    return { tone: 'warn', label: zh ? '部分异常' : 'Partial' };
  }
  const stale =
    state.quota.stale ||
    Boolean(state.quota.error && state.quota.snapshot) ||
    state.extraProviders.some((provider) => provider.stale || Boolean(provider.error && provider.snapshot));
  if (stale) return { tone: 'warn', label: zh ? '数据过期' : 'Stale' };
  if (extraWindows.some((window) => window.remainingPercent <= 20) || openCodeWindows.some((window) => window.remainingPercent <= 20)) {
    return { tone: 'warn', label: zh ? '接近上限' : 'Near limit' };
  }
  if (!openCodeWindows.length && !extraWindows.length) return { tone: 'off', label: zh ? '等待数据' : 'Waiting' };
  return { tone: 'good', label: zh ? '正常' : 'Normal' };
}

/**
 * The original TokenMonitor panel: quota overview + home dashboard.
 * Rendered as a floating side panel inside the router main window.
 */
export function PanelView({
  state,
  onOpenSettings,
  onOpenRouter,
  onClose,
}: {
  state: AppState;
  onOpenSettings: () => void;
  onOpenRouter: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>('home');
  const now = useNow(1000);
  const language = state.settings.language;
  const t = useMemo(() => createTranslator(language), [language]);
  const status = statusOf(state, language === 'zh-CN');
  const onboarding = !state.settings.onboardingCompleted;

  const refresh = () => void window.tokenMonitor.refreshQuota();

  // Per-agent visibility for the quota tab; same setting drives the overview rows and the tray.
  const quotaVisibility = state.settings.quotaVisibility;
  const quotaVisible = (providerId: string) => quotaVisibility[agentQuotaKey(providerId)] !== false;
  const toggleQuotaVisibility = (key: string) => {
    void window.tokenMonitor.updateSettings({ quotaVisibility: { [key]: quotaVisibility[key] === false } });
  };
  const zh = language === 'zh-CN';
  const visibleExtraProviders = state.extraProviders.filter(
    (provider) => (provider.snapshot || provider.configured) && quotaVisible(provider.providerId),
  );
  const hiddenQuotaAgents = new Map<string, string>();
  if (state.quota.snapshot === null && !quotaVisible('opencode')) hiddenQuotaAgents.set(agentQuotaKey('opencode'), 'OpenCode Go');
  for (const providerId of EXTRA_PROVIDER_IDS) {
    const key = agentQuotaKey(providerId);
    if (!quotaVisible(providerId) && !hiddenQuotaAgents.has(key)) {
      hiddenQuotaAgents.set(key, EXTRA_PROVIDER_NAMES[providerId]);
    }
  }

  return (
    <div className="panel-shell">
      <header className="titlebar">
        <BrandMark />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="brand-title">TokenMonitor</div>
          <div className="brand-sub">{t('app.subtitle')}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`status-pill ${status.tone}`}>
            <span className="status-dot" />
            {status.label}
          </span>
          <IconButton icon={Network} label={zh ? '返回路由台' : 'Back to router'} onClick={onOpenRouter} />
          <IconButton icon={Settings2} label={t('common.settings')} onClick={onOpenSettings} />
          <IconButton icon={X} label={zh ? '收起面板' : 'Collapse panel'} onClick={onClose} className="subtle" />
        </div>
      </header>

      {!onboarding ? (
        <>
          <nav className="tabbar" aria-label="Main views">
            <button type="button" className={`tab ${view === 'home' ? 'active' : ''}`} onClick={() => setView('home')}>
              <LayoutDashboard size={14} />
              {t('tabs.home')}
            </button>
            <button type="button" className={`tab ${view === 'quota' ? 'active' : ''}`} onClick={() => setView('quota')}>
              <Gauge size={14} />
              {t('tabs.overview')}
            </button>
          </nav>
          <div className="panel-scroll">
            {view === 'home' ? (
              <Home state={state} language={language} onOpenQuota={() => setView('quota')} onOpenRouter={onOpenRouter} />
            ) : null}
            {view === 'quota' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {quotaVisible('opencode') ? (
                  <ProviderCard
                    state={state}
                    now={now}
                    language={language}
                    t={t}
                    onRetry={refresh}
                    onOpenSettings={onOpenSettings}
                    onHide={() => toggleQuotaVisibility(agentQuotaKey('opencode'))}
                  />
                ) : null}
                {visibleExtraProviders.map((provider) => (
                  <ExtraProviderCard
                    key={provider.providerId}
                    state={provider}
                    now={now}
                    language={language}
                    t={t}
                    onOpenSettings={onOpenSettings}
                    onRefresh={refresh}
                    onHide={() => toggleQuotaVisibility(agentQuotaKey(provider.providerId))}
                  />
                ))}
                {state.router.quota.length > 0 ? (
                  <div className="router-quota-section">
                    <div className="router-quota-section-head">
                      <span>{language === 'zh-CN' ? '路由提供商余量' : 'Router provider quota'}</span>
                      <button type="button" className="home-link" onClick={onOpenRouter}>
                        {language === 'zh-CN' ? '管理' : 'Manage'}
                      </button>
                    </div>
                    {state.router.quota
                      .filter((quota) => {
                        const key = routerQuotaIdentity(quota.providerId, quota.strategyId);
                        // A router provider mirroring an agent subscription is
                        // deduped against the agent card: show the mirror only
                        // when that agent card is hidden, so hiding the
                        // subscription view never loses the provider quota.
                        if (key.startsWith('router:')) return quotaVisibility[key] !== false;
                        return quotaVisibility[key] === false;
                      })
                      .map((quota) => (
                        <RouterQuotaCard key={quota.providerId} quota={quota} language={language} onOpenRouter={onOpenRouter} />
                      ))}
                  </div>
                ) : null}
                <UnconnectedProviders
                  states={state.extraProviders.filter((provider) => !provider.configured && quotaVisible(provider.providerId))}
                  t={t}
                  onOpenSettings={onOpenSettings}
                />
                <ServiceStatusCard
                  statuses={state.serviceStatuses}
                  language={language}
                  onOpenExternal={(url) => void window.tokenMonitor.openExternal(url)}
                />
                {hiddenQuotaAgents.size > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '0 2px' }}>
                    <span className="hint" style={{ margin: 0 }}>{zh ? '已隐藏：' : 'Hidden:'}</span>
                    {[...hiddenQuotaAgents.entries()].map(([key, name]) => (
                      <button
                        type="button"
                        key={key}
                        className="home-hidden-chip"
                        title={zh ? '点击恢复显示' : 'Click to show again'}
                        onClick={() => toggleQuotaVisibility(key)}
                      >
                        <EyeOff size={11} />
                        {name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <footer className="panel-footer">
            <span>
              {state.demo ? `${t('app.demo')} · ` : ''}
              {(() => {
                const timestamps = [
                  state.quota.fetchedAt,
                  ...state.extraProviders.map((provider) => provider.fetchedAt),
                ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
                return timestamps.length ? formatRelative(Math.max(...timestamps), now, language) : t('status.off');
              })()}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={state.quota.loading || (!state.credentials.configured && !state.demo)}>
              {state.quota.loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
              {t('common.refresh')}
            </button>
          </footer>
        </>
      ) : (
        <div className="panel-scroll">
          <Onboarding state={state} t={t} onOpenSettings={onOpenSettings} />
        </div>
      )}
    </div>
  );
}
