import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import type {
  HistoryMetrics,
  HistoryMetricsModel,
  HistoryMetricsPoint,
  HistoryMetricsTotals,
  HistoryRange,
  LocalUsageError,
  TokenTotals,
} from '../../../shared/types';
import { findOpenCodeDbCandidates } from '../../paths';
import type { Logger } from '../../services/logger';
import type { SettingsStore } from '../../services/settings';
import { buildDemoHistoryMetrics } from './demo';

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_TTFT_MS = 120_000;
const MAX_TURN_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_TPS = 10_000;
const MAX_PREFILL_TPS = 200_000;

interface AssistantMessage {
  id: string;
  ts: number;
  completed: number | null;
  provider: string;
  model: string;
  parentId: string | null;
  tokens: TokenTotals | null;
}

interface PartRow {
  messageId: string;
  ts: number;
  updated: number;
  type: string;
  start: number | null;
  end: number | null;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

interface StepRow {
  startedAt: number;
  firstOutputAt: number | null;
  streamMs: number;
  tokens: TokenTotals | null;
}

interface Bucket {
  steps: number;
  turns: number;
  turnMs: number;
  ttftSum: number;
  ttftCount: number;
  ttftValues: number[];
  outputTokens: number;
  generationOutputTokens: number;
  generationMs: number;
  prefillTokens: number;
  prefillSeconds: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface ModelBucket {
  provider: string;
  model: string;
  bucket: Bucket;
  days: Map<string, Bucket>;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function localDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cutoffForRange(range: HistoryRange, now = Date.now()): number {
  if (range === 'all') return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (range === '7d' ? 6 : 29));
  return start.getTime();
}

function newBucket(): Bucket {
  return {
    steps: 0,
    turns: 0,
    turnMs: 0,
    ttftSum: 0,
    ttftCount: 0,
    ttftValues: [],
    outputTokens: 0,
    generationOutputTokens: 0,
    generationMs: 0,
    prefillTokens: 0,
    prefillSeconds: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function tokenTotals(
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
): TokenTotals | null {
  const values = [input, output, reasoning, cacheRead, cacheWrite].map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  );
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return {
    input: values[0],
    output: values[1],
    reasoning: values[2],
    cacheRead: values[3],
    cacheWrite: values[4],
    total,
  };
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function finalize(bucket: Bucket): {
  avgTtftMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  outputTps: number | null;
  prefillTps: number | null;
  turnMs: number | null;
  cacheHitPercent: number | null;
} {
  const sorted = [...bucket.ttftValues].sort((a, b) => a - b);
  const inputSide = bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
  return {
    avgTtftMs: bucket.ttftCount > 0 ? bucket.ttftSum / bucket.ttftCount : null,
    p50TtftMs: percentile(sorted, 0.5),
    p95TtftMs: percentile(sorted, 0.95),
    outputTps:
      bucket.generationMs > 0 && bucket.generationOutputTokens > 0
        ? bucket.generationOutputTokens / (bucket.generationMs / 1000)
        : null,
    prefillTps: bucket.prefillSeconds > 0 ? bucket.prefillTokens / bucket.prefillSeconds : null,
    turnMs: bucket.turns > 0 ? bucket.turnMs / bucket.turns : null,
    cacheHitPercent: inputSide > 0 ? (bucket.cacheReadTokens / inputSide) * 100 : null,
  };
}

function pointFor(day: string, bucket: Bucket): HistoryMetricsPoint {
  const metrics = finalize(bucket);
  return {
    day,
    steps: bucket.steps,
    turns: bucket.turns,
    avgTtftMs: metrics.avgTtftMs,
    outputTps: metrics.outputTps,
    prefillTps: metrics.prefillTps,
    turnMs: metrics.turnMs,
  };
}

function emptyBucketPoint(day: string): HistoryMetricsPoint {
  return {
    day,
    steps: 0,
    turns: 0,
    avgTtftMs: null,
    outputTps: null,
    prefillTps: null,
    turnMs: null,
  };
}

export class SessionMetricsService {
  private cacheKey: string | null = null;
  private cacheAt = 0;
  private cacheValue: HistoryMetrics | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly logger: Logger,
    private readonly demo: boolean,
  ) {}

  async getMetrics(range: HistoryRange, force = false): Promise<HistoryMetrics> {
    if (this.demo) return buildDemoHistoryMetrics(range);

    const settings = this.settings.get();
    if (!settings.localUsageEnabled) {
      return this.emptyMetrics(range, null, 'none', {
        code: 'missing',
        message: '本地用量统计已关闭。',
      });
    }

    const dbPath = this.pickDbPath(settings.localDataPath);
    if (!dbPath) {
      return this.emptyMetrics(range, null, 'none', {
        code: 'missing',
        message: '未找到 OpenCode 本地数据库。',
      });
    }

    const cacheKey = this.makeCacheKey(dbPath, range);
    if (!force && this.cacheValue && this.cacheKey === cacheKey && Date.now() - this.cacheAt < CACHE_TTL_MS) {
      return structuredClone(this.cacheValue);
    }

    const metrics = this.query(dbPath, range);
    this.cacheKey = cacheKey;
    this.cacheAt = Date.now();
    this.cacheValue = metrics;
    return structuredClone(metrics);
  }

  clearCache(): void {
    this.cacheKey = null;
    this.cacheAt = 0;
    this.cacheValue = null;
  }

  private pickDbPath(explicitPath: string | null): string | null {
    if (explicitPath) return existsSync(explicitPath) ? explicitPath : null;
    return findOpenCodeDbCandidates()[0] ?? null;
  }

  private makeCacheKey(dbPath: string, range: HistoryRange): string {
    try {
      const stats = statSync(dbPath);
      return `${dbPath}|${range}|${stats.mtimeMs}|${stats.size}`;
    } catch {
      return `${dbPath}|${range}|missing`;
    }
  }

  private query(dbPath: string, range: HistoryRange): HistoryMetrics {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');

      const tables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => String((row as { name: string }).name)),
      );
      if (!tables.has('message')) {
        return this.emptyMetrics(range, dbPath, 'none', {
          code: 'schema',
          message: 'OpenCode 数据库中没有可识别的消息表。',
        });
      }
      if (!tables.has('part')) {
        return this.emptyMetrics(range, dbPath, 'none', {
          code: 'schema',
          message: 'OpenCode 数据库中没有步骤明细，无法回溯性能。',
        });
      }

      const cutoff = cutoffForRange(range);
      const messages = this.readAssistantMessages(db, cutoff);
      if (messages.length === 0) {
        return this.emptyMetrics(range, dbPath, 'sqlite');
      }
      const userStarts = this.readUserStarts(db);
      const parts = this.readParts(db, cutoff);

      const total = newBucket();
      const totalDays = new Map<string, Bucket>();
      const modelBuckets = new Map<string, ModelBucket>();
      const turns = new Map<string, Array<{ message: AssistantMessage; steps: StepRow[] }>>();

      for (const message of messages) {
        const messageParts = parts.get(message.id) ?? [];
        if (messageParts.length === 0) continue;
        const steps = this.buildSteps(message, messageParts);
        if (steps.length === 0) continue;

        const modelKey = `${message.provider}\u0000${message.model}`;
        const modelEntry = modelBuckets.get(modelKey) ?? {
          provider: message.provider,
          model: message.model,
          bucket: newBucket(),
          days: new Map<string, Bucket>(),
        };
        modelBuckets.set(modelKey, modelEntry);

        for (const step of steps) {
          const day = localDayKey(step.startedAt);
          this.addStep(total, step);
          const totalDay = totalDays.get(day) ?? newBucket();
          this.addStep(totalDay, step);
          totalDays.set(day, totalDay);

          this.addStep(modelEntry.bucket, step);
          const modelDay = modelEntry.days.get(day) ?? newBucket();
          this.addStep(modelDay, step);
          modelEntry.days.set(day, modelDay);
        }

        const parentId = message.parentId ?? message.id;
        const group = turns.get(parentId) ?? [];
        group.push({ message, steps });
        turns.set(parentId, group);
      }

      for (const [parentId, group] of turns) {
        const assistantTimes = group.map((entry) => entry.message.ts).filter((value) => value > 0);
        const start = userStarts.get(parentId) ?? (assistantTimes.length > 0 ? Math.min(...assistantTimes) : null);
        if (start === null) continue;
        const ends = group
          .map((entry) => entry.message.completed)
          .filter((value): value is number => value !== null && value > 0);
        const end = ends.length > 0 ? Math.max(...ends) : null;
        if (end === null) continue;
        const duration = end - start;
        if (duration < 0 || duration > MAX_TURN_MS) continue;
        const day = localDayKey(end);

        const counts = new Map<string, number>();
        for (const entry of group) {
          const key = `${entry.message.provider}\u0000${entry.message.model}`;
          counts.set(key, (counts.get(key) ?? 0) + entry.steps.length);
        }
        const attributedKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

        this.addTurn(total, duration);
        const totalDay = totalDays.get(day) ?? newBucket();
        this.addTurn(totalDay, duration);
        totalDays.set(day, totalDay);

        if (attributedKey) {
          const [provider, model] = attributedKey.split('\u0000');
          const modelKey = `${provider}\u0000${model}`;
          const entry = modelBuckets.get(modelKey) ?? {
            provider,
            model,
            bucket: newBucket(),
            days: new Map<string, Bucket>(),
          };
          modelBuckets.set(modelKey, entry);
          this.addTurn(entry.bucket, duration);
          const modelDay = entry.days.get(day) ?? newBucket();
          this.addTurn(modelDay, duration);
          entry.days.set(day, modelDay);
        }
      }

      const totals = this.totalsFor(total, finalize(total));
      const days = [...totalDays.entries()]
        .map(([day, bucket]) => pointFor(day, bucket))
        .sort((a, b) => a.day.localeCompare(b.day));
      const models: HistoryMetricsModel[] = [...modelBuckets.values()]
        .map((entry) => {
          const metrics = finalize(entry.bucket);
          return {
            provider: entry.provider,
            model: entry.model,
            steps: entry.bucket.steps,
            turns: entry.bucket.turns,
            outputTokens: entry.bucket.outputTokens,
            inputTokens: entry.bucket.inputTokens,
            cacheReadTokens: entry.bucket.cacheReadTokens,
            generationMs: entry.bucket.generationMs,
            avgTtftMs: metrics.avgTtftMs,
            p95TtftMs: metrics.p95TtftMs,
            outputTps: metrics.outputTps,
            prefillTps: metrics.prefillTps,
            turnMs: metrics.turnMs,
            cacheHitPercent: metrics.cacheHitPercent,
            points: [...entry.days.entries()]
              .map(([day, bucket]) => pointFor(day, bucket))
              .sort((a, b) => a.day.localeCompare(b.day)),
          };
        })
        .sort((a, b) => b.steps - a.steps || (a.avgTtftMs ?? Number.MAX_SAFE_INTEGER) - (b.avgTtftMs ?? Number.MAX_SAFE_INTEGER))
        .slice(0, 30);

      const rangeStart = range === 'all' ? Math.min(...messages.map((message) => message.ts)) : cutoff;
      const dayKeys = this.enumerateDays(rangeStart, Date.now());
      const dayList = dayKeys.map((day) => {
        const bucket = totalDays.get(day);
        return bucket ? pointFor(day, bucket) : emptyBucketPoint(day);
      });

      return {
        range,
        generatedAt: Date.now(),
        dbPath,
        source: 'sqlite',
        totals,
        days: dayList,
        models,
        approximate: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法读取 OpenCode 数据库。';
      this.logger.error('Session metrics query failed.', error);
      const locked = /busy|locked/i.test(message);
      return this.emptyMetrics(range, dbPath, 'none', {
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

  private readAssistantMessages(db: DatabaseSync, cutoff: number): AssistantMessage[] {
    const rows = db
      .prepare(`
        SELECT
          id,
          time_created AS ts,
          json_extract(data, '$.parentID') AS parentId,
          COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS provider,
          COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.id')) AS model,
          json_extract(data, '$.time.completed') AS completed,
          json_extract(data, '$.tokens.input') AS input,
          json_extract(data, '$.tokens.output') AS output,
          json_extract(data, '$.tokens.reasoning') AS reasoning,
          json_extract(data, '$.tokens.cache.read') AS cacheRead,
          json_extract(data, '$.tokens.cache.write') AS cacheWrite
        FROM message
        WHERE time_created >= ?
          AND json_valid(data)
          AND json_extract(data, '$.role') = 'assistant'
      `)
      .all(cutoff) as unknown as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      ts: numberValue(row.ts),
      completed: optionalNumber(row.completed),
      provider: typeof row.provider === 'string' && row.provider ? row.provider : 'unknown',
      model: typeof row.model === 'string' && row.model ? row.model : 'unknown',
      parentId: typeof row.parentId === 'string' && row.parentId ? row.parentId : null,
      tokens: tokenTotals(
        numberValue(row.input),
        numberValue(row.output),
        numberValue(row.reasoning),
        numberValue(row.cacheRead),
        numberValue(row.cacheWrite),
      ),
    }));
  }

  private readUserStarts(db: DatabaseSync): Map<string, number> {
    const result = new Map<string, number>();
    const rows = db
      .prepare(`
        SELECT id, COALESCE(json_extract(data, '$.time.created'), time_created) AS created
        FROM message
        WHERE json_valid(data) AND json_extract(data, '$.role') = 'user'
      `)
      .all() as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      const created = numberValue(row.created);
      if (created > 0) result.set(id, created);
    }
    return result;
  }

  private readParts(db: DatabaseSync, cutoff: number): Map<string, PartRow[]> {
    const rows = db
      .prepare(`
        SELECT
          p.message_id AS messageId,
          p.time_created AS ts,
          p.time_updated AS updated,
          json_extract(p.data, '$.type') AS type,
          json_extract(p.data, '$.time.start') AS start,
          json_extract(p.data, '$.time.end') AS end,
          json_extract(p.data, '$.tokens.input') AS input,
          json_extract(p.data, '$.tokens.output') AS output,
          json_extract(p.data, '$.tokens.reasoning') AS reasoning,
          json_extract(p.data, '$.tokens.cache.read') AS cacheRead,
          json_extract(p.data, '$.tokens.cache.write') AS cacheWrite
        FROM part p
        JOIN message m ON m.id = p.message_id
        WHERE m.time_created >= ?
          AND json_valid(p.data)
          AND json_extract(p.data, '$.type') IN ('step-start', 'step-finish', 'text', 'reasoning', 'tool')
        ORDER BY p.message_id, p.time_created
      `)
      .all(cutoff) as unknown as Array<Record<string, unknown>>;

    const result = new Map<string, PartRow[]>();
    for (const row of rows) {
      const messageId = String(row.messageId);
      const list = result.get(messageId) ?? [];
      list.push({
        messageId,
        ts: numberValue(row.ts),
        updated: numberValue(row.updated),
        type: String(row.type ?? ''),
        start: optionalNumber(row.start),
        end: optionalNumber(row.end),
        input: numberValue(row.input),
        output: numberValue(row.output),
        reasoning: numberValue(row.reasoning),
        cacheRead: numberValue(row.cacheRead),
        cacheWrite: numberValue(row.cacheWrite),
      });
      result.set(messageId, list);
    }
    return result;
  }

  private buildSteps(message: AssistantMessage, parts: PartRow[]): StepRow[] {
    const steps: StepRow[] = [];
    let current: StepRow | null = null;
    for (const part of parts) {
      if (part.type === 'step-start') {
        // step-start is written when the response stream is established, so it
        // can miss network/queue time. The first step therefore starts at the
        // assistant message creation time; later steps have no better anchor.
        const startedAt = steps.length === 0 && message.ts > 0 ? message.ts : part.ts;
        current = {
          startedAt,
          firstOutputAt: null,
          streamMs: 0,
          tokens: null,
        };
        steps.push(current);
        continue;
      }
      if (!current) {
        current = {
          startedAt: message.ts,
          firstOutputAt: null,
          streamMs: 0,
          tokens: null,
        };
        steps.push(current);
      }
      if (part.type === 'step-finish') {
        current.tokens = tokenTotals(part.input, part.output, part.reasoning, part.cacheRead, part.cacheWrite);
      } else if (part.type === 'text' || part.type === 'reasoning') {
        const start = part.start ?? part.ts;
        const end = part.end ?? (part.updated > start ? part.updated : null);
        current.firstOutputAt = current.firstOutputAt === null ? start : Math.min(current.firstOutputAt, start);
        if (end !== null && end > start) current.streamMs += end - start;
      } else if (part.type === 'tool') {
        current.firstOutputAt = current.firstOutputAt === null ? part.ts : Math.min(current.firstOutputAt, part.ts);
      }
    }

    if (steps.length === 1 && !steps[0].tokens) steps[0].tokens = message.tokens;
    return steps;
  }

  private addStep(bucket: Bucket, step: StepRow): void {
    bucket.steps += 1;
    const ttft = step.firstOutputAt !== null ? step.firstOutputAt - step.startedAt : null;
    const validTtft = ttft !== null && ttft >= 0 && ttft <= MAX_TTFT_MS;
    if (ttft !== null && validTtft) {
      bucket.ttftSum += ttft;
      bucket.ttftCount += 1;
      bucket.ttftValues.push(ttft);
    }

    const tokens = step.tokens;
    if (!tokens) return;
    bucket.inputTokens += tokens.input;
    bucket.cacheReadTokens += tokens.cacheRead;
    bucket.cacheWriteTokens += tokens.cacheWrite;
    const outputTokens = tokens.output + tokens.reasoning;
    bucket.outputTokens += outputTokens;

    if (validTtft && ttft > 0) {
      const prefillTokens = tokens.input + tokens.cacheWrite;
      const prefillTps = prefillTokens / (ttft / 1000);
      if (prefillTokens > 0 && prefillTps <= MAX_PREFILL_TPS) {
        bucket.prefillTokens += prefillTokens;
        bucket.prefillSeconds += ttft / 1000;
      }
    }

    if (step.streamMs > 0 && outputTokens > 0) {
      const outputTps = outputTokens / (step.streamMs / 1000);
      if (outputTps <= MAX_OUTPUT_TPS) {
        bucket.generationMs += step.streamMs;
        bucket.generationOutputTokens += outputTokens;
      }
    }
  }

  private addTurn(bucket: Bucket, duration: number): void {
    bucket.turns += 1;
    bucket.turnMs += duration;
  }

  private totalsFor(
    bucket: Bucket,
    finalized: ReturnType<typeof finalize>,
  ): HistoryMetricsTotals {
    return {
      steps: bucket.steps,
      turns: bucket.turns,
      outputTokens: bucket.outputTokens,
      inputTokens: bucket.inputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      generationMs: bucket.generationMs,
      avgTtftMs: finalized.avgTtftMs,
      p50TtftMs: finalized.p50TtftMs,
      p95TtftMs: finalized.p95TtftMs,
      outputTps: finalized.outputTps,
      prefillTps: finalized.prefillTps,
      turnMs: finalized.turnMs,
      cacheHitPercent: finalized.cacheHitPercent,
    };
  }

  private enumerateDays(from: number, to: number): string[] {
    const days: string[] = [];
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= end.getTime()) {
      days.push(localDayKey(cursor.getTime()));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  private emptyMetrics(
    range: HistoryRange,
    dbPath: string | null,
    source: HistoryMetrics['source'],
    error?: LocalUsageError,
  ): HistoryMetrics {
    return {
      range,
      generatedAt: Date.now(),
      dbPath: dbPath ?? '',
      source,
      totals: {
        steps: 0,
        turns: 0,
        outputTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        generationMs: 0,
        avgTtftMs: null,
        p50TtftMs: null,
        p95TtftMs: null,
        outputTps: null,
        prefillTps: null,
        turnMs: null,
        cacheHitPercent: null,
      },
      days: [],
      models: [],
      approximate: true,
      error,
    };
  }
}
