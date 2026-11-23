import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalUsageService } from '../src/main/providers/opencodeGo/localUsage';
import { Logger } from '../src/main/services/logger';
import { SettingsStore } from '../src/main/services/settings';

const tempDirs: string[] = [];

function createDb(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-test-'));
  tempDirs.push(dir);
  return join(dir, name);
}

function assistant(ts: number, input: number, output: number, reasoning: number, cacheRead: number, provider = 'opencode', model = 'big-pickle'): string {
  return JSON.stringify({
    role: 'assistant',
    providerID: provider,
    modelID: model,
    time: { created: ts, completed: ts + 1000 },
    tokens: {
      total: input + output + reasoning + cacheRead,
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: 0 },
    },
    cost: 0,
  });
}

function createV1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const insert = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
  const dayOne = new Date(2026, 10, 20, 10, 0, 0).getTime();
  insert.run('msg_1', 'ses_1', dayOne, dayOne, assistant(dayOne, 100, 20, 5, 1000));
  insert.run(
    'msg_2',
    'ses_1',
    dayOne + 1000,
    dayOne + 1000,
    assistant(dayOne + 1000, 50, 10, 0, 500, 'deepseek', 'deepseek-v4-flash'),
  );
  insert.run('msg_user', 'ses_1', dayOne + 2000, dayOne + 2000, JSON.stringify({ role: 'user', time: { created: dayOne } }));
  db.close();
}

function createMixedDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  const ts = new Date(2026, 10, 21, 12, 0, 0).getTime();
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    'msg_dup',
    'ses_1',
    ts,
    ts,
    assistant(ts, 999, 999, 999, 999),
  );
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    'msg_legacy',
    'ses_1',
    ts + 1,
    ts + 1,
    assistant(ts + 1, 7, 3, 0, 10),
  );
  db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'msg_dup',
    'ses_1',
    'assistant',
    1,
    ts,
    ts,
    JSON.stringify({
      type: 'assistant',
      model: { providerID: 'opencode', id: 'glm-5.2' },
      time: { created: ts },
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 100, write: 0 } },
      cost: 0,
    }),
  );
  db.close();
}

function serviceFor(dbPath: string): LocalUsageService {
  const settingsDir = mkdtempSync(join(tmpdir(), 'tokenmonitor-settings-'));
  tempDirs.push(settingsDir);
  const settings = new SettingsStore(settingsDir);
  settings.update({ localDataPath: dbPath, localUsageEnabled: true });
  return new LocalUsageService(settings, new Logger(settingsDir), false);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on Windows.
    }
  }
});

describe('LocalUsageService', () => {
  it('aggregates v1 assistant messages only and skips user rows', async () => {
    const dbPath = createDb('opencode.db');
    createV1Database(dbPath);
    const summary = await serviceFor(dbPath).getSummary('all');
    expect(summary.source).toBe('sqlite');
    expect(summary.schema).toBe('v1');
    expect(summary.messages).toBe(2);
    expect(summary.totals.input).toBe(150);
    expect(summary.totals.output).toBe(30);
    expect(summary.totals.reasoning).toBe(5);
    expect(summary.totals.cacheRead).toBe(1500);
    expect(summary.totals.total).toBe(1685);
    expect(summary.models).toHaveLength(2);
    expect(summary.days.some((day) => day.messages > 0)).toBe(true);
  });

  it('deduplicates v1 and v2 rows by message id and prefers v2', async () => {
    const dbPath = createDb('opencode.db');
    createMixedDatabase(dbPath);
    const summary = await serviceFor(dbPath).getSummary('all');
    expect(summary.schema).toBe('mixed');
    expect(summary.messages).toBe(2);
    expect(summary.totals.input).toBe(17);
    expect(summary.totals.output).toBe(5);
    expect(summary.totals.reasoning).toBe(1);
    expect(summary.totals.cacheRead).toBe(110);
    expect(summary.models.find((model) => model.model === 'glm-5.2')?.total).toBe(113);
  });

  it('returns a missing-database summary rather than throwing', async () => {
    const missing = join(tmpdir(), 'tokenmonitor-does-not-exist', 'opencode.db');
    const tooOld = await serviceFor(missing).getSummary('all');
    expect(tooOld.error?.code).toBe('missing');
    expect(tooOld.messages).toBe(0);
  });
});
