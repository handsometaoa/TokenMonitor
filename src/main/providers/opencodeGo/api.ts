import { z } from 'zod';
import { QUOTA_API_URL } from '../../../shared/types';
import type { ErrorCode, ProviderError, QuotaStatus, QuotaWindowId } from '../../../shared/types';
import type { FetchRequestInit } from '../../../shared/fetch';
import { finiteNumber, stringValue } from '../../../shared/validation';
import { isoReset } from '../extra/types';

export type FetchLike = (input: string, init?: FetchRequestInit) => Promise<Response>;

export interface RawUsageWindow {
  id: QuotaWindowId;
  usedPercent: number;
  status: QuotaStatus;
  resetsAt: string | null;
}

export interface RawUsageSnapshot {
  fetchedAt: number;
  planLabel: string;
  windows: RawUsageWindow[];
}

export class UsageApiError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'UsageApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  toProviderError(): ProviderError {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
    };
  }
}

const numberPayloadSchema = z.union([z.number(), z.string()]).nullish();

const windowFields = {
  status: z.string().nullish(),
  percent: numberPayloadSchema,
  usagePercent: numberPayloadSchema,
  used_percent: numberPayloadSchema,
  resetsAt: z.union([z.string(), z.number()]).nullish(),
  resets_at: z.union([z.string(), z.number()]).nullish(),
  resetInSec: numberPayloadSchema,
};

export const openCodeGoWindowSchema = z.object(windowFields).nullish();

const payloadSchema = z.object({
  usage: z
    .object({
      rolling: openCodeGoWindowSchema,
      weekly: openCodeGoWindowSchema,
      monthly: openCodeGoWindowSchema,
    })
    .nullish(),
  rollingUsage: openCodeGoWindowSchema,
  weeklyUsage: openCodeGoWindowSchema,
  monthlyUsage: openCodeGoWindowSchema,
  windows: z
    .array(
      z
        .object({
          window: z.string().nullish(),
          name: z.string().nullish(),
          ...windowFields,
        })
        .nullish(),
    )
    .nullish(),
});

type WindowPayload = z.infer<typeof openCodeGoWindowSchema>;

const WINDOW_IDS: QuotaWindowId[] = ['rolling', 'weekly', 'monthly'];

function normalizeStatus(status: string | null | undefined): QuotaStatus {
  if (!status) return 'ok';
  const normalized = status.toLowerCase().replaceAll('_', '-');
  if (normalized === 'ok' || normalized === 'active' || normalized === 'normal') return 'ok';
  if (['rate-limited', 'ratelimited', 'limited', 'exhausted', 'blocked'].includes(normalized)) {
    return 'rate-limited';
  }
  return 'unknown';
}

function payloadNumber(value: string | number | null | undefined): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric;
  const text = stringValue(value)?.trim();
  if (!text) return null;
  return finiteNumber(Number(text));
}

function normalizeWindow(id: QuotaWindowId, payload: WindowPayload, now: number): RawUsageWindow | null {
  if (!payload) return null;
  const percent = payloadNumber(payload.percent) ?? payloadNumber(payload.usagePercent) ?? payloadNumber(payload.used_percent);
  if (percent === null) return null;
  return {
    id,
    usedPercent: Math.min(100, Math.max(0, percent)),
    status: normalizeStatus(payload.status),
    resetsAt: isoReset(payload.resetsAt ?? payload.resets_at, payload.resetInSec, now),
  };
}

export class OpenCodeGoUsageApi {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl = QUOTA_API_URL,
    private readonly timeoutMs = 15_000,
  ) {}

  async fetchUsage(apiKey: string, orgId = '', now = Date.now()): Promise<RawUsageSnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'TokenMonitor/0.4.6',
    };
    if (orgId.trim()) headers['x-opencode-org-id'] = orgId.trim();

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new UsageApiError('timeout', '连接 OpenCode 超时，请检查网络或代理。', undefined, true);
      }
      throw new UsageApiError('network', '无法连接 OpenCode，请检查网络或系统代理。', undefined, true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw this.errorForStatus(response.status);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new UsageApiError('malformed', 'OpenCode 返回了无法解析的响应。');
    }

    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new UsageApiError('malformed', 'OpenCode 用量响应格式已变化，暂时无法读取。');
    }

    const payload = parsed.data;
    const windows: RawUsageWindow[] = [];
    for (const id of WINDOW_IDS) {
      const currentPayload = payload.usage?.[id];
      const legacyPayload =
        id === 'rolling' ? payload.rollingUsage : id === 'weekly' ? payload.weeklyUsage : payload.monthlyUsage;
      const fromArray = payload.windows?.find((item) => {
        const name = (item?.window ?? item?.name ?? '').toLowerCase();
        return name === id || (id === 'rolling' && name === '5h') || (id === 'weekly' && name === '7d');
      });
      const normalized =
        normalizeWindow(id, currentPayload ?? legacyPayload, now) ??
        (fromArray ? normalizeWindow(id, fromArray, now) : null);
      if (normalized) windows.push(normalized);
    }

    if (!windows.some((window) => window.id === 'rolling')) {
      throw new UsageApiError('malformed', 'OpenCode 用量响应缺少 5 小时窗口数据。');
    }

    return {
      fetchedAt: now,
      planLabel: 'OpenCode Go',
      windows,
    };
  }

  private errorForStatus(status: number): UsageApiError {
    switch (status) {
      case 400:
        return new UsageApiError('malformed', '请求未被接受，若使用团队 Key，请检查 Organization ID。', status);
      case 401:
        return new UsageApiError('invalid-key', 'OpenCode API Key 无效或已过期。', status);
      case 403:
        return new UsageApiError('no-subscription', '这个 Key 没有可用的 OpenCode Go 订阅。', status);
      case 429:
        return new UsageApiError('rate-limited', 'OpenCode 用量接口暂时限流，稍后会自动重试。', status, true);
      default:
        if (status >= 500) {
          return new UsageApiError('network', `OpenCode 服务暂时不可用（HTTP ${status}）。`, status, true);
        }
        return new UsageApiError('unknown', `OpenCode 请求失败（HTTP ${status}）。`, status, status >= 500);
    }
  }
}
