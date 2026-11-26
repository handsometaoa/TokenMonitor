import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterRepository } from '../src/main/router/db';
import { defined } from './helpers';

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

function repo(): RouterRepository {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-charts-'));
  dirs.push(dir);
  return new RouterRepository(dir);
}

function dayKey(daysAgo: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startedAt(daysAgo: number): number {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

function logRequest(
  db: RouterRepository,
  input: {
    requestId: string;
    daysAgo: number;
    client: string | null;
    providerName: string;
    publicModel?: string;
    totalTokens?: number;
  },
): void {
  db.startLog({
    requestId: input.requestId,
    publicModel: input.publicModel ?? 'model-a',
    providerName: input.providerName,
    upstreamModel: 'upstream-a',
    providerId: 'provider-1',
    modelId: 'model-1',
    client: input.client,
    path: '/v1/chat/completions',
    stream: false,
    requestBody: null,
    requestHeaders: null,
    startedAt: startedAt(input.daysAgo),
  });
  db.finishLog({
    requestId: input.requestId,
    status: 200,
    stream: false,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unrecognizedTokens: 0,
    totalTokens: input.totalTokens ?? 0,
    responseBody: null,
    responseHeaders: null,
    error: null,
    retryTrace: null,
  });
}

describe('router usage activity', () => {
  it('aggregates daily usage across models and fills missing days with zeros', () => {
    const db = repo();
    logRequest(db, { requestId: 'a-1', daysAgo: 0, client: 'Cursor', providerName: 'Mock', totalTokens: 100 });
    logRequest(db, {
      requestId: 'a-2',
      daysAgo: 0,
      client: 'Cursor',
      providerName: 'Mock',
      publicModel: 'model-b',
      totalTokens: 50,
    });
    logRequest(db, { requestId: 'a-3', daysAgo: 3, client: 'Cursor', providerName: 'Mock', totalTokens: 10 });

    const activity = db.getUsageActivity(7);
    expect(activity).toHaveLength(7);
    expect(defined(activity[0]).date).toBe(dayKey(6));
    expect(defined(activity[6]).date).toBe(dayKey(0));

    const byDate = new Map(activity.map((day) => [day.date, day]));
    expect(byDate.get(dayKey(0))).toEqual({ date: dayKey(0), requestCount: 2, totalTokens: 150 });
    expect(byDate.get(dayKey(3))).toEqual({ date: dayKey(3), requestCount: 1, totalTokens: 10 });
    expect(byDate.get(dayKey(1))).toEqual({ date: dayKey(1), requestCount: 0, totalTokens: 0 });
    expect(byDate.get(dayKey(6))).toEqual({ date: dayKey(6), requestCount: 0, totalTokens: 0 });
    db.close();
  });

  it('clamps the activity window to 1-90 days', () => {
    const db = repo();
    expect(db.getUsageActivity(0)).toHaveLength(1);
    const wide = db.getUsageActivity(500);
    expect(wide).toHaveLength(90);
    expect(defined(wide[0]).date).toBe(dayKey(89));
    expect(defined(wide[89]).date).toBe(dayKey(0));
    db.close();
  });
});

describe('router client provider flow', () => {
  it('groups requests by client, provider and model, mapping missing clients to unknown', () => {
    const db = repo();
    logRequest(db, { requestId: 'f-1', daysAgo: 0, client: 'Cursor', providerName: 'Mock A' });
    logRequest(db, { requestId: 'f-2', daysAgo: 0, client: 'Cursor', providerName: 'Mock A' });
    logRequest(db, { requestId: 'f-3', daysAgo: 1, client: 'Cursor', providerName: 'Mock B', publicModel: 'model-b', totalTokens: 500 });
    logRequest(db, { requestId: 'f-4', daysAgo: 2, client: null, providerName: 'Mock A' });
    logRequest(db, { requestId: 'f-5', daysAgo: 2, client: '', providerName: 'Mock A' });
    logRequest(db, { requestId: 'f-6', daysAgo: 3, client: 'Claude Code', providerName: 'Mock B', publicModel: 'model-b', totalTokens: 300 });

    const flow = db.getClientProviderFlow(7);
    expect(flow).toEqual([
      { client: 'Cursor', providerName: 'Mock A', publicModel: 'model-a', requestCount: 2, totalTokens: 0 },
      { client: 'unknown', providerName: 'Mock A', publicModel: 'model-a', requestCount: 2, totalTokens: 0 },
      { client: 'Claude Code', providerName: 'Mock B', publicModel: 'model-b', requestCount: 1, totalTokens: 300 },
      { client: 'Cursor', providerName: 'Mock B', publicModel: 'model-b', requestCount: 1, totalTokens: 500 },
    ]);
    db.close();
  });

  it('caps the flow window at the 7 day log retention', () => {
    const db = repo();
    logRequest(db, { requestId: 'g-1', daysAgo: 10, client: 'Cursor', providerName: 'Mock' });
    logRequest(db, { requestId: 'g-2', daysAgo: 0, client: 'Cursor', providerName: 'Mock' });

    expect(db.getClientProviderFlow(30)).toEqual([
      { client: 'Cursor', providerName: 'Mock', publicModel: 'model-a', requestCount: 1, totalTokens: 0 },
    ]);
    expect(db.getClientProviderFlow(1)).toEqual([
      { client: 'Cursor', providerName: 'Mock', publicModel: 'model-a', requestCount: 1, totalTokens: 0 },
    ]);
    db.close();
  });
});
