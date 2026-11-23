import type {
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
