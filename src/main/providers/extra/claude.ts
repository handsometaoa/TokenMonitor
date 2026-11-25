import { asRecord, errorMessage, finiteNumber } from '../../../shared/validation';
import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset } from './types';

function mapWindow(
  rawValue: unknown,
  id: string,
  label: string,
  windowMs: number,
): RawExtraWindow | null {
  const raw = asRecord(rawValue);
  const utilization = finiteNumber(raw?.utilization);
  if (!raw || utilization === null) return null;
  const used = clampPercent(utilization);
  return {
    id,
    label,
    usedPercent: used,
    resetsAt: isoReset(raw.resets_at),
    status: used >= 100 ? 'rate-limited' : 'ok',
    windowMs,
  };
}

export async function fetchClaudeSnapshot(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now = Date.now(),
): Promise<RawExtraSnapshot> {
  let response: Awaited<ReturnType<ExtraFetch>>;
  try {
    response = await fetchImpl('https://api.anthropic.com/api/oauth/usage?cedar_ember=1', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credential.value}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0 (external, cli)',
      },
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    });
  } catch (error) {
    throw new ExtraProviderError('network', errorMessage(error) || 'Claude 网络请求失败。');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ExtraProviderError('invalid-key', 'Claude 登录已失效，请重新登录 Claude Code 或填写 OAuth Token。', response.status);
    }
    throw errorForStatus(response.status, 'Claude');
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ExtraProviderError('malformed', 'Claude 用量响应无法解析。');
  }
  const payload = asRecord(json);
  if (!payload) throw new ExtraProviderError('malformed', 'Claude 用量响应格式无效。');

  const windows = [
    mapWindow(payload.five_hour, 'session', '5-hour', 5 * 60 * 60 * 1000),
    mapWindow(payload.seven_day, 'weekly', 'Weekly', 7 * 24 * 60 * 60 * 1000),
    mapWindow(payload.seven_day_sonnet, 'sonnet', 'Sonnet weekly', 7 * 24 * 60 * 60 * 1000),
  ].filter((window): window is RawExtraWindow => Boolean(window));
  if (windows.length === 0) {
    throw new ExtraProviderError('malformed', 'Claude 用量响应缺少额度窗口。');
  }

  const planLabel = credential.planLabel?.trim() || 'Claude';
  return {
    providerId: 'claude',
    providerName: 'Claude',
    planLabel,
    fetchedAt: now,
    windows,
  };
}
