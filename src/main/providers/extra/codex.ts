import { asRecord, errorMessage, finiteNumber, stringValue } from '../../../shared/validation';
import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset } from './types';

function windowLabel(seconds: number): { id: string; label: string } {
  if (seconds === 5 * 60 * 60) return { id: 'session', label: '5-hour' };
  if (seconds === 7 * 24 * 60 * 60) return { id: 'weekly', label: 'Weekly' };
  if (seconds === 30 * 24 * 60 * 60) return { id: 'monthly', label: 'Monthly' };
  if (seconds >= 86400) return { id: `window-${seconds}`, label: `${Math.round(seconds / 86400)}d window` };
  return { id: `window-${seconds}`, label: `${Math.round(seconds / 3600)}h window` };
}

function mapWindow(rawValue: unknown, idPrefix: string): RawExtraWindow | null {
  const raw = asRecord(rawValue);
  const usedPercent = finiteNumber(raw?.used_percent);
  if (!raw || usedPercent === null) return null;
  const limitSeconds = finiteNumber(raw.limit_window_seconds);
  const seconds = limitSeconds !== null && limitSeconds > 0 ? limitSeconds : 0;
  const meta = seconds > 0 ? windowLabel(seconds) : { id: idPrefix, label: idPrefix === 'primary' ? 'Session' : 'Weekly' };
  const used = clampPercent(usedPercent);
  return {
    id: meta.id,
    label: meta.label,
    usedPercent: used,
    resetsAt: isoReset(raw.reset_at),
    status: used >= 100 ? 'rate-limited' : 'ok',
    windowMs: seconds > 0 ? seconds * 1000 : undefined,
  };
}

async function fetchCodexResetCredits(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now: number,
): Promise<import('../../../shared/types').ResetCreditsInfo | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.value}`,
    Accept: 'application/json',
    'User-Agent': 'TokenMonitor/0.4.6 Codex',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (credential.accountId) headers['ChatGPT-Account-ID'] = credential.accountId;
  try {
    const response = await fetchImpl('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    const payload = asRecord(json);
    if (!payload) return null;
    const credits = Array.isArray(payload.credits) ? payload.credits : [];
    const available = credits.flatMap((raw) => {
      const credit = asRecord(raw);
      if (!credit || credit.status !== 'available') return [];
      const expiresAt = stringValue(credit.expires_at);
      if (expiresAt !== null) {
        const expires = Date.parse(expiresAt);
        if (Number.isFinite(expires) && expires <= now) return [];
      }
      return [credit];
    });
    const availableCount = finiteNumber(payload.available_count) ?? available.length;
    const expirations = available
      .flatMap((credit) => {
        const expiresAt = stringValue(credit.expires_at);
        return expiresAt === null ? [] : [expiresAt];
      })
      .sort();
    return {
      availableCount,
      nextExpiresAt: expirations[0] ?? null,
      updatedAt: now,
    };
  } catch {
    return null;
  }
}

export async function fetchCodexSnapshot(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now = Date.now(),
): Promise<RawExtraSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.value}`,
    Accept: 'application/json',
    'User-Agent': 'TokenMonitor/0.4.6 Codex',
  };
  if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;

  let response: Awaited<ReturnType<ExtraFetch>>;
  try {
    response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ExtraProviderError('network', errorMessage(error) || 'Codex 网络请求失败。');
  }
  if (!response.ok) throw errorForStatus(response.status, 'Codex');

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ExtraProviderError('malformed', 'Codex 用量响应无法解析。');
  }
  const payload = asRecord(json);
  if (!payload) throw new ExtraProviderError('malformed', 'Codex 用量响应格式无效。');

  const rateLimit = asRecord(payload.rate_limit);
  const primary = asRecord(rateLimit?.primary_window);
  const secondary = asRecord(rateLimit?.secondary_window);
  const windows = [mapWindow(primary, 'primary'), mapWindow(secondary, 'secondary')].filter(
    (window): window is RawExtraWindow => Boolean(window),
  );
  if (windows.length === 0) {
    throw new ExtraProviderError('malformed', 'Codex 用量响应缺少额度窗口。');
  }

  const planRaw = stringValue(payload.plan_type) ?? '';
  const planLabel = planRaw ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1) : 'Codex';
  const resetCredits = await fetchCodexResetCredits(credential, fetchImpl, now);
  return {
    providerId: 'codex',
    providerName: 'Codex',
    planLabel,
    fetchedAt: now,
    windows,
    resetCredits,
  };
}
