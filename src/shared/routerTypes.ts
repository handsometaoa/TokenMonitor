export type RouterProtocol = 'openai' | 'openai-responses' | 'anthropic';
export type RouterProviderKind =
  | 'custom'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'zai'
  | 'opencode'
  | 'openrouter'
  | 'moonshot'
  | 'siliconflow'
  | 'groq'
  | 'xai'
  | 'google';

export interface RouterProvider {
  id: string;
  name: string;
  protocol: RouterProtocol;
  kind: RouterProviderKind;
  baseUrl: string;
  enabled: boolean;
  archivedAt: number | null;
  quotaStrategyId: string | null;
  strategyConfig: Record<string, string>;
  hasKey: boolean;
  keyMasked: string | null;
  modelCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface RouterProviderInput {
  id?: string;
  name: string;
  protocol: RouterProtocol;
  kind: RouterProviderKind;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  quotaStrategyId?: string | null;
  strategyConfig?: Record<string, string>;
}

export interface RouterModelChannel {
  id: string;
  providerId: string;
  providerName: string;
  providerProtocol: RouterProtocol;
  publicName: string;
  upstreamName: string;
  enabled: boolean;
  archivedAt: number | null;
  createdAt: number;
}

export interface RouterModelGroup {
  publicName: string;
  channels: RouterModelChannel[];
  enabledCount: number;
  totalCount: number;
}

export interface RouterModelInput {
  id?: string;
  providerId: string;
  publicName: string;
  upstreamName: string;
  enabled: boolean;
}

export interface RouterServiceConfig {
  enabled: boolean;
  port: number;
  apiKey: string;
  proxyUrl: string;
  /** Store request/response bodies in request_logs (headers are always stored). */
  captureBodies: boolean;
}

export interface RouterServiceState {
  state: 'stopped' | 'running' | 'error';
  port: number;
  error: string | null;
  startedAt: number | null;
  activeRequests: number;
  config: RouterServiceConfig;
}

export interface RouterBalanceConfig {
  enabled: boolean;
  sessionAffinity: boolean;
  quotaGuard: boolean;
  maxAttempts: number;
}

export interface RouterChannelHealth {
  providerId: string;
  providerName: string;
  availability: number;
  state: 'healthy' | 'degraded' | 'blocked';
  blockReason: string | null;
  blockUntil: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export type RouterUsageRange = 'today' | '24h' | '7d' | '30d';

export interface RouterUsageTotals {
  requestCount: number;
  successCount: number;
  failCount: number;
  durationMs: number;
  ttftMs: number;
  ttftSamples: number;
  /** Sum of per-request generation time (total duration minus TTFT); basis for output tok/s. */
  generationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unrecognizedTokens: number;
  totalTokens: number;
}

export interface RouterUsageGroup extends RouterUsageTotals {
  key: string;
}

export interface RouterUsageSeries {
  granularity: 'hour' | 'day';
  buckets: string[];
  labels: string[];
  requestCount: number[];
  totalTokens: number[];
  cacheTokens: number[];
}

export interface RouterUsageOverview {
  range: RouterUsageRange;
  totals: RouterUsageTotals;
  providers: RouterUsageGroup[];
  models: RouterUsageGroup[];
  series: RouterUsageSeries;
}

export interface RouterActivityDay {
  date: string;
  requestCount: number;
  totalTokens: number;
}

export interface RouterClientProviderFlow {
  client: string;
  providerName: string;
  requestCount: number;
}

export interface RouterModelTestResult {
  publicModel: string;
  providerName: string;
  upstreamModel: string;
  ok: boolean;
  status: number | null;
  durationMs: number | null;
  error: string | null;
}

export interface RouterLogEntry {
  id: number;
  requestId: string;
  startedAt: number;
  finishedAt: number | null;
  publicModel: string;
  providerName: string;
  upstreamModel: string;
  client: string | null;
  path: string;
  status: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  stream: boolean;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unrecognizedTokens: number;
  totalTokens: number;
  error: string | null;
  requestBody: string | null;
  requestHeaders: string | null;
  responseBody: string | null;
  responseHeaders: string | null;
  retryTrace: string | null;
}

export interface RouterLogQuery {
  limit?: number;
  offset?: number;
  model?: string | null;
  status?: number | null;
  search?: string | null;
}

export interface RouterLogPage {
  items: RouterLogEntry[];
  total: number;
}

export interface RouterQuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
}

export interface RouterQuotaSnapshot {
  providerId: string;
  providerName: string;
  strategyId: string | null;
  strategyLabel: string | null;
  windows: RouterQuotaWindow[];
  balance: number | null;
  currency: string | null;
  details: Array<{ label: string; value: string }>;
  error: string | null;
  queriedAt: number | null;
}

export interface RouterQuotaStrategyInfo {
  id: string;
  label: string;
  credential: 'apiKey' | 'token' | 'cookie' | 'none';
  description: string;
}

export interface RouterState {
  service: RouterServiceState;
  balance: RouterBalanceConfig;
  channelHealth: RouterChannelHealth[];
  usageToday: { requests: number; tokens: number; successRate: number | null };
  quota: RouterQuotaSnapshot[];
}

export const DEFAULT_ROUTER_PORT = 8787;
export const DEFAULT_ROUTER_BALANCE: RouterBalanceConfig = {
  enabled: true,
  sessionAffinity: true,
  quotaGuard: true,
  maxAttempts: 3,
};
