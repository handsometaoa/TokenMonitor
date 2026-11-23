import { useMemo, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import type { AppState, LocalUsageRange, LocalUsageSummary } from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatTokens, formatRelative } from '../format';
import { useLocalUsage, useNow } from '../hooks';
import { BarChart, type BarPoint } from '../components/BarChart';
import { Banner, EmptyState, Segmented, Spinner, Stat } from '../components/ui';

function downsample(days: LocalUsageSummary['days']): BarPoint[] {
  if (days.length <= 31) {
    return days.map((day) => ({
      day: day.day,
      input: day.input,
      output: day.output,
      reasoning: day.reasoning,
      cacheRead: day.cacheRead,
      cacheWrite: day.cacheWrite,
      total: day.total,
    }));
  }
  const bucketSize = Math.ceil(days.length / 30);
  const buckets: BarPoint[] = [];
  for (let index = 0; index < days.length; index += bucketSize) {
    const slice = days.slice(index, index + bucketSize);
    if (slice.length === 0) continue;
    buckets.push({
      day: slice[slice.length - 1].day,
      input: slice.reduce((sum, day) => sum + day.input, 0),
      output: slice.reduce((sum, day) => sum + day.output, 0),
      reasoning: slice.reduce((sum, day) => sum + day.reasoning, 0),
      cacheRead: slice.reduce((sum, day) => sum + day.cacheRead, 0),
      cacheWrite: slice.reduce((sum, day) => sum + day.cacheWrite, 0),
      total: slice.reduce((sum, day) => sum + day.total, 0),
    });
  }
  return buckets;
}

export function LocalUsage({
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
  const [range, setRange] = useState<LocalUsageRange>('30d');
  const enabled = state.settings.localUsageEnabled;
  const { summary, loading, error, reload } = useLocalUsage(range, enabled);
  const now = useNow(30_000);
  const chartData = useMemo(() => (summary ? downsample(summary.days) : []), [summary]);
  const hasData = Boolean(summary && summary.messages > 0);
  const options = [
    { value: 'today' as const, label: t('local.today') },
    { value: '7d' as const, label: t('local.7d') },
    { value: '30d' as const, label: t('local.30d') },
    { value: 'all' as const, label: t('local.all') },
  ];

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Segmented value={range} options={options} onChange={setRange} />
        <button type="button" className="icon-btn no-drag" onClick={() => void reload(true)} title={t('local.loadMore')} disabled={loading}>
          {loading ? <Spinner size={14} /> : <RefreshCw size={15} />}
        </button>
      </div>

      {!enabled ? (
        <div className="glass-card">
          <EmptyState
            icon={Database}
            title={t('local.disabled')}
            body={t('local.disabledHint')}
            action={<button type="button" className="btn" onClick={onOpenSettings}>{t('common.settings')}</button>}
          />
        </div>
      ) : loading && !summary ? (
        <div className="glass-card" style={{ padding: 18 }}>
          <div className="skeleton" style={{ height: 16, width: '42%' }} />
          <div className="skeleton" style={{ height: 62, marginTop: 14 }} />
          <div className="skeleton" style={{ height: 160, marginTop: 14 }} />
        </div>
      ) : error ? (
        <div className="glass-card">
          <EmptyState
            icon={Database}
            title={t('local.scanFailed')}
            body={error}
            action={<button type="button" className="btn" onClick={() => void reload(true)}>{t('local.loadMore')}</button>}
          />
        </div>
      ) : summary && !hasData ? (
        <div className="glass-card">
          <EmptyState
            icon={Database}
            title={range === 'all' ? t('local.noData') : t('local.noData')}
            body={range === 'all' ? t('local.noDataHint') : t('local.noDataHint')}
            action={
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                {range !== 'all' ? (
                  <button type="button" className="btn" onClick={() => setRange('all')}>{t('local.viewAll')}</button>
                ) : null}
                <button type="button" className="btn" onClick={onOpenSettings}>{t('settings.localTitle')}</button>
              </div>
            }
          />
          {summary.dbPath ? <div className="hint" style={{ padding: '0 18px 16px', wordBreak: 'break-all' }}>{summary.dbPath}</div> : null}
        </div>
      ) : summary ? (
        <>
          <div className="stat-grid">
            <Stat label={t('local.tokens')} value={formatTokens(summary.totals.total)} />
            <Stat label={t('local.sessions')} value={String(summary.sessions)} />
            <Stat label={t('local.messages')} value={String(summary.messages)} />
          </div>

          <div className="breakdown">
            <div className="breakdown-item">
              <div className="breakdown-value mono">{formatTokens(summary.totals.input)}</div>
              <div className="breakdown-label">{t('local.input')}</div>
            </div>
            <div className="breakdown-item">
              <div className="breakdown-value mono">{formatTokens(summary.totals.output)}</div>
              <div className="breakdown-label">{t('local.output')}</div>
            </div>
            <div className="breakdown-item">
              <div className="breakdown-value mono">{formatTokens(summary.totals.reasoning)}</div>
              <div className="breakdown-label">{t('local.reasoning')}</div>
            </div>
            <div className="breakdown-item">
              <div className="breakdown-value mono">{formatTokens(summary.totals.cacheRead + summary.totals.cacheWrite)}</div>
              <div className="breakdown-label">{t('local.cacheRead')}</div>
            </div>
          </div>

          <div className="chart-wrap">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <div style={{ fontSize: 12, fontWeight: 650 }}>{t('local.daily')}</div>
                <span className="chip">{language === 'zh-CN' ? '含缓存' : 'incl. cache'}</span>
              </div>
              <div className="faint mono" style={{ fontSize: 10 }}>{t('local.generated', { time: formatRelative(summary.generatedAt, now, language) })}</div>
            </div>
            <BarChart data={chartData} language={language} t={t} />
          </div>

          {summary.models.length > 0 ? (
            <div className="soft-card" style={{ padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 2 }}>
                <div style={{ fontSize: 12, fontWeight: 650 }}>{t('local.models')}</div>
                <div className="faint" style={{ fontSize: 10 }}>{t('local.tokens')}</div>
              </div>
              {summary.models.slice(0, 7).map((model) => {
                const share = summary.totals.total > 0 ? (model.total / summary.totals.total) * 100 : 0;
                return (
                  <div className="model-row" key={`${model.provider}-${model.model}`}>
                    <div className="model-name">
                      <strong>{model.model}</strong>
                      <span>{model.provider}</span>
                      <div className="share-track">
                        <div className="share-fill" style={{ width: `${Math.min(100, share)}%` }} />
                      </div>
                    </div>
                    <div className="model-tokens mono">{formatTokens(model.total)}</div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {summary.partial ? (
            <Banner tone="warn">{t('local.partial')}</Banner>
          ) : null}

          <div className="hint" style={{ wordBreak: 'break-all', padding: '0 4px' }}>
            {t('local.path')}: {summary.dbPath || '—'} · {t('local.schema')}: {summary.schema}
          </div>
          <div className="hint" style={{ padding: '0 4px' }}>{t('local.subtitle')}</div>
        </>
      ) : null}
    </div>
  );
}
