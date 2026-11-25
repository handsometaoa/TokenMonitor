import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Boxes,
  Gauge,
  LayoutDashboard,
  Network,
  RefreshCw,
  ScrollText,
  Server,
  Settings2,
  X,
} from 'lucide-react';
import type { AppState } from '../../../shared/types';
import type {
  RouterProvider,
  RouterModelGroup,
  RouterQuotaStrategyInfo,
  RouterState,
} from '../../../shared/routerTypes';
import { BrandMark } from '../components/Logo';
import { createTranslator } from '../i18n';
import { PanelView } from '../views/Panel';
import { SettingsPage } from '../views/Settings';
import { RouterBadge } from './components';
import { Models } from './pages/Models';
import { Logs } from './pages/Logs';
import { Overview } from './pages/Overview';
import { Providers } from './pages/Providers';
import { Quota } from './pages/Quota';
import { RouterSettings } from './pages/RouterSettings';
import { ServicePage } from './pages/Service';
import { Usage } from './pages/Usage';
import './router.css';

type RouterPage = 'overview' | 'providers' | 'models' | 'service' | 'logs' | 'usage' | 'quota' | 'settings';

const NAV: Array<{ id: RouterPage; label: string; icon: typeof LayoutDashboard; sub: string }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard, sub: '路由状态与最近请求' },
  { id: 'providers', label: '提供商', icon: Server, sub: '上游端点、协议与凭证' },
  { id: 'models', label: '模型路由', icon: Boxes, sub: '对外模型与渠道组' },
  { id: 'service', label: '本地网关', icon: Network, sub: '端口、API Key 与接入示例' },
  { id: 'logs', label: '请求日志', icon: ScrollText, sub: '请求、响应与重试轨迹' },
  { id: 'usage', label: '用量统计', icon: BarChart3, sub: 'Token、缓存与成功率' },
  { id: 'quota', label: '余量', icon: Gauge, sub: '提供商额度与余额' },
  { id: 'settings', label: '路由设置', icon: Settings2, sub: '负载均衡与数据维护' },
];

export function RouterApp({ state }: { state: AppState }) {
  const [page, setPage] = useState<RouterPage>('overview');
  const [providers, setProviders] = useState<RouterProvider[]>([]);
  const [models, setModels] = useState<RouterModelGroup[]>([]);
  const [strategies, setStrategies] = useState<RouterQuotaStrategyInfo[]>([]);
  const [router, setRouter] = useState<RouterState>(state.router);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(!state.settings.onboardingCompleted);
  const language = state.settings.language;
  const t = useMemo(() => createTranslator(language), [language]);

  useEffect(() => {
    setRouter(state.router);
  }, [state.router]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextProviders, nextModels, nextStrategies, nextState] = await Promise.all([
        window.tokenMonitor.listRouterProviders(false),
        window.tokenMonitor.listRouterModels(false),
        window.tokenMonitor.getRouterQuotaStrategies(),
        window.tokenMonitor.getRouterState(),
      ]);
      setProviders(nextProviders);
      setModels(nextModels);
      setStrategies(nextStrategies);
      setRouter(nextState);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取路由配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = setInterval(() => {
      void window.tokenMonitor
        .getRouterState()
        .then((next) => setRouter(next))
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Tray / IPC navigation keeps everything in the single main window.
  useEffect(
    () =>
      window.tokenMonitor.onNavigate((target) => {
        setAppSettingsOpen(target === 'settings');
        if (target === 'panel') setPanelOpen(true);
        if (target === 'router') setPanelOpen(false);
      }),
    [],
  );

  const active = useMemo(() => NAV.find((item) => item.id === page) ?? NAV[0], [page]);
  const serviceRunning = router.service.state === 'running';

  const refreshQuota = () => {
    void window.tokenMonitor
      .refreshRouterQuota()
      .then(() => reload())
      .catch((reason) => setError(reason instanceof Error ? reason.message : '刷新余量失败'));
  };

  const openAppSettings = () => {
    setPanelOpen(false);
    setAppSettingsOpen(true);
  };

  if (appSettingsOpen) {
    return <SettingsPage state={state} t={t} language={language} onClose={() => setAppSettingsOpen(false)} />;
  }

  return (
    <div className="router-shell">
      <aside className="router-sidebar">
        <div className="router-brand">
          <BrandMark size={26} />
          <div>
            <div className="router-brand-title">TokenMonitor</div>
            <div className="router-brand-sub">AI Router</div>
          </div>
        </div>
        <nav className="router-nav">
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={`router-nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="router-sidebar-foot">
          <button type="button" className="router-sidebar-settings" onClick={openAppSettings}>
            <Settings2 size={15} />
            设置
          </button>
          <div className="router-service-line">
            <span className={`router-dot ${serviceRunning ? 'good' : router.service.state === 'error' ? 'danger' : 'warn'}`} />
            <span>{serviceRunning ? `127.0.0.1:${router.service.port}` : '网关未启动'}</span>
          </div>
          <div className="router-faint">v{state.version} · 本地优先</div>
        </div>
      </aside>

      <main className="router-main">
        <header className="router-header drag">
          <div>
            <div className="router-header-title">{active.label}</div>
            <div className="router-header-sub">{active.sub}</div>
          </div>
          <div className="router-header-actions no-drag">
            <RouterBadge tone={serviceRunning ? 'good' : router.service.state === 'error' ? 'danger' : 'warn'}>
              {serviceRunning ? '网关运行中' : router.service.state === 'error' ? '网关错误' : '网关已停止'}
            </RouterBadge>
            <button type="button" className="router-btn" onClick={() => void reload()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
              刷新
            </button>
            <button type="button" className="router-icon-btn" title="隐藏到托盘" onClick={() => void window.tokenMonitor.hideWindow()}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="router-content">
          {error ? (
            <div className="router-banner danger dismissible">
              <span>{error}</span>
              <button type="button" className="router-btn ghost sm" onClick={() => setError(null)}>
                关闭
              </button>
            </div>
          ) : null}

          {page === 'overview' ? (
            <Overview
              state={router}
              providers={providers}
              models={models}
              onNavigate={setPage}
              onError={setError}
            />
          ) : null}
          {page === 'providers' ? (
            <Providers initial={providers} strategies={strategies} onChanged={() => void reload()} />
          ) : null}
          {page === 'models' ? (
            <Models initial={models} providers={providers} onChanged={() => void reload()} />
          ) : null}
          {page === 'service' ? <ServicePage state={router} onChanged={() => void reload()} /> : null}
          {page === 'logs' ? <Logs onError={setError} /> : null}
          {page === 'usage' ? <Usage onError={setError} /> : null}
          {page === 'quota' ? <Quota quota={router.quota} state={state} onRefresh={refreshQuota} /> : null}
          {page === 'settings' ? <RouterSettings state={router} onChanged={() => void reload()} /> : null}
        </div>
      </main>

      {panelOpen ? (
        <>
          <div className="router-float-scrim" onClick={() => setPanelOpen(false)} />
          <aside className="router-float-panel" role="dialog" aria-label="Token 面板">
            <PanelView
              state={state}
              onOpenSettings={openAppSettings}
              onOpenRouter={() => setPanelOpen(false)}
              onClose={() => setPanelOpen(false)}
            />
          </aside>
        </>
      ) : (
        <button type="button" className="router-float-toggle no-drag" title="展开 Token 面板" onClick={() => setPanelOpen(true)}>
          <Gauge size={16} />
          <span>面板</span>
        </button>
      )}
    </div>
  );
}
