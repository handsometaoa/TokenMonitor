import type {
  AppInfo,
  AppState,
  CredentialDetection,
  CredentialTestResult,
  QuotaHistoryPoint,
  UpdateSettingsPatch,
} from './types';
import type {
  RouterActivityDay,
  RouterBalanceConfig,
  RouterClientProviderFlow,
  RouterLogEntry,
  RouterLogPage,
  RouterLogQuery,
  RouterModelGroup,
  RouterModelInput,
  RouterModelTestResult,
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
  renameRouterModelGroup(from: string, to: string): Promise<RouterModelGroup[]>;
  setRouterModelGroupEnabled(publicName: string, enabled: boolean): Promise<RouterModelGroup[]>;
  listRouterProviderModels(providerId: string): Promise<string[]>;
  testRouterModels(publicName?: string | null): Promise<RouterModelTestResult[]>;
  getRouterServiceConfig(): Promise<RouterServiceConfig>;
  saveRouterServiceConfig(patch: Partial<RouterServiceConfig>): Promise<RouterState>;
  regenerateRouterApiKey(): Promise<RouterState>;
  getRouterBalance(): Promise<RouterBalanceConfig>;
  saveRouterBalance(patch: Partial<RouterBalanceConfig>): Promise<RouterState>;
  getRouterUsage(range: RouterUsageRange): Promise<RouterUsageOverview>;
  getRouterActivity(days: number): Promise<RouterActivityDay[]>;
  getRouterFlow(days: number): Promise<RouterClientProviderFlow[]>;
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
  clearQuotaHistory(): Promise<AppState>;
  openSettings(): Promise<void>;
  hideWindow(): Promise<void>;
  hidePanel(): Promise<void>;
  togglePanel(): Promise<void>;
  startOrbDrag(): Promise<void>;
  endOrbDrag(): Promise<void>;
  resetOrbPosition(): Promise<void>;
  requestOrbContextMenu(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openDataFolder(): Promise<void>;
  setLaunchAtLogin(enabled: boolean): Promise<AppState>;
  quit(): Promise<void>;
  onStateChanged(listener: (state: AppState) => void): () => void;
  onNavigate(listener: (target: AppNavigateTarget) => void): () => void;
}

export type AppNavigateTarget = 'router' | 'settings';

/** Main → renderer channel for in-window navigation (tray/IPC shortcuts). */
export const APP_NAVIGATE = 'app:navigate';

export const IPC = {
  getState: 'app:get-state',
  getAppInfo: 'app:get-info',
  refreshQuota: 'quota:refresh',
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
  renameRouterModelGroup: 'router:rename-model-group',
  setRouterModelGroupEnabled: 'router:set-model-group-enabled',
  listRouterProviderModels: 'router:list-provider-models',
  testRouterModels: 'router:test-models',
  getRouterServiceConfig: 'router:get-service',
  saveRouterServiceConfig: 'router:save-service',
  regenerateRouterApiKey: 'router:regenerate-key',
  getRouterBalance: 'router:get-balance',
  saveRouterBalance: 'router:save-balance',
  getRouterUsage: 'router:get-usage',
  getRouterActivity: 'router:get-activity',
  getRouterFlow: 'router:get-flow',
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
  clearQuotaHistory: 'quota:clear-history',
  openSettings: 'window:open-settings',
  hideWindow: 'window:hide',
  hidePanel: 'window:hide-panel',
  togglePanel: 'window:toggle-panel',
  orbDragStart: 'orb:drag-start',
  orbDragEnd: 'orb:drag-end',
  orbResetPosition: 'orb:reset-position',
  orbContextMenu: 'orb:context-menu',
  openExternal: 'app:open-external',
  openDataFolder: 'app:open-data-folder',
  setLaunchAtLogin: 'app:set-launch-at-login',
  quit: 'app:quit',
  stateChanged: 'app:state-changed',
} as const;
