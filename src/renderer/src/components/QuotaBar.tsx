import type { Language, QuotaWindowView } from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatAbsolute, formatCountdown, formatDaily, formatPercent } from '../format';

function paceText(window: QuotaWindowView, language: Language, t: Translator): string {
  const pace = window.pace;
  if (pace.state === 'insufficient') return t('pace.insufficient');
  if (pace.state === 'ahead') {
    const headroom = Math.round(pace.headroom ?? 0);
    const base = headroom >= 20 ? t('pace.ahead') : t('pace.aheadWithValue', { value: headroom });
    return `${base} · ${t('pace.sustainable')}`;
  }
  if (pace.state === 'behind') {
    return `${t('pace.behind')} · ${t('pace.behindHint')}`;
  }
  let base = `${t('pace.onPace')} · ${t('pace.sustainable')}`;
  if ((window.id === 'weekly' || window.id === 'monthly') && pace.dailyAverage !== null) {
    base += ` · ${t('pace.dailyAvg', { value: formatDaily(pace.dailyAverage) })}`;
  }
  return base;
}

export function QuotaBar({
  window,
  now,
  language,
  t,
}: {
  window: QuotaWindowView;
  now: number;
  language: Language;
  t: Translator;
}) {
  const remaining = Math.max(0, Math.min(100, window.remainingPercent));
  const tone =
    window.status === 'rate-limited' || remaining <= 5 ? 'danger' : remaining <= 20 ? 'warn' : 'normal';
  const label = t(
    window.id === 'rolling' ? 'window.rollingFull' : window.id === 'weekly' ? 'window.weeklyFull' : 'window.monthlyFull',
  );
  const expectedRemaining = window.pace.headroom === null ? null : Math.max(0, Math.min(100, 100 - window.pace.elapsedRatio * 100));
  const reset = formatCountdown(window.resetsAt, now, language);
  const resetTitle = t('reset.tooltip', { time: formatAbsolute(window.resetsAt, language) });

  return (
    <div className="quota-row">
      <div className="quota-row-head">
        <div className="quota-label">{label}</div>
        <div className="quota-remaining mono">
          {t('provider.remaining')} {Math.round(remaining)}%
        </div>
      </div>
      <div className="quota-meta">
        <span>
          {t('provider.used')} {formatPercent(window.usedPercent)}
        </span>
        <span title={window.resetsAt ? resetTitle : undefined}>
          {window.resetsAt ? t('reset.in', { time: reset }) : t('reset.unknown')}
        </span>
      </div>
      <div
        className="quota-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        aria-label={`${label} ${remaining}% remaining`}
      >
        <div
          className={`quota-fill ${tone === 'warn' ? 'warn' : tone === 'danger' ? 'danger' : ''}`}
          style={{ width: `${remaining}%` }}
        />
        {expectedRemaining !== null && expectedRemaining > 0 && expectedRemaining < 100 ? (
          <div
            className={`quota-pace-tick ${window.pace.state === 'behind' ? 'behind' : ''}`}
            style={{ left: `${expectedRemaining}%` }}
            title={t('pace.onPace')}
          />
        ) : null}
      </div>
      <div className="pace-line">
        <span className={`pace-dot ${window.pace.state}`} />
        <span className="muted">{paceText(window, language, t)}</span>
        {window.status === 'rate-limited' ? (
          <span className="chip danger" style={{ marginLeft: 'auto' }}>
            {t('status.limited')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
