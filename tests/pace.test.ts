import { describe, expect, it } from 'vitest';
import { computePace, WINDOW_DURATION_MS } from '../src/main/services/pace';

const NOW = Date.parse('2026-11-24T00:00:00.000Z');

describe('computePace', () => {
  it('marks a fresh window as insufficient', () => {
    const pace = computePace({
      id: 'rolling',
      usedPercent: 1,
      remainingPercent: 99,
      resetsAt: new Date(NOW + WINDOW_DURATION_MS.rolling).toISOString(),
      now: NOW,
    });
    expect(pace.state).toBe('insufficient');
    expect(pace.headroom).toBeNull();
  });

  it('computes headroom against elapsed time', () => {
    const pace = computePace({
      id: 'rolling',
      usedPercent: 12,
      remainingPercent: 88,
      resetsAt: new Date(NOW + 75 * 60 * 1000).toISOString(),
      now: NOW,
    });
    expect(pace.state).toBe('ahead');
    expect(pace.headroom).toBeGreaterThan(50);
    expect(pace.elapsedRatio).toBeCloseTo(0.75, 2);
  });

  it('flags a window that is consuming too quickly', () => {
    const pace = computePace({
      id: 'weekly',
      usedPercent: 90,
      remainingPercent: 10,
      resetsAt: new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString(),
      now: NOW,
    });
    expect(pace.state).toBe('behind');
    expect(pace.headroom).toBeLessThan(0);
    expect(pace.projectedExhaustionAt).toBeTruthy();
  });

  it('returns insufficient when reset time is missing', () => {
    const pace = computePace({
      id: 'monthly',
      usedPercent: 20,
      remainingPercent: 80,
      resetsAt: null,
      now: NOW,
    });
    expect(pace.state).toBe('insufficient');
  });
});
