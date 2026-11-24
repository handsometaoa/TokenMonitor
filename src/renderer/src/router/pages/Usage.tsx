import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { RouterUsageGroup, RouterUsageOverview, RouterUsageRange } from '../../../../shared/routerTypes';
import { RouterStat, formatRouterDuration, formatRouterTokens } from '../components';

const RANGES: Array<{ value: RouterUsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

function UsageBars({ usage }: { usage: RouterUsageOverview }) {
  const max = useMemo(() => Math.max(1, ...usage.series.totalTokens), [usage]);
  return (
    <div className="router-bars" role="img" aria-label="tokens 趋势">
      {usage.series.totalTokens.map((value, index) => (
        <div className="router-bar-slot" key={usage.series.buckets[index]} title={`${usage.series.labels[index]} · ${formatRouterTokens(value)} tokens`}>
          <div className="router-bar" style={{ height: `${Math.max(2, (value / max) * 100)}%` }} />
        </div>
      ))}
      <div className="router-bars-labels">
        {usage.series.labels.map((label, index) =>
          index % Math.max(1, Math.ceil(usage.series.labels.length / 7)) === 0 || index === usage.series.labels.length - 1 ? (
            <span key={`${label}-${index}`}>{label}</span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function UsageTable({ title, rows }: { title: string; rows: RouterUsageGroup[] }) {
  return (
    <div className="router-card table">
      <div className="router-card-head compact">
        <div className="router-card-title">{title}</div>
      </div>
      <table className="router-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>请求</th>
            <th>成功率</th>
            <th>Tokens</th>
            <th>缓存</th>
            <th>平均耗时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="mono">{row.key || '—'}</td>
              <td>{row.requestCount}</td>
              <td>{row.requestCount > 0 ? `${((row.successCount / row.requestCount) * 100).toFixed(1)}%` : '—'}</td>
              <td className="mono">{formatRouterTokens(row.totalTokens)}</td>
              <td className="mono">{formatRouterTokens(row.cacheReadTokens)}</td>
              <td className="mono">{row.requestCount > 0 ? formatRouterDuration(row.durationMs / row.requestCount) : '—'}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6}>
                <div className="router-empty-inline">该区间没有数据。</div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function Usage({ onError }: { onError: (message: string) => void }) {
  const [range, setRange] = useState<RouterUsageRange>('7d');
  const [usage, setUsage] = useState<RouterUsageOverview | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (nextRange = range) => {
    setLoading(true);
    try {
      setUsage(await window.tokenMonitor.getRouterUsage(nextRange));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '读取用量失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const totals = usage?.totals;
  return (
    <div className="router-page">
      <div className="router-toolbar">
        <div className="router-toolbar-actions">
          <select className="router-select" value={range} onChange={(event) => setRange(event.target.value as RouterUsageRange)}>
            {RANGES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
          <button type="button" className="router-btn" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
            刷新
          </button>
        </div>
      </div>

      <div className="router-stats">
        <RouterStat label="请求数" value={totals ? totals.requestCount.toLocaleString() : '—'} hint={`失败 ${totals?.failCount ?? 0}`} />
        <RouterStat label="总 Tokens" value={totals ? formatRouterTokens(totals.totalTokens) : '—'} hint={`输入 ${formatRouterTokens(totals?.promptTokens ?? 0)} / 输出 ${formatRouterTokens(totals?.completionTokens ?? 0)}`} />
        <RouterStat
          label="成功率"
          value={totals && totals.requestCount > 0 ? `${((totals.successCount / totals.requestCount) * 100).toFixed(1)}%` : '—'}
          hint="HTTP 2xx"
          tone={totals && totals.requestCount > 0 && totals.successCount / totals.requestCount < 0.9 ? 'warn' : undefined}
        />
        <RouterStat
          label="平均耗时"
          value={totals && totals.requestCount > 0 ? formatRouterDuration(totals.durationMs / totals.requestCount) : '—'}
          hint={`缓存读 ${formatRouterTokens(totals?.cacheReadTokens ?? 0)}`}
        />
      </div>

      <div className="router-card">
        <div className="router-card-head compact">
          <div>
            <div className="router-card-title">Tokens 趋势</div>
            <div className="router-card-sub">{usage?.series.granularity === 'hour' ? '按小时' : '按天'}聚合</div>
          </div>
        </div>
        {usage ? <UsageBars usage={usage} /> : <div className="router-empty-inline">读取中…</div>}
      </div>

      <div className="router-two-col">
        <UsageTable title="按提供商" rows={usage?.providers ?? []} />
        <UsageTable title="按模型" rows={usage?.models ?? []} />
      </div>
    </div>
  );
}
