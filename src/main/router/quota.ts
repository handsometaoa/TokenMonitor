import type {
  RouterQuotaSnapshot,
  RouterQuotaStrategyInfo,
  RouterQuotaWindow,
  RouterProviderKind,
} from '../../shared/routerTypes';
import { fetchClaudeSnapshot } from '../providers/extra/claude';
import { fetchCodexSnapshot } from '../providers/extra/codex';
import { fetchCursorSnapshot } from '../providers/extra/cursor';
import { fetchZaiSnapshot } from '../providers/extra/zai';
import type { RawExtraSnapshot } from '../providers/extra/types';
import type { RouterFetch } from './gateway';
import type { RouterProviderRow } from './db';

export interface RouterQuotaResult {
  windows: RouterQuotaWindow[];
  balance: number | null;
  currency: string | null;
  details: Array<{ label: string; value: string }>;
}

export interface RouterQuotaContext {
  apiKey: string;
  baseUrl: string;
  config: Record<string, string>;
  kind: RouterProviderKind;
  fetchImpl: RouterFetch;
  now: number;
}

export interface RouterQuotaStrategy extends RouterQuotaStrategyInfo {
  fetch(context: RouterQuotaContext): Promise<RouterQuotaResult>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoToMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extraToResult(raw: RawExtraSnapshot): RouterQuotaResult {
  const windows: RouterQuotaWindow[] = raw.windows.map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: clamp(window.usedPercent),
    resetsAt: isoToMs(window.resetsAt),
    windowMinutes: window.windowMs ? Math.round(window.windowMs / 60_000) : null,
  }));
  const details: Array<{ label: string; value: string }> = [{ label: '套餐', value: raw.planLabel }];
  if (raw.resetCredits) {
    details.push({
      label: '重置积分',
      value: `${raw.resetCredits.availableCount} 次${raw.resetCredits.nextExpiresAt ? ` · 最近过期 ${raw.resetCredits.nextExpiresAt.slice(0, 10)}` : ''}`,
    });
  }
  return { windows, balance: null, currency: null, details };
}

async function fetchOpencode(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const url = ctx.config.usageUrl || 'https://opencode.ai/zen/go/v1/usage';
  const response = await ctx.fetchImpl(url, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('OpenCode API Key 无效或已过期');
  if (response.status !== 200) throw new Error(`OpenCode 余量接口 HTTP ${response.status}`);
  const body = record(await response.json());
  const usage = record(body?.usage);
  if (!usage) throw new Error('OpenCode 响应缺少 usage');

  const windowOf = (raw: unknown, id: string, label: string, minutes: number): RouterQuotaWindow | null => {
    const item = record(raw);
    if (!item) return null;
    const percent =
      numberValue(item.percent) ??
      numberValue(item.usagePercent) ??
      numberValue(item.used_percent) ??
      0;
    const reset =
      typeof item.resetsAt === 'string'
        ? item.resetsAt
        : typeof item.resets_at === 'string'
          ? item.resets_at
          : null;
    return {
      id,
      label,
      usedPercent: clamp(percent),
      resetsAt: isoToMs(reset),
      windowMinutes: minutes,
    };
  };

  const windows = [
    windowOf(usage.rolling, 'rolling', '5-hour', 300),
    windowOf(usage.weekly, 'weekly', 'Weekly', 10_080),
    windowOf(usage.monthly, 'monthly', 'Monthly', 43_200),
  ].filter((window): window is RouterQuotaWindow => window !== null);
  if (windows.length === 0) throw new Error('OpenCode 响应中没有可识别的额度窗口');
  return { windows, balance: null, currency: null, details: [] };
}

async function fetchDeepseek(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://api.deepseek.com/user/balance', {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('DeepSeek API Key 无效');
  if (response.status !== 200) throw new Error(`DeepSeek 余额接口 HTTP ${response.status}`);
  const body = record(await response.json());
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const first = record(infos[0]);
  const balance = numberValue(first?.total_balance);
  if (balance === null) throw new Error('DeepSeek 响应缺少 balance_infos[0].total_balance');
  return {
    windows: [],
    balance,
    currency: typeof first?.currency === 'string' ? first.currency : 'CNY',
    details: [{ label: '账户', value: body?.is_available === false ? '不可用' : '可用' }],
  };
}

async function fetchOpenrouter(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const base = (ctx.config.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const response = await ctx.fetchImpl(`${base}/credits`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('OpenRouter API Key 无效');
  if (response.status !== 200) throw new Error(`OpenRouter credits 接口 HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data);
  const total = numberValue(data?.total_credits);
  const used = numberValue(data?.total_usage);
  if (total === null || used === null) throw new Error('OpenRouter 响应缺少 total_credits / total_usage');
  return {
    windows: [],
    balance: Math.max(0, total - used),
    currency: 'USD',
    details: [
      { label: '总额度', value: `$${total.toFixed(2)}` },
      { label: '已用', value: `$${used.toFixed(2)}` },
    ],
  };
}

async function fetchMoonshot(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const region = ctx.config.region === 'cn' ? 'https://api.moonshot.cn' : 'https://api.moonshot.ai';
  const response = await ctx.fetchImpl(`${region}/v1/users/me/balance`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('Moonshot API Key 无效');
  if (response.status !== 200) throw new Error(`Moonshot 余额接口 HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data);
  const available = numberValue(data?.available_balance);
  if (available === null) throw new Error('Moonshot 响应缺少 data.available_balance');
  const details: Array<{ label: string; value: string }> = [];
  const cash = numberValue(data?.cash_balance);
  const voucher = numberValue(data?.voucher_balance);
  if (cash !== null) details.push({ label: '现金', value: String(cash) });
  if (voucher !== null) details.push({ label: '代金券', value: String(voucher) });
  return {
    windows: [],
    balance: available,
    currency: typeof data?.currency === 'string' ? data.currency : 'CNY',
    details,
  };
}

async function fetchSiliconflow(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const base = (ctx.config.baseUrl || 'https://api.siliconflow.cn').replace(/\/+$/, '').replace(/\/v1$/, '');
  const response = await ctx.fetchImpl(`${base}/v1/user/info`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('SiliconFlow API Key 无效');
  if (response.status !== 200) throw new Error(`SiliconFlow 余额接口 HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data);
  const balance =
    numberValue(data?.totalBalance) ??
    numberValue(data?.balance) ??
    numberValue(data?.chargeBalance);
  if (balance === null) throw new Error('SiliconFlow 响应中没有余额字段');
  return {
    windows: [],
    balance,
    currency: 'CNY',
    details: [
      { label: '充值余额', value: String(numberValue(data?.chargeBalance) ?? '—') },
      { label: '赠送余额', value: String(numberValue(data?.balance) ?? '—') },
    ],
  };
}

async function fetchCodexQuota(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const raw = await fetchCodexSnapshot(
    {
      providerId: 'codex',
      value: ctx.apiKey,
      source: 'manual',
      accountId: ctx.config.accountId,
    },
    ctx.fetchImpl,
    ctx.now,
  );
  return extraToResult(raw);
}

async function fetchClaudeQuota(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const raw = await fetchClaudeSnapshot(
    { providerId: 'claude', value: ctx.apiKey, source: 'manual' },
    ctx.fetchImpl,
    ctx.now,
  );
  return extraToResult(raw);
}

async function fetchCursorQuota(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const raw = await fetchCursorSnapshot(
    { providerId: 'cursor', value: ctx.apiKey, source: 'manual' },
    ctx.fetchImpl,
    ctx.now,
  );
  return extraToResult(raw);
}

async function fetchZaiQuota(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const raw = await fetchZaiSnapshot(
    {
      providerId: 'zai',
      value: ctx.apiKey,
      source: 'manual',
      region: ctx.config.region === 'bigmodel-cn' ? 'bigmodel-cn' : 'global',
      organizationId: ctx.config.organizationId,
      projectId: ctx.config.projectId,
    },
    ctx.fetchImpl,
    ctx.now,
  );
  return extraToResult(raw);
}

export const ROUTER_QUOTA_STRATEGIES: RouterQuotaStrategy[] = [
  {
    id: 'opencode',
    label: 'OpenCode Go',
    credential: 'apiKey',
    description: 'OpenCode Go 5h / weekly / monthly 余量',
    fetch: fetchOpencode,
  },
  {
    id: 'zai',
    label: 'Z.AI / GLM Coding Plan',
    credential: 'apiKey',
    description: 'BigModel / Z.AI Coding Plan 余量',
    fetch: fetchZaiQuota,
  },
  {
    id: 'codex',
    label: 'Codex / ChatGPT',
    credential: 'token',
    description: 'Codex OAuth 用量窗口与重置积分',
    fetch: fetchCodexQuota,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    credential: 'token',
    description: 'Claude OAuth 用量窗口',
    fetch: fetchClaudeQuota,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    credential: 'cookie',
    description: 'Cursor 用量摘要（Cookie）',
    fetch: fetchCursorQuota,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    credential: 'apiKey',
    description: 'DeepSeek 账户余额',
    fetch: fetchDeepseek,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    credential: 'apiKey',
    description: 'OpenRouter credits 余额',
    fetch: fetchOpenrouter,
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    credential: 'apiKey',
    description: 'Moonshot 账户余额',
    fetch: fetchMoonshot,
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    credential: 'apiKey',
    description: 'SiliconFlow 账户余额',
    fetch: fetchSiliconflow,
  },
];

export function quotaStrategyInfo(): RouterQuotaStrategyInfo[] {
  return ROUTER_QUOTA_STRATEGIES.map(({ id, label, credential, description }) => ({
    id,
    label,
    credential,
    description,
  }));
}

export async function executeQuotaStrategy(
  strategyId: string,
  provider: RouterProviderRow,
  apiKey: string,
  fetchImpl: RouterFetch,
  now = Date.now(),
): Promise<RouterQuotaSnapshot> {
  const strategy = ROUTER_QUOTA_STRATEGIES.find((item) => item.id === strategyId);
  const base: RouterQuotaSnapshot = {
    providerId: provider.id,
    providerName: provider.name,
    strategyId,
    strategyLabel: strategy?.label ?? strategyId,
    windows: [],
    balance: null,
    currency: null,
    details: [],
    error: null,
    queriedAt: now,
  };
  if (!strategy) {
    return { ...base, error: `未知余量策略：${strategyId}` };
  }
  try {
    const result = await strategy.fetch({
      apiKey,
      baseUrl: provider.baseUrl,
      config: provider.strategyConfig,
      kind: provider.kind,
      fetchImpl,
      now,
    });
    return {
      ...base,
      ...result,
      error: null,
      queriedAt: now,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '余量查询失败';
    return { ...base, error: message, queriedAt: now };
  }
}
