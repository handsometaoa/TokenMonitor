import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { executeQuotaStrategy } from '../src/main/router/quota';
import type { RouterProviderRow } from '../src/main/router/db';
import { RouterRepository } from '../src/main/router/db';
import { RouterBalancer } from '../src/main/router/balancer';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore Windows cleanup errors.
    }
  }
});

function providerRow(overrides: Partial<RouterProviderRow> = {}): RouterProviderRow {
  return {
    id: 'provider-1',
    name: 'Test Provider',
    protocol: 'openai',
    kind: 'custom',
    baseUrl: 'https://api.example.com/v1',
    quotaStrategyId: 'opencode',
    strategyConfig: {},
    enabled: true,
    archivedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('router quota strategies', () => {
  it('parses OpenCode Go rolling, weekly and monthly windows', async () => {
    const snapshot = await executeQuotaStrategy(
      'opencode',
      providerRow(),
      'sk-test',
      async () =>
        new Response(
          JSON.stringify({
            usage: {
              rolling: { percent: 12, resetsAt: '2026-11-24T12:00:00.000Z' },
              weekly: { percent: 34, resetsAt: '2026-11-29T00:00:00.000Z' },
              monthly: { percent: 56, resetsAt: '2026-12-24T00:00:00.000Z' },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows).toHaveLength(3);
    expect(snapshot.windows[0]).toMatchObject({ id: 'rolling', usedPercent: 12, windowMinutes: 300 });
    expect(snapshot.windows[1]).toMatchObject({ id: 'weekly', usedPercent: 34, windowMinutes: 10_080 });
    expect(snapshot.windows[2]).toMatchObject({ id: 'monthly', usedPercent: 56, windowMinutes: 43_200 });
  });

  it('parses DeepSeek balance', async () => {
    const snapshot = await executeQuotaStrategy(
      'deepseek',
      providerRow({ quotaStrategyId: 'deepseek', kind: 'deepseek' }),
      'sk-test',
      async () =>
        new Response(JSON.stringify({ is_available: true, balance_infos: [{ total_balance: '12.34', currency: 'CNY' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.balance).toBe(12.34);
    expect(snapshot.currency).toBe('CNY');
    expect(snapshot.windows).toHaveLength(0);
  });

  it('parses OpenRouter credits', async () => {
    const snapshot = await executeQuotaStrategy(
      'openrouter',
      providerRow({ quotaStrategyId: 'openrouter', kind: 'openrouter' }),
      'sk-test',
      async () =>
        new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 3.5 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.balance).toBe(6.5);
    expect(snapshot.currency).toBe('USD');
  });

  it('parses MiniMax interval and weekly windows', async () => {
    const snapshot = await executeQuotaStrategy(
      'minimax',
      providerRow({ quotaStrategyId: 'minimax', kind: 'custom' }),
      'sk-test',
      async () =>
        new Response(
          JSON.stringify({
            data: {
              current_interval_usage_count: 30,
              current_interval_total_count: 100,
              current_weekly_usage_count: 200,
              current_weekly_total_count: 1000,
              points_balance: 50,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows).toHaveLength(2);
    expect(snapshot.windows[0]).toMatchObject({ id: 'interval', usedPercent: 30, windowMinutes: 300 });
    expect(snapshot.windows[1]).toMatchObject({ id: 'weekly', usedPercent: 20, windowMinutes: 10_080 });
    expect(snapshot.balance).toBe(50);
  });

  it('parses ElevenLabs character quota', async () => {
    const snapshot = await executeQuotaStrategy(
      'elevenlabs',
      providerRow({ quotaStrategyId: 'elevenlabs', kind: 'custom' }),
      'sk-test',
      async () =>
        new Response(JSON.stringify({ character_count: 400, character_limit: 1000, tier: 'creator' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows[0]).toMatchObject({ id: 'characters', usedPercent: 40 });
    expect(snapshot.details[0]).toEqual({ label: '套餐', value: 'creator' });
  });

  it('parses xAI management balance from cents', async () => {
    const snapshot = await executeQuotaStrategy(
      'xai',
      providerRow({ quotaStrategyId: 'xai', kind: 'xai', strategyConfig: { XAI_TEAM_ID: 'team-1' } }),
      'sk-test',
      async () =>
        new Response(JSON.stringify({ total: { val: '-1234' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.balance).toBe(12.34);
    expect(snapshot.currency).toBe('USD');
  });

  it('parses a self-hosted LiteLLM budget', async () => {
    const snapshot = await executeQuotaStrategy(
      'litellm',
      providerRow({ quotaStrategyId: 'litellm', kind: 'custom', baseUrl: 'https://gateway.example.com' }),
      'sk-test',
      async (input) => {
        expect(input).toBe('https://gateway.example.com/key/info');
        return new Response(JSON.stringify({ info: { spend: 2, max_budget: 10 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows[0]).toMatchObject({ id: 'budget', usedPercent: 20 });
    expect(snapshot.balance).toBe(8);
  });

  it('parses a custom HTTP quota config', async () => {
    const snapshot = await executeQuotaStrategy(
      'custom-http',
      providerRow({
        quotaStrategyId: 'custom-http',
        strategyConfig: {
          url: 'https://api.example.com/quota',
          percentPath: 'data.usedPercent',
          balancePath: 'data.balance',
          currency: 'USD',
          label: 'Weekly',
          windowMinutes: '10080',
        },
      }),
      'sk-test',
      async () =>
        new Response(JSON.stringify({ data: { usedPercent: 42, balance: 3.5 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows[0]).toMatchObject({ id: 'custom', label: 'Weekly', usedPercent: 42, windowMinutes: 10080 });
    expect(snapshot.balance).toBe(3.5);
  });

  it('runs an external Custom JS strategy', async () => {
    const snapshot = await executeQuotaStrategy(
      'custom-js',
      providerRow({
        quotaStrategyId: 'custom-js',
        strategyConfig: {
          script:
            "return { windows: [{ id: 'js', label: 'JS', usedPercent: 12, resetsAt: null, windowMinutes: 10080 }], balance: null, currency: null, details: [{ label: 'source', value: 'script' }] };",
        },
      }),
      'sk-test',
      async () => new Response('{}', { status: 200 }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows[0]).toMatchObject({ id: 'js', usedPercent: 12, windowMinutes: 10080 });
    expect(snapshot.details[0]).toEqual({ label: 'source', value: 'script' });
  });

  it('returns a readable error instead of throwing', async () => {
    const snapshot = await executeQuotaStrategy(
      'opencode',
      providerRow(),
      'sk-test',
      async () => new Response('unauthorized', { status: 401 }),
    );
    expect(snapshot.error).toContain('无效');
    expect(snapshot.windows).toHaveLength(0);
  });
});

describe('router quota guard', () => {
  it('blocks an exhausted channel until its reset time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-quota-'));
    dirs.push(dir);
    const repo = new RouterRepository(dir);
    const provider = repo.saveProvider({
      name: 'Mock',
      protocol: 'openai',
      kind: 'custom',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });
    repo.saveModel({
      providerId: provider.id,
      publicName: 'test-model',
      upstreamName: 'upstream-model',
      enabled: true,
    });
    repo.setBalanceConfig({ enabled: true, sessionAffinity: false, quotaGuard: true, maxAttempts: 2 });
    repo.saveQuotaSnapshot({
      providerId: provider.id,
      snapshot: {
        providerId: provider.id,
        providerName: 'Mock',
        strategyId: 'opencode',
        strategyLabel: 'OpenCode Go',
        windows: [{ id: 'rolling', label: '5-hour', usedPercent: 100, resetsAt: Date.now() + 60_000, windowMinutes: 300 }],
        balance: null,
        currency: null,
        details: [],
        error: null,
        queriedAt: Date.now(),
      },
      error: null,
      queriedAt: Date.now(),
    });
    const balancer = new RouterBalancer(repo);
    const routes = repo.findRoutes('test-model');
    const ordered = balancer.orderCandidates(
      routes,
      { enabled: true, sessionAffinity: false, quotaGuard: true, maxAttempts: 2 },
      null,
    );
    expect(ordered).toHaveLength(0);
    repo.close();
  });
});
