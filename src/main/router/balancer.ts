import { createHash } from 'node:crypto';
import { asRecord } from '../../shared/validation';
import type {
  RouterBalanceConfig,
  RouterChannelHealth,
  RouterQuotaSnapshot,
} from '../../shared/routerTypes';
import type { RouterRepository, RouterRoute } from './db';

export type RouterFailureKind = 'network' | 'server' | 'auth' | 'quota';

interface RuntimeState {
  availability: number;
  consecutiveFailures: number;
  lastError: string | null;
  blockUntil: number | null;
  blockReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastProbeAt: number | null;
}

const DEFAULT_RUNTIME: RuntimeState = {
  availability: 100,
  consecutiveFailures: 0,
  lastError: null,
  blockUntil: null,
  blockReason: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastProbeAt: null,
};

export function sessionKeyFrom(headers: Record<string, string | string[] | undefined>, body: unknown): string | null {
  for (const name of ['x-session-id', 'x-conversation-id', 'x-thread-id', 'x-opencode-session']) {
    const value = headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'string' && text.trim()) return `${name}:${text.trim()}`;
  }
  const record = asRecord(body);
  if (record) {
    const metadata = asRecord(record.metadata) ?? {};
    for (const value of [record.conversation_id, record.session_id, metadata.user_id, metadata.session_id]) {
      if (typeof value === 'string' && value.trim()) return `meta:${value.trim()}`;
    }
  }
  const fingerprint = fingerprintBody(body);
  return fingerprint ? `body:${fingerprint}` : null;
}

function fingerprintBody(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  let text = '';
  if (typeof record.input === 'string') text = record.input;
  if (!text && Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const item = asRecord(message);
      if (!item || item.role !== 'user') continue;
      if (typeof item.content === 'string') {
        text = item.content;
        break;
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          const block = asRecord(part);
          if (typeof block?.text === 'string' && block.text) {
            text = block.text;
            break;
          }
        }
      }
      if (text) break;
    }
  }
  if (!text) return null;
  return createHash('sha1').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
}

export class RouterBalancer {
  private readonly runtimes = new Map<string, RuntimeState>();
  private readonly sessions = new Map<string, string>();

  constructor(private readonly repo: RouterRepository) {}

  getHealth(providers: Array<{ id: string; name: string }>): RouterChannelHealth[] {
    return providers.map((provider) => {
      const runtime = this.runtime(provider.id);
      this.refreshQuotaGuard(provider.id, runtime);
      const state =
        runtime.availability <= 0
          ? 'blocked'
          : runtime.availability < 60 || runtime.consecutiveFailures > 0
            ? 'degraded'
            : 'healthy';
      return {
        providerId: provider.id,
        providerName: provider.name,
        availability: Math.round(runtime.availability),
        state,
        blockReason: runtime.blockReason,
        blockUntil: runtime.blockUntil,
        consecutiveFailures: runtime.consecutiveFailures,
        lastError: runtime.lastError,
        lastFailureAt: runtime.lastFailureAt,
        lastSuccessAt: runtime.lastSuccessAt,
      };
    });
  }

  orderCandidates(
    routes: RouterRoute[],
    config: RouterBalanceConfig,
    sessionKey: string | null,
  ): RouterRoute[] {
    const now = Date.now();
    const usable = routes.filter((route) => {
      const runtime = this.runtime(route.providerId);
      this.refreshQuotaGuard(route.providerId, runtime);
      if (runtime.blockUntil !== null && runtime.blockUntil > now) return false;
      return true;
    });
    if (!config.enabled) {
      const first = usable[0];
      return first ? [first] : [];
    }

    const bound = config.sessionAffinity && sessionKey ? this.sessions.get(sessionKey) : null;
    const remaining = usable.filter((route) => route.providerId !== bound);
    const ordered: RouterRoute[] = [];
    if (bound) {
      const match = usable.find((route) => route.providerId === bound);
      if (match) ordered.push(match);
    }

    const pool = [...remaining];
    while (pool.length > 0) {
      const weights = pool.map((route) => Math.max(1, this.runtime(route.providerId).availability));
      const total = weights.reduce((sum, value) => sum + value, 0);
      let ticket = Math.random() * total;
      let pickedIndex = pool.length - 1;
      for (let index = 0; index < pool.length; index += 1) {
        ticket -= weights[index] ?? 0;
        if (ticket <= 0) {
          pickedIndex = index;
          break;
        }
      }
      const [picked] = pool.splice(pickedIndex, 1);
      if (picked) ordered.push(picked);
    }
    return ordered;
  }

  recordSuccess(providerId: string): void {
    const runtime = this.runtime(providerId);
    runtime.availability = Math.min(100, runtime.availability + 8);
    runtime.consecutiveFailures = 0;
    runtime.lastError = null;
    runtime.lastFailureAt = null;
    runtime.lastSuccessAt = Date.now();
    if (runtime.availability > 0 && runtime.blockReason?.startsWith('连续失败')) {
      runtime.blockUntil = null;
      runtime.blockReason = null;
    }
  }

  recordFailure(providerId: string, kind: RouterFailureKind, message: string): void {
    const runtime = this.runtime(providerId);
    runtime.consecutiveFailures += 1;
    runtime.lastError = message;
    runtime.lastFailureAt = Date.now();
    if (kind === 'auth' || kind === 'quota') {
      runtime.availability = 0;
      runtime.blockUntil = Date.now() + 5 * 60 * 1000;
      runtime.blockReason = kind === 'auth' ? '凭证失效' : '额度耗尽';
      return;
    }
    runtime.availability = Math.max(1, runtime.availability - (kind === 'network' ? 30 : 20));
    if (runtime.consecutiveFailures >= 3 && runtime.availability <= 20) {
      runtime.availability = 1;
      runtime.blockUntil = null;
      runtime.blockReason = '连续失败，低权重重试';
    }
  }

  bindSession(sessionKey: string | null, providerId: string): void {
    if (!sessionKey) return;
    this.sessions.set(sessionKey, providerId);
    if (this.sessions.size > 5000) {
      const first = this.sessions.keys().next().value;
      if (typeof first === 'string') this.sessions.delete(first);
    }
  }

  reset(providerId?: string): void {
    if (providerId) this.runtimes.delete(providerId);
    else this.runtimes.clear();
  }

  private runtime(providerId: string): RuntimeState {
    let runtime = this.runtimes.get(providerId);
    if (!runtime) {
      runtime = { ...DEFAULT_RUNTIME };
      this.runtimes.set(providerId, runtime);
    }
    return runtime;
  }

  private refreshQuotaGuard(providerId: string, runtime: RuntimeState): void {
    const config = this.repo.getBalanceConfig();
    if (!config.quotaGuard) return;
    const now = Date.now();
    const stored = this.repo.getQuotaSnapshot(providerId);
    if (!stored?.snapshot) return;
    const exhausted = isQuotaExhausted(stored.snapshot);
    if (!exhausted) {
      if (runtime.blockReason === '额度耗尽') {
        runtime.availability = 100;
        runtime.blockUntil = null;
        runtime.blockReason = null;
      }
      return;
    }
    if (runtime.blockUntil !== null && runtime.blockUntil <= now) {
      runtime.blockUntil = now + 60 * 1000;
      return;
    }
    runtime.availability = 0;
    runtime.blockReason = '额度耗尽';
    runtime.blockUntil = exhausted.until ?? now + 5 * 60 * 1000;
  }
}

function isQuotaExhausted(snapshot: RouterQuotaSnapshot): { until: number | null } | null {
  if (snapshot.windows.length > 0 && snapshot.windows.every((window) => window.usedPercent >= 100)) {
    const now = Date.now();
    const resets = snapshot.windows
      .map((window) => window.resetsAt)
      .filter((value): value is number => typeof value === 'number' && value > now);
    if (resets.length > 0) return { until: Math.min(...resets) };
    // If every window has a reset time and all of them have passed, the stored
    // snapshot is stale; allow a probe instead of blocking until the next poll.
    const allDated = snapshot.windows.every((window) => typeof window.resetsAt === 'number');
    if (allDated) return null;
    return { until: null };
  }
  if (snapshot.balance !== null && snapshot.balance <= 0) {
    return { until: null };
  }
  return null;
}
