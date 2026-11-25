import { asRecord, errorMessage, finiteNumber, stringValue } from '../../../shared/validation';
import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset } from './types';

function dateMilliseconds(value: unknown): number {
  const text = stringValue(value);
  return text === null ? Number.NaN : Date.parse(text);
}

export async function fetchCursorSnapshot(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now = Date.now(),
): Promise<RawExtraSnapshot> {
  let response: Awaited<ReturnType<ExtraFetch>>;
  try {
    response = await fetchImpl('https://cursor.com/api/usage-summary', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: credential.value,
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
        'User-Agent': 'TokenMonitor/0.4.6 Cursor',
      },
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ExtraProviderError('network', errorMessage(error) || 'Cursor 网络请求失败。');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ExtraProviderError('invalid-key', 'Cursor 登录已失效，请粘贴新的 cursor.com Cookie。', response.status);
    }
    throw errorForStatus(response.status, 'Cursor');
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ExtraProviderError('malformed', 'Cursor 用量响应无法解析。');
  }
  const payload = asRecord(json);
  if (!payload) throw new ExtraProviderError('malformed', 'Cursor 用量响应格式无效。');

  const individualUsage = asRecord(payload.individualUsage);
  const plan = asRecord(individualUsage?.plan);
  const overall = asRecord(individualUsage?.overall);
  const team = asRecord(payload.teamUsage);
  const pooled = asRecord(team?.pooled);
  const onDemand = asRecord(individualUsage?.onDemand);

  const total = finiteNumber(plan?.totalPercentUsed);
  const auto = finiteNumber(plan?.autoPercentUsed);
  const api = finiteNumber(plan?.apiPercentUsed);
  const planUsed = finiteNumber(plan?.used);
  const planLimit = finiteNumber(plan?.limit);
  const overallUsed = finiteNumber(overall?.used);
  const overallLimit = finiteNumber(overall?.limit);
  const pooledUsed = finiteNumber(pooled?.used);
  const pooledLimit = finiteNumber(pooled?.limit);

  let usedPercent: number | null = null;
  if (total !== null) usedPercent = total;
  else if (planLimit && planLimit > 0 && planUsed !== null) usedPercent = (planUsed / planLimit) * 100;
  else if (auto !== null || api !== null) usedPercent = ((auto ?? 0) + (api ?? 0)) / (auto !== null && api !== null ? 2 : 1);
  else if (overallLimit && overallLimit > 0 && overallUsed !== null) usedPercent = (overallUsed / overallLimit) * 100;
  else if (pooledLimit && pooledLimit > 0 && pooledUsed !== null) usedPercent = (pooledUsed / pooledLimit) * 100;

  if (usedPercent === null) {
    throw new ExtraProviderError('malformed', 'Cursor 用量响应缺少额度数据。');
  }

  const billingStart = dateMilliseconds(payload.billingCycleStart);
  const billingEnd = dateMilliseconds(payload.billingCycleEnd);
  const windowMs = Number.isFinite(billingStart) && Number.isFinite(billingEnd) && billingEnd > billingStart
    ? billingEnd - billingStart
    : undefined;
  const resetsAt = isoReset(payload.billingCycleEnd);
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
    const usedCents = finiteNumber(onDemand?.used);
    const limitCents = finiteNumber(onDemand?.limit);
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

  const membership = stringValue(payload.membershipType) ?? '';
  const planLabel = membership ? `Cursor ${membership}` : 'Cursor';
  return {
    providerId: 'cursor',
    providerName: 'Cursor',
    planLabel,
    fetchedAt: now,
    windows,
  };
}
