import { useMemo, useState } from 'react';
import { Activity, Gauge, Settings2 } from 'lucide-react';
import type { AppState, SpeedPoint, SpeedRange } from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatDuration } from '../format';
import { useSpeedSeries } from '../hooks';
import { LineChart, type LineSeries } from '../components/LineChart';
import { Banner, EmptyState, Segmented, Spinner } from '../components/ui';

const PALETTE = ['#2F6BFF', '#8B5CF6', '#0EA5A4', '#F59E0B', '#EC4899', '#22C55E'];

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
  const { series, loading, error, reload } = useSpeedSeries(range, true);

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
          avgTtft:
            points.reduce((sum, point) => sum + (point.ttftMs ?? 0) * point.samples, 0) / weight,
        };
      })
      .sort((a, b) => b.samples - a.samples || a.model.localeCompare(b.model));
  }, [series]);

  const providerLabel = (provider: string) =>
    provider === 'opencode-go' || provider === 'opencode' ? 'OpenCode Go' : provider;
  const chartSeries: LineSeries[] = models.slice(0, 6).map((model) => ({
    key: model.key,
    label: `${providerLabel(model.provider)} · ${model.model}`,
    color: model.color,
    points: model.points.map((point) => ({ day: point.day, value: point.tokensPerSecond })),
  }));

  const hasSamples = Boolean(series && series.totalSamples > 0);
  const enabled = Boolean(series?.enabled ?? state.speed.enabled);

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Segmented
          value={range}
          options={[
            { value: '7d', label: t('speed.7d') },
            { value: '30d', label: t('speed.30d') },
          ]}
          onChange={setRange}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={`chip ${enabled ? 'good' : ''}`}>
            <span className="legend-dot" style={{ background: enabled ? 'var(--good)' : 'var(--faint)' }} />
            {enabled ? t('settings.speedRunning') : t('settings.speedStopped')}
          </span>
          <button type="button" className="icon-btn no-drag" onClick={() => void reload()} title={t('common.refresh')} disabled={loading}>
            {loading ? <Spinner size={14} /> : <Activity size={15} />}
          </button>
        </div>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}
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
            <LineChart series={chartSeries} language={language} height={210} unit=" tok/s" />
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
                  <div className="model-tokens mono">{model.avgTps.toFixed(1)} tok/s</div>
                  <div className="faint" style={{ fontSize: 9.5, marginTop: 1 }}>
                    {t('speed.ttft')} {formatDuration(model.avgTtft)} · {model.samples}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="hint" style={{ padding: '0 4px', lineHeight: 1.55 }}>{t('speed.subtitle')}</div>
    </div>
  );
}
