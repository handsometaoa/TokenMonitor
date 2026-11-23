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
  LocalUsageRange,
  LocalUsageSummary,
  QuotaHistoryPoint,
  SpeedConfigInfo,
  SpeedRange,
  SpeedSeries,
  UpdateSettingsPatch,
} from '../shared/types';
import { EXTRA_PROVIDER_IDS } from '../shared/types';
import { CredentialResolver } from './services/credentials';
import { QuotaHistory } from './services/history';
import { LocalUsageService } from './providers/opencodeGo/localUsage';
import type { FetchLike } from './providers/opencodeGo/api';
import { ExtraProviderService } from './providers/extra/service';
import { Logger } from './services/logger';
import { ProviderSecretStore } from './services/providerSecrets';
import { QuotaNotifierService } from './services/notifier';
import { QuotaService } from './services/quotaService';
import { SecretStore } from './services/secrets';
import { ServiceStatusService } from './services/serviceStatus';
import { SettingsStore } from './services/settings';
import { SpeedManager } from './services/speedManager';
import { SpeedStore } from './services/speedStore';

export class AppController extends EventEmitter {
  readonly logger: Logger;
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly credentials: CredentialResolver;
  readonly history: QuotaHistory;
  readonly quota: QuotaService;
  readonly localUsage: LocalUsageService;
  readonly speed: SpeedManager;
  readonly speedStore: SpeedStore;
  readonly extraSecrets: ProviderSecretStore;
  readonly extraProviders: ExtraProviderService;
  readonly serviceStatus: ServiceStatusService;

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
    this.speedStore = new SpeedStore(baseDir, this.logger);
    this.localUsage = new LocalUsageService(this.settings, this.logger, demo);
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
    this.speed = new SpeedManager(baseDir, this.settings, this.speedStore, this.logger, demo);
    this.extraProviders = new ExtraProviderService(this.settings, this.extraSecrets, this.logger, demo, fetchImpl);
    this.serviceStatus = new ServiceStatusService(fetchImpl, this.logger, demo);

    this.settings.on('changed', (next: AppSettings) => {
      nativeTheme.themeSource = next.theme;
      this.applyLoginItem(next);
      this.emit('state');
    });
    this.quota.on('changed', () => this.emit('state'));
    this.speed.on('changed', () => this.emit('state'));
    this.extraProviders.on('changed', () => this.emit('state'));
    this.serviceStatus.on('changed', () => this.emit('state'));
  }

  start(): void {
    nativeTheme.themeSource = this.settings.get().theme;
    this.applyLoginItem(this.settings.get());
    void this.speed.start();
    this.quota.start();
    this.extraProviders.start();
    this.serviceStatus.start();
  }

  async stop(): Promise<void> {
    this.quota.stop();
    this.extraProviders.stop();
    this.serviceStatus.stop();
    await this.speed.stop();
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
      speed: this.speed.getStatus(),
    };
  }

  async refreshQuota(): Promise<AppState> {
    await Promise.all([this.quota.refresh(true), this.extraProviders.refresh(true), this.serviceStatus.refresh()]);
    return this.getState();
  }

  async getLocalUsage(range: LocalUsageRange): Promise<LocalUsageSummary> {
    return this.localUsage.getSummary(range);
  }

  async getQuotaHistory(hours: number): Promise<QuotaHistoryPoint[]> {
    return this.history.getPoints(hours);
  }

  async getSpeedSeries(range: SpeedRange): Promise<SpeedSeries> {
    return this.speed.getSeries(range);
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
    if (before.localDataPath !== after.localDataPath) this.localUsage.clearCache();
    if (before.launchAtLogin !== after.launchAtLogin) this.applyLoginItem(after);
    this.emit('state');
    return this.getState();
  }

  async setProviderSecret(providerId: string, secret: string): Promise<AppState> {
    if (!EXTRA_PROVIDER_IDS.includes(providerId as ExtraProviderId)) {
      throw new Error('Invalid provider');
    }
    await this.extraProviders.setManualSecret(providerId as ExtraProviderId, secret);
    return this.getState();
  }

  async clearProviderSecret(providerId: string): Promise<AppState> {
    if (!EXTRA_PROVIDER_IDS.includes(providerId as ExtraProviderId)) {
      throw new Error('Invalid provider');
    }
    await this.extraProviders.clearManualSecret(providerId as ExtraProviderId);
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

  async setSpeedEnabled(enabled: boolean): Promise<AppState> {
    await this.speed.setEnabled(enabled);
    this.emit('state');
    return this.getState();
  }

  getSpeedConfig(): SpeedConfigInfo {
    return this.speed.getConfigInfo();
  }

  async testSpeedProxy(): Promise<{ ok: boolean; message: string }> {
    return this.speed.test();
  }

  async clearSpeedSamples(): Promise<AppState> {
    this.speed.clearSamples();
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
