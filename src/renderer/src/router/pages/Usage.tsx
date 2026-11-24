import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  RouterActivityDay,
  RouterClientProviderFlow,
  RouterUsageGroup,
  RouterUsageOverview,
  RouterUsageRange,
} from '../../../../shared/routerTypes';
import { RouterStat, formatRouterDuration, formatRouterTokens } from '../components';

const RANGES: Array<{ value: RouterUsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

const ACTIVITY_DAYS = 90;
const FLOW_DAYS = 7;
const FLOW_OTHER = '\u0000other';
const FLOW_COLORS = ['var(--accent)', 'var(--accent-2)', '#14b8a6', '#d97706', '#ec4899', '#0891b2', '#16a34a', '#f472b6'];

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
            <th>TTFT</th>
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
              <td className="mono">{row.ttftSamples > 0 ? formatRouterDuration(row.ttftMs / row.ttftSamples) : '—'}</td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={7}>
                <div className="router-empty-inline">该区间没有数据。</div>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function ActivityHeatmap({ days }: { days: RouterActivityDay[] }) {
  const weeks = useMemo(() => {
    const result: Array<Array<RouterActivityDay | null>> = [];
    if (days.length === 0) return result;
    const first = new Date(`${days[0].date}T00:00:00`);
    const leading = Number.isNaN(first.getTime()) ? 0 : (first.getDay() + 6) % 7;
    let current: Array<RouterActivityDay | null> = new Array(leading).fill(null);
    for (const day of days) {
      current.push(day);
      if (current.length >= 7) {
        result.push(current);
        current = [];
      }
    }
    if (current.length > 0) {
      while (current.length < 7) current.push(null);
      result.push(current);
    }
    return result;
  }, [days]);

  const levelOf = useMemo(() => {
    const max = Math.max(1, ...days.map((day) => day.requestCount));
    const step = max / 4;
    return (count: number) => (count <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(count / step))));
  }, [days]);

  const monthLabels = useMemo(() => {
    let previous: number | null = null;
    return weeks.map((week) => {
      const first = week.find((day): day is RouterActivityDay => Boolean(day));
      if (!first) return '';
      const month = Number(first.date.slice(5, 7));
      if (month === previous) return '';
      previous = month;
      return `${month}月`;
    });
  }, [weeks]);

  const summary = useMemo(
    () =>
      days.reduce(
        (acc, day) => ({
          activeDays: acc.activeDays + (day.requestCount > 0 ? 1 : 0),
          requests: acc.requests + day.requestCount,
          tokens: acc.tokens + day.totalTokens,
        }),
        { activeDays: 0, requests: 0, tokens: 0 },
      ),
    [days],
  );

  return (
    <div className="router-heat-layout">
      <div className="router-heatmap">
        <div className="router-heat-weekdays" aria-hidden="true">
          {['一', '', '三', '', '五', '', ''].map((label, index) => (
            <span key={index}>{label}</span>
          ))}
        </div>
        <div>
          <div className="router-heat-months" aria-hidden="true">
            {monthLabels.map((label, index) => (
              <span key={index}>{label}</span>
            ))}
          </div>
          <div className="router-heat-grid" role="img" aria-label={`近 ${days.length} 天请求活跃度`}>
            {weeks.map((week, weekIndex) =>
              week.map((day, dayIndex) =>
                day ? (
                  <div
                    key={day.date}
                    className={`router-heat-cell level-${levelOf(day.requestCount)}`}
                    title={`${day.date} · ${day.requestCount} 次请求 · ${formatRouterTokens(day.totalTokens)} tokens`}
                  />
                ) : (
                  <div key={`empty-${weekIndex}-${dayIndex}`} className="router-heat-cell empty" aria-hidden="true" />
                ),
              ),
            )}
          </div>
        </div>
      </div>
      <div className="router-heat-summary">
        <div>
          <strong>{summary.activeDays}</strong>
          <span>活跃天数</span>
        </div>
        <div>
          <strong>{summary.requests.toLocaleString()}</strong>
          <span>90 天请求</span>
        </div>
        <div>
          <strong>{formatRouterTokens(summary.tokens)}</strong>
          <span>90 天 Tokens</span>
        </div>
      </div>
    </div>
  );
}

interface FlowNode {
  key: string;
  label: string;
  total: number;
}

interface FlowLink {
  client: string;
  provider: string;
  count: number;
}

interface FlowModel {
  clients: FlowNode[];
  providers: FlowNode[];
  links: FlowLink[];
}

function flowLabel(key: string): string {
  if (key === FLOW_OTHER) return '其他';
  if (key === 'unknown') return '未知';
  return key;
}

function truncateFlowLabel(value: string, max = 16): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildFlowModel(rows: RouterClientProviderFlow[]): FlowModel {
  const clientTotals = new Map<string, number>();
  const providerTotals = new Map<string, number>();
  for (const row of rows) {
    clientTotals.set(row.client, (clientTotals.get(row.client) ?? 0) + row.requestCount);
    providerTotals.set(row.providerName, (providerTotals.get(row.providerName) ?? 0) + row.requestCount);
  }
  const pickTop = (totals: Map<string, number>) =>
    new Set(
      [...totals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([key]) => key),
    );
  const topClients = pickTop(clientTotals);
  const topProviders = pickTop(providerTotals);
  const clientKey = (value: string) => (topClients.has(value) ? value : FLOW_OTHER);
  const providerKey = (value: string) => (topProviders.has(value) ? value : FLOW_OTHER);

  const merged = new Map<string, FlowLink>();
  for (const row of rows) {
    const client = clientKey(row.client);
    const provider = providerKey(row.providerName);
    const key = `${client}\u0000${provider}`;
    const link = merged.get(key);
    if (link) link.count += row.requestCount;
    else merged.set(key, { client, provider, count: row.requestCount });
  }

  const toNodes = (totals: Map<string, number>, mapKey: (value: string) => string): FlowNode[] => {
    const grouped = new Map<string, number>();
    for (const [key, total] of totals) {
      const mapped = mapKey(key);
      grouped.set(mapped, (grouped.get(mapped) ?? 0) + total);
    }
    return [...grouped.entries()]
      .map(([key, total]) => ({ key, label: flowLabel(key), total }))
      .sort((a, b) => b.total - a.total);
  };

  return {
    clients: toNodes(clientTotals, clientKey),
    providers: toNodes(providerTotals, providerKey),
    links: [...merged.values()].sort((a, b) => b.count - a.count),
  };
}

const FLOW_WIDTH = 880;
const FLOW_LABEL_WIDTH = 172;
const FLOW_NODE_WIDTH = 12;
const FLOW_PADDING_Y = 12;
const FLOW_NODE_GAP = 16;

function buildFlowGeometry(model: FlowModel) {
  if (model.links.length === 0) return null;
  const total = model.links.reduce((sum, link) => sum + link.count, 0);
  const nodeCount = Math.max(model.clients.length, model.providers.length, 1);
  const content = Math.max(150, nodeCount * 30);
  const scale = total > 0 ? content / total : 0;
  const heightsOf = (nodes: FlowNode[]) => nodes.map((node) => Math.max(8, node.total * scale));
  const clientHeights = heightsOf(model.clients);
  const providerHeights = heightsOf(model.providers);
  const sideHeight = (heights: number[]) =>
    heights.reduce((sum, height) => sum + height, 0) + FLOW_NODE_GAP * Math.max(0, heights.length - 1);
  const height = FLOW_PADDING_Y * 2 + Math.max(sideHeight(clientHeights), sideHeight(providerHeights));

  const layout = (nodes: FlowNode[], heights: number[]) => {
    let cursor = FLOW_PADDING_Y;
    return nodes.map((node, index) => {
      const item = { ...node, y: cursor, height: heights[index] };
      cursor += heights[index] + FLOW_NODE_GAP;
      return item;
    });
  };
  const clients = layout(model.clients, clientHeights);
  const providers = layout(model.providers, providerHeights);
  const leftX = FLOW_LABEL_WIDTH;
  const rightX = FLOW_WIDTH - FLOW_LABEL_WIDTH - FLOW_NODE_WIDTH;
  const startX = leftX + FLOW_NODE_WIDTH;
  const endX = rightX;
  const linksByKey = new Map(model.links.map((link) => [`${link.client}\u0000${link.provider}`, link]));
  const clientCursors = new Map(clients.map((node) => [node.key, node.y]));
  const providerCursors = new Map(providers.map((node) => [node.key, node.y]));
  const ribbons: Array<{
    key: string;
    d: string;
    width: number;
    color: string;
    client: string;
    provider: string;
    count: number;
  }> = [];

  clients.forEach((client, clientIndex) => {
    const color = FLOW_COLORS[clientIndex % FLOW_COLORS.length];
    for (const provider of providers) {
      const link = linksByKey.get(`${client.key}\u0000${provider.key}`);
      if (!link) continue;
      const y1 = clientCursors.get(client.key) ?? client.y;
      const y2 = providerCursors.get(provider.key) ?? provider.y;
      const allocated = link.count * scale;
      const width = Math.max(1.4, allocated);
      const control = (endX - startX) * 0.4;
      ribbons.push({
        key: `${client.key}\u0000${provider.key}`,
        d: `M ${startX} ${y1 + width / 2} C ${startX + control} ${y1 + width / 2}, ${endX - control} ${y2 + width / 2}, ${endX} ${y2 + width / 2}`,
        width,
        color,
        client: client.label,
        provider: provider.label,
        count: link.count,
      });
      clientCursors.set(client.key, y1 + allocated);
      providerCursors.set(provider.key, y2 + allocated);
    }
  });

  return { width: FLOW_WIDTH, height, clients, providers, ribbons, leftX, rightX };
}

function ClientProviderFlowChart({ rows }: { rows: RouterClientProviderFlow[] }) {
  const model = useMemo(() => buildFlowModel(rows), [rows]);
  const geometry = useMemo(() => buildFlowGeometry(model), [model]);

  if (!geometry) {
    return <div className="router-empty-inline">近 7 天还没有请求记录。</div>;
  }

  return (
    <svg
      className="router-flow-svg"
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
      role="img"
      aria-label="Agent 客户端到提供商的请求流向"
    >
      {geometry.ribbons.map((ribbon) => (
        <path
          key={ribbon.key}
          className="router-flow-link"
          d={ribbon.d}
          fill="none"
          stroke={ribbon.color}
          strokeWidth={ribbon.width}
          strokeOpacity={0.32}
          strokeLinecap="butt"
        >
          <title>{`${ribbon.client} → ${ribbon.provider} · ${ribbon.count} 次请求`}</title>
        </path>
      ))}
      {geometry.clients.map((node, index) => (
        <g key={`client-${node.key}`}>
          <rect
            x={geometry.leftX}
            y={node.y}
            width={FLOW_NODE_WIDTH}
            height={Math.max(3, node.height)}
            rx={3}
            fill={FLOW_COLORS[index % FLOW_COLORS.length]}
          />
          <text
            x={geometry.leftX - 8}
            y={node.y + node.height / 2}
            textAnchor="end"
            dominantBaseline="middle"
            className="router-flow-label"
          >
            {truncateFlowLabel(node.label)} · {node.total}
          </text>
        </g>
      ))}
      {geometry.providers.map((node, index) => (
        <g key={`provider-${node.key}`}>
          <rect
            x={geometry.rightX}
            y={node.y}
            width={FLOW_NODE_WIDTH}
            height={Math.max(3, node.height)}
            rx={3}
            fill={FLOW_COLORS[(index + 3) % FLOW_COLORS.length]}
          />
          <text
            x={geometry.rightX + FLOW_NODE_WIDTH + 8}
            y={node.y + node.height / 2}
            textAnchor="start"
            dominantBaseline="middle"
            className="router-flow-label"
          >
            {truncateFlowLabel(node.label)} · {node.total}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function Usage({ onError }: { onError: (message: string) => void }) {
  const [range, setRange] = useState<RouterUsageRange>('7d');
  const [usage, setUsage] = useState<RouterUsageOverview | null>(null);
  const [activity, setActivity] = useState<RouterActivityDay[] | null>(null);
  const [flow, setFlow] = useState<RouterClientProviderFlow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [chartsLoading, setChartsLoading] = useState(false);

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

  const loadCharts = async () => {
    setChartsLoading(true);
    try {
      const [activityData, flowData] = await Promise.all([
        window.tokenMonitor.getRouterActivity(ACTIVITY_DAYS),
        window.tokenMonitor.getRouterFlow(FLOW_DAYS),
      ]);
      setActivity(activityData);
      setFlow(flowData);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '读取活动图表失败');
    } finally {
      setChartsLoading(false);
    }
  };

  useEffect(() => {
    void load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => {
    void loadCharts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <button
            type="button"
            className="router-btn"
            onClick={() => {
              void load();
              void loadCharts();
            }}
            disabled={loading || chartsLoading}
          >
            <RefreshCw size={14} className={loading || chartsLoading ? 'spin' : ''} />
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
          label="平均 TTFT"
          value={totals && totals.ttftSamples > 0 ? formatRouterDuration(totals.ttftMs / totals.ttftSamples) : '—'}
          hint={`首 token 延迟 · ${totals?.ttftSamples ?? 0} 个样本`}
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
            <div className="router-card-title">活跃度</div>
            <div className="router-card-sub">近 90 天每日请求 · 悬停查看明细</div>
          </div>
          <div className="router-heat-legend" aria-hidden="true">
            <span>少</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className={`router-heat-cell level-${level}`} />
            ))}
            <span>多</span>
          </div>
        </div>
        {activity ? <ActivityHeatmap days={activity} /> : <div className="router-empty-inline">读取中…</div>}
      </div>

      <div className="router-card">
        <div className="router-card-head compact">
          <div>
            <div className="router-card-title">Agent → 提供商流向</div>
            <div className="router-card-sub">近 7 天请求分布 · 左侧为客户端，右侧为提供商</div>
          </div>
        </div>
        {flow ? <ClientProviderFlowChart rows={flow} /> : <div className="router-empty-inline">读取中…</div>}
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
