import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QuotaHistory } from '../src/main/services/history';
import { Logger } from '../src/main/services/logger';
import type { QuotaHistoryPoint } from '../src/shared/types';

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

function setup(): { dir: string; historyDir: string; logger: Logger } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-history-persistence-'));
  dirs.push(dir);
  const historyDir = join(dir, 'quota-history');
  mkdirSync(historyDir, { recursive: true });
  return { dir, historyDir, logger: new Logger(dir) };
}

function monthKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function point(ts: number, rolling = 10): QuotaHistoryPoint {
  return {
    ts,
    rolling,
    weekly: null,
    monthly: null,
    rollingReset: null,
    weeklyReset: null,
    monthlyReset: null,
  };
}

describe('quota history persistence hardening', () => {
  it('skips malformed lines and keeps searching older lines and files', () => {
    const { dir, historyDir, logger } = setup();
    const now = Date.now();
    const currentFile = join(historyDir, `${monthKey(now)}.jsonl`);
    const older = new Date(now);
    older.setDate(1);
    older.setMonth(older.getMonth() - 1);
    const olderFile = join(historyDir, `${monthKey(older.getTime())}.jsonl`);
    const olderTs = older.getTime();
    writeFileSync(currentFile, `${JSON.stringify(point(now - 2_000))}\n{broken\n${JSON.stringify({ ts: 'bad' })}\n`);
    writeFileSync(olderFile, `${JSON.stringify({ ts: olderTs })}\n`);

    const history = new QuotaHistory(dir, logger);
    expect(history.getLatestPoint()).toEqual({
      ts: now - 2_000,
      rolling: 10,
      weekly: null,
      monthly: null,
      rollingReset: null,
      weeklyReset: null,
      monthlyReset: null,
    });

    writeFileSync(currentFile, '{broken\n');
    const fallback = new QuotaHistory(dir, logger);
    expect(fallback.getLatestPoint()).toEqual({
      ts: olderTs,
      rolling: null,
      weekly: null,
      monthly: null,
      rollingReset: null,
      weeklyReset: null,
      monthlyReset: null,
    });
  });

  it('validates every returned JSONL point', () => {
    const { dir, historyDir, logger } = setup();
    const now = Date.now();
    const recent = point(now - 60 * 60 * 1000, 20);
    const older = point(now - 2 * 60 * 60 * 1000, 30);
    writeFileSync(
      join(historyDir, `${monthKey(now)}.jsonl`),
      [
        JSON.stringify(recent),
        '{broken',
        JSON.stringify({ ts: now - 90 * 60 * 1000, rolling: 'not-a-number' }),
        JSON.stringify(older),
        '',
      ].join('\n'),
    );

    const history = new QuotaHistory(dir, logger);
    expect(history.getPoints(3)).toEqual([older, recent]);
  });

  it('only deletes valid YYYY-MM.jsonl files when clearing or pruning', () => {
    const { dir, historyDir, logger } = setup();
    const now = Date.now();
    const currentFile = join(historyDir, `${monthKey(now)}.jsonl`);
    const expiredFile = join(historyDir, '2000-01.jsonl');
    const invalidExpiredFile = join(historyDir, '2000-13.jsonl');
    const unrelatedFile = join(historyDir, 'notes.jsonl');
    writeFileSync(currentFile, `${JSON.stringify(point(now))}\n`);
    writeFileSync(expiredFile, `${JSON.stringify(point(now))}\n`);
    writeFileSync(invalidExpiredFile, 'keep');
    writeFileSync(unrelatedFile, 'keep');

    const history = new QuotaHistory(dir, logger);
    expect(existsSync(expiredFile)).toBe(false);
    expect(existsSync(invalidExpiredFile)).toBe(true);
    expect(existsSync(unrelatedFile)).toBe(true);

    history.clear();
    expect(existsSync(currentFile)).toBe(false);
    expect(existsSync(invalidExpiredFile)).toBe(true);
    expect(existsSync(unrelatedFile)).toBe(true);
  });
});
