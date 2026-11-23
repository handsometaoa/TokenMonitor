import { z } from 'zod';
import { QUOTA_API_URL } from '../../../shared/types';
import type { ErrorCode, ProviderError, QuotaStatus, QuotaWindowId } from '../../../shared/types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

const windowPayloadSchema = z
  .object({
    status: z.string().nullish(),
    percent: z.number().nullish(),
    usagePercent: z.number().nullish(),
    resetsAt: z.union([z.string(), z.number()]).nullish(),
    resetInSec: z.number().nullish(),
  })
  .nullish();

const payloadSchema = z.object({
  usage: z
    .object({
      rolling: windowPayloadSchema,
      weekly: windowPayloadSchema,
      monthly: windowPayloadSchema,
    })
    .nullish(),
  rollingUsage: windowPayloadSchema,
  weeklyUsage: windowPayloadSchema,
  monthlyUsage: windowPayloadSchema,
  windows: z
    .array(
      z
        .object({
          window: z.string().nullish(),
          name: z.string().nullish(),
          status: z.string().nullish(),
          percent: z.number().nullish(),
          usagePercent: z.number().nullish(),
          resetsAt: z.union([z.string(), z.number()]).nullish(),
          resetInSec: z.number().nullish(),
        })
        .nullish(),
    )
    .nullish(),
});

type WindowPayload = z.infer<typeof windowPayloadSchema>;

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

function parseResetAt(value: string | number | null | undefined, resetInSec: number | null | undefined, now: number): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(value.trim())) {
      return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof resetInSec === 'number' && Number.isFinite(resetInSec)) {
    return new Date(now + resetInSec * 1000).toISOString();
  }
  return null;
}

function normalizeWindow(id: QuotaWindowId, payload: WindowPayload, now: number): RawUsageWindow | null {
  if (!payload) return null;
  const percent = payload.percent ?? payload.usagePercent;
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  return {
    id,
    usedPercent: Math.min(100, Math.max(0, percent)),
    status: normalizeStatus(payload.status),
    resetsAt: parseResetAt(payload.resetsAt, payload.resetInSec, now),
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
      'User-Agent': 'TokenMonitor/0.2.0',
    };
    if (orgId.trim()) headers['x-opencode-org-id'] = orgId.trim();

    let response: Response;
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
