import { describe, expect, it } from 'vitest';
import { fetchClaudeSnapshot } from '../src/main/providers/extra/claude';
import { fetchCodexSnapshot } from '../src/main/providers/extra/codex';
import { fetchCursorSnapshot } from '../src/main/providers/extra/cursor';
import type { ExtraFetch, ExtraProviderCredential } from '../src/main/providers/extra/types';
import { fetchZaiSnapshot } from '../src/main/providers/extra/zai';
import { OpenCodeGoUsageApi } from '../src/main/providers/opencodeGo/api';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchJson(body: unknown): ExtraFetch {
  return async () => response(body);
}

function credential(providerId: ExtraProviderCredential['providerId']): ExtraProviderCredential {
  return { providerId, value: 'test', source: 'manual' };
}

describe('provider external boundaries', () => {
  it('keeps valid Claude windows when optional windows are malformed', async () => {
    const snapshot = await fetchClaudeSnapshot(
      credential('claude'),
      fetchJson({
        five_hour: [],
        seven_day: { utilization: 42, resets_at: '2026-11-29T00:00:00.000Z' },
        seven_day_sonnet: { utilization: '30' },
      }),
    );
    expect(snapshot.windows.map((window) => window.id)).toEqual(['weekly']);
  });

  it('keeps the valid Codex secondary window when the primary window is malformed', async () => {
    const snapshot = await fetchCodexSnapshot(
      credential('codex'),
      fetchJson({
        rate_limit: {
          primary_window: { used_percent: '32' },
          secondary_window: { used_percent: 61, limit_window_seconds: 604800 },
        },
      }),
    );
    expect(snapshot.windows.map((window) => window.id)).toEqual(['weekly']);
  });

  it('skips malformed Z.AI limits without discarding valid limits', async () => {
    const snapshot = await fetchZaiSnapshot(
      credential('zai'),
      fetchJson({
        success: true,
        code: 200,
        data: {
          limits: [
            null,
            [],
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 24 },
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 'bad' },
          ],
        },
      }),
    );
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]).toMatchObject({ id: 'session', usedPercent: 24 });
  });

  it('returns null for out-of-range string and numeric resets', async () => {
    const claude = await fetchClaudeSnapshot(
      credential('claude'),
      fetchJson({ five_hour: { utilization: 10, resets_at: '999999999999999999999999' } }),
    );
    const codex = await fetchCodexSnapshot(
      credential('codex'),
      fetchJson({ rate_limit: { primary_window: { used_percent: 10, reset_at: 1e30 } } }),
    );
    const cursor = await fetchCursorSnapshot(
      credential('cursor'),
      fetchJson({
        membershipType: 'pro',
        billingCycleEnd: '+275760-09-13T00:00:00.001Z',
        individualUsage: { plan: { totalPercentUsed: 10 } },
      }),
    );
    expect(claude.windows[0]?.resetsAt).toBeNull();
    expect(codex.windows[0]?.resetsAt).toBeNull();
    expect(cursor.windows[0]?.resetsAt).toBeNull();
  });

  it('returns null for an out-of-range relative OpenCode reset', async () => {
    const now = Date.parse('+275760-09-13T00:00:00.000Z');
    const snapshot = await new OpenCodeGoUsageApi(
      async () => response({ usage: { rolling: { percent: 10, resetInSec: 1 } } }),
    ).fetchUsage('key', '', now);
    expect(snapshot.windows[0]?.resetsAt).toBeNull();
  });

  it('silently omits Codex reset credits for malformed optional JSON', async () => {
    const fetchImpl: ExtraFetch = async (url) => {
      if (url.includes('rate-limit-reset-credits')) return new Response('not-json', { status: 200 });
      return response({ rate_limit: { primary_window: { used_percent: 10 } } });
    };
    const snapshot = await fetchCodexSnapshot(credential('codex'), fetchImpl);
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.resetCredits).toBeNull();
  });

  it('preserves the Z.AI no-subscription error code and message', async () => {
    await expect(
      fetchZaiSnapshot(credential('zai'), fetchJson({ success: false, code: 400, msg: 'Coding Plan 不存在' })),
    ).rejects.toMatchObject({ code: 'no-subscription', message: expect.stringContaining('Coding Plan 不存在') });
  });

  it('accepts intentional numeric-string OpenCode percentages', async () => {
    const snapshot = await new OpenCodeGoUsageApi(
      async () => response({ usage: { rolling: { percent: '12.5' } } }),
    ).fetchUsage('key');
    expect(snapshot.windows[0]?.usedPercent).toBe(12.5);
  });
});
