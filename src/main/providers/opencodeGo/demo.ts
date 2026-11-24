import type {
  HistoryMetrics,
  HistoryMetricsModel,
  HistoryMetricsPoint,
  HistoryRange,
  LocalUsageDay,
  LocalUsageModel,
  LocalUsageRange,
  LocalUsageSummary,
  SpeedPoint,
  SpeedRange,
  SpeedSeries,
  TokenTotals,
} from '../../../shared/types';
import type { RawUsageSnapshot } from './api';

const DAY_MS = 24 * 60 * 60 * 1000;

const DEMO_MODELS = [
  { provider: 'opencode', model: 'big-pickle', weight: 0.48, base: 420_000 },
  { provider: 'opencode', model: 'deepseek-v4.1-flash', weight: 0.32, base: 280_000 },
  { provider: 'opencode', model: 'glm-5.2', weight: 0.2, base: 180_000 },
];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dayCount(range: LocalUsageRange): number {
  if (range === 'today') return 1;
  if (range === '7d') return 7;
  if (range === '30d') return 30;
  return 90;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function add(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

export function buildDemoLocalUsage(range: LocalUsageRange): LocalUsageSummary {
  const now = new Date();
  const count = dayCount(range);
  const days: LocalUsageDay[] = [];
  const models = new Map<string, LocalUsageModel>();
  const totals = emptyTotals();
  let messages = 0;
  let sessions = 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const date = addDays(now, -index);
    const dayKey = localDayKey(date);
    const daySeed = Number(dayKey.replaceAll('-', ''));
    const random = seededRandom(daySeed);
    const dayEntry: LocalUsageDay = { day: dayKey, ...emptyTotals(), messages: 0 };
    const dayMultiplier = index === 0 ? 0.62 : 0.72 + random() * 0.7;

    for (const model of DEMO_MODELS) {
      const modelRandom = random();
      const input = Math.round(model.base * model.weight * dayMultiplier * (0.65 + modelRandom * 0.55));
      const output = Math.round(input * (0.12 + modelRandom * 0.08));
      const reasoning = Math.round(output * (0.08 + modelRandom * 0.12));
      const cacheRead = Math.round(input * (4 + modelRandom * 5));
      const tokens = { input, output, reasoning, cacheRead, cacheWrite: 0, total: input + output + reasoning + cacheRead };
      add(dayEntry, tokens);
      const modelMessages = Math.round(8 + modelRandom * 24);
      dayEntry.messages += modelMessages;
      messages += modelMessages;

      const key = `${model.provider}\u0000${model.model}`;
      const aggregate = models.get(key) ?? {
        provider: model.provider,
        model: model.model,
        ...emptyTotals(),
        messages: 0,
      };
      add(aggregate, tokens);
      aggregate.messages += modelMessages;
      models.set(key, aggregate);
    }

    sessions += 2 + Math.round(random() * 5);
    add(totals, dayEntry);
    days.push(dayEntry);
  }

  return {
    range,
    generatedAt: Date.now(),
    dbPath: '演示数据',
    schema: 'demo',
    source: 'demo',
    totals,
    sessions,
    messages,
    days,
    models: [...models.values()].sort((a, b) => b.total - a.total),
    partial: false,
  };
}

export function buildDemoRawSnapshot(now = Date.now()): RawUsageSnapshot {
  return {
    fetchedAt: now,
    planLabel: 'OpenCode Go',
    windows: [
      {
        id: 'rolling',
        usedPercent: 12,
        status: 'ok',
        resetsAt: new Date(now + 75 * 60 * 1000).toISOString(),
      },
      {
        id: 'weekly',
        usedPercent: 14,
        status: 'ok',
        resetsAt: new Date(now + (5 * 24 + 13) * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 'monthly',
        usedPercent: 19,
        status: 'ok',
        resetsAt: new Date(now + (23 * 24 + 21) * 60 * 60 * 1000).toISOString(),
      },
    ],
  };
}

export function buildDemoSpeedSeries(range: SpeedRange): SpeedSeries {
  const count = range === '7d' ? 7 : 30;
  const now = new Date();
  const points: SpeedPoint[] = [];
  let totalSamples = 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const date = addDays(now, -index);
    const dayKey = localDayKey(date);
    const random = seededRandom(Number(dayKey.replaceAll('-', '')) + 17);
    for (const [modelIndex, model] of DEMO_MODELS.entries()) {
      const baseline = [61, 54, 46][modelIndex] ?? 50;
      const wave = Math.sin((index / Math.max(1, count - 1)) * Math.PI * 2 + modelIndex) * 7;
      const samples = 3 + Math.round(random() * 9);
      points.push({
        day: dayKey,
        provider: model.provider,
        model: model.model,
        tokensPerSecond: Math.round((baseline + wave + random() * 8) * 10) / 10,
        ttftMs: Math.round(420 + random() * 620),
        samples,
        tokenSource: 'upstream',
      });
      totalSamples += samples;
    }
  }

  return {
    range,
    generatedAt: Date.now(),
    enabled: true,
    running: true,
    points,
    totalSamples,
    approximate: false,
  };
}

export const DEMO_DAY_MS = DAY_MS;

interface DemoHistoryAccumulator {
  steps: number;
  turns: number;
  turnMs: number;
  ttftWeighted: number;
  p95Weighted: number;
  outputTokens: number;
  inputTokens: number;
  cacheRead: number;
  generationMs: number;
  prefillSeconds: number;
}

function emptyHistoryAccumulator(): DemoHistoryAccumulator {
  return {
    steps: 0,
    turns: 0,
    turnMs: 0,
    ttftWeighted: 0,
    p95Weighted: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheRead: 0,
    generationMs: 0,
    prefillSeconds: 0,
  };
}

function historyPoint(day: string, accumulator: DemoHistoryAccumulator): HistoryMetricsPoint {
  const avgTtft = accumulator.steps > 0 ? accumulator.ttftWeighted / accumulator.steps : null;
  return {
    day,
    steps: accumulator.steps,
    turns: accumulator.turns,
    avgTtftMs: avgTtft,
    outputTps:
      accumulator.generationMs > 0 ? accumulator.outputTokens / (accumulator.generationMs / 1000) : null,
    prefillTps:
      accumulator.prefillSeconds > 0 ? accumulator.inputTokens / accumulator.prefillSeconds : null,
    turnMs: accumulator.turns > 0 ? accumulator.turnMs / accumulator.turns : null,
  };
}

export function buildDemoHistoryMetrics(range: HistoryRange): HistoryMetrics {
  const count = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const now = new Date();
  const days: HistoryMetricsPoint[] = [];
  const dayAccumulators = new Map<string, DemoHistoryAccumulator>();
  const models = new Map<
    string,
    {
      provider: string;
      model: string;
      totals: DemoHistoryAccumulator;
      points: HistoryMetricsPoint[];
    }
  >();
  const totals = emptyHistoryAccumulator();
  let totalP95 = 0;
  let totalCacheRead = 0;

  for (let index = count - 1; index >= 0; index -= 1) {
    const date = addDays(now, -index);
    const dayKey = localDayKey(date);
    const daySeed = Number(dayKey.replaceAll('-', ''));
    const dayAccumulator = emptyHistoryAccumulator();
    dayAccumulators.set(dayKey, dayAccumulator);

    for (const [modelIndex, model] of DEMO_MODELS.entries()) {
      const random = seededRandom(daySeed + modelIndex * 97);
      const steps = 4 + Math.round(random() * 10);
      const turns = Math.max(1, Math.round(steps / (4 + random() * 4)));
      const turnMs = 5_500 + random() * 38_000;
      const ttftMs = 320 + random() * 780;
      const outputTps = 38 + random() * 34;
      const prefillTps = 700 + random() * 1_900;
      const outputTokens = Math.round(steps * (180 + random() * 380));
      const inputTokens = Math.round(steps * (90 + random() * 180));
      const cacheRead = Math.round(inputTokens * (5 + random() * 6));
      const generationMs = (outputTokens / outputTps) * 1_000;
      const prefillSeconds = inputTokens / prefillTps;
      const p95TtftMs = ttftMs * (1.45 + random() * 0.5);

      const key = `${model.provider}\u0000${model.model}`;
      const entry = models.get(key) ?? {
        provider: model.provider,
        model: model.model,
        totals: emptyHistoryAccumulator(),
        points: [] as HistoryMetricsPoint[],
      };
      const modelDay = emptyHistoryAccumulator();
      for (const accumulator of [dayAccumulator, entry.totals, totals]) {
        accumulator.steps += steps;
        accumulator.turns += turns;
        accumulator.turnMs += turnMs * turns;
        accumulator.ttftWeighted += ttftMs * steps;
        accumulator.p95Weighted += p95TtftMs * steps;
        accumulator.outputTokens += outputTokens;
        accumulator.inputTokens += inputTokens;
        accumulator.cacheRead += cacheRead;
        accumulator.generationMs += generationMs;
        accumulator.prefillSeconds += prefillSeconds;
      }
      modelDay.steps = steps;
      modelDay.turns = turns;
      modelDay.turnMs = turnMs * turns;
      modelDay.ttftWeighted = ttftMs * steps;
      modelDay.p95Weighted = p95TtftMs * steps;
      modelDay.outputTokens = outputTokens;
      modelDay.inputTokens = inputTokens;
      modelDay.cacheRead = cacheRead;
      modelDay.generationMs = generationMs;
      modelDay.prefillSeconds = prefillSeconds;
      entry.points.push(historyPoint(dayKey, modelDay));
      entry.points.sort((a, b) => a.day.localeCompare(b.day));
      models.set(key, entry);
      totalP95 += p95TtftMs * steps;
      totalCacheRead += cacheRead;
    }

    days.push(historyPoint(dayKey, dayAccumulator));
  }

  const inputSide = totals.inputTokens + totals.cacheRead;
  const modelList: HistoryMetricsModel[] = [...models.values()]
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      steps: entry.totals.steps,
      turns: entry.totals.turns,
      outputTokens: entry.totals.outputTokens,
      inputTokens: entry.totals.inputTokens,
      cacheReadTokens: entry.totals.cacheRead,
      generationMs: entry.totals.generationMs,
      avgTtftMs: entry.totals.steps > 0 ? entry.totals.ttftWeighted / entry.totals.steps : null,
      p95TtftMs: entry.totals.steps > 0 ? entry.totals.p95Weighted / entry.totals.steps : null,
      outputTps:
        entry.totals.generationMs > 0
          ? entry.totals.outputTokens / (entry.totals.generationMs / 1000)
          : null,
      prefillTps:
        entry.totals.prefillSeconds > 0
          ? entry.totals.inputTokens / entry.totals.prefillSeconds
          : null,
      turnMs: entry.totals.turns > 0 ? entry.totals.turnMs / entry.totals.turns : null,
      cacheHitPercent:
        entry.totals.inputTokens + entry.totals.cacheRead > 0
          ? (entry.totals.cacheRead / (entry.totals.inputTokens + entry.totals.cacheRead)) * 100
          : null,
      points: entry.points.sort((a, b) => a.day.localeCompare(b.day)),
    }))
    .sort((a, b) => b.steps - a.steps);

  return {
    range,
    generatedAt: Date.now(),
    dbPath: '演示数据',
    source: 'demo',
    totals: {
      steps: totals.steps,
      turns: totals.turns,
      outputTokens: totals.outputTokens,
      inputTokens: totals.inputTokens,
      cacheReadTokens: totalCacheRead,
      generationMs: totals.generationMs,
      avgTtftMs: totals.steps > 0 ? totals.ttftWeighted / totals.steps : null,
      p50TtftMs: totals.steps > 0 ? (totals.ttftWeighted / totals.steps) * 0.92 : null,
      p95TtftMs: totals.steps > 0 ? totalP95 / totals.steps : null,
      outputTps: totals.generationMs > 0 ? totals.outputTokens / (totals.generationMs / 1000) : null,
      prefillTps: totals.prefillSeconds > 0 ? totals.inputTokens / totals.prefillSeconds : null,
      turnMs: totals.turns > 0 ? totals.turnMs / totals.turns : null,
      cacheHitPercent: inputSide > 0 ? (totalCacheRead / inputSide) * 100 : null,
    },
    days,
    models: modelList,
    approximate: true,
  };
}
