import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  RouterBalanceConfig,
  RouterChannelHealth,
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
  RouterServiceState,
  RouterState,
  RouterUsageOverview,
  RouterUsageRange,
} from '../../shared/routerTypes';
import { DEFAULT_ROUTER_PORT } from '../../shared/routerTypes';
import type { Logger } from '../services/logger';
import type { ProviderSecretStore } from '../services/providerSecrets';
import { RouterBalancer } from './balancer';
import { RouterRepository, type RouterProviderRow } from './db';
import { RouterGateway, type RouterFetch } from './gateway';
import { ROUTER_QUOTA_STRATEGIES, executeQuotaStrategy, quotaStrategyInfo } from './quota';

function maskKey(secret: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 6) return '••••';
  return `••••${secret.slice(-4)}`;
}

function secretKey(providerId: string): string {
  return `router:${providerId}`;
}

function providerView(
  row: RouterProviderRow,
  secret: string | null,
  modelCount: number,
): RouterProvider {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    kind: row.kind,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    archivedAt: row.archivedAt,
    quotaStrategyId: row.quotaStrategyId,
    strategyConfig: row.strategyConfig,
    hasKey: Boolean(secret),
    keyMasked: maskKey(secret),
    modelCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validBaseUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Base URL 无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Base URL 必须是 http 或 https');
  }
  return trimmed.replace(/\/+$/, '');
}

export class RouterService extends EventEmitter {
  readonly repo: RouterRepository;
  readonly balancer: RouterBalancer;
  private readonly gateway: RouterGateway;
  private readonly demo: boolean;
  private closed = false;
  private quotaTimer: NodeJS.Timeout | null = null;
  private quotaStartupTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(
    baseDir: string,
    private readonly logger: Logger,
    private readonly secrets: ProviderSecretStore,
    private readonly fetchImpl: RouterFetch,
    demo: boolean,
  ) {
    super();
    this.demo = demo;
    this.repo = new RouterRepository(baseDir);
    this.balancer = new RouterBalancer(this.repo);
    this.gateway = new RouterGateway(
      this.repo,
      this.secrets,
      this.balancer,
      this.logger,
      fetchImpl,
      () => this.repo.getServiceConfig(),
    );
  }

  async start(): Promise<void> {
    if (this.demo) {
      this.emit('changed');
      return;
    }
    this.repo.markPendingInterrupted();
    this.repo.pruneLogs(7);
    this.repo.pruneUsage(7);
    const config = this.repo.getServiceConfig();
    if (!config.apiKey) {
      config.apiKey = this.generateApiKey();
      this.repo.setServiceConfig(config);
    }
    await this.gateway.start();
    this.quotaStartupTimer = setTimeout(() => void this.refreshQuota(), 5000);
    this.quotaStartupTimer.unref?.();
    this.quotaTimer = setInterval(() => void this.refreshQuota(), 10 * 60 * 1000);
    this.quotaTimer.unref?.();
    this.maintenanceTimer = setInterval(() => {
      this.repo.pruneLogs(7);
      this.repo.pruneUsage(7);
    }, 24 * 60 * 60 * 1000);
    this.maintenanceTimer.unref?.();
    this.emit('changed');
  }

  async stop(): Promise<void> {
    if (this.quotaStartupTimer) clearTimeout(this.quotaStartupTimer);
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.quotaStartupTimer = null;
    this.quotaTimer = null;
    this.maintenanceTimer = null;
    await this.gateway.stop();
    if (!this.closed) {
      this.closed = true;
      this.repo.close();
    }
    this.emit('changed');
  }

  getState(): RouterState {
    const config = this.repo.getServiceConfig();
    const status = this.gateway.getStatus();
    const service: RouterServiceState = {
      state: status.error ? 'error' : status.running ? 'running' : 'stopped',
      port: status.running ? status.port ?? config.port : config.port,
      error: status.error,
      startedAt: status.startedAt,
      activeRequests: status.activeRequests,
      config,
    };
    const providers = this.repo.listProviders(false);
    const today = this.repo.getUsage('today').totals;
    return {
      service,
      balance: this.repo.getBalanceConfig(),
      channelHealth: this.balancer.getHealth(providers.map((provider) => ({ id: provider.id, name: provider.name }))),
      usageToday: {
        requests: today.requestCount,
        tokens: today.totalTokens,
        successRate: today.requestCount > 0 ? (today.successCount / today.requestCount) * 100 : null,
      },
      quota: this.getQuota(),
    };
  }

  getServiceConfig(): RouterServiceConfig {
    return this.repo.getServiceConfig();
  }

  async saveServiceConfig(patch: Partial<RouterServiceConfig>): Promise<RouterState> {
    const current = this.repo.getServiceConfig();
    const next: RouterServiceConfig = {
      enabled: patch.enabled ?? current.enabled,
      port: Number(patch.port ?? current.port),
      apiKey: patch.apiKey?.trim() || current.apiKey,
      proxyUrl: patch.proxyUrl !== undefined ? patch.proxyUrl.trim() : current.proxyUrl,
    };
    if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65_535) {
      throw new Error('端口必须是 1024-65535');
    }
    if (next.apiKey.length < 12) throw new Error('API Key 至少 12 个字符');
    if (!next.apiKey) next.apiKey = this.generateApiKey();
    this.repo.setServiceConfig(next);
    await this.gateway.start();
    this.emit('changed');
    return this.getState();
  }

  regenerateApiKey(): RouterState {
    const config = this.repo.getServiceConfig();
    config.apiKey = this.generateApiKey();
    this.repo.setServiceConfig(config);
    this.emit('changed');
    return this.getState();
  }

  listProviders(includeArchived = false): RouterProvider[] {
    return this.repo.listProviders(includeArchived).map((row) =>
      providerView(row, this.secrets.get(secretKey(row.id)), this.repo.countModels(row.id)),
    );
  }

  saveProvider(input: RouterProviderInput): RouterProvider[] {
    if (!input.name.trim()) throw new Error('提供商名称不能为空');
    const existing = input.id ? this.repo.getProvider(input.id) : null;
    const row = this.repo.saveProvider({
      ...input,
      name: input.name.trim(),
      baseUrl: validBaseUrl(input.baseUrl),
    });
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      this.secrets.save(secretKey(row.id), input.apiKey.trim());
    }
    if (existing) this.balancer.reset(existing.id);
    if (input.quotaStrategyId) void this.refreshQuota();
    this.emit('changed');
    return this.listProviders();
  }

  archiveProvider(id: string, archived: boolean): RouterProvider[] {
    this.repo.setProviderArchived(id, archived);
    this.balancer.reset(id);
    this.emit('changed');
    return this.listProviders(true);
  }

  deleteProvider(id: string): RouterProvider[] {
    this.repo.deleteProvider(id);
    this.secrets.clear(secretKey(id));
    this.balancer.reset(id);
    this.emit('changed');
    return this.listProviders(true);
  }

  listModels(includeArchived = false): RouterModelGroup[] {
    return this.repo.listModelGroups(includeArchived).map((group) => ({
      publicName: group.publicName,
      channels: group.channels,
      enabledCount: group.channels.filter((channel) => channel.enabled).length,
      totalCount: group.channels.length,
    }));
  }

  saveModel(input: RouterModelInput): RouterModelGroup[] {
    const provider = this.repo.getProvider(input.providerId);
    if (!provider) throw new Error('提供商不存在');
    if (!input.publicName.trim()) throw new Error('对外模型名不能为空');
    if (!input.upstreamName.trim()) throw new Error('上游模型名不能为空');
    try {
      this.repo.saveModel({
        ...input,
        publicName: input.publicName.trim(),
        upstreamName: input.upstreamName.trim(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存模型失败';
      if (/UNIQUE/i.test(message)) throw new Error('同一提供商下已存在同名对外模型');
      throw error;
    }
    this.emit('changed');
    return this.listModels(true);
  }

  archiveModel(id: string, archived: boolean): RouterModelGroup[] {
    this.repo.setModelArchived(id, archived);
    this.emit('changed');
    return this.listModels(true);
  }

  deleteModel(id: string): RouterModelGroup[] {
    this.repo.deleteModel(id);
    this.emit('changed');
    return this.listModels(true);
  }

  getBalanceConfig(): RouterBalanceConfig {
    return this.repo.getBalanceConfig();
  }

  saveBalanceConfig(patch: Partial<RouterBalanceConfig>): RouterState {
    const current = this.repo.getBalanceConfig();
    const next: RouterBalanceConfig = {
      enabled: patch.enabled ?? current.enabled,
      sessionAffinity: patch.sessionAffinity ?? current.sessionAffinity,
      quotaGuard: patch.quotaGuard ?? current.quotaGuard,
      maxAttempts: Math.min(5, Math.max(1, Number(patch.maxAttempts ?? current.maxAttempts) || 3)),
    };
    this.repo.setBalanceConfig(next);
    this.balancer.reset();
    this.emit('changed');
    return this.getState();
  }

  getChannelHealth(): RouterChannelHealth[] {
    return this.getState().channelHealth;
  }

  getUsage(range: RouterUsageRange): RouterUsageOverview {
    return this.repo.getUsage(range);
  }

  getLogs(query: RouterLogQuery): RouterLogPage {
    return this.repo.listLogs(query);
  }

  getLog(id: number): RouterLogEntry | null {
    return this.repo.getLog(id);
  }

  getQuotaStrategies(): RouterQuotaStrategyInfo[] {
    return quotaStrategyInfo();
  }

  getQuota(): RouterQuotaSnapshot[] {
    const snapshots = new Map(this.repo.listQuotaSnapshots().map((item) => [item.providerId, item]));
    return this.repo
      .listProviders(false)
      .filter((provider) => Boolean(provider.quotaStrategyId))
      .map((provider) => {
        const stored = snapshots.get(provider.id);
        const strategy = ROUTER_QUOTA_STRATEGIES.find((item) => item.id === provider.quotaStrategyId);
        if (stored?.snapshot) {
          return { ...stored.snapshot, providerName: provider.name, strategyLabel: strategy?.label ?? provider.quotaStrategyId };
        }
        return {
          providerId: provider.id,
          providerName: provider.name,
          strategyId: provider.quotaStrategyId,
          strategyLabel: strategy?.label ?? provider.quotaStrategyId,
          windows: [],
          balance: null,
          currency: null,
          details: [],
          error: stored?.error ?? null,
          queriedAt: stored?.queriedAt ?? null,
        };
      });
  }

  async refreshQuota(): Promise<RouterQuotaSnapshot[]> {
    const providers = this.repo.listProviders(false).filter((provider) => provider.quotaStrategyId);
    await Promise.all(
      providers.map(async (provider) => {
        const strategyId = provider.quotaStrategyId;
        if (!strategyId) return;
        const apiKey = this.secrets.get(secretKey(provider.id));
        if (!apiKey) {
          const snapshot: RouterQuotaSnapshot = {
            providerId: provider.id,
            providerName: provider.name,
            strategyId,
            strategyLabel: ROUTER_QUOTA_STRATEGIES.find((item) => item.id === strategyId)?.label ?? strategyId,
            windows: [],
            balance: null,
            currency: null,
            details: [],
            error: '缺少 API Key / Token / Cookie',
            queriedAt: Date.now(),
          };
          this.repo.saveQuotaSnapshot({
            providerId: provider.id,
            snapshot,
            error: snapshot.error,
            queriedAt: snapshot.queriedAt ?? Date.now(),
          });
          return;
        }
        const snapshot = await executeQuotaStrategy(strategyId, provider, apiKey, this.fetchImpl);
        this.repo.saveQuotaSnapshot({
          providerId: provider.id,
          snapshot,
          error: snapshot.error,
          queriedAt: snapshot.queriedAt ?? Date.now(),
        });
      }),
    );
    this.emit('changed');
    return this.getQuota();
  }

  clearLogs(): RouterState {
    this.repo.clearLogs();
    this.emit('changed');
    return this.getState();
  }

  private generateApiKey(): string {
    return `sk-router-${randomBytes(24).toString('hex')}`;
  }

  isDemo(): boolean {
    return this.demo;
  }
}
