import { describe, expect, it } from 'vitest';
import type { RouterProviderRow } from '../src/main/router/db';
import { executeQuotaStrategy } from '../src/main/router/quota';

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('quota external boundaries', () => {
  it.each([
    ['opencode', 'OpenCode'],
    ['deepseek', 'DeepSeek'],
  ])('returns a consistent object-shape error for %s', async (strategyId, label) => {
    const snapshot = await executeQuotaStrategy(
      strategyId,
      providerRow({ quotaStrategyId: strategyId }),
      'key',
      async () => jsonResponse([]),
    );
    expect(snapshot.error).toBe(`${label} 响应格式无效，应为 JSON 对象`);
  });

  it('returns a consistent JSON parse error', async () => {
    const snapshot = await executeQuotaStrategy(
      'opencode',
      providerRow(),
      'key',
      async () => new Response('not-json', { status: 200 }),
    );
    expect(snapshot.error).toBe('OpenCode 响应无法解析为 JSON');
  });

  it('reuses the OpenCode window schema and keeps valid optional windows', async () => {
    const snapshot = await executeQuotaStrategy(
      'opencode',
      providerRow(),
      'key',
      async () =>
        jsonResponse({
          usage: {
            rolling: { percent: '12.5', resetsAt: '2026-11-24T12:00:00.000Z' },
            weekly: [],
            monthly: { used_percent: '25' },
          },
        }),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows.map((window) => window.id)).toEqual(['rolling', 'monthly']);
    expect(snapshot.windows[0]).toMatchObject({ usedPercent: 12.5, resetsAt: Date.parse('2026-11-24T12:00:00.000Z') });
    expect(snapshot.windows[1]?.usedPercent).toBe(25);
  });

  it('keeps Custom HTTP array-root path semantics', async () => {
    const snapshot = await executeQuotaStrategy(
      'custom-http',
      providerRow({
        quotaStrategyId: 'custom-http',
        strategyConfig: {
          url: 'https://api.example.com/quota',
          percentPath: '0.usedPercent',
          balancePath: '1.balance',
        },
      }),
      'key',
      async () => jsonResponse([{ usedPercent: 42 }, { balance: 3.5 }]),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows[0]?.usedPercent).toBe(42);
    expect(snapshot.balance).toBe(3.5);
  });

  it('keeps Custom JS getJSON payloads permissive', async () => {
    const snapshot = await executeQuotaStrategy(
      'custom-js',
      providerRow({
        quotaStrategyId: 'custom-js',
        strategyConfig: {
          script:
            "const response = await getJSON('https://api.example.com/quota'); return { windows: [{ id: 'js', label: 'JS', usedPercent: response.json[0].usedPercent, resetsAt: null, windowMinutes: 60 }], balance: null, currency: null, details: [] };",
        },
      }),
      'key',
      async () => jsonResponse([{ usedPercent: 37 }]),
    );
    expect(snapshot.error).toBeNull();
    expect(snapshot.windows[0]).toMatchObject({ id: 'js', usedPercent: 37, windowMinutes: 60 });
  });
});
