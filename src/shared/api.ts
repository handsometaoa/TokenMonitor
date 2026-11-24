import type {
  AppInfo,
  AppState,
  CredentialDetection,
  CredentialTestResult,
  HistoryMetrics,
  HistoryRange,
  LocalUsageRange,
  LocalUsageSummary,
  QuotaHistoryPoint,
  SpeedConfigInfo,
  SpeedRange,
  SpeedSeries,
  UpdateSettingsPatch,
} from './types';

export interface TokenMonitorApi {
  getState(): Promise<AppState>;
  getAppInfo(): Promise<AppInfo>;
  refreshQuota(): Promise<AppState>;
  refreshLocalUsage(range: LocalUsageRange): Promise<LocalUsageSummary>;
  getSpeedSeries(range: SpeedRange): Promise<SpeedSeries>;
  getHistoryMetrics(range: HistoryRange, force?: boolean): Promise<HistoryMetrics>;
  getQuotaHistory(hours: number): Promise<QuotaHistoryPoint[]>;
  updateSettings(patch: UpdateSettingsPatch): Promise<AppState>;
  detectCredential(): Promise<CredentialDetection>;
  testAndSaveKey(key: string, orgId: string): Promise<CredentialTestResult>;
  useAutoCredential(orgId: string): Promise<CredentialTestResult>;
  clearCredential(): Promise<AppState>;
  setProviderSecret(providerId: string, secret: string): Promise<AppState>;
  clearProviderSecret(providerId: string): Promise<AppState>;
  chooseLocalDb(): Promise<string | null>;
  setSpeedEnabled(enabled: boolean): Promise<AppState>;
  getSpeedConfig(): Promise<SpeedConfigInfo>;
  testSpeedProxy(): Promise<{ ok: boolean; message: string }>;
  clearSpeedSamples(): Promise<AppState>;
  clearQuotaHistory(): Promise<AppState>;
  openSettings(): Promise<void>;
  hideWindow(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openDataFolder(): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<AppState>;
  quit(): Promise<void>;
  onStateChanged(listener: (state: AppState) => void): () => void;
}

export const IPC = {
  getState: 'app:get-state',
  getAppInfo: 'app:get-info',
  refreshQuota: 'quota:refresh',
  refreshLocalUsage: 'local:refresh',
  getSpeedSeries: 'speed:series',
  getHistoryMetrics: 'speed:history-metrics',
  getQuotaHistory: 'quota:history',
  updateSettings: 'settings:update',
  detectCredential: 'credentials:detect',
  testAndSaveKey: 'credentials:test-and-save',
  useAutoCredential: 'credentials:use-auto',
  clearCredential: 'credentials:clear',
  setProviderSecret: 'providers:set-secret',
  clearProviderSecret: 'providers:clear-secret',
  chooseLocalDb: 'local:choose-db',
  setSpeedEnabled: 'speed:set-enabled',
  getSpeedConfig: 'speed:get-config',
  testSpeedProxy: 'speed:test',
  clearSpeedSamples: 'speed:clear-samples',
  clearQuotaHistory: 'quota:clear-history',
  openSettings: 'window:open-settings',
  hideWindow: 'window:hide',
  openExternal: 'app:open-external',
  openDataFolder: 'app:open-data-folder',
  setLaunchAtLogin: 'app:set-launch-at-login',
  quit: 'app:quit',
  stateChanged: 'app:state-changed',
} as const;
