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
import type {
  RouterBalanceConfig,
  RouterLogEntry,
  RouterLogPage,
  RouterLogQuery,
  RouterModelGroup,
  RouterModelInput,
  RouterProvider,
  RouterProviderInput,
  RouterQuotaSnapshot,
  RouterQuotaStrategyInfo,
  RouterServiceConfig,
  RouterState,
  RouterUsageOverview,
  RouterUsageRange,
} from './routerTypes';

export interface TokenMonitorApi {
  getState(): Promise<AppState>;
  getAppInfo(): Promise<AppInfo>;
  refreshQuota(): Promise<AppState>;
  refreshLocalUsage(range: LocalUsageRange): Promise<LocalUsageSummary>;
  getSpeedSeries(range: SpeedRange): Promise<SpeedSeries>;
  getHistoryMetrics(range: HistoryRange, force?: boolean): Promise<HistoryMetrics>;
  getQuotaHistory(hours: number): Promise<QuotaHistoryPoint[]>;
  getRouterState(): Promise<RouterState>;
  listRouterProviders(includeArchived?: boolean): Promise<RouterProvider[]>;
  saveRouterProvider(input: RouterProviderInput): Promise<RouterProvider[]>;
  archiveRouterProvider(id: string, archived: boolean): Promise<RouterProvider[]>;
  deleteRouterProvider(id: string): Promise<RouterProvider[]>;
  listRouterModels(includeArchived?: boolean): Promise<RouterModelGroup[]>;
  saveRouterModel(input: RouterModelInput): Promise<RouterModelGroup[]>;
  archiveRouterModel(id: string, archived: boolean): Promise<RouterModelGroup[]>;
  deleteRouterModel(id: string): Promise<RouterModelGroup[]>;
  getRouterServiceConfig(): Promise<RouterServiceConfig>;
  saveRouterServiceConfig(patch: Partial<RouterServiceConfig>): Promise<RouterState>;
  regenerateRouterApiKey(): Promise<RouterState>;
  getRouterBalance(): Promise<RouterBalanceConfig>;
  saveRouterBalance(patch: Partial<RouterBalanceConfig>): Promise<RouterState>;
  getRouterUsage(range: RouterUsageRange): Promise<RouterUsageOverview>;
  getRouterLogs(query: RouterLogQuery): Promise<RouterLogPage>;
  getRouterLog(id: number): Promise<RouterLogEntry | null>;
  getRouterQuota(): Promise<RouterQuotaSnapshot[]>;
  refreshRouterQuota(): Promise<RouterQuotaSnapshot[]>;
  getRouterQuotaStrategies(): Promise<RouterQuotaStrategyInfo[]>;
  clearRouterLogs(): Promise<RouterState>;
  openRouterWindow(): Promise<void>;
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
  getRouterState: 'router:get-state',
  listRouterProviders: 'router:list-providers',
  saveRouterProvider: 'router:save-provider',
  archiveRouterProvider: 'router:archive-provider',
  deleteRouterProvider: 'router:delete-provider',
  listRouterModels: 'router:list-models',
  saveRouterModel: 'router:save-model',
  archiveRouterModel: 'router:archive-model',
  deleteRouterModel: 'router:delete-model',
  getRouterServiceConfig: 'router:get-service',
  saveRouterServiceConfig: 'router:save-service',
  regenerateRouterApiKey: 'router:regenerate-key',
  getRouterBalance: 'router:get-balance',
  saveRouterBalance: 'router:save-balance',
  getRouterUsage: 'router:get-usage',
  getRouterLogs: 'router:get-logs',
  getRouterLog: 'router:get-log',
  getRouterQuota: 'router:get-quota',
  refreshRouterQuota: 'router:refresh-quota',
  getRouterQuotaStrategies: 'router:get-quota-strategies',
  clearRouterLogs: 'router:clear-logs',
  openRouterWindow: 'router:open-window',
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
