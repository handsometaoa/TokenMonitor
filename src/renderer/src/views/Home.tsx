import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Copy, Gauge, Network, RefreshCw, Server, Zap } from 'lucide-react';
import type { AppState, Language } from '../../../shared/types';
import type { RouterLogPage, RouterUsageOverview } from '../../../shared/routerTypes';
import { LineChart, type LineSeries } from '../components/LineChart';
import { Spinner } from '../components/ui';
import { formatDuration, formatTokens } from '../format';

interface HomeQuota {
  key: string;
  name: string;
  remaining: number | null;
  detail: string;
  tone: 'good' | 'warn' | 'danger' | 'neutral';
}

const COPY = {
  'zh-CN': {
    router: 'AI Router 本地网关',
    running: '运行中',
    stopped: '已停止',
    error: '异常',
    port: '端口 {port}',
    channels: '{n} 个渠道',
    quotas: '{n} 个 Provider',
    requests: '{n} 次请求',
    todayRequests: '今日请求',
    todayTokens: '今日 Tokens',
    success: '成功率',
    openConsole: '打开路由控制台',
    copy: '复制地址',
    copied: '已复制',
    quota: '余量概览',
    manage: '管理',
    remaining: '剩余',
    balance: '余额',
    noQuota: '还没有可展示的余量',
    noQuotaHint: '在路由控制台绑定提供商余量策略，或在设置中连接 OpenCode / Codex 等 Provider。',
    trend: '近 7 天 Tokens',
    noUsage: '近 7 天还没有路由请求',
    recent: '最近请求',
    all: '全部',
    noRequests: '还没有路由请求',
    noRequestsHint: '配置提供商和模型渠道并启动网关后，请求会出现在这里。',
    emptyTitle: '开始使用 AI Router',
    emptyBody: '添加提供商和模型渠道，启动本地网关后，客户端即可通过统一地址调用。',
    emptyAction: '打开路由控制台',
    never: '未查询',
    notConfigured: '未配置',
    low: '余量偏低',
    startHint: '网关未启动，客户端暂时无法调用。',
    refresh: '刷新',
  },
  en: {
    router: 'AI Router gateway',
    running: 'Running',
    stopped: 'Stopped',
    error: 'Error',
    port: 'Port {port}',
    channels: '{n} channels',
    quotas: '{n} providers',
    requests: '{n} requests',
    todayRequests: 'Requests today',
    todayTokens: 'Tokens today',
    success: 'Success rate',
    openConsole: 'Open router console',
    copy: 'Copy URL',
    copied: 'Copied',
    quota: 'Quota overview',
    manage: 'Manage',
    remaining: 'left',
    balance: 'Balance',
    noQuota: 'No quota to show yet',
    noQuotaHint: 'Bind a quota strategy in the router console, or connect OpenCode / Codex in settings.',
    trend: 'Tokens · last 7 days',
    noUsage: 'No router requests in the last 7 days',
    recent: 'Recent requests',
    all: 'All',
    noRequests: 'No router requests yet',
    noRequestsHint: 'Add a provider and model channel, start the gateway, and requests will appear here.',
    emptyTitle: 'Get started with AI Router',
    emptyBody: 'Add providers and model channels, start the local gateway, and point any supported client at it.',
    emptyAction: 'Open router console',
    never: 'Never queried',
    notConfigured: 'Not configured',
    low: 'Quota low',
    startHint: 'The gateway is stopped; clients cannot connect yet.',
    refresh: 'Refresh',
  },
} as const;

function lowestRemaining(windows: Array<{ usedPercent: number }>): number | null {
  if (windows.length === 0) return null;
  return Math.min(...windows.map((window) => Math.max(0, 100 - window.usedPercent)));
}

function toneFor(remaining: number | null): HomeQuota['tone'] {
  if (remaining === null) return 'neutral';
  if (remaining <= 10) return 'danger';
  if (remaining <= 30) return 'warn';
  return 'good';
}

function fill(template: string, vars: Record<string, string | number>): string {
  let value = template;
  for (const [key, replacement] of Object.entries(vars)) value = value.replaceAll(`{${key}}`, String(replacement));
  return value;
}

export function Home({
  state,
  language,
  onOpenQuota,
}: {
  state: AppState;
  language: Language;
  onOpenQuota: () => void;
}) {
  const copy = COPY[language];
  const [usage, setUsage] = useState<RouterUsageOverview | null>(null);
  const [todayUsage, setTodayUsage] = useState<RouterUsageOverview | null>(null);
  const [logs, setLogs] = useState<RouterLogPage>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextUsage, nextToday, nextLogs] = await Promise.all([
        window.tokenMonitor.getRouterUsage('7d'),
        window.tokenMonitor.getRouterUsage('today'),
        window.tokenMonitor.getRouterLogs({ limit: 4 }),
      ]);
      setUsage(nextUsage);
      setTodayUsage(nextToday);
      setLogs(nextLogs);
    } catch {
      // The router is optional; keep the monitoring views usable if it is unavailable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const router = state.router;
  const running = router.service.state === 'running';
  const today = todayUsage
    ? {
        requests: todayUsage.totals.requestCount,
        tokens: todayUsage.totals.totalTokens,
        successRate:
          todayUsage.totals.requestCount > 0
            ? (todayUsage.totals.successCount / todayUsage.totals.requestCount) * 100
            : null,
      }
    : router.usageToday;
  const baseUrl = `http://127.0.0.1:${router.service.port}/v1`;

  const quotas = useMemo<HomeQuota[]>(() => {
    const items: HomeQuota[] = [];
    const openCode = state.quota.snapshot;
    if (openCode) {
      const remaining = lowestRemaining(openCode.windows);
      items.push({
        key: 'opencode',
        name: 'OpenCode Go',
        remaining,
        detail: openCode.planLabel,
        tone: toneFor(remaining),
      });
    }
    for (const provider of state.extraProviders) {
      if (!provider.snapshot) continue;
      const remaining = lowestRemaining(provider.snapshot.windows);
      items.push({
        key: `extra:${provider.providerId}`,
        name: provider.providerName,
        remaining,
        detail: provider.snapshot.planLabel,
        tone: toneFor(remaining),
      });
    }
    for (const item of router.quota) {
      if (item.windows.length > 0) {
        const remaining = lowestRemaining(item.windows);
        items.push({
          key: `router:${item.providerId}`,
          name: item.providerName,
          remaining,
          detail: item.strategyLabel ?? item.strategyId ?? '',
          tone: toneFor(remaining),
        });
      } else if (item.balance !== null) {
        items.push({
          key: `router:${item.providerId}`,
          name: item.providerName,
          remaining: null,
          detail: `${copy.balance} ${item.balance.toFixed(2)} ${item.currency ?? ''}`.trim(),
          tone: item.balance <= 0 ? 'danger' : 'neutral',
        });
      }
    }
    return items
      .sort((a, b) => {
        if (a.remaining === null && b.remaining === null) return a.name.localeCompare(b.name);
        if (a.remaining === null) return 1;
        if (b.remaining === null) return -1;
        return a.remaining - b.remaining;
      })
      .slice(0, 6);
  }, [state.quota.snapshot, state.extraProviders, router.quota, copy.balance]);

  const series: LineSeries[] = usage
    ? [
        {
          key: 'router-tokens',
          label: 'Tokens',
          color: '#2F6BFF',
          points: usage.series.buckets.map((day, index) => ({ day, value: usage.series.totalTokens[index] ?? 0 })),
        },
      ]
    : [];
  const hasUsage = Boolean(usage && usage.totals.requestCount > 0);
  const hasRouterSetup = router.channelHealth.length > 0 || router.quota.length > 0;

  const openRouter = () => void window.tokenMonitor.openRouterWindow();

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section className={`home-hero ${running ? 'running' : ''}`}>
        <div className="home-hero-head">
          <div className="home-hero-icon">
            <Network size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="home-hero-title">{copy.router}</div>
            <div className="home-hero-sub">
              {running
                ? `${fill(copy.port, { port: router.service.port })} · ${fill(copy.channels, { n: router.channelHealth.length })}`
                : copy.startHint}
            </div>
          </div>
          <span className={`status-pill ${running ? 'good' : router.service.state === 'error' ? 'danger' : 'off'}`}>
            <span className="status-dot" />
            {running ? copy.running : router.service.state === 'error' ? copy.error : copy.stopped}
          </span>
        </div>
        <div className="home-hero-metrics">
          <div>
            <strong className="mono">{today.requests}</strong>
            <span>{copy.todayRequests}</span>
          </div>
          <div>
            <strong className="mono">{formatTokens(today.tokens)}</strong>
            <span>{copy.todayTokens}</span>
          </div>
          <div>
            <strong className="mono">
              {today.successRate === null ? '—' : `${today.successRate.toFixed(1)}%`}
            </strong>
            <span>{copy.success}</span>
          </div>
        </div>
        <div className="home-hero-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={openRouter}>
            <Zap size={13} />
            {copy.openConsole}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              void navigator.clipboard.writeText(baseUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={13} />
            {copied ? copy.copied : copy.copy}
          </button>
          <button type="button" className="icon-btn" onClick={() => void load()} title={copy.refresh} disabled={loading}>
            {loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
          </button>
        </div>
      </section>

      <section className="glass-card home-quota-card">
        <div className="home-section-head">
          <div>
            <div className="home-section-title">{copy.quota}</div>
            <div className="home-section-sub">
              {quotas.length > 0 ? fill(copy.quotas, { n: quotas.length }) : copy.noQuota}
            </div>
          </div>
          <button type="button" className="home-link" onClick={onOpenQuota}>
            {copy.manage} <ArrowRight size={12} />
          </button>
        </div>
        {quotas.length === 0 ? (
          <div className="home-empty-inline">{copy.noQuotaHint}</div>
        ) : (
          <div className="home-quota-list">
            {quotas.map((quota) => (
              <button type="button" className="home-quota-row" key={quota.key} onClick={onOpenQuota}>
                <div className="home-quota-main">
                  <div className="home-quota-name">
                    <span className={`home-quota-dot ${quota.tone}`} />
                    <strong>{quota.name}</strong>
                    <span>{quota.detail}</span>
                  </div>
                  <div className="home-quota-track">
                    <div
                      className={`home-quota-fill ${quota.tone}`}
                      style={{ width: `${quota.remaining === null ? 0 : Math.max(2, quota.remaining)}%` }}
                    />
                  </div>
                </div>
                <div className={`home-quota-value ${quota.tone}`}>
                  {quota.remaining === null ? quota.detail : `${quota.remaining.toFixed(0)}%`}
                  {quota.remaining !== null ? <span>{copy.remaining}</span> : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="glass-card home-trend-card">
        <div className="home-section-head">
          <div>
            <div className="home-section-title">{copy.trend}</div>
            <div className="home-section-sub">
              {usage ? `${fill(copy.requests, { n: usage.totals.requestCount })} · ${formatTokens(usage.totals.totalTokens)} tokens` : '—'}
            </div>
          </div>
        </div>
        {hasUsage ? (
          <LineChart series={series} language={language} height={150} unit=" tokens" digits={0} />
        ) : (
          <div className="home-empty-inline">{copy.noUsage}</div>
        )}
      </section>

      <section className="glass-card home-recent-card">
        <div className="home-section-head">
          <div>
            <div className="home-section-title">{copy.recent}</div>
            <div className="home-section-sub">{logs.total > 0 ? `${logs.total} ${language === 'zh-CN' ? '条' : 'total'}` : copy.noRequests}</div>
          </div>
          <button type="button" className="home-link" onClick={openRouter}>
            {copy.all} <ArrowRight size={12} />
          </button>
        </div>
        {logs.items.length === 0 ? (
          <div className="home-empty-inline">{hasRouterSetup ? copy.noRequestsHint : copy.emptyBody}</div>
        ) : (
          <div className="home-request-list">
            {logs.items.map((entry) => (
              <div className="home-request-row" key={entry.id}>
                <span className={`home-request-status ${entry.status === null ? '' : entry.status < 300 ? 'good' : entry.status < 500 ? 'warn' : 'danger'}`} />
                <div className="home-request-main">
                  <strong>{entry.publicModel}</strong>
                  <span>{entry.providerName} · {new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="home-request-meta mono">
                  <span>{entry.status ?? '…'}</span>
                  <span>{formatDuration(entry.durationMs)}</span>
                  <span>{formatTokens(entry.totalTokens)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {!hasRouterSetup && !running ? (
        <div className="home-cta">
          <Server size={16} />
          <div>
            <strong>{copy.emptyTitle}</strong>
            <span>{copy.emptyBody}</span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={openRouter}>
            {copy.emptyAction}
          </button>
        </div>
      ) : null}

      <div className="hint" style={{ padding: '0 4px', lineHeight: 1.55 }}>
        <Gauge size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
        {language === 'zh-CN'
          ? '总览聚合网关状态、路由用量和所有 Provider 余量；OpenCode 本地统计与 TTFT 仍保留在独立页。'
          : 'Overview combines gateway status, routed usage and all provider quotas; OpenCode local stats and TTFT stay on their own tabs.'}
      </div>
    </div>
  );
}
