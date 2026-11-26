import type { AppSettings } from './types';

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
    homeCards: {
      quota: true,
      health: true,
      trend: true,
      recent: true,
    },
    homeCardOrder: ['quota', 'health', 'trend', 'recent'],
    quotaVisibility: {},
    trayShowRouterQuota: true,
    launchAtLogin: false,
    startHidden: true,
    hideOnBlur: true,
    trayShowRemaining: true,
    localUsageEnabled: true,
    localDataPath: null,
    credentialSource: 'auto',
    orgId: '',
    onboardingCompleted: false,
    windowBounds: null,
    orbEnabled: true,
    orbPosition: null,
    orbTargetKey: null,
    orbQuotaView: 'all',
  };
}
