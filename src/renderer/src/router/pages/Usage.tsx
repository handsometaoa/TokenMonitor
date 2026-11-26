import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  RouterActivityDay,
  RouterClientProviderFlow,
  RouterUsageBreakdown,
  RouterUsageGroup,
  RouterUsageOverview,
  RouterUsageRange,
} from '../../../../shared/routerTypes';
import { RouterBadge, RouterStat, formatRouterDuration, formatRouterTokens } from '../components';
import { isRouterUsageRange } from '../../../../shared/routerSchemas';

const RANGES: Array<{ value: RouterUsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近一个月' },
  { value: '1y', label: '近一年' },
];

const RANGE_STORAGE_KEY = 'tokenmonitor.usage.range';

function storedRange(): RouterUsageRange {
  try {
    const value = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return isRouterUsageRange(value) ? value : '7d';
  } catch {
    return '7d';
  }
}

const ACTIVITY_DAYS = 90;
const FLOW_DAYS = 7;
const FLOW_OTHER = '\u0000other';
const FLOW_COLORS = ['var(--accent)', 'var(--accent-2)', '#14b8a6', '#d97706', '#ec4899', '#0891b2', '#16a34a', '#f472b6'];

const BREAKDOWN_META: Array<{ key: keyof RouterUsageBreakdown; label: string; color: string }> = [
  { key: 'system', label: '系统提示词', color: '#5b8def' },
  { key: 'tools', label: '工具定义', color: '#f59e0b' },
  { key: 'user', label: '用户消息', color: '#22c55e' },
  { key: 'toolResults', label: '工具调用结果', color: '#14b8a6' },
  { key: 'assistant', label: '注入历史', color: '#8b5cf6' },
  { key: 'reasoning', label: '模型思考', color: '#c084fc' },
  { key: 'reply', label: '模型回复', color: '#ec4899' },
];

function breakdownTotal(breakdown: RouterUsageBreakdown): number {
  return BREAKDOWN_META.reduce((sum, meta) => sum + (breakdown[meta.key] || 0), 0);
}

function TokenBreakdownCard({
  breakdown,
  cacheHit,
}: {
  breakdown: RouterUsageBreakdown;
  cacheHit: number | null;
}) {
  const total = breakdownTotal(breakdown);
  const segments = BREAKDOWN_META.map((meta) => ({ ...meta, value: breakdown[meta.key] || 0 })).filter(
    (segment) => segment.value > 0,
  );
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="router-card">
      <div className="router-card-head compact">
        <div>
          <div className="router-card-title">Token 统计</div>
          <div className="router-card-sub">按请求体结构估算分类 · 输出侧为精确值</div>
        </div>
        {cacheHit !== null ? <RouterBadge tone={cacheHit >= 70 ? 'good' : 'warn'}>缓存命中 {cacheHit.toFixed(2)}%</RouterBadge> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28, flexWrap: 'wrap' }}>
        <svg width={160} height={160} viewBox="0 0 160 160" role="img" aria-label="Token 分类占比" style={{ flex: '0 0 auto' }}>
          <circle cx={80} cy={80} r={radius} fill="none" stroke="var(--track)" strokeWidth={20} />
          {segments.map((segment) => {
            const fraction = segment.value / total;
            const dash = fraction * circumference;
            const element = (
              <circle
                key={segment.key}
                cx={80}
                cy={80}
                r={radius}
                fill="none"
                stroke={segment.color}
                strokeWidth={20}
                strokeDasharray={`${Math.max(0, dash - 1.5)} ${circumference - Math.max(0, dash - 1.5)}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
              />
            );
            offset += dash;
            return element;
          })}
          <text x={80} y={76} textAnchor="middle" fontSize={17} fontWeight={700} fill="var(--text)" className="mono">
            {formatRouterTokens(total)}
          </text>
          <text x={80} y={95} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
            总用量
          </text>
        </svg>
        <div style={{ flex: 1, minWidth: 260, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '7px 18px' }}>
          {segments.map((segment) => (
            <div key={segment.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: segment.color, flex: '0 0 auto' }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}>
                {segment.label}
              </span>
              <span className="mono" style={{ fontWeight: 650, fontSize: 11.5 }}>
                {((segment.value / total) * 100).toFixed(1)}%
              </span>
              <span className="mono" style={{ color: 'var(--muted)', fontSize: 10.5, width: 64, textAlign: 'right' }}>
                ≈{formatRouterTokens(segment.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function UsageBars({ usage }: { usage: RouterUsageOverview }) {
  const max = useMemo(() => Math.max(1, ...usage.series.totalTokens), [usage]);
  const [hover, setHover] = useState<number | null>(null);
  const count = usage.series.totalTokens.length;
  const hovered =
    hover === null
      ? null
      : {
          label: usage.series.labels[hover] ?? '',
          tokens: usage.series.totalTokens[hover] ?? 0,
          requests: usage.series.requestCount[hover] ?? 0,
          cache: usage.series.cacheTokens[hover] ?? 0,
        };
  // Anchor the tooltip to the hovered bar, clamped to the chart edges.
  const tipLeft = hover === null || count === 0 ? '50%' : `${((hover + 0.5) / count) * 100}%`;
  return (
    <div className="router-bars" role="img" aria-label="tokens 趋势" onMouseLeave={() => setHover(null)}>
      {usage.series.totalTokens.map((value, index) => (
        <div
          className={`router-bar-slot ${hover === index ? 'active' : ''}`}
          key={usage.series.buckets[index]}
          onMouseEnter={() => setHover(index)}
        >
          <div className="router-bar" style={{ height: `${Math.max(2, (value / max) * 100)}%` }} />
        </div>
      ))}
      {hovered ? (
        <div
          className="router-bar-tip"
          style={{ left: `clamp(88px, ${tipLeft}, calc(100% - 88px))` }}
        >
          <div className="router-bar-tip-date">{hovered.label}</div>
          <div className="router-bar-tip-row">
            <span>Tokens</span>
            <strong>{formatRouterTokens(hovered.tokens)}</strong>
          </div>
          <div className="router-bar-tip-row">
            <span>请求</span>
            <strong>{hovered.requests}</strong>
          </div>
          <div className="router-bar-tip-row">
            <span>缓存</span>
            <strong>{formatRouterTokens(hovered.cache)}</strong>
          </div>
        </div>
      ) : null}
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
      <div className="router-table-scroll">
        <table className="router-table usage">
          <thead>
            <tr>
              <th>名称</th>
              <th>请求</th>
              <th>成功率</th>
              <th>Tokens</th>
              <th>缓存</th>
              <th>平均耗时</th>
              <th>TTFT</th>
              <th>输出速度</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="mono router-table-name" title={row.key || '—'}>{row.key || '—'}</td>
                <td className="mono">{row.requestCount}</td>
                <td className="mono">{row.requestCount > 0 ? `${((row.successCount / row.requestCount) * 100).toFixed(1)}%` : '—'}</td>
                <td className="mono">{formatRouterTokens(row.totalTokens)}</td>
                <td className="mono">{formatRouterTokens(row.cacheReadTokens)}</td>
                <td className="mono">{row.requestCount > 0 ? formatRouterDuration(row.durationMs / row.requestCount) : '—'}</td>
                <td className="mono">{row.ttftSamples > 0 ? formatRouterDuration(row.ttftMs / row.ttftSamples) : '—'}</td>
                <td className="mono">{row.generationMs > 0 ? `${((row.completionTokens / row.generationMs) * 1000).toFixed(1)} tok/s` : '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <div className="router-empty-inline">该区间没有数据。</div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
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
  tokens: number;
}

interface FlowClientLink {
  client: string;
  provider: string;
  count: number;
  tokens: number;
}

interface FlowModelLink {
  provider: string;
  model: string;
  count: number;
  tokens: number;
}

interface FlowModel {
  clients: FlowNode[];
  providers: FlowNode[];
  models: FlowNode[];
  clientLinks: FlowClientLink[];
  modelLinks: FlowModelLink[];
}

function flowLabel(key: string): string {
  if (key === FLOW_OTHER) return '其他';
  if (key === 'unknown') return '未知';
  return key;
}

function truncateFlowLabel(value: string, max = 16): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function buildFlowModel(rawRows: RouterClientProviderFlow[]): FlowModel {
  // Gateway-local rejections are not a real provider — keep them off the chart.
  const rows = rawRows.filter((row) => row.providerName !== 'local-router');
  const clientTotals = new Map<string, { count: number; tokens: number }>();
  const providerTotals = new Map<string, { count: number; tokens: number }>();
  const modelTotals = new Map<string, { count: number; tokens: number }>();
  const bump = (
    totals: Map<string, { count: number; tokens: number }>,
    key: string,
    count: number,
    tokens: number,
  ) => {
    const entry = totals.get(key) ?? { count: 0, tokens: 0 };
    entry.count += count;
    entry.tokens += tokens;
    totals.set(key, entry);
  };
  for (const row of rows) {
    bump(clientTotals, row.client, row.requestCount, row.totalTokens);
    bump(providerTotals, row.providerName, row.requestCount, row.totalTokens);
    bump(modelTotals, row.publicModel, row.requestCount, row.totalTokens);
  }
  const pickTop = (totals: Map<string, { count: number; tokens: number }>, limit: number) =>
    new Set(
      [...totals.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([key]) => key),
    );
  const topClients = pickTop(clientTotals, 6);
  const topProviders = pickTop(providerTotals, 6);
  const topModels = pickTop(modelTotals, 8);
  const clientKey = (value: string) => (topClients.has(value) ? value : FLOW_OTHER);
  const providerKey = (value: string) => (topProviders.has(value) ? value : FLOW_OTHER);
  const modelKey = (value: string) => (topModels.has(value) ? value : FLOW_OTHER);

  const clientLinks = new Map<string, FlowClientLink>();
  const modelLinks = new Map<string, FlowModelLink>();
  for (const row of rows) {
    const client = clientKey(row.client);
    const provider = providerKey(row.providerName);
    const model = modelKey(row.publicModel);
    const clientKey0 = `${client}\u0000${provider}`;
    const clientLink = clientLinks.get(clientKey0);
    if (clientLink) {
      clientLink.count += row.requestCount;
      clientLink.tokens += row.totalTokens;
    } else {
      clientLinks.set(clientKey0, { client, provider, count: row.requestCount, tokens: row.totalTokens });
    }
    const modelKey0 = `${provider}\u0000${model}`;
    const modelLink = modelLinks.get(modelKey0);
    if (modelLink) {
      modelLink.count += row.requestCount;
      modelLink.tokens += row.totalTokens;
    } else {
      modelLinks.set(modelKey0, { provider, model, count: row.requestCount, tokens: row.totalTokens });
    }
  }

  const toNodes = (
    totals: Map<string, { count: number; tokens: number }>,
    mapKey: (value: string) => string,
  ): FlowNode[] => {
    const grouped = new Map<string, { count: number; tokens: number }>();
    for (const [key, value] of totals) {
      const mapped = mapKey(key);
      const entry = grouped.get(mapped) ?? { count: 0, tokens: 0 };
      entry.count += value.count;
      entry.tokens += value.tokens;
      grouped.set(mapped, entry);
    }
    return [...grouped.entries()]
      .map(([key, value]) => ({ key, label: flowLabel(key), total: value.count, tokens: value.tokens }))
      .sort((a, b) => b.total - a.total);
  };

  return {
    clients: toNodes(clientTotals, clientKey),
    providers: toNodes(providerTotals, providerKey),
    models: toNodes(modelTotals, modelKey),
    clientLinks: [...clientLinks.values()].sort((a, b) => b.count - a.count),
    modelLinks: [...modelLinks.values()].sort((a, b) => b.count - a.count),
  };
}

const FLOW_WIDTH = 880;
const FLOW_LABEL_WIDTH = 172;
const FLOW_NODE_WIDTH = 12;
const FLOW_PADDING_Y = 12;
const FLOW_NODE_GAP = 16;
const FLOW_MID_LABEL_SPACE = 16;

function buildFlowGeometry(model: FlowModel) {
  if (model.clientLinks.length === 0 || model.modelLinks.length === 0) return null;
  const total = model.clients.reduce((sum, node) => sum + node.total, 0);
  const nodeCount = Math.max(model.clients.length, model.providers.length, model.models.length, 1);
  const content = Math.max(150, nodeCount * 30);
  const scale = total > 0 ? content / total : 0;
  const heightsOf = (nodes: FlowNode[]) => nodes.map((node) => Math.max(8, node.total * scale));
  const clientHeights = heightsOf(model.clients);
  const providerHeights = heightsOf(model.providers);
  const modelHeights = heightsOf(model.models);
  const sideHeight = (heights: number[]) =>
    heights.reduce((sum, height) => sum + height, 0) + FLOW_NODE_GAP * Math.max(0, heights.length - 1);
  const height =
    FLOW_PADDING_Y * 2 + FLOW_MID_LABEL_SPACE + Math.max(sideHeight(clientHeights), sideHeight(providerHeights), sideHeight(modelHeights));

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
  const models = layout(model.models, modelHeights);
  const leftX = FLOW_LABEL_WIDTH;
  const midX = FLOW_WIDTH / 2 - FLOW_NODE_WIDTH / 2;
  const rightX = FLOW_WIDTH - FLOW_LABEL_WIDTH - FLOW_NODE_WIDTH;

  const clientLinksByKey = new Map(model.clientLinks.map((link) => [`${link.client}\u0000${link.provider}`, link]));
  const modelLinksByKey = new Map(model.modelLinks.map((link) => [`${link.provider}\u0000${link.model}`, link]));
  const clientCursors = new Map(clients.map((node) => [node.key, node.y]));
  const providerInCursors = new Map(providers.map((node) => [node.key, node.y]));
  const providerOutCursors = new Map(providers.map((node) => [node.key, node.y]));
  const modelCursors = new Map(models.map((node) => [node.key, node.y]));

  interface Ribbon {
    key: string;
    d: string;
    width: number;
    color: string;
    title: string;
  }
  const ribbons: Ribbon[] = [];

  const ribbonPath = (x1: number, y1: number, x2: number, y2: number, width: number) => {
    const control = (x2 - x1) * 0.4;
    return `M ${x1} ${y1 + width / 2} C ${x1 + control} ${y1 + width / 2}, ${x2 - control} ${y2 + width / 2}, ${x2} ${y2 + width / 2}`;
  };

  clients.forEach((client, clientIndex) => {
    const color = FLOW_COLORS[clientIndex % FLOW_COLORS.length];
    for (const provider of providers) {
      const link = clientLinksByKey.get(`${client.key}\u0000${provider.key}`);
      if (!link) continue;
      const y1 = clientCursors.get(client.key) ?? client.y;
      const y2 = providerInCursors.get(provider.key) ?? provider.y;
      const allocated = link.count * scale;
      const width = Math.max(1.4, allocated);
      ribbons.push({
        key: `c-${client.key}\u0000${provider.key}`,
        d: ribbonPath(leftX + FLOW_NODE_WIDTH, y1, midX, y2, width),
        width,
        color,
        title: `${client.label} → ${provider.label} · ${link.count} 次请求 · ${formatRouterTokens(link.tokens)} tokens`,
      });
      clientCursors.set(client.key, y1 + allocated);
      providerInCursors.set(provider.key, y2 + allocated);
    }
  });

  providers.forEach((provider, providerIndex) => {
    const color = FLOW_COLORS[(providerIndex + 3) % FLOW_COLORS.length];
    for (const model of models) {
      const link = modelLinksByKey.get(`${provider.key}\u0000${model.key}`);
      if (!link) continue;
      const y1 = providerOutCursors.get(provider.key) ?? provider.y;
      const y2 = modelCursors.get(model.key) ?? model.y;
      const allocated = link.count * scale;
      const width = Math.max(1.4, allocated);
      ribbons.push({
        key: `m-${provider.key}\u0000${model.key}`,
        d: ribbonPath(midX + FLOW_NODE_WIDTH, y1, rightX, y2, width),
        width,
        color,
        title: `${provider.label} → ${model.label} · ${link.count} 次请求 · ${formatRouterTokens(link.tokens)} tokens`,
      });
      providerOutCursors.set(provider.key, y1 + allocated);
      modelCursors.set(model.key, y2 + allocated);
    }
  });

  return { width: FLOW_WIDTH, height, clients, providers, models, ribbons, leftX, midX, rightX };
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
      aria-label="Agent 客户端经提供商到模型的请求流向"
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
          <title>{ribbon.title}</title>
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
      {geometry.providers.map((node) => (
        <g key={`provider-${node.key}`}>
          <rect
            x={geometry.midX}
            y={node.y}
            width={FLOW_NODE_WIDTH}
            height={Math.max(3, node.height)}
            rx={3}
            fill="var(--accent)"
            fillOpacity={0.7}
          />
          <text
            x={geometry.midX + FLOW_NODE_WIDTH / 2}
            y={node.y + node.height + 11}
            textAnchor="middle"
            className="router-flow-label router-flow-label-mid"
          >
            {truncateFlowLabel(node.label)} · {node.total}
          </text>
        </g>
      ))}
      {geometry.models.map((node, index) => (
        <g key={`model-${node.key}`}>
          <rect
            x={geometry.rightX}
            y={node.y}
            width={FLOW_NODE_WIDTH}
            height={Math.max(3, node.height)}
            rx={3}
            fill={FLOW_COLORS[(index + 5) % FLOW_COLORS.length]}
          />
          <text
            x={geometry.rightX + FLOW_NODE_WIDTH + 8}
            y={node.y + node.height / 2}
            textAnchor="start"
            dominantBaseline="middle"
            className="router-flow-label"
          >
            {truncateFlowLabel(node.label, 20)} · {formatRouterTokens(node.tokens)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function Usage({ onError }: { onError: (message: string) => void }) {
  const [range, setRange] = useState<RouterUsageRange>(storedRange);
  const [usage, setUsage] = useState<RouterUsageOverview | null>(null);
  const [activity, setActivity] = useState<RouterActivityDay[] | null>(null);
  const [flow, setFlow] = useState<RouterClientProviderFlow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [chartsLoading, setChartsLoading] = useState(false);

  // Remember the last selected range across page switches and restarts.
  useEffect(() => {
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, range);
    } catch {
      // Storage unavailable; the selection just won't persist.
    }
  }, [range]);

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
    <div className={`router-page ${loading || chartsLoading ? 'page-refreshing' : ''}`}>
      <div className="router-toolbar">
        <div className="router-toolbar-actions">
          <select
            className="router-select"
            value={range}
            onChange={(event) => {
              const next = event.target.value;
              if (isRouterUsageRange(next)) setRange(next);
            }}
          >
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
          label="输出速度"
          value={totals && totals.generationMs > 0 ? `${((totals.completionTokens / totals.generationMs) * 1000).toFixed(1)} tok/s` : '—'}
          hint={`输出 ${formatRouterTokens(totals?.completionTokens ?? 0)} tokens / 生成 ${totals && totals.generationMs > 0 ? formatRouterDuration(totals.generationMs) : '—'}`}
        />
        <RouterStat
          label="平均耗时"
          value={totals && totals.requestCount > 0 ? formatRouterDuration(totals.durationMs / totals.requestCount) : '—'}
          hint={`缓存读 ${formatRouterTokens(totals?.cacheReadTokens ?? 0)}`}
        />
      </div>

      {usage?.breakdown ? (
        <TokenBreakdownCard
          breakdown={usage.breakdown}
          cacheHit={
            totals && totals.promptTokens + totals.cacheReadTokens + totals.cacheWriteTokens > 0
              ? (totals.cacheReadTokens / (totals.promptTokens + totals.cacheReadTokens + totals.cacheWriteTokens)) * 100
              : null
          }
        />
      ) : null}

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
            <div className="router-card-title">Agent → 提供商 → 模型流向</div>
            <div className="router-card-sub">近 7 天请求分布 · 左侧为客户端，中间为提供商，右侧为模型 Tokens 流量</div>
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

      <div className="router-two-col usage">
        <UsageTable title="按提供商" rows={usage?.providers ?? []} />
        <UsageTable title="按模型" rows={usage?.models ?? []} />
      </div>
    </div>
  );
}
