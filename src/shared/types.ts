export const APP_NAME = 'TokenMonitor';
export const APP_VERSION = '0.7.3';
export const QUOTA_API_URL = 'https://opencode.ai/zen/go/v1/usage';

export type QuotaWindowId = 'rolling' | 'weekly' | 'monthly';
export type ExtraProviderId = 'codex' | 'claude' | 'cursor' | 'zai' | 'zcode';
export const EXTRA_PROVIDER_IDS: ExtraProviderId[] = ['codex', 'claude', 'cursor', 'zai', 'zcode'];

export interface ExtraProviderWindow {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  status: QuotaStatus;
  windowMs: number;
  pace: PaceView;
}

export interface ResetCreditsInfo {
  availableCount: number;
  nextExpiresAt: string | null;
  updatedAt: number;
}

export interface ExtraProviderSnapshot {
  providerId: ExtraProviderId;
  providerName: string;
  planLabel: string;
  fetchedAt: number;
  windows: ExtraProviderWindow[];
  resetCredits?: ResetCreditsInfo | null;
}

export interface ServiceStatusComponent {
  name: string;
  status: string;
}

export interface ServiceStatus {
  /** Loosely typed: 'opencode' has a custom status page and is not an ExtraProviderId. */
  providerId: string;
  providerName: string;
  indicator: 'none' | 'minor' | 'major' | 'critical' | 'unknown';
  description: string;
  incidentCount: number;
  components: ServiceStatusComponent[];
  updatedAt: number;
  url: string;
  error?: string;
}

export interface ExtraProviderState {
  providerId: ExtraProviderId;
  providerName: string;
  configured: boolean;
  source: 'manual' | 'auto' | 'env' | 'auth-file' | 'zcode' | 'none';
  snapshot: ExtraProviderSnapshot | null;
  error: ProviderError | null;
  loading: boolean;
  stale: boolean;
  fetchedAt: number | null;
}
export type QuotaStatus = 'ok' | 'rate-limited' | 'unknown';
export type PaceState = 'insufficient' | 'ahead' | 'on-pace' | 'behind';

export interface PaceView {
  state: PaceState;
  headroom: number | null;
  elapsedRatio: number;
  dailyAverage: number | null;
  sustainableDaily: number | null;
  projectedExhaustionAt: string | null;
}

export interface QuotaWindowView {
  id: QuotaWindowId;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  status: QuotaStatus;
  windowMs: number;
  pace: PaceView;
}

export interface ProviderSnapshot {
  providerId: 'opencode-go';
  providerName: string;
  planLabel: string;
  fetchedAt: number;
  windows: QuotaWindowView[];
  source: 'api' | 'cache' | 'demo';
}

export type ErrorCode =
  | 'not-configured'
  | 'invalid-key'
  | 'no-subscription'
  | 'network'
  | 'timeout'
  | 'malformed'
  | 'rate-limited'
  | 'unknown';

export interface ProviderError {
  code: ErrorCode;
  message: string;
  status?: number;
  retryable: boolean;
}

export interface QuotaState {
  snapshot: ProviderSnapshot | null;
  error: ProviderError | null;
  fetchedAt: number | null;
  stale: boolean;
  loading: boolean;
  configured: boolean;
}

export type Theme = 'system' | 'light' | 'dark';
export type Language = 'zh-CN' | 'en';
export type CredentialSource = 'auto' | 'manual';

export type HomeCardId = 'quota' | 'health' | 'trend' | 'recent';

export interface HomeCardSettings {
  quota: boolean;
  health: boolean;
  trend: boolean;
  recent: boolean;
}

/** Router quota strategies that mirror a local agent subscription (dedup + visibility share one key). */
const AGENT_STRATEGY_IDS = new Set(['opencode', 'codex', 'claude', 'cursor', 'zai']);

/** Stable visibility/dedup key for an agent subscription. ZCode and Z.AI share one account system. */
export function agentQuotaKey(providerId: string): string {
  const key = providerId === 'opencode' || providerId === 'opencode-go' ? 'agent:opencode' : `agent:${providerId}`;
  return key === 'agent:zcode' ? 'agent:zai' : key;
}

/** Visibility/dedup key for a router quota entry: agent strategies share the agent key, others stay per-provider. */
export function routerQuotaIdentity(providerId: string, strategyId: string | null | undefined): string {
  return strategyId && AGENT_STRATEGY_IDS.has(strategyId) ? agentQuotaKey(strategyId) : `router:${providerId}`;
}

export interface NotificationSettings {
  enabled: boolean;
  /** Remaining-percentage thresholds, e.g. [20, 5]. */
  remainingThresholds: number[];
  rateLimited: boolean;
  reset: boolean;
  pace: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OrbPosition {
  x: number;
  y: number;
}

export interface AppSettings {
  schemaVersion: 1;
  theme: Theme;
  language: Language;
  refreshMinutes: number;
  notifications: NotificationSettings;
  homeCards: HomeCardSettings;
  homeCardOrder: HomeCardId[];
  /** Per-Agent display switch for the overview quota card, keyed by stable agent key. Missing = shown. */
  quotaVisibility: Record<string, boolean>;
  trayShowRouterQuota: boolean;
  launchAtLogin: boolean;
  startHidden: boolean;
  hideOnBlur: boolean;
  trayShowRemaining: boolean;
  localUsageEnabled: boolean;
  localDataPath: string | null;
  credentialSource: CredentialSource;
  orgId: string;
  onboardingCompleted: boolean;
  windowBounds: WindowBounds | null;
  /** Persistent always-on-top floating orb; position null = default spot near the tray. */
  orbEnabled: boolean;
  orbPosition: OrbPosition | null;
  /** Quota identity key (agentQuotaKey / routerQuotaIdentity) shown on the orb; null = first available. */
  orbTargetKey: string | null;
  /** Which quota slice the orb displays: lowest window, money balance, or a fixed window bucket. */
  orbQuotaView: 'all' | 'money' | 'hours' | 'week' | 'month';
}

export type CredentialKind = 'none' | 'manual' | 'env' | 'auth-file';

export interface CredentialStatus {
  configured: boolean;
  kind: CredentialKind;
  masked: string | null;
  persisted: boolean;
  envAvailable: boolean;
  authFileAvailable: boolean;
  authFileHasOpenCode: boolean;
}

export interface CredentialDetection {
  found: boolean;
  masked: string | null;
  provider: string | null;
  message: string;
}

export interface CredentialTestResult {
  ok: boolean;
  code?: ErrorCode;
  message?: string;
}

export type LocalUsageRange = 'today' | '7d' | '30d' | 'all';
export type LocalSchemaKind = 'v1' | 'v2' | 'mixed' | 'none' | 'demo';

export interface TokenTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface QuotaHistoryPoint {
  ts: number;
  rolling: number | null;
  weekly: number | null;
  monthly: number | null;
  rollingReset: string | null;
  weeklyReset: string | null;
  monthlyReset: string | null;
}

export interface AppState {
  ready: boolean;
  demo: boolean;
  version: string;
  platform: string;
  settings: AppSettings;
  credentials: CredentialStatus;
  quota: QuotaState;
  extraProviders: ExtraProviderState[];
  serviceStatuses: ServiceStatus[];
  router: import('./routerTypes').RouterState;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface UpdateSettingsPatch {
  theme?: Theme;
  language?: Language;
  refreshMinutes?: number;
  notifications?: Partial<NotificationSettings>;
  homeCards?: Partial<HomeCardSettings>;
  homeCardOrder?: HomeCardId[];
  quotaVisibility?: Record<string, boolean>;
  trayShowRouterQuota?: boolean;
  launchAtLogin?: boolean;
  startHidden?: boolean;
  hideOnBlur?: boolean;
  trayShowRemaining?: boolean;
  localUsageEnabled?: boolean;
  localDataPath?: string | null;
  credentialSource?: CredentialSource;
  orgId?: string;
  onboardingCompleted?: boolean;
  windowBounds?: WindowBounds | null;
  orbEnabled?: boolean;
  orbPosition?: OrbPosition | null;
  orbTargetKey?: string | null;
  orbQuotaView?: 'all' | 'money' | 'hours' | 'week' | 'month';
}
