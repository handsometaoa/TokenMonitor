import type { RawUsageSnapshot } from './api';

export function buildDemoRawSnapshot(now = Date.now()): RawUsageSnapshot {
  return {
    fetchedAt: now,
    planLabel: 'OpenCode Go',
    windows: [
      {
        id: 'rolling',
        usedPercent: 12,
        status: 'ok',
        resetsAt: new Date(now + 75 * 60 * 1000).toISOString(),
      },
      {
        id: 'weekly',
        usedPercent: 14,
        status: 'ok',
        resetsAt: new Date(now + (5 * 24 + 13) * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'monthly',
        usedPercent: 19,
        status: 'ok',
        resetsAt: new Date(now + (23 * 24 + 21) * 60 * 60 * 1000).toISOString(),
      },
    ],
  };
}
