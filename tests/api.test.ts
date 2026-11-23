import { describe, expect, it } from 'vitest';
import { OpenCodeGoUsageApi, UsageApiError, type FetchLike } from '../src/main/providers/opencodeGo/api';

function fetchJson(body: unknown, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('OpenCodeGoUsageApi', () => {
  it('normalizes the current usage envelope and treats percent as used', async () => {
    const api = new OpenCodeGoUsageApi(
      fetchJson({
        usage: {
          rolling: { status: 'ok', percent: 12, resetsAt: '2026-11-24T02:00:00.000Z' },
          weekly: { status: 'ok', percent: 14, resetsAt: '2026-11-29T00:00:00.000Z' },
          monthly: { status: 'ok', percent: 19, resetsAt: '2026-12-18T00:00:00.000Z' },
        },
      }),
    );
    const snapshot = await api.fetchUsage('key');
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.windows[0].usedPercent).toBe(12);
    expect(snapshot.windows[0].resetsAt).toBe('2026-11-24T02:00:00.000Z');
  });

  it('accepts the legacy usage shape and resetInSec', async () => {
    const now = Date.parse('2026-11-24T00:00:00.000Z');
    const api = new OpenCodeGoUsageApi(
      fetchJson({
        rollingUsage: { usagePercent: 40, resetInSec: 3600 },
        weeklyUsage: { usagePercent: 20, resetInSec: 86400 },
      }),
    );
    const snapshot = await api.fetchUsage('key', '', now);
    expect(snapshot.windows.find((window) => window.id === 'rolling')?.usedPercent).toBe(40);
    expect(snapshot.windows.find((window) => window.id === 'rolling')?.resetsAt).toBe(
      new Date(now + 3600_000).toISOString(),
    );
  });

  it('maps 401 and 403 to actionable errors', async () => {
    await expect(new OpenCodeGoUsageApi(fetchJson({}, 401)).fetchUsage('bad')).rejects.toMatchObject({
      code: 'invalid-key',
    });
    await expect(new OpenCodeGoUsageApi(fetchJson({}, 403)).fetchUsage('zen')).rejects.toMatchObject({
      code: 'no-subscription',
    });
  });

  it('rejects a malformed response', async () => {
    const api = new OpenCodeGoUsageApi(fetchJson({ usage: {} }));
    await expect(api.fetchUsage('key')).rejects.toBeInstanceOf(UsageApiError);
    await expect(api.fetchUsage('key')).rejects.toMatchObject({ code: 'malformed' });
  });
});
