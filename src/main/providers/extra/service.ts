import { EventEmitter } from 'node:events';
import type {
  ExtraProviderId,
  ExtraProviderSnapshot,
  ExtraProviderState,
  ProviderError,
} from '../../../shared/types';
import { EXTRA_PROVIDER_IDS, agentQuotaKey } from '../../../shared/types';
import { EXTRA_PROVIDER_NAMES } from '../../../shared/providers';
import { computePace } from '../../services/pace';
import type { Logger } from '../../services/logger';
import type { ProviderSecretStore } from '../../services/providerSecrets';
import type { SettingsStore } from '../../services/settings';
import { fetchClaudeSnapshot } from './claude';
import { fetchCodexSnapshot } from './codex';
import { resolveExtraCredential } from './credentials';
import { fetchCursorSnapshot } from './cursor';
import { ExtraProviderError, type ExtraFetch, type RawExtraSnapshot, type RawExtraWindow } from './types';
import { fetchZaiSnapshot } from './zai';

interface ExtraProviderMeta {
  providerId: ExtraProviderId;
  providerName: string;
}

const DEMO_STATES: Record<
  ExtraProviderId,
  { plan: string; windows: Array<Omit<RawExtraWindow, 'resetsAt'> & { hours: number }> }
> = {
  codex: {
    plan: 'Plus',
    windows: [
      { id: 'session', label: '5-hour', usedPercent: 32, hours: 1.5, status: 'ok' },
      { id: 'weekly', label: 'Weekly', usedPercent: 61, hours: 96, status: 'ok' },
    ],
  },
  claude: {
    plan: 'Claude Max',
    windows: [
      { id: 'session', label: '5-hour', usedPercent: 18, hours: 2.2, status: 'ok' },
      { id: 'weekly', label: 'Weekly', usedPercent: 42, hours: 120, status: 'ok' },
      { id: 'sonnet', label: 'Sonnet weekly', usedPercent: 30, hours: 120, status: 'ok' },
    ],
  },
  cursor: {
    plan: 'Cursor Pro',
    windows: [
      { id: 'monthly', label: 'Monthly', usedPercent: 47, hours: 24 * 15, status: 'ok' },
      { id: 'on-demand', label: 'On-demand', usedPercent: 12, hours: 24 * 15, status: 'ok' },
    ],
  },
  zai: {
    plan: 'GLM Coding Plan',
    windows: [
      { id: 'session', label: '5-hour', usedPercent: 24, hours: 1.7, status: 'ok' },
      { id: 'weekly', label: 'Weekly', usedPercent: 53, hours: 110, status: 'ok' },
      { id: 'monthly', label: 'Monthly', usedPercent: 37, hours: 24 * 20, status: 'ok' },
    ],
  },
  zcode: {
    plan: 'BigModel Coding Plan',
    windows: [
      { id: 'session', label: '5-hour', usedPercent: 12, hours: 2.4, status: 'ok' },
      { id: 'weekly', label: 'Weekly', usedPercent: 28, hours: 130, status: 'ok' },
      { id: 'monthly', label: 'Monthly', usedPercent: 19, hours: 24 * 22, status: 'ok' },
    ],
  },
};

function rawMeta(id: ExtraProviderId): ExtraProviderMeta {
  return { providerId: id, providerName: EXTRA_PROVIDER_NAMES[id] };
}

function buildSnapshot(raw: RawExtraSnapshot, now = Date.now()): ExtraProviderSnapshot {
  return {
    providerId: raw.providerId,
    providerName: raw.providerName,
    planLabel: raw.planLabel,
    fetchedAt: raw.fetchedAt,
    resetCredits: raw.resetCredits ?? null,
    windows: raw.windows.map((window) => {
      const remainingPercent = Math.min(100, Math.max(0, 100 - window.usedPercent));
      const windowMs = window.windowMs ?? 30 * 24 * 60 * 60 * 1000;
      return {
        id: window.id,
        label: window.label,
        usedPercent: window.usedPercent,
        remainingPercent,
        resetsAt: window.resetsAt,
        status: window.status ?? 'ok',
        windowMs,
        pace: computePace({
          usedPercent: window.usedPercent,
          remainingPercent,
          resetsAt: window.resetsAt,
          windowMs,
          now,
        }),
      };
    }),
  };
}

function demoRaw(id: ExtraProviderId, now: number): RawExtraSnapshot {
  const demo = DEMO_STATES[id];
  return {
    ...rawMeta(id),
    planLabel: demo.plan,
    fetchedAt: now,
    windows: demo.windows.map(({ hours, ...window }) => {
      const durationHours =
        window.id === 'session'
          ? 5
          : window.id === 'weekly' || window.id === 'sonnet'
            ? 7 * 24
            : window.id === 'monthly' || window.id === 'on-demand'
              ? 30 * 24
              : hours;
      return {
        ...window,
        resetsAt: new Date(now + hours * 60 * 60 * 1000).toISOString(),
        windowMs: durationHours * 60 * 60 * 1000,
      };
    }),
    resetCredits:
      id === 'codex'
        ? {
            availableCount: 1,
            nextExpiresAt: new Date(now + 27 * 24 * 60 * 60 * 1000).toISOString(),
            updatedAt: now,
          }
        : null,
  };
}

function initialStates(now: number, demo: boolean): Map<ExtraProviderId, ExtraProviderState> {
  const states = new Map<ExtraProviderId, ExtraProviderState>();
  for (const providerId of EXTRA_PROVIDER_IDS) {
    const meta = rawMeta(providerId);
    if (demo) {
      const snapshot = buildSnapshot(demoRaw(providerId, now), now);
      states.set(providerId, {
        ...meta,
        configured: true,
        source: 'auto',
        snapshot,
        error: null,
        loading: false,
        stale: false,
        fetchedAt: snapshot.fetchedAt,
      });
    } else {
      states.set(providerId, {
        ...meta,
        configured: false,
        source: 'none',
        snapshot: null,
        error: {
          code: 'not-configured',
          message: `${meta.providerName} 尚未连接。`,
          retryable: false,
        },
        loading: false,
        stale: false,
        fetchedAt: null,
      });
    }
  }
  return states;
}

function toProviderError(providerName: string, error: unknown): ProviderError {
  if (error instanceof ExtraProviderError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.code === 'network' || error.code === 'timeout' || error.code === 'rate-limited',
    };
  }
  return {
    code: 'unknown',
    message: `${providerName}: ${error instanceof Error ? error.message : '刷新失败。'}`,
    retryable: true,
  };
}

export class ExtraProviderService extends EventEmitter {
  private states: Map<ExtraProviderId, ExtraProviderState>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly secrets: ProviderSecretStore,
    private readonly logger: Logger,
    private readonly demo: boolean,
    private readonly fetchImpl: ExtraFetch,
  ) {
    super();
    this.states = initialStates(Date.now(), demo);
  }

  start(): void {
    this.started = true;
    if (this.demo) {
      this.emit('changed');
      return;
    }
    void this.refresh();
    this.schedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reconfigure(): void {
    if (!this.started || this.demo) return;
    this.schedule();
    void this.refresh();
  }

  getStates(): ExtraProviderState[] {
    return EXTRA_PROVIDER_IDS.filter((id) => this.agentEnabled(id)).map((id) => structuredClone(this.states.get(id)!));
  }

  getState(providerId: ExtraProviderId): ExtraProviderState {
    return structuredClone(this.states.get(providerId)!);
  }

  async refresh(manual = false): Promise<void> {
    if (this.demo) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh(manual).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async setManualSecret(providerId: ExtraProviderId, secret: string): Promise<void> {
    const saved = this.secrets.save(providerId, secret);
    this.logger.info(`Saved ${providerId} provider secret (${saved.persisted ? 'encrypted' : 'session-only'}).`);
    await this.refreshProvider(providerId);
    this.emit('changed');
  }

  async clearManualSecret(providerId: ExtraProviderId): Promise<void> {
    this.secrets.clear(providerId);
    await this.refreshProvider(providerId);
    this.emit('changed');
  }

  private agentEnabled(providerId: ExtraProviderId): boolean {
    // Disabled agents are not scanned at all: no credential file reads, no quota requests.
    return this.settings.get().quotaVisibility[agentQuotaKey(providerId)] !== false;
  }

  private async doRefresh(_manual: boolean): Promise<void> {
    for (const state of this.states.values()) {
      if (state.configured) state.loading = true;
    }
    this.emit('changed');
    await Promise.all(EXTRA_PROVIDER_IDS.filter((id) => this.agentEnabled(id)).map((id) => this.refreshProvider(id, false)));
    this.emit('changed');
    if (this.started) this.schedule();
  }

  private async refreshProvider(providerId: ExtraProviderId, emit = true): Promise<void> {
    if (!this.agentEnabled(providerId)) {
      // Keep the entry unconfigured so no UI shows quota for a disabled agent.
      const meta = rawMeta(providerId);
      this.states.set(providerId, {
        ...meta,
        configured: false,
        source: 'none',
        snapshot: null,
        error: null,
        loading: false,
        stale: false,
        fetchedAt: null,
      });
      if (emit) this.emit('changed');
      return;
    }
    const state = this.states.get(providerId)!;
    const credential = resolveExtraCredential(providerId, this.secrets);
    if (!credential) {
      const meta = rawMeta(providerId);
      this.states.set(providerId, {
        ...meta,
        configured: false,
        source: 'none',
        snapshot: state.snapshot,
        error: {
          code: 'not-configured',
          message: `${meta.providerName} 尚未连接。`,
          retryable: false,
        },
        loading: false,
        stale: Boolean(state.snapshot),
        fetchedAt: state.fetchedAt,
      });
      if (emit) this.emit('changed');
      return;
    }

    this.states.set(providerId, {
      ...state,
      configured: true,
      source: credential.source,
      loading: true,
      error: null,
    });
    if (emit) this.emit('changed');

    try {
      let raw: RawExtraSnapshot;
      switch (providerId) {
        case 'codex':
          raw = await fetchCodexSnapshot(credential, this.fetchImpl);
          break;
        case 'claude':
          raw = await fetchClaudeSnapshot(credential, this.fetchImpl);
          break;
        case 'cursor':
          raw = await fetchCursorSnapshot(credential, this.fetchImpl);
          break;
        case 'zai':
        case 'zcode':
          raw = await fetchZaiSnapshot(credential, this.fetchImpl);
          break;
        default:
          throw new ExtraProviderError('unknown', 'Unsupported provider');
      }
      const snapshot = buildSnapshot(raw);
      this.states.set(providerId, {
        ...rawMeta(providerId),
        configured: true,
        source: credential.source,
        snapshot,
        error: null,
        loading: false,
        stale: false,
        fetchedAt: snapshot.fetchedAt,
      });
    } catch (error) {
      const providerError = toProviderError(state.providerName, error);
      this.logger.error(`${providerId} refresh failed: ${providerError.code}${providerError.status ? ` (${providerError.status})` : ''}.`);
      this.states.set(providerId, {
        ...state,
        configured: true,
        source: credential.source,
        snapshot: state.snapshot,
        error: providerError,
        loading: false,
        stale: Boolean(state.snapshot),
        fetchedAt: state.fetchedAt,
      });
    }
    if (emit) this.emit('changed');
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.started) return;
    const delay = Math.max(1, this.settings.get().refreshMinutes) * 60 * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().finally(() => {
        if (this.started) this.schedule();
      });
    }, delay);
  }
}
