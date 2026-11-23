import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import type {
  LocalSchemaKind,
  LocalUsageDay,
  LocalUsageModel,
  LocalUsageRange,
  LocalUsageSummary,
  TokenTotals,
} from '../../../shared/types';
import { findOpenCodeDbCandidates } from '../../paths';
import type { Logger } from '../../services/logger';
import type { SettingsStore } from '../../services/settings';
import { buildDemoLocalUsage } from './demo';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 2 * 60 * 1000;

interface UsageRow {
  id: string;
  sessionId: string;
  ts: number;
  provider: string;
  model: string;
  tokens: TokenTotals;
  valid: boolean;
}

interface SessionInfo {
  timeCreated: number;
  forkSessionId: string | null;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTotals(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTokens(raw: unknown): TokenTotals | null {
  if (!raw || typeof raw !== 'object') return null;
  const tokens = raw as Record<string, unknown>;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? (tokens.cache as Record<string, unknown>) : {};
  const input = numberValue(tokens.input);
  const output = numberValue(tokens.output);
  const reasoning = numberValue(tokens.reasoning);
  const cacheRead = numberValue(cache.read);
  const cacheWrite = numberValue(cache.write);
  const sum = input + output + reasoning + cacheRead + cacheWrite;
  const total = sum > 0 ? sum : numberValue(tokens.total);
  if (!Number.isFinite(total) || total < 0) return null;
  return { input, output, reasoning, cacheRead, cacheWrite, total };
}

function localDayKey(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function cutoffForRange(range: LocalUsageRange, now = Date.now()): number {
  if (range === 'all') return 0;
  if (range === 'today') return startOfLocalDay(now);
  if (range === '7d') {
    const start = new Date(startOfLocalDay(now));
    start.setDate(start.getDate() - 6);
    return start.getTime();
  }
  const start = new Date(startOfLocalDay(now));
  start.setDate(start.getDate() - 29);
  return start.getTime();
}

function enumerateDays(from: number, to: number): string[] {
  const days: string[] = [];
  const cursor = new Date(startOfLocalDay(from));
  const end = startOfLocalDay(to);
  while (cursor.getTime() <= end) {
    days.push(localDayKey(cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export class LocalUsageService {
  private cacheKey: string | null = null;
  private cacheAt = 0;
  private cacheValue: LocalUsageSummary | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly logger: Logger,
    private readonly demo: boolean,
  ) {}

  async getSummary(range: LocalUsageRange, force = false): Promise<LocalUsageSummary> {
    if (this.demo) {
      return buildDemoLocalUsage(range);
    }

    const settings = this.settings.get();
    if (!settings.localUsageEnabled) {
      return this.emptySummary(range, null, 'none', {
        code: 'missing',
        message: '本地用量统计已关闭。',
      });
    }

    const dbPath = this.pickDbPath(settings.localDataPath);
    if (!dbPath) {
      return this.emptySummary(range, null, 'none', {
        code: 'missing',
        message: '未找到 OpenCode 本地数据库。',
      });
    }

    const cacheKey = this.makeCacheKey(dbPath, range);
    if (!force && this.cacheValue && this.cacheKey === cacheKey && Date.now() - this.cacheAt < CACHE_TTL_MS) {
      return structuredClone(this.cacheValue);
    }

    const summary = this.query(dbPath, range);
    this.cacheKey = cacheKey;
    this.cacheAt = Date.now();
    this.cacheValue = summary;
    return structuredClone(summary);
  }

  clearCache(): void {
    this.cacheKey = null;
    this.cacheAt = 0;
    this.cacheValue = null;
  }

  private pickDbPath(explicitPath: string | null): string | null {
    if (explicitPath) {
      return existsSync(explicitPath) ? explicitPath : null;
    }
    return findOpenCodeDbCandidates()[0] ?? null;
  }

  private makeCacheKey(dbPath: string, range: LocalUsageRange): string {
    try {
      const stats = statSync(dbPath);
      return `${dbPath}|${range}|${stats.mtimeMs}|${stats.size}`;
    } catch {
      return `${dbPath}|${range}|missing`;
    }
  }

  private query(dbPath: string, range: LocalUsageRange): LocalUsageSummary {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');

      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String((row as { name: string }).name)),
      );
      if (!tables.has('message') && !tables.has('session_message')) {
        return this.emptySummary(range, dbPath, 'none', {
          code: 'schema',
          message: 'OpenCode 数据库中没有可识别的消息表。',
        });
      }

      const now = Date.now();
      const cutoff = cutoffForRange(range, now);
      const sessions = this.readSessions(db, tables);
      const rows = new Map<string, UsageRow>();
      let hasV2 = false;
      let hasV1 = false;

      if (tables.has('session_message')) {
        const v2Count = Number(
          (db.prepare("SELECT count(*) AS n FROM session_message WHERE type = 'assistant'").get() as { n: number }).n,
        );
        if (v2Count > 0) {
          hasV2 = true;
          for (const row of this.readV2(db, cutoff)) {
            rows.set(row.id, row);
          }
        }
      }

      if (tables.has('message')) {
        const v1Rows = this.readV1(db, cutoff);
        hasV1 = v1Rows.length > 0;
        for (const row of v1Rows) {
          if (!rows.has(row.id)) rows.set(row.id, row);
        }
      }

      const filtered = [...rows.values()].filter((row) => {
        const session = sessions.get(row.sessionId);
        if (!session || !session.forkSessionId) return true;
        return row.ts >= session.timeCreated;
      });

      const schema: LocalSchemaKind = hasV2 && hasV1 ? 'mixed' : hasV2 ? 'v2' : hasV1 ? 'v1' : 'none';

      if (filtered.length === 0) {
        return this.emptySummary(range, dbPath, schema);
      }

      const totals = emptyTotals();
      const days = new Map<string, LocalUsageDay>();
      const models = new Map<string, LocalUsageModel>();
      const sessionIds = new Set<string>();
      let partial = false;

      for (const row of filtered) {
        if (!row.valid) {
          partial = true;
          continue;
        }
        addTotals(totals, row.tokens);
        sessionIds.add(row.sessionId);

        const day = localDayKey(row.ts);
        const dayEntry = days.get(day) ?? {
          day,
          ...emptyTotals(),
          messages: 0,
        };
        addTotals(dayEntry, row.tokens);
        dayEntry.messages += 1;
        days.set(day, dayEntry);

        const key = `${row.provider}\u0000${row.model}`;
        const modelEntry = models.get(key) ?? {
          provider: row.provider,
          model: row.model,
          ...emptyTotals(),
          messages: 0,
        };
        addTotals(modelEntry, row.tokens);
        modelEntry.messages += 1;
        models.set(key, modelEntry);
      }

      const rangeStart = range === 'all'
        ? Math.min(...filtered.map((row) => row.ts))
        : cutoff;
      const dayKeys = enumerateDays(rangeStart, now);
      const dayList = dayKeys.map(
        (day) =>
          days.get(day) ?? {
            day,
            ...emptyTotals(),
            messages: 0,
          },
      );

      const modelList = [...models.values()].sort((a, b) => b.total - a.total).slice(0, 30);
      return {
        range,
        generatedAt: Date.now(),
        dbPath,
        schema,
        source: 'sqlite',
        totals,
        sessions: sessionIds.size,
        messages: filtered.length,
        days: dayList,
        models: modelList,
        partial,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取 OpenCode 数据库。';
      this.logger.error('Local usage query failed.', error);
      const locked = /busy|locked/i.test(message);
      return this.emptySummary(range, dbPath, 'none', {
        code: locked ? 'locked' : 'unknown',
        message: locked ? 'OpenCode 数据库正忙，请稍后重试。' : message,
      });
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore.
      }
    }
  }

  private readSessions(db: DatabaseSync, tables: Set<string>): Map<string, SessionInfo> {
    const result = new Map<string, SessionInfo>();
    if (!tables.has('session')) return result;
    const columns = new Set(
      db.prepare('PRAGMA table_info(session)').all().map((row) => String((row as { name: string }).name)),
    );
    const hasFork = columns.has('fork_session_id');
    const sql = hasFork
      ? 'SELECT id, time_created, fork_session_id FROM session'
      : 'SELECT id, time_created, NULL AS fork_session_id FROM session';
    for (const raw of db.prepare(sql).all()) {
      const row = raw as { id: string; time_created: number; fork_session_id: string | null };
      result.set(row.id, {
        timeCreated: numberValue(row.time_created),
        forkSessionId: row.fork_session_id || null,
      });
    }
    return result;
  }

  private readV1(db: DatabaseSync, cutoff: number): UsageRow[] {
    const statement = db.prepare(`
      SELECT id, session_id, time_created, data
      FROM message
      WHERE time_created >= ?
        AND json_valid(data)
        AND json_extract(data, '$.role') = 'assistant'
    `);
    return this.parseRows(statement.all(cutoff) as Array<{ id: string; session_id: string; time_created: number; data: string }>, 'v1');
  }

  private readV2(db: DatabaseSync, cutoff: number): UsageRow[] {
    const statement = db.prepare(`
      SELECT id, session_id, time_created, data
      FROM session_message
      WHERE time_created >= ?
        AND type = 'assistant'
        AND json_valid(data)
    `);
    return this.parseRows(statement.all(cutoff) as Array<{ id: string; session_id: string; time_created: number; data: string }>, 'v2');
  }

  private parseRows(
    rows: Array<{ id: string; session_id: string; time_created: number; data: string }>,
    version: 'v1' | 'v2',
  ): UsageRow[] {
    const result: UsageRow[] = [];
    for (const row of rows) {
      try {
        const message = JSON.parse(row.data) as Record<string, unknown>;
        const tokens = parseTokens(message.tokens);
        const model = message.model && typeof message.model === 'object' ? (message.model as Record<string, unknown>) : null;
        const provider =
          (typeof message.providerID === 'string' && message.providerID) ||
          (typeof model?.providerID === 'string' && model.providerID) ||
          'unknown';
        const modelId =
          (typeof message.modelID === 'string' && message.modelID) ||
          (typeof model?.id === 'string' && model.id) ||
          'unknown';
        const ts = numberValue(row.time_created) || numberValue((message.time as Record<string, unknown> | undefined)?.created);
        result.push({
          id: row.id,
          sessionId: row.session_id,
          ts,
          provider,
          model: modelId,
          tokens: tokens ?? emptyTotals(),
          valid: Boolean(tokens),
        });
      } catch {
        result.push({
          id: row.id,
          sessionId: row.session_id,
          ts: numberValue(row.time_created),
          provider: 'unknown',
          model: 'unknown',
          tokens: emptyTotals(),
          valid: false,
        });
      }
    }
    this.logger.info(`Local usage parsed ${result.length} ${version} assistant rows.`);
    return result;
  }

  private emptySummary(
    range: LocalUsageRange,
    dbPath: string | null,
    schema: LocalSchemaKind,
    error?: LocalUsageSummary['error'],
    sessionCount = 0,
  ): LocalUsageSummary {
    return {
      range,
      generatedAt: Date.now(),
      dbPath: dbPath ?? '',
      schema,
      source: dbPath ? 'sqlite' : 'none',
      totals: emptyTotals(),
      sessions: sessionCount,
      messages: 0,
      days: [],
      models: [],
      partial: false,
      error,
    };
  }
}
