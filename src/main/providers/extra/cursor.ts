import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function fetchCursorSnapshot(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now = Date.now(),
): Promise<RawExtraSnapshot> {
  let response: Response;
  try {
    response = await fetchImpl('https://cursor.com/api/usage-summary', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: credential.value,
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
        'User-Agent': 'TokenMonitor/0.4.0 Cursor',
      },
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ExtraProviderError('network', error instanceof Error ? error.message : 'Cursor 网络请求失败。');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ExtraProviderError('invalid-key', 'Cursor 登录已失效，请粘贴新的 cursor.com Cookie。', response.status);
    }
    throw errorForStatus(response.status, 'Cursor');
  }

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ExtraProviderError('malformed', 'Cursor 用量响应无法解析。');
  }

  const individualUsage = record(json.individualUsage);
  const plan = record(individualUsage?.plan);
  const overall = record(individualUsage?.overall);
  const team = record(json.teamUsage);
  const pooled = record(team?.pooled);
  const onDemand = record(individualUsage?.onDemand);

  const total = numberValue(plan?.totalPercentUsed);
  const auto = numberValue(plan?.autoPercentUsed);
  const api = numberValue(plan?.apiPercentUsed);
  const planUsed = numberValue(plan?.used);
  const planLimit = numberValue(plan?.limit);
  const overallUsed = numberValue(overall?.used);
  const overallLimit = numberValue(overall?.limit);
  const pooledUsed = numberValue(pooled?.used);
  const pooledLimit = numberValue(pooled?.limit);

  let usedPercent: number | null = null;
  if (total !== null) usedPercent = total;
  else if (planLimit && planLimit > 0 && planUsed !== null) usedPercent = (planUsed / planLimit) * 100;
  else if (auto !== null || api !== null) usedPercent = ((auto ?? 0) + (api ?? 0)) / (auto !== null && api !== null ? 2 : 1);
  else if (overallLimit && overallLimit > 0 && overallUsed !== null) usedPercent = (overallUsed / overallLimit) * 100;
  else if (pooledLimit && pooledLimit > 0 && pooledUsed !== null) usedPercent = (pooledUsed / pooledLimit) * 100;

  if (usedPercent === null) {
    throw new ExtraProviderError('malformed', 'Cursor 用量响应缺少额度数据。');
  }

  const billingStart = typeof json.billingCycleStart === 'string' ? Date.parse(json.billingCycleStart) : Number.NaN;
  const billingEnd = typeof json.billingCycleEnd === 'string' ? Date.parse(json.billingCycleEnd) : Number.NaN;
  const windowMs = Number.isFinite(billingStart) && Number.isFinite(billingEnd) && billingEnd > billingStart
    ? billingEnd - billingStart
    : undefined;
  const resetsAt = Number.isFinite(billingEnd) ? new Date(billingEnd).toISOString() : null;
  const used = clampPercent(usedPercent);
  const windows: RawExtraWindow[] = [
    {
      id: 'monthly',
      label: 'Monthly',
      usedPercent: used,
      resetsAt,
      status: used >= 100 ? 'rate-limited' : 'ok',
      windowMs,
    },
  ];

  if (onDemand?.enabled !== false) {
    const usedCents = numberValue(onDemand?.used);
    const limitCents = numberValue(onDemand?.limit);
    if (usedCents !== null && limitCents && limitCents > 0) {
      const onDemandUsed = clampPercent((usedCents / limitCents) * 100);
      windows.push({
        id: 'on-demand',
        label: 'On-demand',
        usedPercent: onDemandUsed,
        resetsAt,
        status: onDemandUsed >= 100 ? 'rate-limited' : 'ok',
        windowMs,
      });
    }
  }

  const membership = typeof json.membershipType === 'string' ? json.membershipType : '';
  const planLabel = membership ? `Cursor ${membership}` : 'Cursor';
  return {
    providerId: 'cursor',
    providerName: 'Cursor',
    planLabel,
    fetchedAt: now,
    windows,
  };
}
