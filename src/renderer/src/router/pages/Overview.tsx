import { useEffect, useState } from 'react';
import { ArrowRight, Boxes, Network, Server, Settings2 } from 'lucide-react';
import type {
  RouterLogPage,
  RouterModelGroup,
  RouterProvider,
  RouterState,
  RouterUsageOverview,
} from '../../../../shared/routerTypes';
import { RouterBadge, RouterStat, formatRouterDuration, formatRouterTime, statusTone } from '../components';

export function Overview({
  state,
  providers,
  models,
  onNavigate,
  onError,
}: {
  state: RouterState;
  providers: RouterProvider[];
  models: RouterModelGroup[];
  onNavigate: (page: 'providers' | 'models' | 'service' | 'logs' | 'usage' | 'quota' | 'settings') => void;
  onError: (message: string) => void;
}) {
  const [logs, setLogs] = useState<RouterLogPage>({ items: [], total: 0 });
  const [usage, setUsage] = useState<RouterUsageOverview | null>(null);

  const load = async () => {
    try {
      const [logPage, usageToday] = await Promise.all([
        window.tokenMonitor.getRouterLogs({ limit: 6 }),
        window.tokenMonitor.getRouterUsage('today'),
      ]);
      setLogs(logPage);
      setUsage(usageToday);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '读取概览失败');
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalChannels = models.reduce((sum, group) => sum + group.totalCount, 0);
  const enabledChannels = models.reduce((sum, group) => sum + group.enabledCount, 0);
  const serviceRunning = state.service.state === 'running';

  return (
    <div className="router-page">
      <div className="router-stats">
        <RouterStat
          label="网关"
          value={serviceRunning ? '运行中' : state.service.state === 'error' ? '错误' : '已停止'}
          hint={serviceRunning ? `127.0.0.1:${state.service.port}` : state.service.error ?? '未启动'}
          tone={serviceRunning ? 'good' : state.service.state === 'error' ? 'danger' : undefined}
        />
        <RouterStat label="今日请求" value={usage ? usage.totals.requestCount.toLocaleString() : '—'} hint={`失败 ${usage?.totals.failCount ?? 0}`} />
        <RouterStat label="今日 Tokens" value={usage ? usage.totals.totalTokens.toLocaleString() : '—'} hint={`缓存读 ${usage?.totals.cacheReadTokens.toLocaleString() ?? 0}`} />
        <RouterStat
          label="成功率"
          value={usage && usage.totals.requestCount > 0 ? `${((usage.totals.successCount / usage.totals.requestCount) * 100).toFixed(1)}%` : '—'}
          hint="今日 HTTP 2xx"
          tone={usage && usage.totals.requestCount > 0 && usage.totals.successCount / usage.totals.requestCount < 0.9 ? 'warn' : undefined}
        />
      </div>

      <div className="router-two-col">
        <div className="router-card">
          <div className="router-card-head compact">
            <div>
              <div className="router-card-title">接入状态</div>
              <div className="router-card-sub">提供商 / 模型渠道 / 网关</div>
            </div>
            <Network size={18} />
          </div>
          <div className="router-checklist">
            <button type="button" className="router-checklist-row" onClick={() => onNavigate('providers')}>
              <span className={`router-dot ${providers.length > 0 ? 'good' : 'warn'}`} />
              <div>
                <strong>提供商</strong>
                <span>{providers.length} 个已配置 · {providers.filter((provider) => provider.hasKey).length} 个有凭证</span>
              </div>
              <ArrowRight size={14} />
            </button>
            <button type="button" className="router-checklist-row" onClick={() => onNavigate('models')}>
              <span className={`router-dot ${enabledChannels > 0 ? 'good' : 'warn'}`} />
              <div>
                <strong>模型渠道</strong>
                <span>{models.length} 个对外模型 · {enabledChannels}/{totalChannels} 渠道启用</span>
              </div>
              <ArrowRight size={14} />
            </button>
            <button type="button" className="router-checklist-row" onClick={() => onNavigate('service')}>
              <span className={`router-dot ${serviceRunning ? 'good' : 'warn'}`} />
              <div>
                <strong>本地网关</strong>
                <span>{serviceRunning ? `http://127.0.0.1:${state.service.port}/v1` : '点击启动并查看接入示例'}</span>
              </div>
              <ArrowRight size={14} />
            </button>
            <button type="button" className="router-checklist-row" onClick={() => onNavigate('settings')}>
              <span className={`router-dot ${state.balance.enabled ? 'good' : ''}`} />
              <div>
                <strong>负载均衡</strong>
                <span>{state.balance.enabled ? `开启 · 最多 ${state.balance.maxAttempts} 次尝试` : '单渠道直连'}</span>
              </div>
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="router-quick-actions">
            <button type="button" className="router-btn sm" onClick={() => onNavigate('providers')}>
              <Server size={13} /> 添加提供商
            </button>
            <button type="button" className="router-btn sm" onClick={() => onNavigate('models')}>
              <Boxes size={13} /> 配置模型
            </button>
            <button type="button" className="router-btn sm" onClick={() => onNavigate('settings')}>
              <Settings2 size={13} /> 路由设置
            </button>
          </div>
        </div>

        <div className="router-card">
          <div className="router-card-head compact">
            <div>
              <div className="router-card-title">渠道健康</div>
              <div className="router-card-sub">可用度即选路权重；额度耗尽会被前置拦截。</div>
            </div>
            <RouterBadge tone={state.channelHealth.some((item) => item.state === 'blocked') ? 'danger' : 'good'}>
              {state.channelHealth.length} 渠道
            </RouterBadge>
          </div>
          <div className="router-health-list">
            {state.channelHealth.map((item) => (
              <div className="router-health-row" key={item.providerId}>
                <div className="router-health-main">
                  <strong>{item.providerName}</strong>
                  <span>{item.blockReason ?? item.lastError ?? '正常'}</span>
                </div>
                <div className="router-health-right">
                  <span className={`router-dot ${item.state === 'healthy' ? 'good' : item.state === 'degraded' ? 'warn' : 'danger'}`} />
                  <span className="mono">{item.availability}</span>
                </div>
              </div>
            ))}
            {state.channelHealth.length === 0 ? <div className="router-empty-inline">还没有提供商。</div> : null}
          </div>
          <button type="button" className="router-link-btn" onClick={() => onNavigate('quota')}>
            查看余量详情 <ArrowRight size={13} />
          </button>
        </div>
      </div>

      <div className="router-card table">
        <div className="router-card-head compact">
          <div>
            <div className="router-card-title">最近请求</div>
            <div className="router-card-sub">点击日志页查看完整请求与响应。</div>
          </div>
          <button type="button" className="router-link-btn" onClick={() => onNavigate('logs')}>
            全部日志 <ArrowRight size={13} />
          </button>
        </div>
        <table className="router-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>渠道</th>
              <th>状态</th>
              <th>耗时</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {logs.items.map((entry) => (
              <tr key={entry.id}>
                <td className="mono">{formatRouterTime(entry.startedAt)}</td>
                <td className="mono">{entry.publicModel}</td>
                <td>{entry.providerName}</td>
                <td>
                  <RouterBadge tone={statusTone(entry.status)}>{entry.status ?? '进行中'}</RouterBadge>
                </td>
                <td className="mono">{formatRouterDuration(entry.durationMs)}</td>
                <td className="mono">{entry.totalTokens.toLocaleString()}</td>
              </tr>
            ))}
            {logs.items.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="router-empty-inline">还没有请求。完成服务与模型配置后，用任意 OpenAI/Anthropic 客户端调用本地网关。</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
