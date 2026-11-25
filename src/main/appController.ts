import { EventEmitter } from 'node:events';
import { app, nativeTheme } from 'electron';
import type {
  AppInfo,
  AppSettings,
  AppState,
  CredentialDetection,
  CredentialStatus,
  CredentialTestResult,
  ExtraProviderId,
  QuotaHistoryPoint,
  UpdateSettingsPatch,
} from '../shared/types';
import { EXTRA_PROVIDER_IDS } from '../shared/types';
import { CredentialResolver } from './services/credentials';
import { QuotaHistory } from './services/history';
import type { FetchLike } from './providers/opencodeGo/api';
import { ExtraProviderService } from './providers/extra/service';
import { Logger } from './services/logger';
import { ProviderSecretStore } from './services/providerSecrets';
import { QuotaNotifierService } from './services/notifier';
import { QuotaService } from './services/quotaService';
import { SecretStore } from './services/secrets';
import { ServiceStatusService } from './services/serviceStatus';
import { SettingsStore } from './services/settings';
import { RouterService } from './router/service';
import type {
  RouterActivityDay,
  RouterBalanceConfig,
  RouterClientProviderFlow,
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
  RouterModelTestResult,
  RouterUsageOverview,
  RouterUsageRange,
} from '../shared/routerTypes';

function isExtraProviderId(value: string): value is ExtraProviderId {
  return EXTRA_PROVIDER_IDS.some((id) => id === value);
}

export class AppController extends EventEmitter {
  readonly logger: Logger;
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly credentials: CredentialResolver;
  readonly history: QuotaHistory;
  readonly quota: QuotaService;
  readonly extraSecrets: ProviderSecretStore;
  readonly extraProviders: ExtraProviderService;
  readonly serviceStatus: ServiceStatusService;
  readonly router: RouterService;

  constructor(
    private readonly baseDir: string,
    private readonly demo: boolean,
    fetchImpl: FetchLike,
    private readonly showWindow: () => void,
  ) {
    super();
    this.logger = new Logger(baseDir);
    this.settings = new SettingsStore(baseDir);
    this.secrets = new SecretStore(baseDir, this.logger);
    this.extraSecrets = new ProviderSecretStore(baseDir, this.logger);
    this.credentials = new CredentialResolver(this.settings, this.secrets, this.logger);
    this.history = new QuotaHistory(baseDir, this.logger);
    const notifier = new QuotaNotifierService(this.settings, showWindow, demo);
    this.quota = new QuotaService(
      this.settings,
      this.credentials,
      this.history,
      notifier,
      this.logger,
      demo,
      fetchImpl,
    );
    this.extraProviders = new ExtraProviderService(this.settings, this.extraSecrets, this.logger, demo, fetchImpl);
    this.serviceStatus = new ServiceStatusService(fetchImpl, this.logger, demo);
    this.router = new RouterService(baseDir, this.logger, this.extraSecrets, fetchImpl, demo);
    this.router.on('changed', () => this.emit('state'));

    this.settings.on('changed', (next: AppSettings) => {
      nativeTheme.themeSource = next.theme;
      this.applyLoginItem(next);
      this.emit('state');
    });
    this.quota.on('changed', () => this.emit('state'));
    this.extraProviders.on('changed', () => this.emit('state'));
    this.serviceStatus.on('changed', () => this.emit('state'));
  }

  start(): void {
    nativeTheme.themeSource = this.settings.get().theme;
    this.applyLoginItem(this.settings.get());
    void this.router.start();
    this.quota.start();
    this.extraProviders.start();
    this.serviceStatus.start();
  }

  async stop(): Promise<void> {
    this.quota.stop();
    this.extraProviders.stop();
    this.serviceStatus.stop();
    await this.router.stop();
  }

  getState(): AppState {
    const settings = this.settings.get();
    const credentials = this.credentials.status();
    const demoStatus: CredentialStatus = {
      configured: true,
      kind: 'manual',
      masked: '•••• demo',
      persisted: false,
      envAvailable: false,
      authFileAvailable: false,
      authFileHasOpenCode: false,
    };
    return {
      ready: true,
      demo: this.demo,
      version: app.getVersion(),
      platform: process.platform,
      settings: {
        ...settings,
        onboardingCompleted: this.demo ? true : settings.onboardingCompleted,
      },
      credentials: this.demo ? demoStatus : credentials,
      quota: this.quota.getState(),
      extraProviders: this.extraProviders.getStates(),
      serviceStatuses: this.serviceStatus.getStatuses(),
      router: this.router.getState(),
    };
  }

  async refreshQuota(): Promise<AppState> {
    await Promise.all([this.quota.refresh(true), this.extraProviders.refresh(true), this.serviceStatus.refresh()]);
    return this.getState();
  }

  async getQuotaHistory(hours: number): Promise<QuotaHistoryPoint[]> {
    return this.history.getPoints(hours);
  }

  updateSettings(patch: UpdateSettingsPatch): AppState {
    const before = this.settings.get();
    const after = this.settings.update(patch);
    const refreshChanged =
      before.refreshMinutes !== after.refreshMinutes ||
      before.orgId !== after.orgId ||
      before.credentialSource !== after.credentialSource;
    if (refreshChanged) {
      this.quota.reconfigure();
      this.extraProviders.reconfigure();
    }
    if (before.launchAtLogin !== after.launchAtLogin) this.applyLoginItem(after);
    this.emit('state');
    return this.getState();
  }

  async setProviderSecret(providerId: string, secret: string): Promise<AppState> {
    if (!isExtraProviderId(providerId)) {
      throw new Error('Invalid provider');
    }
    await this.extraProviders.setManualSecret(providerId, secret);
    return this.getState();
  }

  async clearProviderSecret(providerId: string): Promise<AppState> {
    if (!isExtraProviderId(providerId)) {
      throw new Error('Invalid provider');
    }
    await this.extraProviders.clearManualSecret(providerId);
    return this.getState();
  }

  detectCredential(): CredentialDetection {
    return this.credentials.detect();
  }

  async testAndSaveKey(key: string, orgId: string): Promise<CredentialTestResult> {
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      return { ok: false, code: 'invalid-key', message: 'API Key 长度不正确。' };
    }
    const test = await this.quota.testKey(trimmed, orgId);
    if (!test.ok) return test;
    const saved = this.credentials.saveManual(trimmed, orgId);
    this.quota.reconfigure();
    this.emit('state');
    return {
      ok: true,
      message: saved.persisted ? undefined : 'Key 已验证，但系统加密不可用，仅在本次运行中保留。',
    };
  }

  async useAutoCredential(orgId: string): Promise<CredentialTestResult> {
    const resolved = this.credentials.resolve();
    if (!resolved) {
      return { ok: false, code: 'not-configured', message: '没有检测到可用的 OpenCode Key。' };
    }
    const test = await this.quota.testKey(resolved.key, orgId);
    if (!test.ok) return test;
    this.credentials.useAuto(orgId);
    this.quota.reconfigure();
    this.emit('state');
    return { ok: true };
  }

  clearCredential(): AppState {
    this.credentials.clear();
    this.quota.reconfigure();
    this.emit('state');
    return this.getState();
  }

  clearQuotaHistory(): AppState {
    this.history.clear();
    this.emit('state');
    return this.getState();
  }

  getAppInfo(): AppInfo {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    };
  }

  setLaunchAtLogin(enabled: boolean): AppState {
    return this.updateSettings({ launchAtLogin: enabled });
  }

  getRouterState(): RouterState {
    return this.router.getState();
  }

  listRouterProviders(includeArchived = false): RouterProvider[] {
    return this.router.listProviders(includeArchived);
  }

  saveRouterProvider(input: RouterProviderInput): RouterProvider[] {
    return this.router.saveProvider(input);
  }

  archiveRouterProvider(id: string, archived: boolean): RouterProvider[] {
    return this.router.archiveProvider(id, archived);
  }

  deleteRouterProvider(id: string): RouterProvider[] {
    return this.router.deleteProvider(id);
  }

  listRouterModels(includeArchived = false): RouterModelGroup[] {
    return this.router.listModels(includeArchived);
  }

  saveRouterModel(input: RouterModelInput): RouterModelGroup[] {
    return this.router.saveModel(input);
  }

  archiveRouterModel(id: string, archived: boolean): RouterModelGroup[] {
    return this.router.archiveModel(id, archived);
  }

  deleteRouterModel(id: string): RouterModelGroup[] {
    return this.router.deleteModel(id);
  }

  renameRouterModelGroup(from: string, to: string): RouterModelGroup[] {
    return this.router.renameModelGroup(from, to);
  }

  setRouterModelGroupEnabled(publicName: string, enabled: boolean): RouterModelGroup[] {
    return this.router.setModelGroupEnabled(publicName, enabled);
  }

  async listRouterProviderModels(providerId: string): Promise<string[]> {
    return this.router.listProviderModels(providerId);
  }

  async testRouterModels(publicName: string | null): Promise<RouterModelTestResult[]> {
    return this.router.testModelRoutes(publicName);
  }

  getRouterServiceConfig(): RouterServiceConfig {
    return this.router.getServiceConfig();
  }

  async saveRouterServiceConfig(patch: Partial<RouterServiceConfig>): Promise<RouterState> {
    return this.router.saveServiceConfig(patch);
  }

  async regenerateRouterApiKey(): Promise<RouterState> {
    return this.router.regenerateApiKey();
  }

  getRouterBalance(): RouterBalanceConfig {
    return this.router.getBalanceConfig();
  }

  saveRouterBalance(patch: Partial<RouterBalanceConfig>): RouterState {
    return this.router.saveBalanceConfig(patch);
  }

  getRouterUsage(range: RouterUsageRange): RouterUsageOverview {
    return this.router.getUsage(range);
  }

  getRouterActivity(days: number): RouterActivityDay[] {
    return this.router.getUsageActivity(days);
  }

  getRouterFlow(days: number): RouterClientProviderFlow[] {
    return this.router.getClientProviderFlow(days);
  }

  getRouterLogs(query: RouterLogQuery): RouterLogPage {
    return this.router.getLogs(query);
  }

  getRouterLog(id: number): RouterLogEntry | null {
    return this.router.getLog(id);
  }

  getRouterQuota(): RouterQuotaSnapshot[] {
    return this.router.getQuota();
  }

  async refreshRouterQuota(): Promise<RouterQuotaSnapshot[]> {
    return this.router.refreshQuota();
  }

  getRouterQuotaStrategies(): RouterQuotaStrategyInfo[] {
    return this.router.getQuotaStrategies();
  }

  clearRouterLogs(): RouterState {
    return this.router.clearLogs();
  }

  private applyLoginItem(settings: AppSettings): void {
    if (!app.isPackaged) return;
    try {
      app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin,
        args: ['--hidden'],
      });
    } catch (error) {
      this.logger.error('Could not update login item.', error);
    }
  }
}
