import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset, labelForMinutes } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function minutesFor(unit: number | null, number: number | null): number | null {
  if (unit === null || number === null || number <= 0) return null;
  const multipliers: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: 10080 };
  const multiplier = multipliers[unit];
  return multiplier ? number * multiplier : null;
}

function mapLimit(
  rawValue: unknown,
  providerId: 'zai' | 'zcode',
): RawExtraWindow | null {
  const raw = record(rawValue);
  if (!raw) return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(type)) return null;

  const percentage = integer(raw.percentage);
  if (percentage === null) return null;
  const usage = integer(raw.usage);
  const current = integer(raw.currentValue);
  const remaining = integer(raw.remaining);
  let used = percentage;
  if (usage !== null && usage > 0) {
    const usedCount = remaining !== null ? Math.max(usage - remaining, current ?? usage - remaining) : current;
    if (usedCount !== null) used = (usedCount / usage) * 100;
  }
  used = clampPercent(used);

  const windowMinutes = minutesFor(integer(raw.unit), integer(raw.number));
  const meta = windowMinutes ? labelForMinutes(windowMinutes) : type === 'TIME_LIMIT'
    ? { id: 'mcp', label: 'MCP' }
    : { id: `${providerId}-quota`, label: 'Quota' };
  const resetsAt = isoReset(raw.nextResetTime);
  return {
    id: meta.id,
    label: meta.label,
    usedPercent: used,
    resetsAt,
    status: used >= 100 ? 'rate-limited' : 'ok',
    windowMs: windowMinutes ? windowMinutes * 60 * 1000 : undefined,
  };
}

export async function fetchZaiSnapshot(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now = Date.now(),
): Promise<RawExtraSnapshot> {
  const providerId = credential.providerId === 'zcode' ? 'zcode' : 'zai';
  const providerName = providerId === 'zcode' ? 'ZCode' : 'Z.AI / GLM';
  const region = credential.region ?? 'global';
  const base = region === 'bigmodel-cn' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
  const team = Boolean(credential.organizationId && credential.projectId);
  const url = `${base}/api/monitor/usage/quota/limit${team ? '?type=2' : ''}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.value}`,
    Accept: 'application/json',
    'User-Agent': 'TokenMonitor/0.4.6',
  };
  if (team) {
    headers['Bigmodel-Organization'] = credential.organizationId!;
    headers['Bigmodel-Project'] = credential.projectId!;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ExtraProviderError('network', error instanceof Error ? error.message : `${providerName} 网络请求失败。`);
  }
  if (!response.ok) throw errorForStatus(response.status, providerName);

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ExtraProviderError('malformed', `${providerName} 用量响应无法解析。`);
  }

  if (json.success !== true || json.code !== 200) {
    const message = typeof json.msg === 'string' ? json.msg : '无法读取 Coding Plan 用量。';
    const noPlan = /coding plan|不存在/i.test(message);
    const hint =
      providerId === 'zcode' && noPlan
        ? '若使用 BigModel 团队版，请在设置中粘贴包含 organizationId/projectId 的 JSON。'
        : '';
    throw new ExtraProviderError(
      noPlan ? 'no-subscription' : 'malformed',
      `${providerName}: ${message}${hint ? ` ${hint}` : ''}`,
    );
  }

  const data = record(json.data);
  const rawLimits = Array.isArray(data?.limits) ? data?.limits : [];
  const windows = rawLimits
    .map((limit) => mapLimit(limit, providerId))
    .filter((window): window is RawExtraWindow => Boolean(window))
    .sort((a, b) => (a.windowMs ?? Number.MAX_SAFE_INTEGER) - (b.windowMs ?? Number.MAX_SAFE_INTEGER));

  if (windows.length === 0) {
    const hint =
      credential.region === 'bigmodel-cn'
        ? ' 如果是 BigModel 团队版，请提供 organizationId 和 projectId。'
        : '';
    throw new ExtraProviderError('malformed', `${providerName} 用量响应缺少 Coding Plan 窗口。${hint}`);
  }

  const planCandidate = [data?.planName, data?.plan, data?.plan_type, data?.packageName, data?.level].find(
    (value) => typeof value === 'string' && value.trim(),
  );
  const planLabel = credential.planLabel || (typeof planCandidate === 'string' ? planCandidate : providerName);
  return {
    providerId,
    providerName,
    planLabel,
    fetchedAt: now,
    windows,
  };
}
