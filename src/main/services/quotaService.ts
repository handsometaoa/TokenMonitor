import { EventEmitter } from 'node:events';
import type { ProviderError, ProviderSnapshot, QuotaState } from '../../shared/types';
import { QUOTA_API_URL, agentQuotaKey } from '../../shared/types';
import type { FetchLike } from '../providers/opencodeGo/api';
import { OpenCodeGoUsageApi, UsageApiError } from '../providers/opencodeGo/api';
import { buildDemoRawSnapshot } from '../providers/opencodeGo/demo';
import { buildProviderSnapshot } from '../providers/opencodeGo/snapshot';
import type { CredentialResolver } from './credentials';
import type { QuotaHistory } from './history';
import type { Logger } from './logger';
import type { SettingsStore } from './settings';

export interface QuotaNotifier {
  evaluate(previous: ProviderSnapshot | null, current: ProviderSnapshot): void;
}

type Timer = ReturnType<typeof setTimeout>;

export class QuotaService extends EventEmitter {
  private state: QuotaState = {
    snapshot: null,
    error: null,
    fetchedAt: null,
    stale: false,
    loading: false,
    configured: false,
  };
  private timer: Timer | null = null;
  private inFlight: Promise<QuotaState> | null = null;
  private failureCount = 0;
  private lastManualAt = 0;
  private started = false;
  private readonly api: OpenCodeGoUsageApi;

  constructor(
    private readonly settings: SettingsStore,
    private readonly credentials: CredentialResolver,
    private readonly history: QuotaHistory,
    private readonly notifier: QuotaNotifier,
    private readonly logger: Logger,
    private readonly demo: boolean,
    fetchImpl: FetchLike,
  ) {
    super();
    this.api = new OpenCodeGoUsageApi(fetchImpl, QUOTA_API_URL, 15_000);
  }

  getState(): QuotaState {
    return structuredClone(this.state);
  }

  private openCodeEnabled(): boolean {
    // Master switch: a disabled OpenCode Go agent is never scanned or shown.
    return this.settings.get().quotaVisibility[agentQuotaKey('opencode')] !== false;
  }

  start(): void {
    this.started = true;
    this.loadCache();
    if (!this.openCodeEnabled()) {
      this.clearTimer();
      this.state = {
        snapshot: null,
        error: null,
        fetchedAt: null,
        stale: false,
        loading: false,
        configured: false,
      };
      this.emitState();
      return;
    }
    this.refresh().catch((error) => this.logger.error('Initial quota refresh failed.', error));
  }

  async testKey(key: string, orgId = ''): Promise<import('../../shared/types').CredentialTestResult> {
    try {
      await this.api.fetchUsage(key, orgId);
      return { ok: true };
    } catch (error) {
      if (error instanceof UsageApiError) {
        return { ok: false, code: error.code, message: error.message };
      }
      return {
        ok: false,
        code: 'unknown',
        message: error instanceof Error ? error.message : '测试连接失败。',
      };
    }
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
  }

  reconfigure(): void {
    this.clearTimer();
    if (!this.started) return;
    this.refresh().catch((error) => this.logger.error('Quota reconfigure refresh failed.', error));
  }

  async refresh(manual = false): Promise<QuotaState> {
    if (this.inFlight) return this.inFlight;
    if (manual) {
      const now = Date.now();
      if (now - this.lastManualAt < 5_000) return this.getState();
      this.lastManualAt = now;
    }

    this.inFlight = this.doRefresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async doRefresh(): Promise<QuotaState> {
    if (!this.openCodeEnabled()) {
      this.clearTimer();
      this.state = {
        snapshot: null,
        error: null,
        fetchedAt: null,
        stale: false,
        loading: false,
        configured: false,
      };
      this.emitState();
      return this.getState();
    }
    if (this.demo) {
      const raw = buildDemoRawSnapshot();
      const snapshot = buildProviderSnapshot(raw, 'demo');
      const previous = this.state.snapshot;
      this.state = {
        snapshot,
        error: null,
        fetchedAt: snapshot.fetchedAt,
        stale: false,
        loading: false,
        configured: true,
      };
      this.emitState();
      return this.getState();
    }

    const credential = this.credentials.resolve();
    if (!credential) {
      this.clearTimer();
      this.state = {
        snapshot: this.state.snapshot,
        error: {
          code: 'not-configured',
          message: '尚未配置 OpenCode Go API Key。',
          retryable: false,
        },
        fetchedAt: this.state.fetchedAt,
        stale: Boolean(this.state.snapshot),
        loading: false,
        configured: false,
      };
      this.emitState();
      return this.getState();
    }

    this.state = { ...this.state, loading: true, configured: true };
    this.emitState();

    const previous = this.state.snapshot;
    const settings = this.settings.get();
    try {
      const raw = await this.api.fetchUsage(credential.key, settings.orgId);
      const snapshot = buildProviderSnapshot(raw, 'api');
      this.state = {
        snapshot,
        error: null,
        fetchedAt: snapshot.fetchedAt,
        stale: false,
        loading: false,
        configured: true,
      };
      this.failureCount = 0;
      this.history.append(snapshot);
      this.notifier.evaluate(previous, snapshot);
      this.schedule(settings.refreshMinutes * 60 * 1000);
      this.emitState();
      return this.getState();
    } catch (error) {
      const providerError: ProviderError =
        error instanceof UsageApiError
          ? error.toProviderError()
          : {
              code: 'unknown',
              message: error instanceof Error ? error.message : '额度刷新失败。',
              retryable: true,
            };
      this.logger.error(`Quota refresh failed: ${providerError.code}${providerError.status ? ` (${providerError.status})` : ''}.`);
      this.failureCount += 1;
      this.state = {
        snapshot: previous,
        error: providerError,
        fetchedAt: previous?.fetchedAt ?? this.state.fetchedAt,
        stale: Boolean(previous),
        loading: false,
        configured: true,
      };
      this.schedule(this.nextDelay(providerError));
      this.emitState();
      return this.getState();
    }
  }

  private loadCache(): void {
    if (this.demo) {
      const raw = buildDemoRawSnapshot();
      const snapshot = buildProviderSnapshot(raw, 'demo');
      this.state = {
        snapshot,
        error: null,
        fetchedAt: snapshot.fetchedAt,
        stale: false,
        loading: false,
        configured: true,
      };
      this.emitState();
      return;
    }

    const latest = this.history.getLatestPoint();
    if (!latest) return;
    const now = Date.now();
    const raw = {
      fetchedAt: latest.ts,
      planLabel: 'OpenCode Go',
      windows: (['rolling', 'weekly', 'monthly'] as const)
        .map((id) => {
          const percent = latest[id];
          const reset = latest[`${id}Reset` as 'rollingReset' | 'weeklyReset' | 'monthlyReset'];
          if (percent === null) return null;
          return { id, usedPercent: percent, status: 'ok' as const, resetsAt: reset };
        })
        .filter((window): window is NonNullable<typeof window> => Boolean(window)),
    };
    this.state = {
      snapshot: buildProviderSnapshot(raw, 'cache', now),
      error: null,
      fetchedAt: latest.ts,
      stale: now - latest.ts > 10 * 60 * 1000,
      loading: false,
      configured: this.credentials.status().configured,
    };
    this.emitState();
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch((error) => this.logger.error('Scheduled quota refresh failed.', error));
    }, Math.max(10_000, delayMs));
  }

  private nextDelay(error: ProviderError): number {
    if (error.code === 'invalid-key' || error.code === 'no-subscription' || error.code === 'malformed') {
      return 15 * 60 * 1000;
    }
    const base = error.code === 'rate-limited' ? 60_000 : 30_000;
    const backoff = Math.min(base * 2 ** Math.max(0, this.failureCount - 1), 5 * 60 * 1000);
    const jitter = Math.round(Math.random() * 0.2 * backoff);
    return backoff + jitter;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emitState(): void {
    this.emit('changed', this.getState());
  }
}
