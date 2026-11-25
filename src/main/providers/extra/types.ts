import type { ErrorCode, ExtraProviderId, QuotaStatus, ResetCreditsInfo } from '../../../shared/types';
import { finiteNumber } from '../../../shared/validation';

export interface ExtraProviderCredential {
  providerId: ExtraProviderId;
  value: string;
  source: 'manual' | 'env' | 'auth-file' | 'zcode';
  region?: 'global' | 'bigmodel-cn';
  accountId?: string;
  planLabel?: string;
  organizationId?: string;
  projectId?: string;
}

export interface RawExtraWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  status?: QuotaStatus;
  windowMs?: number;
}

export interface RawExtraSnapshot {
  providerId: ExtraProviderId;
  providerName: string;
  planLabel: string;
  fetchedAt: number;
  windows: RawExtraWindow[];
  resetCredits?: ResetCreditsInfo | null;
}

export class ExtraProviderError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;

  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ExtraProviderError';
    this.code = code;
    this.status = status;
  }
}

export interface FetchRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached';
}

export interface FetchResponseHeaders {
  get(name: string): string | null;
  entries(): IterableIterator<[string, string]>;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers: FetchResponseHeaders;
  readonly body?: unknown;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type ExtraFetch = (input: string, init?: FetchRequestInit) => Promise<FetchResponse>;

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function isoFromMilliseconds(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isoReset(value: unknown, resetInSec?: unknown, now = Date.now()): string | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    return isoFromMilliseconds(numeric > 1e12 ? numeric : numeric * 1000);
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) {
    const numericText = Number(text);
    if (Number.isFinite(numericText) && /^\d+(?:\.\d+)?$/.test(text)) {
      return isoFromMilliseconds(numericText > 1e12 ? numericText : numericText * 1000);
    }
    return isoFromMilliseconds(Date.parse(text));
  }
  const seconds = finiteNumber(resetInSec);
  return seconds === null ? null : isoFromMilliseconds(now + seconds * 1000);
}

export function labelForMinutes(minutes: number): { id: string; label: string } {
  if (minutes === 300) return { id: 'session', label: '5-hour' };
  if (minutes === 10080) return { id: 'weekly', label: 'Weekly' };
  if (minutes === 43200) return { id: 'monthly', label: 'Monthly' };
  if (minutes >= 1440) return { id: `window-${minutes}`, label: `${Math.round(minutes / 1440)}d window` };
  if (minutes >= 60) return { id: `window-${minutes}`, label: `${Math.round(minutes / 60)}h window` };
  return { id: `window-${minutes}`, label: `${minutes}m window` };
}

export function errorForStatus(status: number, providerLabel: string): ExtraProviderError {
  if (status === 401 || status === 403) {
    return new ExtraProviderError('invalid-key', `${providerLabel} 登录已失效或凭证无权限。`, status);
  }
  if (status === 429) {
    return new ExtraProviderError('rate-limited', `${providerLabel} 用量接口暂时限流。`, status);
  }
  if (status >= 500) {
    return new ExtraProviderError('network', `${providerLabel} 服务暂时不可用（HTTP ${status}）。`, status);
  }
  return new ExtraProviderError('unknown', `${providerLabel} 请求失败（HTTP ${status}）。`, status);
}
