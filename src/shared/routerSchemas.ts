import { z } from 'zod';
import type { QuotaHistoryPoint } from './types';
import type {
  RouterBalanceConfig,
  RouterProtocol,
  RouterProviderKind,
  RouterQuotaSnapshot,
  RouterServiceConfig,
  RouterUsageRange,
} from './routerTypes';

export const ROUTER_PROTOCOLS = ['openai', 'openai-responses', 'anthropic'] as const;
export const ROUTER_PROVIDER_KINDS = [
  'custom',
  'openai',
  'anthropic',
  'deepseek',
  'zai',
  'opencode',
  'openrouter',
  'moonshot',
  'siliconflow',
  'groq',
  'xai',
  'google',
] as const;
export const ROUTER_USAGE_RANGES = ['today', '24h', '7d', '30d'] as const;

export const routerProtocolSchema = z.enum(ROUTER_PROTOCOLS);
export const routerProviderKindSchema = z.enum(ROUTER_PROVIDER_KINDS);
export const routerUsageRangeSchema = z.enum(ROUTER_USAGE_RANGES);

export function isRouterProtocol(value: unknown): value is RouterProtocol {
  return routerProtocolSchema.safeParse(value).success;
}

export function isRouterProviderKind(value: unknown): value is RouterProviderKind {
  return routerProviderKindSchema.safeParse(value).success;
}

export function isRouterUsageRange(value: unknown): value is RouterUsageRange {
  return routerUsageRangeSchema.safeParse(value).success;
}

export const routerServiceConfigSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65_535),
  apiKey: z.string(),
  proxyUrl: z.string(),
  captureBodies: z.boolean(),
}) satisfies z.ZodType<RouterServiceConfig>;

export const routerBalanceConfigSchema = z.object({
  enabled: z.boolean(),
  sessionAffinity: z.boolean(),
  quotaGuard: z.boolean(),
  maxAttempts: z.number().int().min(1).max(5),
}) satisfies z.ZodType<RouterBalanceConfig>;

export const routerQuotaSnapshotSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  strategyId: z.string().nullable(),
  strategyLabel: z.string().nullable(),
  windows: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      usedPercent: z.number().finite(),
      resetsAt: z.number().finite().nullable(),
      windowMinutes: z.number().finite().nullable(),
    }),
  ),
  balance: z.number().finite().nullable(),
  currency: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  error: z.string().nullable(),
  queriedAt: z.number().finite().nullable(),
}) satisfies z.ZodType<RouterQuotaSnapshot>;

const nullableFinite = z.number().finite().nullable().default(null);
const nullableReset = z.string().nullable().default(null);

export const quotaHistoryPointSchema = z.object({
  ts: z.number().finite(),
  rolling: nullableFinite,
  weekly: nullableFinite,
  monthly: nullableFinite,
  rollingReset: nullableReset,
  weeklyReset: nullableReset,
  monthlyReset: nullableReset,
}) satisfies z.ZodType<QuotaHistoryPoint>;

export const secretEnvelopeSchema = z.object({
  version: z.literal(1),
  data: z.string().min(1),
});
