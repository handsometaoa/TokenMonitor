import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeedPoint, SpeedRange } from '../../shared/types';
import type { Logger } from './logger';

export interface SpeedSampleRecord {
  ts: number;
  provider: string;
  model: string;
  ttftMs: number;
  durationMs: number;
  outputTokens: number;
  inputTokens: number;
  tokenSource: 'upstream' | 'local' | 'unknown';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

function monthKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function localDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class SpeedStore {
  private readonly dir: string;

  constructor(
    baseDir: string,
    private readonly logger: Logger,
  ) {
    this.dir = join(baseDir, 'speed-samples');
    mkdirSync(this.dir, { recursive: true });
    this.prune();
  }

  append(record: SpeedSampleRecord): void {
    try {
      appendFileSync(join(this.dir, `${monthKey(record.ts)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      this.logger.error('Could not append speed sample.', error);
    }
  }

  getStatus(): { sampleCount: number; lastSampleAt: number | null } {
    const cutoff = Date.now() - 30 * DAY_MS;
    let sampleCount = 0;
    let lastSampleAt: number | null = null;
    for (const record of this.readSince(cutoff)) {
      sampleCount += 1;
      if (!lastSampleAt || record.ts > lastSampleAt) lastSampleAt = record.ts;
    }
    return { sampleCount, lastSampleAt };
  }

  getSeries(range: SpeedRange): SpeedPoint[] {
    const days = range === '7d' ? 7 : 30;
    const cutoff = Date.now() - days * DAY_MS;
    const groups = new Map<
      string,
      {
        day: string;
        provider: string;
        model: string;
        durationMs: number;
        outputTokens: number;
        ttftMs: number;
        samples: number;
        sources: Set<SpeedSampleRecord['tokenSource']>;
      }
    >();

    for (const record of this.readSince(cutoff)) {
      if (record.outputTokens <= 0 || record.durationMs <= 0) continue;
      const day = localDayKey(record.ts);
      const key = `${day}\u0000${record.provider}\u0000${record.model}`;
      const group = groups.get(key) ?? {
        day,
        provider: record.provider,
        model: record.model,
        durationMs: 0,
        outputTokens: 0,
        ttftMs: 0,
        samples: 0,
        sources: new Set<SpeedSampleRecord['tokenSource']>(),
      };
      group.durationMs += record.durationMs;
      group.outputTokens += record.outputTokens;
      group.ttftMs += record.ttftMs;
      group.samples += 1;
      group.sources.add(record.tokenSource);
      groups.set(key, group);
    }

    return [...groups.values()]
      .map((group) => {
        const sources = [...group.sources];
        const tokenSource =
          sources.length === 1 ? (sources[0] === 'unknown' ? 'unknown' : sources[0]) : sources.includes('upstream') ? 'mixed' : 'local';
        return {
          day: group.day,
          provider: group.provider,
          model: group.model,
          tokensPerSecond: Math.round((group.outputTokens / (group.durationMs / 1000)) * 10) / 10,
          ttftMs: Math.round(group.ttftMs / group.samples),
          samples: group.samples,
          tokenSource,
        } satisfies SpeedPoint;
      })
      .sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
  }

  clear(): void {
    try {
      for (const file of readdirSync(this.dir)) {
        if (file.endsWith('.jsonl')) unlinkSync(join(this.dir, file));
      }
    } catch (error) {
      this.logger.error('Could not clear speed samples.', error);
    }
  }

  private readSince(cutoff: number): SpeedSampleRecord[] {
    const records: SpeedSampleRecord[] = [];
    const now = Date.now();
    const cursor = new Date(cutoff);
    cursor.setDate(1);
    const end = new Date(now);
    while (cursor <= end) {
      const file = join(this.dir, `${monthKey(cursor.getTime())}.jsonl`);
      if (existsSync(file)) {
        try {
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            const record = JSON.parse(line) as SpeedSampleRecord;
            if (typeof record.ts === 'number' && record.ts >= cutoff) records.push(record);
          }
        } catch (error) {
          this.logger.error(`Could not read speed samples ${file}.`, error);
        }
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return records;
  }

  private prune(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffKey = monthKey(cutoff.getTime());
    try {
      for (const file of readdirSync(this.dir)) {
        if (file.endsWith('.jsonl') && file.slice(0, 7) < cutoffKey) {
          unlinkSync(join(this.dir, file));
        }
      }
    } catch (error) {
      this.logger.error('Could not prune speed samples.', error);
    }
  }
}
