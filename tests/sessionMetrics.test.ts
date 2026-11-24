import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionMetricsService } from '../src/main/providers/opencodeGo/sessionMetrics';
import { Logger } from '../src/main/services/logger';
import { SettingsStore } from '../src/main/services/settings';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows.
    }
  }
});

function createDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-session-'));
  tempDirs.push(dir);
  return join(dir, 'opencode.db');
}

function messageData(input: {
  role: 'user' | 'assistant';
  parentId?: string;
  created: number;
  completed?: number;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
}): string {
  if (input.role === 'user') {
    return JSON.stringify({ role: 'user', time: { created: input.created } });
  }
  return JSON.stringify({
    role: 'assistant',
    parentID: input.parentId,
    providerID: input.provider ?? 'opencode',
    modelID: input.model ?? 'big-pickle',
    time: { created: input.created, completed: input.completed },
    tokens: {
      input: input.input ?? 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: { read: input.cacheRead ?? 0, write: 0 },
    },
  });
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
}

function insertMessage(
  db: DatabaseSync,
  id: string,
  ts: number,
  data: string,
  sessionId = 'ses_1',
): void {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    ts,
    ts,
    data,
  );
}

function insertPart(
  db: DatabaseSync,
  id: string,
  messageId: string,
  ts: number,
  updated: number,
  data: Record<string, unknown>,
): void {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    messageId,
    'ses_1',
    ts,
    updated,
    JSON.stringify(data),
  );
}

function createTwoStepDatabase(): { path: string; base: number } {
  const path = createDb();
  const db = new DatabaseSync(path);
  createSchema(db);
  const base = Date.now() - 2 * 60 * 60 * 1000;

  insertMessage(db, 'u1', base, messageData({ role: 'user', created: base }));
  insertMessage(
    db,
    'a1',
    base + 100,
    messageData({
      role: 'assistant',
      parentId: 'u1',
      created: base + 100,
      completed: base + 2_700,
      input: 200,
      output: 50,
      reasoning: 150,
      cacheRead: 1000,
    }),
  );
  insertPart(db, 'a1-start', 'a1', base + 100, base + 101, { type: 'step-start' });
  insertPart(db, 'a1-reasoning', 'a1', base + 700, base + 1_700, {
    type: 'reasoning',
    text: 'private reasoning',
    time: { start: base + 700, end: base + 1_700 },
  });
  insertPart(db, 'a1-text', 'a1', base + 1_700, base + 2_300, {
    type: 'text',
    text: 'private answer',
    time: { start: base + 1_700, end: base + 2_300 },
  });
  insertPart(db, 'a1-finish', 'a1', base + 2_400, base + 2_401, {
    type: 'step-finish',
    tokens: { input: 200, output: 50, reasoning: 150, cache: { read: 1000, write: 0 } },
  });

  insertMessage(
    db,
    'a2',
    base + 2_800,
    messageData({
      role: 'assistant',
      parentId: 'u1',
      created: base + 2_800,
      completed: base + 5_000,
      input: 100,
      output: 10,
    }),
  );
  insertPart(db, 'a2-start', 'a2', base + 3_000, base + 3_001, { type: 'step-start' });
  insertPart(db, 'a2-text', 'a2', base + 3_400, base + 3_900, {
    type: 'text',
    text: 'private answer 2',
    time: { start: base + 3_400, end: base + 3_900 },
  });
  insertPart(db, 'a2-finish', 'a2', base + 3_950, base + 3_951, {
    type: 'step-finish',
    tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
  });

  db.close();
  return { path, base };
}

function serviceFor(dbPath: string): SessionMetricsService {
  const settingsDir = mkdtempSync(join(tmpdir(), 'tokenmonitor-settings-'));
  tempDirs.push(settingsDir);
  const settings = new SettingsStore(settingsDir);
  settings.update({ localDataPath: dbPath, localUsageEnabled: true });
  return new SessionMetricsService(settings, new Logger(settingsDir), false);
}

describe('SessionMetricsService', () => {
  it('replays TTFT, output speed, prefill speed and turn duration', async () => {
    const { path } = createTwoStepDatabase();
    const metrics = await serviceFor(path).getMetrics('7d');

    expect(metrics.source).toBe('sqlite');
    expect(metrics.approximate).toBe(true);
    expect(metrics.totals.steps).toBe(2);
    expect(metrics.totals.turns).toBe(1);

    expect(metrics.totals.avgTtftMs).toBe(600);
    expect(metrics.totals.p50TtftMs).toBe(600);
    expect(metrics.totals.p95TtftMs).toBe(600);

    expect(metrics.totals.outputTokens).toBe(210);
    expect(metrics.totals.outputTps).toBe(100);
    expect(metrics.totals.prefillTps).toBe(250);
    expect(metrics.totals.turnMs).toBe(5_000);
    expect(metrics.totals.cacheHitPercent).toBeCloseTo((1000 / 1300) * 100, 6);

    expect(metrics.models).toHaveLength(1);
    expect(metrics.models[0].provider).toBe('opencode');
    expect(metrics.models[0].model).toBe('big-pickle');
    expect(metrics.models[0].steps).toBe(2);
    expect(metrics.models[0].turns).toBe(1);
    expect(metrics.models[0].outputTps).toBe(100);
    expect(metrics.models[0].prefillTps).toBe(250);
    expect(metrics.models[0].turnMs).toBe(5_000);
    expect(metrics.models[0].points).toHaveLength(1);
  });

  it('falls back to message tokens when a step has no step-finish part', async () => {
    const path = createDb();
    const db = new DatabaseSync(path);
    createSchema(db);
    const base = Date.now() - 60 * 60 * 1000;

    insertMessage(db, 'u1', base, messageData({ role: 'user', created: base }));
    insertMessage(
      db,
      'a1',
      base + 100,
      messageData({
        role: 'assistant',
        parentId: 'u1',
        created: base + 100,
        completed: base + 1_100,
        input: 40,
        output: 20,
        cacheRead: 60,
      }),
    );
    insertPart(db, 'a1-start', 'a1', base + 100, base + 101, { type: 'step-start' });
    insertPart(db, 'a1-text', 'a1', base + 500, base + 1_000, {
      type: 'text',
      text: 'private answer',
      time: { start: base + 500, end: base + 1_000 },
    });
    db.close();

    const metrics = await serviceFor(path).getMetrics('7d');
    expect(metrics.totals.steps).toBe(1);
    expect(metrics.totals.avgTtftMs).toBe(400);
    expect(metrics.totals.outputTokens).toBe(20);
    expect(metrics.totals.outputTps).toBe(40);
    expect(metrics.totals.prefillTps).toBe(100);
    expect(metrics.totals.turnMs).toBe(1_100);
    expect(metrics.totals.cacheHitPercent).toBeCloseTo((60 / 100) * 100, 6);
  });

  it('returns a missing-database result rather than throwing', async () => {
    const missing = join(tmpdir(), 'tokenmonitor-history-does-not-exist', 'opencode.db');
    const metrics = await serviceFor(missing).getMetrics('7d');
    expect(metrics.source).toBe('none');
    expect(metrics.error?.code).toBe('missing');
    expect(metrics.totals.steps).toBe(0);
  });
});
