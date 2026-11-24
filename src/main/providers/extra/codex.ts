import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset } from './types';

interface CodexWindow {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
}

function windowLabel(seconds: number): { id: string; label: string } {
  if (seconds === 5 * 60 * 60) return { id: 'session', label: '5-hour' };
  if (seconds === 7 * 24 * 60 * 60) return { id: 'weekly', label: 'Weekly' };
  if (seconds === 30 * 24 * 60 * 60) return { id: 'monthly', label: 'Monthly' };
  if (seconds >= 86400) return { id: `window-${seconds}`, label: `${Math.round(seconds / 86400)}d window` };
  return { id: `window-${seconds}`, label: `${Math.round(seconds / 3600)}h window` };
}

function mapWindow(raw: CodexWindow | undefined, idPrefix: string): RawExtraWindow | null {
  if (!raw || typeof raw.used_percent !== 'number') return null;
  const seconds = typeof raw.limit_window_seconds === 'number' ? raw.limit_window_seconds : 0;
  const meta = seconds > 0 ? windowLabel(seconds) : { id: idPrefix, label: idPrefix === 'primary' ? 'Session' : 'Weekly' };
  const used = clampPercent(raw.used_percent);
  return {
    id: meta.id,
    label: meta.label,
    usedPercent: used,
    resetsAt: raw.reset_at ? isoReset(raw.reset_at) : null,
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
    'User-Agent': 'TokenMonitor/0.2.2 Codex',
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
    const json = (await response.json()) as Record<string, unknown>;
    const credits = Array.isArray(json.credits) ? json.credits : [];
    const available = credits.filter((raw) => {
      if (!raw || typeof raw !== 'object') return false;
      const credit = raw as Record<string, unknown>;
      if (credit.status !== 'available') return false;
      if (typeof credit.expires_at !== 'string') return true;
      const expires = Date.parse(credit.expires_at);
      return !Number.isFinite(expires) || expires > now;
    });
    const availableCount = typeof json.available_count === 'number' ? json.available_count : available.length;
    const expirations = available
      .map((raw) => (raw as Record<string, unknown>).expires_at)
      .filter((value): value is string => typeof value === 'string')
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
    'User-Agent': 'TokenMonitor/0.2.2 Codex',
  };
  if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;

  let response: Response;
  try {
    response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ExtraProviderError('network', error instanceof Error ? error.message : 'Codex 网络请求失败。');
  }
  if (!response.ok) throw errorForStatus(response.status, 'Codex');

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ExtraProviderError('malformed', 'Codex 用量响应无法解析。');
  }

  const rateLimit =
    json.rate_limit && typeof json.rate_limit === 'object' ? (json.rate_limit as Record<string, unknown>) : null;
  const primary = rateLimit?.primary_window && typeof rateLimit.primary_window === 'object'
    ? (rateLimit.primary_window as CodexWindow)
    : undefined;
  const secondary = rateLimit?.secondary_window && typeof rateLimit.secondary_window === 'object'
    ? (rateLimit.secondary_window as CodexWindow)
    : undefined;
  const windows = [mapWindow(primary, 'primary'), mapWindow(secondary, 'secondary')].filter(
    (window): window is RawExtraWindow => Boolean(window),
  );
  if (windows.length === 0) {
    throw new ExtraProviderError('malformed', 'Codex 用量响应缺少额度窗口。');
  }

  const planRaw = typeof json.plan_type === 'string' ? json.plan_type : '';
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
