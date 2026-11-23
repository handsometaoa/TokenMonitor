import { AlertTriangle, KeyRound, RefreshCw } from 'lucide-react';
import type { AppState, Language, ProviderSnapshot, QuotaState } from '../../../shared/types';
import type { Translator } from '../i18n';
import { formatRelative } from '../format';
import { QuotaBar } from './QuotaBar';
import { Banner, Chip, EmptyState, IconButton, Spinner } from './ui';

function overallStatus(snapshot: ProviderSnapshot, quota: QuotaState):
  | { tone: 'good' | 'warn' | 'danger' | 'neutral'; labelKey: 'status.normal' | 'status.near' | 'status.limited' | 'status.stale' | 'status.loading' } {
  if (quota.loading && !snapshot) return { tone: 'neutral', labelKey: 'status.loading' };
  const windows = snapshot.windows;
  if (windows.some((window) => window.status === 'rate-limited')) return { tone: 'danger', labelKey: 'status.limited' };
  if (windows.some((window) => window.remainingPercent <= 5)) return { tone: 'danger', labelKey: 'status.near' };
  if (quota.stale) return { tone: 'warn', labelKey: 'status.stale' };
  if (windows.some((window) => window.remainingPercent <= 20)) return { tone: 'warn', labelKey: 'status.near' };
  return { tone: 'good', labelKey: 'status.normal' };
}

function errorTitle(state: AppState, t: Translator): string {
  switch (state.quota.error?.code) {
    case 'invalid-key':
      return t('error.invalidKey');
    case 'no-subscription':
      return t('error.noSubscription');
    case 'network':
      return t('error.network');
    case 'timeout':
      return t('error.timeout');
    case 'malformed':
      return t('error.malformed');
    case 'rate-limited':
      return t('error.rateLimited');
    case 'not-configured':
      return t('error.notConfigured');
    default:
      return t('error.unknown');
  }
}

function errorHint(state: AppState, t: Translator): string {
  switch (state.quota.error?.code) {
    case 'invalid-key':
      return t('error.invalidKeyHint');
    case 'no-subscription':
      return t('error.noSubscriptionHint');
    case 'network':
      return t('error.networkHint');
    case 'timeout':
      return t('error.timeoutHint');
    case 'malformed':
      return t('error.malformedHint');
    case 'rate-limited':
      return t('error.rateLimitedHint');
    case 'not-configured':
      return t('error.notConfiguredHint');
    default:
      return state.quota.error?.message ?? '';
  }
}

export function ProviderCard({
  state,
  now,
  language,
  t,
  onRetry,
  onOpenSettings,
}: {
  state: AppState;
  now: number;
  language: Language;
  t: Translator;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const { quota } = state;
  const snapshot = quota.snapshot;

  if (!snapshot) {
    if (quota.error?.code === 'not-configured') {
      return (
        <div className="glass-card provider-card">
          <div className="provider-head">
            <div>
              <div className="provider-title">{t('provider.openCodeGo')}</div>
              <div className="provider-updated">{t('status.off')}</div>
            </div>
            <Chip tone="warn">{t('status.off')}</Chip>
          </div>
          <EmptyState
            icon={KeyRound}
            title={t('error.notConfigured')}
            body={t('error.notConfiguredHint')}
            action={
              <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                {t('error.openSettings')}
              </button>
            }
          />
        </div>
      );
    }

    return (
      <div className="glass-card provider-card">
        <div className="provider-head">
          <div>
            <div className="provider-title">{t('provider.openCodeGo')}</div>
            <div className="provider-updated">{t('status.stale')}</div>
          </div>
          <Chip tone="danger">{t('status.stale')}</Chip>
        </div>
        <EmptyState
          icon={AlertTriangle}
          title={errorTitle(state, t)}
          body={errorHint(state, t)}
          action={
            <button type="button" className="btn btn-primary" onClick={onRetry} disabled={quota.loading}>
              {quota.loading ? <Spinner /> : <RefreshCw size={14} />}
              {t('common.retry')}
            </button>
          }
        />
      </div>
    );
  }

  const status = overallStatus(snapshot, quota);
  const isStale = quota.stale && quota.error;
  return (
    <div className="glass-card provider-card fade-in">
      <div className="provider-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="provider-title">{snapshot.planLabel}</div>
            <span className="plan-pill">Go</span>
            {state.demo ? <Chip tone="neutral">{t('app.demo')}</Chip> : null}
          </div>
          <div className="provider-updated">
            {formatRelative(snapshot.fetchedAt, now, language)}
            {isStale ? ` · ${t('status.stale')}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Chip tone={status.tone === 'neutral' ? 'neutral' : status.tone}>{t(status.labelKey)}</Chip>
          <IconButton icon={RefreshCw} label={t('common.refresh')} onClick={onRetry} disabled={quota.loading} />
        </div>
      </div>

      {quota.loading ? <div className="loading-line" style={{ margin: '8px 0 2px' }} /> : null}

      {isStale ? (
        <div style={{ marginTop: 10 }}>
          <Banner
            tone="warn"
            icon={AlertTriangle}
            action={
              <button type="button" className="btn btn-sm" onClick={onRetry} disabled={quota.loading}>
                {t('common.retry')}
              </button>
            }
          >
            <strong>{errorTitle(state, t)}</strong>
            <div style={{ marginTop: 2 }}>{errorHint(state, t)}</div>
          </Banner>
        </div>
      ) : null}

      <div style={{ marginTop: 6 }}>
        {snapshot.windows.map((window) => (
          <QuotaBar key={window.id} window={window} now={now} language={language} t={t} />
        ))}
      </div>

      {snapshot.windows.length < 3 ? (
        <div className="hint" style={{ marginTop: 8 }}>
          {language === 'zh-CN' ? '部分额度窗口本次未返回。' : 'Some quota windows were not returned.'}
        </div>
      ) : null}
    </div>
  );
}
