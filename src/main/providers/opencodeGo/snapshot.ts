import { computePace, WINDOW_DURATION_MS } from '../../services/pace';
import type { ProviderSnapshot, QuotaWindowView } from '../../../shared/types';
import type { RawUsageSnapshot } from './api';

export function buildProviderSnapshot(
  raw: RawUsageSnapshot,
  source: ProviderSnapshot['source'],
  now = Date.now(),
): ProviderSnapshot {
  const windows: QuotaWindowView[] = raw.windows.map((window) => {
    const remainingPercent = Math.min(100, Math.max(0, 100 - window.usedPercent));
    const windowMs = WINDOW_DURATION_MS[window.id];
    return {
      id: window.id,
      usedPercent: window.usedPercent,
      remainingPercent,
      resetsAt: window.resetsAt,
      status: window.status,
      windowMs,
      pace: computePace({
        id: window.id,
        usedPercent: window.usedPercent,
        remainingPercent,
        resetsAt: window.resetsAt,
        now,
        windowMs,
      }),
    };
  });

  return {
    providerId: 'opencode-go',
    providerName: 'OpenCode',
    planLabel: raw.planLabel,
    fetchedAt: raw.fetchedAt,
    windows,
    source,
  };
}
