import type { AppState } from '../../shared/types';
import { agentQuotaKey, routerQuotaIdentity } from '../../shared/types';

/** Which slice of a provider's quota the orb shows. */
export type OrbQuotaView = 'all' | 'money' | 'hours' | 'week' | 'month';

export interface OrbQuotaWindow {
  label: string;
  remainingPercent: number;
  resetsAt: string | null;
  bucket: 'hours' | 'week' | 'month';
}

export interface OrbTarget {
  key: string;
  label: string;
  remainingPercent: number | null;
  balanceText: string | null;
  /** Per-window detail so the orb can switch between 金额/5小时/周/月. */
  windows: OrbQuotaWindow[];
  loading: boolean;
  stale: boolean;
  hasError: boolean;
  /** Credential not set up (yet) — not an error, just nothing fresh to show. */
  notConfigured: boolean;
}

/** Bucket a window by its length: ≤24h → hours, ≤10 days → week, else month. */
function bucketOf(minutes: number | null): 'hours' | 'week' | 'month' {
  if (minutes !== null && minutes <= 24 * 60) return 'hours';
  if (minutes !== null && minutes <= 10 * 24 * 60) return 'week';
  return 'month';
}

/** OpenCode Go agent windows carry no label — derive one from the window id. */
function opencodeWindowLabel(id: string): string {
  if (id === 'rolling') return '5 小时';
  if (id === 'weekly') return '每周';
  if (id === 'monthly') return '每月';
  return id;
}

function minRemaining(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(0, Math.min(...values));
}

function formatBalance(balance: number, currency: string | null): string {
  const amount = Math.abs(balance) >= 1000 ? `${(balance / 1000).toFixed(1)}k` : balance.toFixed(2);
  if (currency === '$' || currency === 'USD') return `$${amount}`;
  return currency ? `${amount} ${currency}` : amount;
}

/**
 * Candidate quota surfaces for the orb, in default priority order. Router
 * entries dedup onto agent keys, so a Map keyed by identity keeps the first
 * (agent-native, with loading/stale state) occurrence.
 */
export function orbTargets(state: AppState): OrbTarget[] {
  const byKey = new Map<string, OrbTarget>();
  const push = (target: OrbTarget): void => {
    if (!byKey.has(target.key)) byKey.set(target.key, target);
  };

  const { quota } = state;
  if (quota.snapshot) {
    push({
      key: agentQuotaKey('opencode'),
      label: quota.snapshot.providerName,
      remainingPercent: minRemaining(quota.snapshot.windows.map((window) => window.remainingPercent)),
      balanceText: null,
      windows: quota.snapshot.windows.map((window) => ({
        label: opencodeWindowLabel(window.id),
        remainingPercent: window.remainingPercent,
        resetsAt: window.resetsAt,
        bucket: bucketOf(window.windowMs ? Math.round(window.windowMs / 60_000) : null),
      })),
      loading: quota.loading,
      stale: quota.stale,
      hasError: Boolean(quota.error),
      notConfigured: quota.error?.code === 'not-configured',
    });
  }
  for (const provider of state.extraProviders) {
    if (!provider.configured && !provider.snapshot) continue;
    push({
      key: agentQuotaKey(provider.providerId),
      label: provider.providerName,
      remainingPercent: provider.snapshot
        ? minRemaining(provider.snapshot.windows.map((window) => window.remainingPercent))
        : null,
      balanceText: null,
      windows:
        provider.snapshot?.windows.map((window) => ({
          label: window.label,
          remainingPercent: window.remainingPercent,
          resetsAt: window.resetsAt,
          bucket: bucketOf(window.windowMs ? Math.round(window.windowMs / 60_000) : null),
        })) ?? [],
      loading: provider.loading,
      stale: provider.stale,
      hasError: Boolean(provider.error),
      notConfigured: provider.error?.code === 'not-configured',
    });
  }
  for (const entry of state.router.quota) {
    push({
      key: routerQuotaIdentity(entry.providerId, entry.strategyId),
      label: entry.providerName,
      remainingPercent: entry.windows.length
        ? minRemaining(entry.windows.map((window) => Math.max(0, 100 - window.usedPercent)))
        : null,
      balanceText: entry.balance !== null ? formatBalance(entry.balance, entry.currency) : null,
      windows: entry.windows.map((window) => ({
        label: window.label,
        remainingPercent: Math.max(0, 100 - window.usedPercent),
        resetsAt: null,
        bucket: bucketOf(window.windowMinutes),
      })),
      loading: false,
      stale: false,
      hasError: Boolean(entry.error),
      notConfigured: false,
    });
  }
  return [...byKey.values()];
}

export function pickTarget(state: AppState, targets: OrbTarget[]): OrbTarget | null {
  const wanted = state.settings.orbTargetKey;
  if (wanted) {
    const exact = targets.find((target) => target.key === wanted);
    if (exact) return exact;
  }
  return targets.find((target) => target.remainingPercent !== null) ?? targets[0] ?? null;
}

/** Resolve what the orb shows for a target under the selected quota view. */
export function resolveOrbView(
  target: OrbTarget | null,
  view: OrbQuotaView,
): { percent: number | null; balanceText: string | null } {
  if (!target) return { percent: null, balanceText: null };
  if (view === 'money') return { percent: null, balanceText: target.balanceText };
  if (view !== 'all') {
    const window = target.windows.find((entry) => entry.bucket === view);
    if (window) return { percent: window.remainingPercent, balanceText: null };
    return { percent: null, balanceText: null };
  }
  return { percent: target.remainingPercent, balanceText: target.balanceText };
}
