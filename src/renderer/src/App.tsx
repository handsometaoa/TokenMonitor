import { useEffect, useMemo, useState } from 'react';
import { Activity, Database, Gauge, RefreshCw, Settings2, X } from 'lucide-react';
import type { AppState } from '../../shared/types';
import { BrandMark } from './components/Logo';
import { ProviderCard } from './components/ProviderCard';
import { IconButton, Spinner } from './components/ui';
import { createTranslator } from './i18n';
import { formatRelative } from './format';
import { useNow, useTheme } from './hooks';
import { LocalUsage } from './views/LocalUsage';
import { Onboarding } from './views/Onboarding';
import { SettingsPage } from './views/Settings';
import { Speed } from './views/Speed';

type View = 'overview' | 'local' | 'speed';

function Splash() {
  return (
    <div className="app-bg" style={{ display: 'grid', placeItems: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, position: 'relative', zIndex: 1 }}>
        <BrandMark size={42} />
        <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
          <Spinner /> TokenMonitor
        </div>
      </div>
    </div>
  );
}

function statusOf(state: AppState, zh: boolean): { tone: string; label: string } {
  if (state.demo) return { tone: 'demo', label: zh ? '演示模式' : 'Demo' };
  if (!state.credentials.configured) return { tone: 'off', label: zh ? '未配置' : 'Not configured' };
  if (!state.quota.snapshot) return { tone: 'off', label: zh ? '等待数据' : 'Waiting' };
  if (state.quota.stale || state.quota.error) return { tone: 'warn', label: zh ? '数据过期' : 'Stale' };
  const windows = state.quota.snapshot.windows;
  if (windows.some((window) => window.status === 'rate-limited')) return { tone: 'danger', label: zh ? '已限流' : 'Rate limited' };
  if (windows.some((window) => window.remainingPercent <= 5)) return { tone: 'danger', label: zh ? '接近上限' : 'Near limit' };
  if (windows.some((window) => window.remainingPercent <= 20)) return { tone: 'warn', label: zh ? '接近上限' : 'Near limit' };
  return { tone: 'good', label: zh ? '正常' : 'Normal' };
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>('overview');
  const [error, setError] = useState<string | null>(null);
  const isSettingsWindow = window.location.hash === '#settings';
  const now = useNow(1000);
  const theme = state?.settings.theme ?? 'system';
  useTheme(theme);

  useEffect(() => {
    let alive = true;
    void window.tokenMonitor
      .getState()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    const unsubscribe = window.tokenMonitor.onStateChanged((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const language = state?.settings.language ?? 'zh-CN';
  const t = useMemo(() => createTranslator(language), [language]);

  if (!state) {
    return error ? (
      <div className="app-bg" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="glass-card" style={{ padding: 20, maxWidth: 360, position: 'relative', zIndex: 1 }}>
          <div className="empty-title">TokenMonitor</div>
          <div className="empty-body">{error}</div>
        </div>
      </div>
    ) : (
      <Splash />
    );
  }

  if (isSettingsWindow) {
    return <SettingsPage state={state} t={t} language={language} />;
  }

  const openSettings = () => void window.tokenMonitor.openSettings();
  const refresh = () => void window.tokenMonitor.refreshQuota();
  const onboarding = !state.settings.onboardingCompleted && !state.credentials.configured;
  const status = statusOf(state, language === 'zh-CN');

  return (
    <div className="app-bg">
      <div className="panel-shell">
        <header className="titlebar drag">
          <BrandMark />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="brand-title">TokenMonitor</div>
            <div className="brand-sub">{t('app.subtitle')}</div>
          </div>
          <div className="no-drag" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`status-pill ${status.tone}`}>
              <span className="status-dot" />
              {status.label}
            </span>
            <IconButton icon={Settings2} label={t('common.settings')} onClick={openSettings} />
            <IconButton icon={X} label={t('common.hide')} onClick={() => void window.tokenMonitor.hideWindow()} className="subtle" />
          </div>
        </header>

        {!onboarding ? (
          <>
            <nav className="tabbar no-drag" aria-label="Main views">
              <button type="button" className={`tab ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}>
                <Gauge size={14} />
                {t('tabs.overview')}
              </button>
              <button type="button" className={`tab ${view === 'local' ? 'active' : ''}`} onClick={() => setView('local')}>
                <Database size={14} />
                {t('tabs.local')}
              </button>
              <button type="button" className={`tab ${view === 'speed' ? 'active' : ''}`} onClick={() => setView('speed')}>
                <Activity size={14} />
                {t('tabs.speed')}
              </button>
            </nav>
            <div className="panel-scroll">
              {view === 'overview' ? (
                <ProviderCard
                  state={state}
                  now={now}
                  language={language}
                  t={t}
                  onRetry={refresh}
                  onOpenSettings={openSettings}
                />
              ) : null}
              {view === 'local' ? (
                <LocalUsage state={state} language={language} t={t} onOpenSettings={openSettings} />
              ) : null}
              {view === 'speed' ? (
                <Speed state={state} language={language} t={t} onOpenSettings={openSettings} />
              ) : null}
            </div>
            <footer className="panel-footer">
              <span>
                {state.demo ? `${t('app.demo')} · ` : ''}
                {state.credentials.configured || state.demo
                  ? formatRelative(state.quota.fetchedAt, now, language)
                  : t('status.off')}
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={state.quota.loading || (!state.credentials.configured && !state.demo)}>
                {state.quota.loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
                {t('common.refresh')}
              </button>
            </footer>
          </>
        ) : (
          <div className="panel-scroll">
            <Onboarding state={state} t={t} onOpenSettings={openSettings} />
          </div>
        )}
      </div>
    </div>
  );
}
