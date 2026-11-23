import type { ExtraProviderCredential, ExtraFetch, RawExtraSnapshot, RawExtraWindow } from './types';
import { ExtraProviderError, clampPercent, errorForStatus, isoReset } from './types';

interface ClaudeWindow {
  utilization?: number;
  resets_at?: string;
}

function mapWindow(
  raw: ClaudeWindow | undefined,
  id: string,
  label: string,
  windowMs: number,
): RawExtraWindow | null {
  if (!raw || typeof raw.utilization !== 'number') return null;
  const used = clampPercent(raw.utilization);
  return {
    id,
    label,
    usedPercent: used,
    resetsAt: raw.resets_at ? isoReset(raw.resets_at) : null,
    status: used >= 100 ? 'rate-limited' : 'ok',
    windowMs,
  };
}

export async function fetchClaudeSnapshot(
  credential: ExtraProviderCredential,
  fetchImpl: ExtraFetch,
  now = Date.now(),
): Promise<RawExtraSnapshot> {
  let response: Response;
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
    throw new ExtraProviderError('network', error instanceof Error ? error.message : 'Claude 网络请求失败。');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ExtraProviderError('invalid-key', 'Claude 登录已失效，请重新登录 Claude Code 或填写 OAuth Token。', response.status);
    }
    throw errorForStatus(response.status, 'Claude');
  }

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ExtraProviderError('malformed', 'Claude 用量响应无法解析。');
  }

  const windows = [
    mapWindow(json.five_hour as ClaudeWindow | undefined, 'session', '5-hour', 5 * 60 * 60 * 1000),
    mapWindow(json.seven_day as ClaudeWindow | undefined, 'weekly', 'Weekly', 7 * 24 * 60 * 60 * 1000),
    mapWindow(json.seven_day_sonnet as ClaudeWindow | undefined, 'sonnet', 'Sonnet weekly', 7 * 24 * 60 * 60 * 1000),
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
