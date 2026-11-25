import { describe, expect, it } from 'vitest';
import { fetchCodexSnapshot } from '../src/main/providers/extra/codex';
import { fetchClaudeSnapshot } from '../src/main/providers/extra/claude';
import { fetchCursorSnapshot } from '../src/main/providers/extra/cursor';
import { fetchZaiSnapshot } from '../src/main/providers/extra/zai';
import type { ExtraFetch, ExtraProviderCredential } from '../src/main/providers/extra/types';
import { OpenCodeGoUsageApi } from '../src/main/providers/opencodeGo/api';
import {
  isRouterProtocol,
  isRouterProviderKind,
  isRouterUsageRange,
  quotaHistoryPointSchema,
  routerQuotaSnapshotSchema,
} from '../src/shared/routerSchemas';
import { isRecord, parseJson, safeInteger } from '../src/shared/validation';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fetchJson(body: unknown): ExtraFetch {
  return async () => response(body);
}

function credential(providerId: ExtraProviderCredential['providerId']): ExtraProviderCredential {
  return { providerId, value: 'test', source: 'manual' };
}

describe('shared runtime validation', () => {
  it('rejects arrays and primitives as records', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(isRecord({ ok: true })).toBe(true);
    expect(parseJson('null')).toBeNull();
  });

  it('converts only safe integer values', () => {
    expect(safeInteger(12)).toBe(12);
    expect(safeInteger(12n)).toBe(12);
    expect(safeInteger(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(safeInteger(1n << 80n)).toBeNull();
  });

  it('guards router unions', () => {
    expect(isRouterProtocol('openai')).toBe(true);
    expect(isRouterProtocol('invalid')).toBe(false);
    expect(isRouterProviderKind('opencode')).toBe(true);
    expect(isRouterProviderKind('invalid')).toBe(false);
    expect(isRouterUsageRange('7d')).toBe(true);
    expect(isRouterUsageRange('invalid')).toBe(false);
  });

  it('defaults legacy history reset fields and rejects malformed snapshots', () => {
    expect(quotaHistoryPointSchema.parse({ ts: 1, rolling: 10 })).toEqual({
      ts: 1,
      rolling: 10,
      weekly: null,
      monthly: null,
      rollingReset: null,
      weeklyReset: null,
      monthlyReset: null,
    });
    expect(routerQuotaSnapshotSchema.safeParse({ providerId: 'p', windows: null }).success).toBe(false);
  });
});

describe('provider malformed payload boundaries', () => {
  it.each([null, [], 'text', 42])('rejects non-object Codex payload %j', async (payload) => {
    await expect(fetchCodexSnapshot(credential('codex'), fetchJson(payload))).rejects.toMatchObject({ code: 'malformed' });
  });

  it.each([null, [], 'text', 42])('rejects non-object Claude payload %j', async (payload) => {
    await expect(fetchClaudeSnapshot(credential('claude'), fetchJson(payload))).rejects.toMatchObject({ code: 'malformed' });
  });

  it.each([null, [], 'text', 42])('rejects non-object Cursor payload %j', async (payload) => {
    await expect(fetchCursorSnapshot(credential('cursor'), fetchJson(payload))).rejects.toMatchObject({ code: 'malformed' });
  });

  it.each([null, [], 'text', 42])('rejects non-object Z.AI payload %j', async (payload) => {
    await expect(fetchZaiSnapshot(credential('zai'), fetchJson(payload))).rejects.toMatchObject({ code: 'malformed' });
  });

  it('returns null for out-of-range reset timestamps', async () => {
    const codex = await fetchCodexSnapshot(
      credential('codex'),
      fetchJson({ rate_limit: { primary_window: { used_percent: 10, reset_at: 1e30, limit_window_seconds: 18_000 } } }),
    );
    expect(codex.windows[0]?.resetsAt).toBeNull();

    const claude = await fetchClaudeSnapshot(
      credential('claude'),
      fetchJson({ five_hour: { utilization: 10, resets_at: 'not-a-date' } }),
    );
    expect(claude.windows[0]?.resetsAt).toBeNull();

    const opencode = await new OpenCodeGoUsageApi(async () =>
      response({ usage: { rolling: { percent: 10, resetsAt: 1e30 } } }),
    ).fetchUsage('key');
    expect(opencode.windows[0]?.resetsAt).toBeNull();
  });
});
