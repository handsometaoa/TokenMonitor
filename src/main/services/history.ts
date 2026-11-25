import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderSnapshot, QuotaHistoryPoint } from '../../shared/types';
import { quotaHistoryPointSchema } from '../../shared/routerSchemas';
import { parseJson } from '../../shared/validation';
import type { Logger } from './logger';

const MIN_APPEND_MS = 5 * 60 * 1000;
const RETENTION_DAYS = 90;
const HISTORY_FILE_NAME = /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/;

function isHistoryFileName(name: string): boolean {
  return HISTORY_FILE_NAME.test(name);
}

function monthKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function pointFromSnapshot(snapshot: ProviderSnapshot): QuotaHistoryPoint {
  const get = (id: 'rolling' | 'weekly' | 'monthly') => snapshot.windows.find((window) => window.id === id);
  return {
    ts: snapshot.fetchedAt,
    rolling: get('rolling')?.usedPercent ?? null,
    weekly: get('weekly')?.usedPercent ?? null,
    monthly: get('monthly')?.usedPercent ?? null,
    rollingReset: get('rolling')?.resetsAt ?? null,
    weeklyReset: get('weekly')?.resetsAt ?? null,
    monthlyReset: get('monthly')?.resetsAt ?? null,
  };
}

export class QuotaHistory {
  private readonly dir: string;
  private lastPoint: QuotaHistoryPoint | null = null;

  constructor(
    baseDir: string,
    private readonly logger: Logger,
  ) {
    this.dir = join(baseDir, 'quota-history');
    mkdirSync(this.dir, { recursive: true });
    this.lastPoint = this.readLatestPoint();
    this.prune();
  }

  append(snapshot: ProviderSnapshot): void {
    const parsed = quotaHistoryPointSchema.safeParse(pointFromSnapshot(snapshot));
    if (!parsed.success) {
      this.logger.error('Could not append quota history: invalid point.');
      return;
    }
    const point = parsed.data;
    const changed =
      !this.lastPoint ||
      point.rolling !== this.lastPoint.rolling ||
      point.weekly !== this.lastPoint.weekly ||
      point.monthly !== this.lastPoint.monthly ||
      point.rollingReset !== this.lastPoint.rollingReset ||
      point.weeklyReset !== this.lastPoint.weeklyReset ||
      point.monthlyReset !== this.lastPoint.monthlyReset;
    if (!changed && this.lastPoint && point.ts - this.lastPoint.ts < MIN_APPEND_MS) {
      return;
    }

    try {
      appendFileSync(this.pathFor(point.ts), `${JSON.stringify(point)}\n`, 'utf8');
      this.lastPoint = point;
    } catch (error) {
      this.logger.error('Could not append quota history.', error);
    }
  }

  getLatestPoint(): QuotaHistoryPoint | null {
    return this.lastPoint ? { ...this.lastPoint } : null;
  }

  getPoints(hours: number): QuotaHistoryPoint[] {
    const now = Date.now();
    const cutoff = now - hours * 60 * 60 * 1000;
    const files = this.filesForRange(cutoff);
    const points: QuotaHistoryPoint[] = [];
    for (const file of files) {
      try {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = quotaHistoryPointSchema.safeParse(parseJson(line));
            if (parsed.success && parsed.data.ts >= cutoff) points.push(parsed.data);
          } catch {
            // Skip malformed line.
          }
        }
      } catch (error) {
        this.logger.error(`Could not read quota history ${file}.`, error);
      }
    }
    return points.sort((a, b) => a.ts - b.ts);
  }

  clear(): void {
    this.lastPoint = null;
    try {
      for (const file of readdirSync(this.dir)) {
        if (isHistoryFileName(file)) unlinkSync(join(this.dir, file));
      }
    } catch (error) {
      this.logger.error('Could not clear quota history.', error);
    }
  }

  private readLatestPoint(): QuotaHistoryPoint | null {
    const files = this.filesForRange(0).reverse();
    for (const file of files) {
      try {
        const lines = readFileSync(file, 'utf8').trim().split('\n').reverse();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = quotaHistoryPointSchema.safeParse(parseJson(line));
            if (parsed.success) return parsed.data;
          } catch {
            // Skip malformed line and keep searching older lines/files.
          }
        }
      } catch {
        // Try older file.
      }
    }
    return null;
  }

  private filesForRange(cutoff: number): string[] {
    try {
      const now = Date.now();
      const files: string[] = [];
      const cursor = new Date(cutoff || now - RETENTION_DAYS * 24 * 60 * 60 * 1000);
      cursor.setDate(1);
      const end = new Date(now);
      while (cursor <= end) {
        const file = join(this.dir, `${monthKey(cursor.getTime())}.jsonl`);
        if (existsSync(file) && !files.includes(file)) files.push(file);
        cursor.setMonth(cursor.getMonth() + 1);
      }
      files.sort();
      return files;
    } catch {
      return [];
    }
  }

  private pathFor(ts: number): string {
    return join(this.dir, `${monthKey(ts)}.jsonl`);
  }

  private prune(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffKey = monthKey(cutoff.getTime());
    try {
      for (const file of readdirSync(this.dir)) {
        if (!isHistoryFileName(file)) continue;
        const key = file.slice(0, 7);
        if (key < cutoffKey) unlinkSync(join(this.dir, file));
      }
    } catch (error) {
      this.logger.error('Could not prune quota history.', error);
    }
  }
}
