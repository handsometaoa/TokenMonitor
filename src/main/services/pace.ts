import type { PaceState, PaceView, QuotaWindowId } from '../../shared/types';

export const WINDOW_DURATION_MS: Record<QuotaWindowId, number> = {
  rolling: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ELAPSED_RATIO = 0.03;
const PACING_TOLERANCE = 5;

export function computePace(input: {
  id: QuotaWindowId;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  now?: number;
  windowMs?: number;
}): PaceView {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? WINDOW_DURATION_MS[input.id];
  const resetMs = input.resetsAt ? Date.parse(input.resetsAt) : Number.NaN;

  if (!Number.isFinite(resetMs)) {
    return {
      state: 'insufficient',
      headroom: null,
      elapsedRatio: 0,
      dailyAverage: null,
      sustainableDaily: null,
      projectedExhaustionAt: null,
    };
  }

  const elapsedMs = Math.min(windowMs, Math.max(0, windowMs - (resetMs - now)));
  const elapsedRatio = windowMs > 0 ? elapsedMs / windowMs : 0;
  if (elapsedRatio < MIN_ELAPSED_RATIO || resetMs <= now) {
    return {
      state: 'insufficient',
      headroom: null,
      elapsedRatio,
      dailyAverage: null,
      sustainableDaily: null,
      projectedExhaustionAt: null,
    };
  }

  const expectedUsed = elapsedRatio * 100;
  const headroom = expectedUsed - input.usedPercent;
  const state: PaceState = headroom >= PACING_TOLERANCE ? 'ahead' : headroom <= -PACING_TOLERANCE ? 'behind' : 'on-pace';

  const elapsedDays = elapsedMs / DAY_MS;
  const daysUntilReset = Math.max(0, (resetMs - now) / DAY_MS);
  const dailyAverage = elapsedDays > 0.02 ? input.usedPercent / elapsedDays : null;
  const sustainableDaily = daysUntilReset > 0 ? input.remainingPercent / daysUntilReset : null;

  let projectedExhaustionAt: string | null = null;
  if (dailyAverage && dailyAverage > 0 && input.remainingPercent > 0) {
    const hoursLeft = (input.remainingPercent / dailyAverage) * 24;
    const exhaustion = now + hoursLeft * 60 * 60 * 1000;
    if (exhaustion < resetMs) projectedExhaustionAt = new Date(exhaustion).toISOString();
  }

  return {
    state,
    headroom,
    elapsedRatio,
    dailyAverage,
    sustainableDaily,
    projectedExhaustionAt,
  };
}
