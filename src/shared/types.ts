export const APP_NAME = 'TokenMonitor';
export const APP_VERSION = '0.2.2';
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
  providerId: ExtraProviderId;
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

export interface NotificationSettings {
  enabled: boolean;
  /** Remaining-percentage thresholds, e.g. [20, 5]. */
  remainingThresholds: number[];
  rateLimited: boolean;
  reset: boolean;
  pace: boolean;
}

export interface SpeedSettings {
  enabled: boolean;
  upstreamBase: string;
  configApplied: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AppSettings {
  schemaVersion: 1;
  theme: Theme;
  language: Language;
  refreshMinutes: number;
  notifications: NotificationSettings;
  launchAtLogin: boolean;
  startHidden: boolean;
  hideOnBlur: boolean;
  trayShowRemaining: boolean;
  localUsageEnabled: boolean;
  localDataPath: string | null;
  credentialSource: CredentialSource;
  orgId: string;
  speed: SpeedSettings;
  onboardingCompleted: boolean;
  windowBounds: WindowBounds | null;
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

export interface LocalUsageDay extends TokenTotals {
  day: string;
  messages: number;
}

export interface LocalUsageModel extends TokenTotals {
  provider: string;
  model: string;
  messages: number;
}

export interface LocalUsageError {
  code: 'missing' | 'locked' | 'schema' | 'unknown';
  message: string;
}

export interface LocalUsageSummary {
  range: LocalUsageRange;
  generatedAt: number;
  dbPath: string;
  schema: LocalSchemaKind;
  source: 'sqlite' | 'demo' | 'none';
  totals: TokenTotals;
  sessions: number;
  messages: number;
  days: LocalUsageDay[];
  models: LocalUsageModel[];
  partial: boolean;
  error?: LocalUsageError;
}

export type SpeedRange = '7d' | '30d';

export interface SpeedPoint {
  day: string;
  provider: string;
  model: string;
  tokensPerSecond: number;
  ttftMs: number | null;
  samples: number;
  tokenSource: 'upstream' | 'local' | 'mixed' | 'unknown';
}

export interface SpeedSeries {
  range: SpeedRange;
  generatedAt: number;
  enabled: boolean;
  running: boolean;
  points: SpeedPoint[];
  totalSamples: number;
  approximate: boolean;
  error?: string;
}

export interface SpeedStatus {
  enabled: boolean;
  running: boolean;
  port: number | null;
  upstreamBase: string;
  sampleCount: number;
  lastSampleAt: number | null;
  configApplied: boolean;
  error: string | null;
}

export interface SpeedConfigInfo {
  proxyUrl: string;
  snippet: string;
  configPathHint: string;
  applied: boolean;
  running: boolean;
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
  speed: SpeedStatus;
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
}
