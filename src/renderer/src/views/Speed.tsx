import { useMemo, useState } from 'react';
import { Activity, Database, Gauge, Settings2 } from 'lucide-react';
import type {
  AppState,
  HistoryMetricKey,
  HistoryMetrics,
  HistoryMetricsModel,
  HistoryMetricsPoint,
  HistoryRange,
  SpeedPoint,
  SpeedRange,
} from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatDuration, formatTime, formatTokens } from '../format';
import { useHistoryMetrics, useSpeedSeries } from '../hooks';
import { LineChart, type LineSeries } from '../components/LineChart';
import { Banner, EmptyState, Segmented, Spinner } from '../components/ui';

const PALETTE = ['#2F6BFF', '#8B5CF6', '#0EA5A4', '#F59E0B', '#EC4899', '#22C55E'];
type SpeedSource = 'proxy' | 'history';

const METRIC_META: Record<HistoryMetricKey, { unit: string; digits: number; scale: number }> = {
  ttft: { unit: ' s', digits: 1, scale: 1 / 1000 },
  output: { unit: ' tok/s', digits: 1, scale: 1 },
  prefill: { unit: ' tok/s', digits: 0, scale: 1 },
  turn: { unit: ' s', digits: 1, scale: 1 / 1000 },
};

interface ModelSummary {
  key: string;
  provider: string;
  model: string;
  color: string;
  points: SpeedPoint[];
  samples: number;
  avgTps: number;
  avgTtft: number;
}

function formatRate(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(digits);
}

function historyValue(point: HistoryMetricsPoint, metric: HistoryMetricKey): number | null {
  switch (metric) {
    case 'ttft':
      return point.avgTtftMs;
    case 'output':
      return point.outputTps;
    case 'prefill':
      return point.prefillTps;
    case 'turn':
      return point.turnMs;
  }
}

function modelValue(model: HistoryMetricsModel, metric: HistoryMetricKey): number | null {
  switch (metric) {
    case 'ttft':
      return model.avgTtftMs;
    case 'output':
      return model.outputTps;
    case 'prefill':
      return model.prefillTps;
    case 'turn':
      return model.turnMs;
  }
}

function HistoryStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value mono">{value}</div>
      <div className="stat-label">{label}</div>
      <div
        className="faint"
        style={{ fontSize: 9.5, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {sub}
      </div>
    </div>
  );
}

export function Speed({
  state,
  language,
  t,
  onOpenSettings,
}: {
  state: AppState;
  language: 'zh-CN' | 'en';
  t: Translator;
  onOpenSettings: () => void;
}) {
  const [range, setRange] = useState<SpeedRange>('7d');
  const [historyRange, setHistoryRange] = useState<HistoryRange>('all');
  const [source, setSource] = useState<SpeedSource>('history');
  const [chartMetric, setChartMetric] = useState<HistoryMetricKey>('ttft');
  const {
    series,
    loading: speedLoading,
    error: speedError,
    reload: reloadSpeed,
  } = useSpeedSeries(range, source === 'proxy');
  const {
    metrics,
    loading: historyLoading,
    error: historyError,
    reload: reloadHistory,
  } = useHistoryMetrics(historyRange, source === 'history');

  const models = useMemo<ModelSummary[]>(() => {
    if (!series) return [];
    const groups = new Map<string, SpeedPoint[]>();
    for (const point of series.points) {
      const key = `${point.provider}\u0000${point.model}`;
      const list = groups.get(key) ?? [];
      list.push(point);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, points], index) => {
        const sampleCount = points.reduce((sum, point) => sum + point.samples, 0);
        const weight = Math.max(1, sampleCount);
        return {
          key,
          provider: points[0]?.provider ?? 'opencode-go',
          model: points[0]?.model ?? 'unknown',
          color: PALETTE[index % PALETTE.length],
          points,
          samples: sampleCount,
          avgTps: points.reduce((sum, point) => sum + point.tokensPerSecond * point.samples, 0) / weight,
          avgTtft: (() => {
            const ttftPoints = points.filter(
              (point): point is SpeedPoint & { ttftMs: number } => point.ttftMs !== null,
            );
            const ttftSamples = ttftPoints.reduce((sum, point) => sum + point.samples, 0);
            return ttftSamples > 0
              ? ttftPoints.reduce((sum, point) => sum + point.ttftMs * point.samples, 0) / ttftSamples
              : 0;
          })(),
        };
      })
      .sort((a, b) => (a.avgTtft || Number.MAX_SAFE_INTEGER) - (b.avgTtft || Number.MAX_SAFE_INTEGER) || b.samples - a.samples);
  }, [series]);

  const providerLabel = (provider: string) =>
    provider === 'opencode-go' || provider === 'opencode' ? 'OpenCode Go' : provider;
  const chartSeries: LineSeries[] = models
    .slice(0, 6)
    .map((model) => ({
      key: model.key,
      label: `${providerLabel(model.provider)} · ${model.model}`,
      color: model.color,
      points: model.points
        .filter((point): point is SpeedPoint & { ttftMs: number } => point.ttftMs !== null)
        .map((point) => ({ day: point.day, value: point.ttftMs })),
    }))
    .filter((series) => series.points.length > 0);

  const hasSamples = Boolean(series && series.totalSamples > 0);
  const enabled = Boolean(series?.enabled ?? state.speed.enabled);
  const loading = source === 'proxy' ? speedLoading : historyLoading;
  const error = source === 'proxy' ? speedError : historyError;
  const historyModels = metrics?.models ?? [];
  const totals = metrics?.totals;
  const hasHistory = Boolean(totals && totals.steps > 0);
  const metricMeta = METRIC_META[chartMetric];

  const historyChartSeries: LineSeries[] = historyModels
    .slice(0, 6)
    .map((model, index) => ({
      key: `${model.provider}\u0000${model.model}`,
      label: `${providerLabel(model.provider)} · ${model.model}`,
      color: PALETTE[index % PALETTE.length],
      points: model.points
        .map((point) => {
          const value = historyValue(point, chartMetric);
          return value === null ? null : { day: point.day, value: value * metricMeta.scale };
        })
        .filter((point): point is { day: string; value: number } => point !== null),
    }))
    .filter((item) => item.points.length > 0);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {source === 'proxy' ? (
            <Segmented
              value={range}
              options={[
                { value: '7d', label: t('speed.7d') },
                { value: '30d', label: t('speed.30d') },
              ]}
              onChange={setRange}
            />
          ) : (
            <Segmented
              value={historyRange}
              options={[
                { value: '7d', label: t('speed.7d') },
                { value: '30d', label: t('speed.30d') },
                { value: 'all', label: t('common.all') },
              ]}
              onChange={setHistoryRange}
            />
          )}
          <Segmented
            value={source}
            options={[
              { value: 'history', label: t('speed.sourceHistory') },
              { value: 'proxy', label: t('speed.sourceProxy') },
            ]}
            onChange={setSource}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {source === 'proxy' ? (
            <span className={`chip ${enabled ? 'good' : ''}`}>
              <span className="legend-dot" style={{ background: enabled ? 'var(--good)' : 'var(--faint)' }} />
              {enabled ? t('settings.speedRunning') : t('settings.speedStopped')}
            </span>
          ) : metrics?.source === 'sqlite' || metrics?.source === 'demo' ? (
            <span className="chip">
              <span className="legend-dot" style={{ background: 'var(--good)' }} />
              {metrics.source === 'demo' ? t('app.demo') : 'SQLite'}
            </span>
          ) : null}
          <button
            type="button"
            className="icon-btn no-drag"
            onClick={() => void (source === 'proxy' ? reloadSpeed() : reloadHistory())}
            title={t('common.refresh')}
            disabled={loading}
          >
            {loading ? <Spinner size={14} /> : <Activity size={15} />}
          </button>
        </div>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {source === 'proxy' ? (
        <>
          {series?.error ? <Banner tone="danger">{t('speed.error')}: {series.error}</Banner> : null}
          {series?.approximate && hasSamples ? <Banner tone="warn">{t('speed.approx')}</Banner> : null}

          {!hasSamples ? (
            <div className="glass-card">
              <EmptyState
                icon={enabled ? Activity : Gauge}
                title={enabled ? t('speed.waiting') : t('speed.disabled')}
                body={enabled ? t('speed.waitingHint') : t('speed.disabledHint')}
                action={
                  <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                    <Settings2 size={14} />
                    {t('speed.setup')}
                  </button>
                }
              />
            </div>
          ) : (
            <>
              <div className="chart-wrap">
                <div className="chart-legend">
                  {models.slice(0, 6).map((model) => (
                    <span className="legend-item" key={model.key}>
                      <span className="legend-dot" style={{ background: model.color }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {providerLabel(model.provider)} · {model.model}
                      </span>
                    </span>
                  ))}
                </div>
                <LineChart series={chartSeries} language={language} height={210} unit=" ms" digits={0} />
              </div>

              <div className="soft-card" style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 650 }}>{t('speed.title')}</div>
                  <div className="faint" style={{ fontSize: 10 }}>
                    {t('speed.rangeSummary', { n: series?.totalSamples ?? 0 })}
                  </div>
                </div>
                {models.map((model) => (
                  <div className="model-row" key={model.key}>
                    <span className="legend-dot" style={{ background: model.color, width: 8, height: 8 }} />
                    <div className="model-name">
                      <strong>{model.model}</strong>
                      <span>{providerLabel(model.provider)}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="model-tokens mono">
                        {model.avgTtft > 0 ? formatDuration(model.avgTtft) : '—'}
                      </div>
                      <div className="faint" style={{ fontSize: 9.5, marginTop: 1 }}>
                        {model.avgTps > 0 ? `${model.avgTps.toFixed(1)} tok/s · ` : ''}
                        {model.samples}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {metrics?.error ? (
            <Banner tone="danger">
              {t('speed.history.error')}: {metrics.error.message}
            </Banner>
          ) : null}
          <HistoryLoading loading={historyLoading} metrics={metrics} t={t} />
          {!historyLoading && hasHistory && totals ? (
            <>
              <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                <HistoryStat
                  label={t('speed.history.ttft')}
                  value={formatDuration(totals.avgTtftMs)}
                  sub={t('speed.history.p50p95', {
                    p50: formatDuration(totals.p50TtftMs),
                    p95: formatDuration(totals.p95TtftMs),
                  })}
                />
                <HistoryStat
                  label={t('speed.history.output')}
                  value={`${formatRate(totals.outputTps)} tok/s`}
                  sub={`${t('speed.history.steps', { n: totals.steps })} · ${t('speed.history.outputSub', {
                    tokens: formatTokens(totals.outputTokens),
                  })}`}
                />
                <HistoryStat
                  label={t('speed.history.prefill')}
                  value={`${formatRate(totals.prefillTps, 0)} tok/s`}
                  sub={t('speed.history.cacheHit', {
                    value: totals.cacheHitPercent === null ? '—' : totals.cacheHitPercent.toFixed(0),
                  })}
                />
                <HistoryStat
                  label={t('speed.history.turn')}
                  value={formatDuration(totals.turnMs)}
                  sub={t('speed.history.turns', { n: totals.turns })}
                />
              </div>

              <div className="chart-wrap">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                  <Segmented
                    value={chartMetric}
                    options={[
                      { value: 'ttft', label: t('speed.history.metric.ttft') },
                      { value: 'output', label: t('speed.history.metric.output') },
                      { value: 'prefill', label: t('speed.history.metric.prefill') },
                      { value: 'turn', label: t('speed.history.metric.turn') },
                    ]}
                    onChange={setChartMetric}
                  />
                </div>
                <div className="chart-legend">
                  {historyModels.slice(0, 6).map((model, index) => (
                    <span className="legend-item" key={`${model.provider}\u0000${model.model}`}>
                      <span className="legend-dot" style={{ background: PALETTE[index % PALETTE.length] }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {providerLabel(model.provider)} · {model.model}
                      </span>
                    </span>
                  ))}
                </div>
                <LineChart
                  series={historyChartSeries}
                  language={language}
                  height={210}
                  unit={metricMeta.unit}
                  digits={metricMeta.digits}
                />
                <div className="faint" style={{ fontSize: 9.5, textAlign: 'right', marginTop: 2 }}>
                  {t('speed.history.updated', { time: formatTime(metrics?.generatedAt ?? null, language) })}
                </div>
              </div>

              <div className="soft-card" style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
                  <div style={{ fontSize: 12, fontWeight: 650 }}>{t('speed.history.title')}</div>
                  <div className="faint" style={{ fontSize: 10 }}>
                    {t('speed.history.steps', { n: totals.steps })}
                  </div>
                </div>
                {historyModels.map((model, index) => (
                  <div className="model-row" key={`${model.provider}\u0000${model.model}`} style={{ alignItems: 'flex-start' }}>
                    <span
                      className="legend-dot"
                      style={{ background: PALETTE[index % PALETTE.length], width: 8, height: 8, marginTop: 4 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="model-name">
                        <strong>{model.model}</strong>
                        <span>
                          {providerLabel(model.provider)} · {t('speed.history.steps', { n: model.steps })} ·{' '}
                          {formatTokens(model.outputTokens)} tok
                        </span>
                      </div>
                      <div className="history-metrics">
                        <div className="history-metric">
                          <b>{t('speed.history.metric.ttft')}</b>
                          <span>{formatDuration(modelValue(model, 'ttft'))}</span>
                        </div>
                        <div className="history-metric">
                          <b>{t('speed.tps')}</b>
                          <span>{formatRate(modelValue(model, 'output'))}</span>
                        </div>
                        <div className="history-metric">
                          <b>{t('speed.history.metric.prefill')}</b>
                          <span>{formatRate(modelValue(model, 'prefill'), 0)}</span>
                        </div>
                        <div className="history-metric">
                          <b>{t('speed.history.turnShort')}</b>
                          <span>{formatDuration(modelValue(model, 'turn'))}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {!historyLoading && !hasHistory && !metrics?.error ? (
            <div className="glass-card">
              <EmptyState
                icon={Database}
                title={t('speed.history.noData')}
                body={t('speed.history.noDataHint')}
                action={
                  <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                    <Settings2 size={14} />
                    {t('speed.setup')}
                  </button>
                }
              />
            </div>
          ) : null}
        </>
      )}

      <div className="hint" style={{ padding: '0 4px', lineHeight: 1.55 }}>
        {source === 'proxy' ? t('speed.subtitle') : t('speed.history.footnote')}
      </div>
    </div>
  );
}

function HistoryLoading({
  loading,
  metrics,
  t,
}: {
  loading: boolean;
  metrics: HistoryMetrics | null;
  t: Translator;
}) {
  if (!loading || metrics) return null;
  return (
    <div className="glass-card" style={{ padding: 28, display: 'grid', placeItems: 'center', gap: 8 }}>
      <Spinner size={18} />
      <div className="faint" style={{ fontSize: 11 }}>
        {t('common.loading')}
      </div>
    </div>
  );
}
