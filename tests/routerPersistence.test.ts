import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterRepository } from '../src/main/router/db';

const dirs: string[] = [];
const repositories: RouterRepository[] = [];
const rawDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const database of rawDatabases.splice(0)) {
    try {
      database.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore Windows cleanup errors.
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-persistence-'));
  dirs.push(dir);
  return dir;
}

function repository(): RouterRepository {
  const repo = new RouterRepository(tempDir());
  repositories.push(repo);
  return repo;
}

function rawDatabase(dir: string): DatabaseSync {
  const database = new DatabaseSync(join(dir, 'router.db'));
  rawDatabases.push(database);
  return database;
}

function logRequest(repo: RouterRepository, requestId: string, breakdown?: boolean): void {
  repo.startLog({
    requestId,
    publicModel: 'model-a',
    providerName: 'Mock',
    upstreamModel: 'upstream-a',
    providerId: 'provider-1',
    modelId: 'model-1',
    client: 'test',
    path: '/v1/chat/completions',
    stream: false,
    requestBody: null,
    requestHeaders: null,
  });
  repo.finishLog({
    requestId,
    status: 200,
    stream: false,
    breakdown: breakdown
      ? { system: 1, tools: 2, user: 3, toolResults: 4, assistant: 5 }
      : null,
    promptTokens: 15,
    completionTokens: 5,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unrecognizedTokens: 0,
    totalTokens: 20,
    responseBody: null,
    responseHeaders: null,
    error: null,
    retryTrace: null,
  });
}

describe('router database persistence hardening', () => {
  it('reconciles missing migration columns transactionally and remains idempotent', () => {
    const dir = tempDir();
    const initial = new RouterRepository(dir);
    logRequest(initial, 'before-migration', true);
    initial.close();

    const legacy = rawDatabase(dir);
    legacy.exec(`
      ALTER TABLE request_logs DROP COLUMN ttft_ms;
      ALTER TABLE request_logs DROP COLUMN token_breakdown;
      ALTER TABLE usage_daily DROP COLUMN ttft_ms;
      ALTER TABLE usage_daily DROP COLUMN ttft_samples;
      ALTER TABLE usage_daily DROP COLUMN generation_ms;
      ALTER TABLE usage_hourly DROP COLUMN ttft_ms;
      ALTER TABLE usage_hourly DROP COLUMN ttft_samples;
      ALTER TABLE usage_hourly DROP COLUMN generation_ms;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new RouterRepository(dir);
    repositories.push(migrated);
    const check = rawDatabase(dir);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
    expect(check.prepare('SELECT request_id, token_breakdown FROM request_logs').get()?.request_id).toBe('before-migration');
    expect(check.prepare('SELECT request_count, total_tokens FROM usage_daily').get()).toMatchObject({
      request_count: 1,
      total_tokens: 20,
    });
    expect(() => check.prepare('SELECT ttft_ms FROM request_logs').get()).not.toThrow();
    expect(() => check.prepare('SELECT generation_ms FROM usage_hourly').get()).not.toThrow();
    migrated.close();

    const reopened = new RouterRepository(dir);
    repositories.push(reopened);
    expect(reopened.listLogs({ limit: 10 }).total).toBe(1);
  });

  it('rejects future and invalid schema versions without changing them', () => {
    for (const version of [5, -1]) {
      const dir = tempDir();
      const database = rawDatabase(dir);
      database.exec(`PRAGMA user_version = ${version};`);
      database.close();

      expect(() => new RouterRepository(dir)).toThrow(
        version > 4 ? 'Unsupported router database schema version' : 'Invalid router database schema version',
      );
      const check = rawDatabase(dir);
      expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(version);
    }
  });

  it('keeps legacy service and balance config coercions and defaults', () => {
    const repo = repository();
    repo.setSetting(
      'router.service',
      JSON.stringify({ enabled: 0, port: '9000', apiKey: 42, proxyUrl: null, captureBodies: 0 }),
    );
    expect(repo.getServiceConfig()).toEqual({
      enabled: true,
      port: 9000,
      apiKey: '',
      proxyUrl: '',
      captureBodies: true,
    });

    repo.setSetting(
      'router.balancing',
      JSON.stringify({ enabled: false, sessionAffinity: 0, quotaGuard: null, maxAttempts: '99' }),
    );
    expect(repo.getBalanceConfig()).toEqual({
      enabled: false,
      sessionAffinity: true,
      quotaGuard: true,
      maxAttempts: 5,
    });

    repo.setSetting('router.balancing', JSON.stringify({ maxAttempts: 0 }));
    expect(repo.getBalanceConfig().maxAttempts).toBe(3);
    repo.setSetting('router.service', '[]');
    expect(repo.getServiceConfig()).toEqual({
      enabled: false,
      port: 8787,
      apiKey: '',
      proxyUrl: '',
      captureBodies: true,
    });
  });

  it('skips provider rows that fail runtime validation', () => {
    const dir = tempDir();
    const repo = new RouterRepository(dir);
    repositories.push(repo);
    const provider = repo.saveProvider({
      name: 'Mock',
      protocol: 'openai',
      kind: 'custom',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });
    const raw = rawDatabase(dir);
    raw.prepare('UPDATE providers SET protocol = ? WHERE id = ?').run('not-a-protocol', provider.id);
    expect(repo.getProvider(provider.id)).toBeNull();
    expect(repo.listProviders(true)).toEqual([]);

    raw.prepare('UPDATE providers SET protocol = ?, enabled = ? WHERE id = ?').run('openai', 2, provider.id);
    expect(repo.getProvider(provider.id)).toBeNull();
  });

  it('validates persisted quota snapshot JSON', () => {
    const dir = tempDir();
    const repo = new RouterRepository(dir);
    repositories.push(repo);
    const now = Date.now();
    const snapshot = {
      providerId: 'provider-1',
      providerName: 'Mock',
      strategyId: null,
      strategyLabel: null,
      windows: [],
      balance: null,
      currency: null,
      details: [],
      error: null,
      queriedAt: now,
    };
    repo.saveQuotaSnapshot({ providerId: 'provider-1', snapshot, error: null, queriedAt: now });
    const raw = rawDatabase(dir);

    raw.prepare('UPDATE quota_snapshots SET snapshot = ? WHERE provider_id = ?').run('{broken', 'provider-1');
    expect(repo.getQuotaSnapshot('provider-1')).toEqual({ snapshot: null, queriedAt: now });
    expect(repo.listQuotaSnapshots()[0]?.snapshot).toBeNull();

    raw.prepare('UPDATE quota_snapshots SET snapshot = ? WHERE provider_id = ?').run('{}', 'provider-1');
    expect(repo.getQuotaSnapshot('provider-1')?.snapshot).toBeNull();
  });

  it('ignores malformed token breakdown JSON while retaining valid usage', () => {
    const dir = tempDir();
    const repo = new RouterRepository(dir);
    repositories.push(repo);
    logRequest(repo, 'valid-breakdown', true);
    logRequest(repo, 'invalid-breakdown', true);
    const raw = rawDatabase(dir);
    raw.prepare('UPDATE request_logs SET token_breakdown = ? WHERE request_id = ?').run('{broken', 'invalid-breakdown');

    const usage = repo.getUsage('7d');
    expect(usage.totals.requestCount).toBe(2);
    expect(usage.totals.totalTokens).toBe(40);
    expect(usage.breakdown).toEqual({
      system: 1,
      tools: 2,
      user: 3,
      toolResults: 4,
      assistant: 5,
      reasoning: 0,
      reply: 5,
    });
  });
});
