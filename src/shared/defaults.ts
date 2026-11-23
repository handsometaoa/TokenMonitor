import type { AppSettings } from './types';

export const DEFAULT_SPEED_UPSTREAM = 'https://opencode.ai/zen/go/v1';

export function createDefaultSettings(): AppSettings {
  return {
    schemaVersion: 1,
    theme: 'system',
    language: 'zh-CN',
    refreshMinutes: 5,
    notifications: {
      enabled: true,
      remainingThresholds: [20, 5],
      rateLimited: true,
      reset: false,
      pace: true,
    },
    launchAtLogin: false,
    startHidden: true,
    hideOnBlur: true,
    trayShowRemaining: true,
    localUsageEnabled: true,
    localDataPath: null,
    credentialSource: 'auto',
    orgId: '',
    speed: {
      enabled: false,
      upstreamBase: DEFAULT_SPEED_UPSTREAM,
      configApplied: false,
    },
    onboardingCompleted: false,
    windowBounds: null,
  };
}
