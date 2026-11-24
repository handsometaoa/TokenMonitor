import vm from 'node:vm';
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

function pickNumber(data: Record<string, unknown> | null, keys: string[]): number | null {
  if (!data) return null;
  for (const key of keys) {
    const value = numberValue(data[key]);
    if (value !== null) return value;
  }
  return null;
}

async function fetchAiand(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://api.aiand.com/logs', {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('AiAnd API Key 无效');
  if (response.status !== 200) throw new Error(`AiAnd HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data) ?? body;
  const used = pickNumber(data, ['used', 'credits_used', 'total_used', 'usage']);
  const limit = pickNumber(data, ['limit', 'credits_limit', 'quota', 'total_limit']);
  if (used === null && limit === null) throw new Error('AiAnd 响应缺少用量字段');
  const windows: RouterQuotaWindow[] = [];
  if (limit !== null && limit > 0) {
    windows.push({
      id: 'subscription',
      label: 'Subscription',
      usedPercent: clamp(((used ?? 0) / limit) * 100),
      resetsAt: null,
      windowMinutes: 30 * 1440,
    });
  }
  return {
    windows,
    balance: null,
    currency: null,
    details: used !== null ? [{ label: '已用额度', value: String(used) }] : [],
  };
}

async function fetchChutes(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://api.chutes.ai/users/me/subscription_usage', {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Chutes API Key 无效');
  if (response.status !== 200) throw new Error(`Chutes HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data) ?? body;
  const usedPercent = pickNumber(data, ['percent_used', 'usagePercent', 'percentUsed']);
  const remainingPercent = pickNumber(data, ['percent_remaining', 'percentRemaining']);
  const percent = usedPercent ?? (remainingPercent !== null ? 100 - remainingPercent : null);
  const used = pickNumber(data, ['request_count', 'used']);
  const limit = pickNumber(data, ['request_limit', 'quota_limit', 'monthly_limit', 'hard_limit']);
  if (percent === null && (used === null || limit === null)) throw new Error('Chutes 响应缺少配额字段');
  return {
    windows: [
      {
        id: 'subscription',
        label: 'Subscription',
        usedPercent: clamp(percent ?? ((used ?? 0) / (limit ?? 1)) * 100),
        resetsAt: null,
        windowMinutes: 30 * 1440,
      },
    ],
    balance: null,
    currency: null,
    details:
      used !== null && limit !== null ? [{ label: '请求', value: `${used} / ${limit}` }] : [],
  };
}

async function fetchDeepinfra(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const headers = { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' };
  const [checklistResponse, usageResponse] = await Promise.all([
    ctx.fetchImpl('https://api.deepinfra.com/payment/checklist?compute_owed=true', {
      headers,
      signal: AbortSignal.timeout(20_000),
    }),
    ctx.fetchImpl('https://api.deepinfra.com/payment/usage?from=current', {
      headers,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null),
  ]);
  if (checklistResponse.status === 401) throw new Error('DeepInfra API Key 无效');
  if (checklistResponse.status !== 200) throw new Error(`DeepInfra HTTP ${checklistResponse.status}`);
  const checklist = record(await checklistResponse.json());
  const balance =
    pickNumber(record(checklist?.data), ['stripe_balance']) ?? pickNumber(checklist, ['stripe_balance']);
  let used: number | null = null;
  if (usageResponse?.status === 200) {
    const usage = record(await usageResponse.json());
    used = pickNumber(usage, ['usage']) ?? pickNumber(record(usage?.data), ['usage']);
  }
  if (balance === null && used === null) throw new Error('DeepInfra 未返回余额或用量');
  return {
    windows: [],
    balance,
    currency: balance !== null ? 'USD' : null,
    details: used !== null ? [{ label: '本期用量', value: `$${used.toFixed(2)}` }] : [],
  };
}

async function fetchElevenlabs(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': ctx.apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('ElevenLabs API Key 无效');
  if (response.status !== 200) throw new Error(`ElevenLabs HTTP ${response.status}`);
  const body = record(await response.json());
  const used = pickNumber(body, ['character_count']);
  const limit = pickNumber(body, ['character_limit']);
  if (used === null || limit === null || limit <= 0) throw new Error('ElevenLabs 响应缺少字符额度');
  const tier = typeof body?.tier === 'string' ? body.tier : null;
  return {
    windows: [
      {
        id: 'characters',
        label: 'Characters',
        usedPercent: clamp((used / limit) * 100),
        resetsAt: null,
        windowMinutes: null,
      },
    ],
    balance: null,
    currency: null,
    details: tier ? [{ label: '套餐', value: tier }] : [],
  };
}

async function fetchVenice(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://api.venice.ai/api/v1/billing/balance', {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('Venice API Key 无效');
  if (response.status !== 200) throw new Error(`Venice HTTP ${response.status}`);
  const body = record(await response.json());
  if (!body) throw new Error('Venice 响应不是对象');
  const balances = record(body.balances);
  const usd = pickNumber(balances, ['usd']);
  const diem = pickNumber(balances, ['diem']);
  const allocation = pickNumber(body, ['diemEpochAllocation']);
  const canConsume = body.canConsume === true;
  const currency = typeof body.consumptionCurrency === 'string' ? body.consumptionCurrency.toUpperCase() : null;
  const windows: RouterQuotaWindow[] = [];
  if (!canConsume) {
    windows.push({
      id: 'balance',
      label: 'Balance',
      usedPercent: 100,
      resetsAt: null,
      windowMinutes: null,
    });
  } else if (currency !== 'USD' && diem !== null && allocation !== null && allocation > 0) {
    windows.push({
      id: 'epoch',
      label: 'Epoch allocation',
      usedPercent: clamp(((allocation - diem) / allocation) * 100),
      resetsAt: null,
      windowMinutes: null,
    });
  }
  const balance = currency === 'USD' ? usd : diem;
  return {
    windows,
    balance,
    currency: currency ?? (usd !== null ? 'USD' : diem !== null ? 'DIEM' : null),
    details: [
      ...(usd !== null ? [{ label: 'USD', value: usd.toFixed(2) }] : []),
      ...(diem !== null ? [{ label: 'DIEM', value: diem.toFixed(2) }] : []),
    ],
  };
}

async function fetchMinimax(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const host = ctx.config.region === 'global' ? 'https://api.minimax.io' : 'https://api.minimaxi.com';
  const response = await ctx.fetchImpl(`${host}/v1/api/openplatform/coding_plan/remains`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('MiniMax API Key 无效');
  if (response.status !== 200) throw new Error(`MiniMax HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data);
  if (!data) throw new Error('MiniMax 响应缺少 data');
  const windows: RouterQuotaWindow[] = [];
  const intervalUsed = pickNumber(data, ['current_interval_usage_count']);
  const intervalTotal = pickNumber(data, ['current_interval_total_count']);
  if (intervalUsed !== null && intervalTotal !== null && intervalTotal > 0) {
    windows.push({
      id: 'interval',
      label: '5-hour',
      usedPercent: clamp((intervalUsed / intervalTotal) * 100),
      resetsAt: null,
      windowMinutes: 300,
    });
  }
  const weekUsed = pickNumber(data, ['current_weekly_usage_count']);
  const weekTotal = pickNumber(data, ['current_weekly_total_count']);
  if (weekUsed !== null && weekTotal !== null && weekTotal > 0) {
    windows.push({
      id: 'weekly',
      label: 'Weekly',
      usedPercent: clamp((weekUsed / weekTotal) * 100),
      resetsAt: null,
      windowMinutes: 7 * 1440,
    });
  }
  if (windows.length === 0) throw new Error('MiniMax 响应缺少当期用量');
  const balance = pickNumber(data, ['points_balance', 'credit_balance', 'point_balance', 'credits_balance']);
  return {
    windows,
    balance,
    currency: balance !== null ? 'point' : null,
    details: [],
  };
}

async function fetchXai(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const team = ctx.config.XAI_TEAM_ID;
  if (!team || team.includes('/') || team === '.' || team === '..') {
    throw new Error('缺少 xAI Team ID（策略附加配置 XAI_TEAM_ID）');
  }
  const response = await ctx.fetchImpl(
    `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team)}/prepaid/balance`,
    {
      headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error('xAI Management API Key 无效（推理 Key 不能查询账单）');
  }
  if (response.status === 404) throw new Error('xAI 团队不存在或 Team ID 不匹配');
  if (response.status !== 200) throw new Error(`xAI HTTP ${response.status}`);
  const body = record(await response.json());
  const total = record(record(body?.total)?.val) ?? record(body?.total);
  const raw = total && typeof total.val === 'string' ? total.val : typeof body?.total === 'string' ? body.total : null;
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw.trim())) throw new Error('xAI 响应缺少余额');
  return {
    windows: [],
    balance: -Number(raw) / 100,
    currency: 'USD',
    details: [{ label: 'Team', value: team }],
  };
}

async function fetchWarp(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      'content-type': 'application/json',
      'x-warp-client-id': 'warp-app',
      'user-agent': 'Warp/1.0',
    },
    body: JSON.stringify({
      query: `query GetRequestLimitInfo($requestContext: RequestContext!) { user(requestContext: $requestContext) { __typename ... on UserOutput { user { requestLimitInfo { isUnlimited nextRefreshTime requestLimit requestsUsedSinceLastRefresh } } } } }`,
      variables: {
        requestContext: {
          clientContext: {},
          osContext: { category: 'macOS', name: 'macOS', version: '25.6.0' },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('Warp API Key 无效');
  if (response.status !== 200) throw new Error(`Warp HTTP ${response.status}`);
  const body = record(await response.json());
  const info = record(record(record(record(body?.data)?.user)?.user)?.requestLimitInfo);
  const limit = pickNumber(info, ['requestLimit']);
  const used = pickNumber(info, ['requestsUsedSinceLastRefresh']);
  if (limit === null || used === null) throw new Error('Warp 响应缺少 requestLimitInfo');
  const unlimited = info?.isUnlimited === true;
  const nextRefresh = pickNumber(info, ['nextRefreshTime']);
  return {
    windows: [
      {
        id: 'requests',
        label: unlimited ? 'Unlimited' : 'Requests',
        usedPercent: unlimited ? 0 : limit > 0 ? clamp((used / limit) * 100) : 0,
        resetsAt: nextRefresh && nextRefresh > 0 ? nextRefresh * 1000 : null,
        windowMinutes: null,
      },
    ],
    balance: null,
    currency: null,
    details: [{ label: '请求', value: `${used} / ${limit}` }],
  };
}

async function fetchCrof(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://crof.ai/usage_api/', {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`Crof HTTP ${response.status}`);
  const body = record(await response.json());
  const credits = pickNumber(body, ['credits']);
  if (credits === null) throw new Error('Crof 响应缺少 credits');
  const plan = pickNumber(body, ['requests_plan']);
  const usable = pickNumber(body, ['usable_requests']);
  const windows: RouterQuotaWindow[] = [];
  if (plan !== null && usable !== null && plan > 0) {
    const remaining = Math.max(0, Math.min(plan, usable));
    windows.push({
      id: 'requests',
      label: 'Requests',
      usedPercent: clamp(100 - (remaining / plan) * 100),
      resetsAt: null,
      windowMinutes: 1440,
    });
  }
  return {
    windows,
    balance: credits,
    currency: 'USD',
    details: usable !== null ? [{ label: '剩余请求', value: String(usable) }] : [],
  };
}

async function fetchZenmux(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const headers = { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' };
  const [subResponse, paygResponse] = await Promise.all([
    ctx.fetchImpl('https://zenmux.ai/api/v1/management/subscription/detail', {
      headers,
      signal: AbortSignal.timeout(20_000),
    }),
    ctx.fetchImpl('https://zenmux.ai/api/v1/management/payg/balance', {
      headers,
      signal: AbortSignal.timeout(20_000),
    }),
  ]);
  const windows: RouterQuotaWindow[] = [];
  let plan: string | null = null;
  if (subResponse.status === 200) {
    const body = record(await subResponse.json());
    const sub = record(body?.data) ?? body;
    const used = pickNumber(sub, ['used', 'usage', 'used_credits']);
    const limit = pickNumber(sub, ['limit', 'quota', 'total_credits']);
    if (used !== null && limit !== null && limit > 0) {
      windows.push({
        id: 'subscription',
        label: 'Subscription',
        usedPercent: clamp((used / limit) * 100),
        resetsAt: null,
        windowMinutes: 30 * 1440,
      });
    }
    plan = typeof sub?.plan_name === 'string' ? sub.plan_name : typeof sub?.plan === 'string' ? sub.plan : null;
  }
  let balance: number | null = null;
  if (paygResponse.status === 200) {
    const body = record(await paygResponse.json());
    const payg = record(body?.data) ?? body;
    balance = pickNumber(payg, ['balance', 'available', 'remaining', 'total_balance']);
  }
  if (windows.length === 0 && balance === null) throw new Error('ZenMux 订阅与按量余额均未取到');
  return {
    windows,
    balance,
    currency: balance !== null ? 'USD' : null,
    details: plan ? [{ label: '套餐', value: plan }] : [],
  };
}

async function fetchNeuralwatt(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const response = await ctx.fetchImpl('https://api.neuralwatt.com/v1/quota', {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) throw new Error('NeuralWatt API Key 无效');
  if (response.status !== 200) throw new Error(`NeuralWatt HTTP ${response.status}`);
  const body = record(await response.json());
  const data = record(body?.data) ?? body;
  const used = pickNumber(data, ['kwh_used', 'used']);
  const remaining = pickNumber(data, ['kwh_remaining', 'remaining']);
  if (used === null && remaining === null) throw new Error('NeuralWatt 响应缺少 kwh 用量');
  return {
    windows:
      used !== null && remaining !== null && used + remaining > 0
        ? [
            {
              id: 'quota',
              label: 'kWh quota',
              usedPercent: clamp((used / (used + remaining)) * 100),
              resetsAt: null,
              windowMinutes: 30 * 1440,
            },
          ]
        : [],
    balance: remaining,
    currency: remaining !== null ? 'kWh' : null,
    details: used !== null ? [{ label: '已用', value: `${used} kWh` }] : [],
  };
}

async function fetchLlmproxy(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  if (!ctx.baseUrl) throw new Error('需要在提供商 Base URL 填写代理服务地址');
  const base = ctx.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const response = await ctx.fetchImpl(`${base}/v1/quota-stats`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`LLM Proxy HTTP ${response.status}`);
  const body = record(await response.json());
  const total = pickNumber(body, ['credential_count', 'total']);
  const exhausted = pickNumber(body, ['exhausted_count', 'exhausted']);
  const active = pickNumber(body, ['active_count', 'active']);
  if (total === null) throw new Error('LLM Proxy 响应缺少 credential_count');
  return {
    windows: total > 0
      ? [
          {
            id: 'credentials',
            label: 'Credentials',
            usedPercent: clamp(((exhausted ?? 0) / total) * 100),
            resetsAt: null,
            windowMinutes: null,
          },
        ]
      : [],
    balance: null,
    currency: null,
    details: [{ label: '可用 / 耗尽 / 总数', value: `${active ?? '?'} / ${exhausted ?? '?'} / ${total}` }],
  };
}

async function fetchLitellm(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  if (!ctx.baseUrl) throw new Error('需要在提供商 Base URL 填写网关地址');
  const base = ctx.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const response = await ctx.fetchImpl(`${base}/key/info`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status !== 200) throw new Error(`LiteLLM HTTP ${response.status}`);
  const body = record(await response.json());
  const info = record(body?.info) ?? body;
  const spend = pickNumber(info, ['spend', 'total_spend']);
  const maxBudget = pickNumber(info, ['max_budget', 'budget']);
  if (spend === null) throw new Error('LiteLLM 响应缺少 info.spend');
  return {
    windows:
      maxBudget !== null && maxBudget > 0
        ? [
            {
              id: 'budget',
              label: 'Budget',
              usedPercent: clamp((spend / maxBudget) * 100),
              resetsAt: null,
              windowMinutes: null,
            },
          ]
        : [],
    balance: maxBudget !== null ? Math.max(0, maxBudget - spend) : null,
    currency: maxBudget !== null ? 'USD' : null,
    details: [{ label: '已用预算', value: `$${spend.toFixed(4)}` }],
  };
}

async function fetchCodebuffQuota(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const token = ctx.config.token || ctx.apiKey;
  if (!token) throw new Error('未配置 Codebuff 令牌');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const [usageResponse, subResponse] = await Promise.all([
    ctx.fetchImpl('https://www.codebuff.com/api/v1/usage', { headers, signal: AbortSignal.timeout(20_000) }),
    ctx.fetchImpl('https://www.codebuff.com/api/user/subscription', { headers, signal: AbortSignal.timeout(20_000) }),
  ]);
  if (usageResponse.status !== 200) throw new Error(`Codebuff usage HTTP ${usageResponse.status}`);
  const usage = record(await usageResponse.json());
  const used = pickNumber(usage, ['used', 'credits_used', 'total_used']);
  const limit = pickNumber(usage, ['limit', 'credits_limit', 'total_limit', 'quota']);
  const windows: RouterQuotaWindow[] = [];
  if (used !== null && limit !== null && limit > 0) {
    windows.push({
      id: 'subscription',
      label: 'Subscription',
      usedPercent: clamp((used / limit) * 100),
      resetsAt: null,
      windowMinutes: 30 * 1440,
    });
  }
  let plan: string | null = null;
  if (subResponse.status === 200) {
    const sub = record(await subResponse.json());
    plan = typeof sub?.plan === 'string' ? sub.plan : typeof sub?.tier === 'string' ? sub.tier : null;
  }
  if (windows.length === 0 && !plan) throw new Error('Codebuff 未取到用量或订阅');
  return {
    windows,
    balance: null,
    currency: null,
    details: plan ? [{ label: '订阅', value: plan }] : [],
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
  {
    id: 'minimax',
    label: 'MiniMax Coding Plan',
    credential: 'apiKey',
    description: '5 小时 / 周窗口与积分余额；region=global 切海外区',
    fetch: fetchMinimax,
  },
  {
    id: 'aiand',
    label: 'AiAnd',
    credential: 'apiKey',
    description: '账号用量日志聚合',
    fetch: fetchAiand,
  },
  {
    id: 'chutes',
    label: 'Chutes',
    credential: 'apiKey',
    description: '订阅配额百分比与请求计数',
    fetch: fetchChutes,
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    credential: 'apiKey',
    description: '账户余额与本期用量',
    fetch: fetchDeepinfra,
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    credential: 'apiKey',
    description: '字符额度与订阅套餐',
    fetch: fetchElevenlabs,
  },
  {
    id: 'venice',
    label: 'Venice',
    credential: 'apiKey',
    description: 'USD / DIEM 余额与 epoch 配额',
    fetch: fetchVenice,
  },
  {
    id: 'xai',
    label: 'xAI（Management API）',
    credential: 'apiKey',
    description: '团队预付费余额；附加配置 XAI_TEAM_ID',
    fetch: fetchXai,
  },
  {
    id: 'warp',
    label: 'Warp',
    credential: 'apiKey',
    description: '请求限额与下次刷新时间',
    fetch: fetchWarp,
  },
  {
    id: 'crof',
    label: 'Crof',
    credential: 'apiKey',
    description: '额度、请求余量与每日重置',
    fetch: fetchCrof,
  },
  {
    id: 'zenmux',
    label: 'ZenMux',
    credential: 'apiKey',
    description: '订阅额度 + 按量余额',
    fetch: fetchZenmux,
  },
  {
    id: 'neuralwatt',
    label: 'NeuralWatt',
    credential: 'apiKey',
    description: 'kWh 算力配额',
    fetch: fetchNeuralwatt,
  },
  {
    id: 'llmproxy',
    label: 'LLM Proxy（自建）',
    credential: 'apiKey',
    description: 'Base URL + /v1/quota-stats 凭据统计',
    fetch: fetchLlmproxy,
  },
  {
    id: 'litellm',
    label: 'LiteLLM（自建）',
    credential: 'apiKey',
    description: 'Base URL + key/info 预算余量',
    fetch: fetchLitellm,
  },
  {
    id: 'custom-js',
    label: 'Custom JS（外置脚本）',
    credential: 'apiKey',
    description: '附加配置 script；返回 windows/balance，运行于受限 vm',
    fetch: fetchCustomJs,
  },
  {
    id: 'custom-http',
    label: 'Custom HTTP（自定义）',
    credential: 'apiKey',
    description: '附加配置填写 url / 字段路径，适配任意 JSON 余量接口',
    fetch: fetchCustomHttp,
  },
  {
    id: 'codebuff',
    label: 'Codebuff',
    credential: 'token',
    description: '用量计数与订阅档位',
    fetch: fetchCodebuffQuota,
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

function dotValue(data: unknown, path: string): unknown {
  if (!path) return data;
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function dotNumber(data: unknown, path: string | undefined): number | null {
  if (!path) return null;
  return numberValue(dotValue(data, path));
}

async function fetchCustomJs(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const script = ctx.config.script;
  if (!script) throw new Error('Custom JS 策略需要在附加配置中提供 script');
  const sandbox = {
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    config: ctx.config,
    result: null as unknown,
    getJSON: async (url: string, options?: { headers?: Record<string, string>; timeoutSeconds?: number }) => {
      const response = await ctx.fetchImpl(url, {
        headers: { accept: 'application/json', ...(options?.headers ?? {}) },
        signal: AbortSignal.timeout(Math.min(30, Math.max(1, options?.timeoutSeconds ?? 20)) * 1000),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: response.status, json, text };
    },
    pct: (used: number, limit: number) => clamp(limit > 0 ? (used / limit) * 100 : 0),
  };
  const promise = vm.runInNewContext(`(async () => {\n${script}\n})()`, sandbox, {
    timeout: 20_000,
    contextCodeGeneration: { strings: false, wasm: false },
  });
  const result = (await promise) ?? sandbox.result;
  const data = record(result);
  if (!data) throw new Error('Custom JS 脚本必须返回对象');
  const rawWindows = Array.isArray(data.windows) ? data.windows : [];
  const windows: RouterQuotaWindow[] = rawWindows.flatMap((raw) => {
    const item = record(raw);
    if (!item) return [];
    const usedPercent = numberValue(item.usedPercent);
    if (usedPercent === null) return [];
    return [
      {
        id: typeof item.id === 'string' ? item.id : 'custom',
        label: typeof item.label === 'string' ? item.label : 'Custom',
        usedPercent: clamp(usedPercent),
        resetsAt: numberValue(item.resetsAt),
        windowMinutes: numberValue(item.windowMinutes),
      },
    ];
  });
  const balance = numberValue(data.balance);
  if (windows.length === 0 && balance === null) throw new Error('Custom JS 未返回 windows 或 balance');
  return {
    windows,
    balance,
    currency: typeof data.currency === 'string' ? data.currency : null,
    details: Array.isArray(data.details)
      ? data.details.flatMap((raw) => {
          const item = record(raw);
          if (!item || typeof item.label !== 'string' || typeof item.value !== 'string') return [];
          return [{ label: item.label, value: item.value }];
        })
      : [],
  };
}

async function fetchCustomHttp(ctx: RouterQuotaContext): Promise<RouterQuotaResult> {
  const config = ctx.config;
  const rawUrl = config.url;
  if (!rawUrl) throw new Error('自定义策略需要在附加配置中提供 url');
  const url = rawUrl.replaceAll('{baseUrl}', ctx.baseUrl).replaceAll('{apiKey}', ctx.apiKey);
  let headers: Record<string, string> = { accept: 'application/json' };
  if (config.headers) {
    try {
      const parsed = JSON.parse(config.headers) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
        );
      }
    } catch {
      throw new Error('自定义策略 headers 必须是 JSON 对象');
    }
  }
  const auth = config.auth ?? 'bearer';
  if (auth === 'bearer') headers.authorization = `Bearer ${ctx.apiKey}`;
  else if (auth === 'x-api-key') headers['x-api-key'] = ctx.apiKey;

  const method = (config.method ?? 'GET').toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(20_000),
  };
  if (method === 'POST' && config.body) {
    headers['content-type'] = 'application/json';
    init.body = config.body;
  }
  const response = await ctx.fetchImpl(url, init);
  if (response.status === 401 || response.status === 403) throw new Error('自定义策略凭证无效');
  if (response.status !== 200) throw new Error(`自定义策略 HTTP ${response.status}`);
  const payload = (await response.json()) as unknown;

  const percent = dotNumber(payload, config.percentPath);
  const used = dotNumber(payload, config.usedPath);
  const limit = dotNumber(payload, config.limitPath);
  const balance = dotNumber(payload, config.balancePath);
  const windows: RouterQuotaWindow[] = [];
  if (percent !== null) {
    windows.push({
      id: 'custom',
      label: config.label ?? 'Custom',
      usedPercent: clamp(percent),
      resetsAt: null,
      windowMinutes: numberValue(config.windowMinutes) ?? null,
    });
  } else if (used !== null && limit !== null && limit > 0) {
    windows.push({
      id: 'custom',
      label: config.label ?? 'Custom',
      usedPercent: clamp((used / limit) * 100),
      resetsAt: null,
      windowMinutes: numberValue(config.windowMinutes) ?? null,
    });
  }
  if (windows.length === 0 && balance === null) {
    throw new Error('自定义策略未解析到 percentPath / usedPath+limitPath / balancePath');
  }
  return {
    windows,
    balance,
    currency: config.currency ?? (balance !== null ? 'USD' : null),
    details:
      used !== null || limit !== null
        ? [{ label: '用量', value: `${used ?? '?'} / ${limit ?? '?'}` }]
        : [],
  };
}
