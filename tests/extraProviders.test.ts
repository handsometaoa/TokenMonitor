import { describe, expect, it } from 'vitest';
import { fetchCodexSnapshot } from '../src/main/providers/extra/codex';
import { fetchClaudeSnapshot } from '../src/main/providers/extra/claude';
import { fetchCursorSnapshot } from '../src/main/providers/extra/cursor';
import { fetchZaiSnapshot } from '../src/main/providers/extra/zai';
import type { ExtraFetch, ExtraProviderCredential } from '../src/main/providers/extra/types';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchJson(body: unknown, status = 200): ExtraFetch {
  return async () => response(body, status);
}

const credential = (providerId: ExtraProviderCredential['providerId'], value = 'test', extra = {}): ExtraProviderCredential => ({
  providerId,
  value,
  source: 'manual',
  ...extra,
});

describe('extra provider adapters', () => {
  it('maps Codex primary and secondary windows', async () => {
    const snapshot = await fetchCodexSnapshot(
      credential('codex'),
      fetchJson({
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 32, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 61, reset_at: 1_800_500_000, limit_window_seconds: 604800 },
        },
      }),
    );
    expect(snapshot.providerId).toBe('codex');
    expect(snapshot.planLabel).toBe('Plus');
    expect(snapshot.windows.map((window) => window.id)).toEqual(['session', 'weekly']);
    expect(snapshot.windows[0].usedPercent).toBe(32);
  });

  it('maps Claude session, weekly and Sonnet windows', async () => {
    const snapshot = await fetchClaudeSnapshot(
      credential('claude', 'test', { planLabel: 'Max' }),
      fetchJson({
        five_hour: { utilization: 18, resets_at: '2026-11-24T04:00:00.000Z' },
        seven_day: { utilization: 42, resets_at: '2026-11-29T00:00:00.000Z' },
        seven_day_sonnet: { utilization: 30, resets_at: '2026-11-29T00:00:00.000Z' },
      }),
    );
    expect(snapshot.planLabel).toBe('Max');
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.windows.find((window) => window.id === 'sonnet')?.usedPercent).toBe(30);
  });

  it('maps Cursor plan percentages and billing cycle', async () => {
    const snapshot = await fetchCursorSnapshot(
      credential('cursor', 'WorkosCursorSessionToken=x'),
      fetchJson({
        membershipType: 'pro',
        billingCycleStart: '2026-11-01T00:00:00.000Z',
        billingCycleEnd: '2026-12-01T00:00:00.000Z',
        individualUsage: {
          plan: { totalPercentUsed: 47 },
          onDemand: { enabled: true, used: 1200, limit: 10000 },
        },
      }),
    );
    expect(snapshot.planLabel).toBe('Cursor pro');
    expect(snapshot.windows[0].usedPercent).toBe(47);
    expect(snapshot.windows[1].id).toBe('on-demand');
    expect(snapshot.windows[1].usedPercent).toBe(12);
  });

  it('maps Z.AI coding plan limits', async () => {
    const snapshot = await fetchZaiSnapshot(
      credential('zai', 'test', { region: 'global' }),
      fetchJson({
        success: true,
        code: 200,
        data: {
          planName: 'GLM Coding Plan',
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 24, nextResetTime: 1_800_000_000_000 },
            { type: 'TOKENS_LIMIT', unit: 1, number: 7, percentage: 53, nextResetTime: 1_800_500_000_000 },
          ],
        },
      }),
    );
    expect(snapshot.planLabel).toBe('GLM Coding Plan');
    expect(snapshot.windows[0].id).toBe('session');
    expect(snapshot.windows[0].windowMs).toBe(5 * 60 * 60 * 1000);
    expect(snapshot.windows[1].id).toBe('weekly');
  });

  it('marks ZCode as its own provider when using the BigModel quota', async () => {
    const snapshot = await fetchZaiSnapshot(
      credential('zcode', 'test', { region: 'bigmodel-cn', planLabel: 'BigModel Coding Plan' }),
      fetchJson({
        success: true,
        code: 200,
        data: { limits: [{ type: 'TOKENS_LIMIT', unit: 5, number: 300, percentage: 12 }] },
      }),
    );
    expect(snapshot.providerId).toBe('zcode');
    expect(snapshot.providerName).toBe('ZCode');
    expect(snapshot.planLabel).toBe('BigModel Coding Plan');
  });

  it('maps 401 to a credential error', async () => {
    await expect(fetchCodexSnapshot(credential('codex'), fetchJson({}, 401))).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});
