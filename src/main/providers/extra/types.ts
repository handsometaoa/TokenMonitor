import type { ErrorCode, ExtraProviderId, QuotaStatus } from '../../../shared/types';

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

export type ExtraFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function isoReset(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
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
