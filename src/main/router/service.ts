import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { asRecord, errorMessage } from '../../shared/validation';
import type {
  RouterActivityDay,
  RouterBalanceConfig,
  RouterChannelHealth,
  RouterClientProviderFlow,
  RouterLogEntry,
  RouterLogPage,
  RouterLogQuery,
  RouterModelGroup,
  RouterModelTestResult,
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
import { adapterFor } from './protocol/registry';
import type { Conversation } from './protocol/types';
import { ROUTER_QUOTA_STRATEGIES, executeQuotaStrategy, quotaStrategyInfo } from './quota';

type RouterSecretStore = Pick<ProviderSecretStore, 'get' | 'save' | 'clear'>;

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
    private readonly secrets: RouterSecretStore,
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
    // getState runs on every tray/broadcast cycle; skip the token_breakdown
    // re-scan (seconds of blocking on busy days) — only totals are needed.
    const today = this.repo.getUsage('today', { includeBreakdown: false }).totals;
    const state: RouterState = {
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
    return state;
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
      captureBodies: patch.captureBodies ?? current.captureBodies,
    };
    if (!Number.isInteger(next.port) || next.port < 1024 || next.port > 65_535) {
      throw new Error('端口必须是 1024-65535');
    }
    if (!next.apiKey) next.apiKey = this.generateApiKey();
    if (next.apiKey.length < 12) throw new Error('API Key 至少 12 个字符');
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

  async listProviderModels(providerId: string): Promise<string[]> {
    const provider = this.repo.getProvider(providerId);
    if (!provider) throw new Error('提供商不存在');
    const apiKey = this.secrets.get(secretKey(providerId));
    if (!apiKey) throw new Error('该提供商尚未配置 API Key，请先在编辑里保存密钥');
    const adapter = adapterFor(provider.protocol);
    const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { ...adapter.authHeaders(apiKey), accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(`连接上游失败：${errorMessage(error)}`);
    }
    if (response.status === 401 || response.status === 403) throw new Error('API Key 无效或已过期');
    if (!response.ok) throw new Error(`模型列表接口 HTTP ${response.status}`);
    const body: unknown = await response.json();
    const record = asRecord(body);
    const list = Array.isArray(record?.data) ? record.data : Array.isArray(body) ? body : [];
    const ids = list
      .map((item) => asRecord(item)?.id ?? item)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  async testModelRoutes(publicName: string | null): Promise<RouterModelTestResult[]> {
    const groups = this.repo
      .listModelGroups(false)
      .filter((group) => !publicName || group.publicName === publicName);
    const targets = groups.flatMap((group) =>
      group.channels
        .filter((channel) => channel.enabled && !channel.archivedAt)
        .map((channel) => ({
          publicModel: group.publicName,
          providerId: channel.providerId,
          providerName: channel.providerName,
          protocol: channel.providerProtocol,
          upstreamModel: channel.upstreamName,
        })),
    );
    if (targets.length === 0) return [];

    const run = async (target: (typeof targets)[number]): Promise<RouterModelTestResult> => {
      const base: RouterModelTestResult = {
        publicModel: target.publicModel,
        providerName: target.providerName,
        upstreamModel: target.upstreamModel,
        ok: false,
        status: null,
        durationMs: null,
        error: null,
      };
      const provider = this.repo.getProvider(target.providerId);
      const apiKey = provider ? this.secrets.get(secretKey(provider.id)) : null;
      if (!provider || !apiKey) return { ...base, error: '缺少 API Key' };
      const adapter = adapterFor(target.protocol);
      const conversation: Conversation = {
        stream: false,
        system: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], toolCalls: [] }],
        tools: [],
        toolChoice: null,
        temperature: null,
        topP: null,
        maxOutputTokens: 1,
        stop: [],
        reasoningEffort: null,
      };
      let wire: { body: unknown; stream: boolean };
      try {
        wire = adapter.buildRequest(conversation, target.upstreamModel);
      } catch (error) {
        return { ...base, error: `构造请求失败：${error instanceof Error ? error.message : String(error)}` };
      }
      const url = `${provider.baseUrl.replace(/\/+$/, '')}${adapter.upstreamPath}`;
      const headers: Record<string, string> = {
        ...adapter.authHeaders(apiKey),
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (provider.kind === 'opencode' || /opencode\.ai/i.test(provider.baseUrl)) {
        // OpenCode Go rejects probe requests without a session id. Each probe is a
        // standalone conversation, so give it a unique id rather than reusing a client's.
        headers['x-opencode-session'] = randomUUID();
      }
      const startedAt = Date.now();
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(wire.body),
          signal: AbortSignal.timeout(25_000),
        });
        const durationMs = Date.now() - startedAt;
        if (response.ok) return { ...base, ok: true, status: response.status, durationMs, error: null };
        const text = await response.text().catch(() => '');
        const kind = response.status === 401 || response.status === 403 ? '凭证无效' : response.status === 429 ? '已限流' : '上游错误';
        return { ...base, status: response.status, durationMs, error: `${kind}（HTTP ${response.status}）：${text.slice(0, 200)}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ...base, durationMs: Date.now() - startedAt, error: /abort|timeout/i.test(message) ? '请求超时（25s）' : `网络错误：${message}` };
      }
    };

    // Run in small batches so a page-full of channels does not hammer providers at once.
    const results: RouterModelTestResult[] = [];
    const batchSize = 4;
    for (let index = 0; index < targets.length; index += batchSize) {
      results.push(...(await Promise.all(targets.slice(index, index + batchSize).map(run))));
    }
    return results;
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

  renameModelGroup(from: string, to: string): RouterModelGroup[] {
    const source = from.trim();
    const target = to.trim();
    if (!source || !target) throw new Error('模型名不能为空');
    if (source === target) return this.listModels(true);
    this.repo.renameModelGroup(source, target);
    this.emit('changed');
    return this.listModels(true);
  }

  setModelGroupEnabled(publicName: string, enabled: boolean): RouterModelGroup[] {
    this.repo.setModelGroupEnabled(publicName, enabled);
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

  getUsageActivity(days: number): RouterActivityDay[] {
    return this.repo.getUsageActivity(days);
  }

  getClientProviderFlow(days: number): RouterClientProviderFlow[] {
    return this.repo.getClientProviderFlow(days);
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
