import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  RouterBalanceConfig,
  RouterLogEntry,
  RouterLogPage,
  RouterLogQuery,
  RouterModelChannel,
  RouterModelInput,
  RouterProvider,
  RouterProviderInput,
  RouterProviderKind,
  RouterProtocol,
  RouterQuotaSnapshot,
  RouterServiceConfig,
  RouterUsageOverview,
  RouterUsageRange,
  RouterUsageSeries,
  RouterUsageTotals,
} from '../../shared/routerTypes';
import { DEFAULT_ROUTER_BALANCE, DEFAULT_ROUTER_PORT } from '../../shared/routerTypes';

const SCHEMA_VERSION = 1;

export interface RouterProviderRow {
  id: string;
  name: string;
  protocol: RouterProtocol;
  kind: RouterProviderKind;
  baseUrl: string;
  quotaStrategyId: string | null;
  strategyConfig: Record<string, string>;
  enabled: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RouterRoute {
  modelId: string;
  providerId: string;
  providerName: string;
  providerProtocol: RouterProtocol;
  publicName: string;
  upstreamModel: string;
  providerEnabled: boolean;
  modelEnabled: boolean;
}

interface ProviderDbRow {
  id: string;
  name: string;
  protocol: string;
  kind: string;
  base_url: string;
  quota_strategy_id: string | null;
  strategy_config: string | null;
  enabled: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ModelDbRow {
  id: string;
  provider_id: string;
  public_name: string;
  upstream_name: string;
  enabled: number;
  archived_at: number | null;
  created_at: number;
  provider_name?: string;
  provider_protocol?: string;
}

interface LogDbRow {
  id: number;
  request_id: string;
  started_at: number;
  finished_at: number | null;
  public_model: string;
  provider_name: string;
  upstream_model: string;
  provider_id: string | null;
  model_id: string | null;
  client: string | null;
  path: string;
  status: number | null;
  duration_ms: number | null;
  stream: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  unrecognized_tokens: number;
  total_tokens: number;
  error: string | null;
  request_body: string | null;
  request_headers: string | null;
  response_body: string | null;
  response_headers: string | null;
  retry_trace: string | null;
  aggregated: number;
}

const EMPTY_TOTALS: RouterUsageTotals = {
  requestCount: 0,
  successCount: 0,
  failCount: 0,
  durationMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  unrecognizedTokens: 0,
  totalTokens: 0,
};

function parseConfig(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, item]) => [key, item]),
    );
  } catch {
    return {};
  }
}

function localDayKey(ts = Date.now()): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localHourKey(ts: number): string {
  const date = new Date(ts);
  return `${localDayKey(ts)}T${String(date.getHours()).padStart(2, '0')}`;
}

function startOfLocalDay(ts: number): number {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addTotals(target: RouterUsageTotals, source: RouterUsageTotals): void {
  target.requestCount += source.requestCount;
  target.successCount += source.successCount;
  target.failCount += source.failCount;
  target.durationMs += source.durationMs;
  target.promptTokens += source.promptTokens;
  target.completionTokens += source.completionTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.unrecognizedTokens += source.unrecognizedTokens;
  target.totalTokens += source.totalTokens;
}

function emptyTotals(): RouterUsageTotals {
  return { ...EMPTY_TOTALS };
}

export class RouterRepository {
  private readonly db: DatabaseSync;

  constructor(baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
    this.db = new DatabaseSync(join(baseDir, 'router.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore.
    }
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version ?? 0);
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'openai',
        kind TEXT NOT NULL DEFAULT 'custom',
        base_url TEXT NOT NULL,
        quota_strategy_id TEXT,
        strategy_config TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_router_providers_name ON providers(name);

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        public_name TEXT NOT NULL,
        upstream_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(public_name, provider_id)
      );
      CREATE INDEX IF NOT EXISTS idx_router_models_public ON models(public_name);
      CREATE INDEX IF NOT EXISTS idx_router_models_provider ON models(provider_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        log_date TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        public_model TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        upstream_model TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        client TEXT,
        path TEXT NOT NULL,
        status INTEGER,
        duration_ms INTEGER,
        stream INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        unrecognized_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        request_body TEXT,
        request_headers TEXT,
        response_body TEXT,
        response_headers TEXT,
        error TEXT,
        retry_trace TEXT,
        aggregated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_router_logs_date ON request_logs(log_date);
      CREATE INDEX IF NOT EXISTS idx_router_logs_started ON request_logs(started_at);

      CREATE TABLE IF NOT EXISTS usage_daily (
        date TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        public_model TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        unrecognized_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, provider_name, public_model)
      );

      CREATE TABLE IF NOT EXISTS usage_hourly (
        hour_key TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        public_model TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        unrecognized_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_key, provider_name, public_model)
      );
      CREATE INDEX IF NOT EXISTS idx_router_usage_hourly ON usage_hourly(hour_key);

      CREATE TABLE IF NOT EXISTS quota_snapshots (
        provider_id TEXT PRIMARY KEY,
        snapshot TEXT,
        error TEXT,
        queried_at INTEGER NOT NULL
      );

      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getServiceConfig(): RouterServiceConfig {
    const raw = this.getSetting('router.service');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<RouterServiceConfig>;
        return {
          enabled: parsed.enabled !== false,
          port: Number(parsed.port) || DEFAULT_ROUTER_PORT,
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
          proxyUrl: typeof parsed.proxyUrl === 'string' ? parsed.proxyUrl : '',
        };
      } catch {
        // Fall through to defaults.
      }
    }
    return { enabled: false, port: DEFAULT_ROUTER_PORT, apiKey: '', proxyUrl: '' };
  }

  setServiceConfig(config: RouterServiceConfig): void {
    this.setSetting('router.service', JSON.stringify(config));
  }

  getBalanceConfig(): RouterBalanceConfig {
    const raw = this.getSetting('router.balancing');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<RouterBalanceConfig>;
        return {
          enabled: parsed.enabled !== false,
          sessionAffinity: parsed.sessionAffinity !== false,
          quotaGuard: parsed.quotaGuard !== false,
          maxAttempts: Math.min(5, Math.max(1, Number(parsed.maxAttempts) || 3)),
        };
      } catch {
        // Fall through.
      }
    }
    return { ...DEFAULT_ROUTER_BALANCE };
  }

  setBalanceConfig(config: RouterBalanceConfig): void {
    this.setSetting('router.balancing', JSON.stringify(config));
  }

  listProviders(includeArchived = false): RouterProviderRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM providers ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at`)
      .all() as unknown as ProviderDbRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      protocol: row.protocol as RouterProtocol,
      kind: row.kind as RouterProviderKind,
      baseUrl: row.base_url,
      quotaStrategyId: row.quota_strategy_id,
      strategyConfig: parseConfig(row.strategy_config),
      enabled: Boolean(row.enabled),
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getProvider(id: string): RouterProviderRow | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderDbRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol as RouterProtocol,
      kind: row.kind as RouterProviderKind,
      baseUrl: row.base_url,
      quotaStrategyId: row.quota_strategy_id,
      strategyConfig: parseConfig(row.strategy_config),
      enabled: Boolean(row.enabled),
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  saveProvider(input: RouterProviderInput): RouterProviderRow {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    const existing = input.id ? this.getProvider(input.id) : null;
    if (existing) {
      this.db
        .prepare(`
          UPDATE providers SET name = ?, protocol = ?, kind = ?, base_url = ?, quota_strategy_id = ?,
            strategy_config = ?, enabled = ?, updated_at = ? WHERE id = ?
        `)
        .run(
          input.name,
          input.protocol,
          input.kind,
          input.baseUrl,
          input.quotaStrategyId ?? null,
          JSON.stringify(input.strategyConfig ?? {}),
          input.enabled ? 1 : 0,
          now,
          id,
        );
    } else {
      this.db
        .prepare(`
          INSERT INTO providers (id, name, protocol, kind, base_url, quota_strategy_id, strategy_config, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.name,
          input.protocol,
          input.kind,
          input.baseUrl,
          input.quotaStrategyId ?? null,
          JSON.stringify(input.strategyConfig ?? {}),
          input.enabled ? 1 : 0,
          now,
          now,
        );
    }
    return this.getProvider(id)!;
  }

  setProviderArchived(id: string, archived: boolean): void {
    const now = Date.now();
    this.db.prepare('UPDATE providers SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? now : null, now, id);
    if (archived) this.db.prepare('UPDATE models SET archived_at = ? WHERE provider_id = ?').run(now, id);
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  listModelGroups(includeArchived = false): Array<{ publicName: string; channels: RouterModelChannel[] }> {
    const where = includeArchived ? '' : 'WHERE m.archived_at IS NULL AND p.archived_at IS NULL';
    const rows = this.db
      .prepare(`
        SELECT m.*, p.name AS provider_name, p.protocol AS provider_protocol
        FROM models m JOIN providers p ON p.id = m.provider_id
        ${where}
        ORDER BY m.public_name, m.created_at
      `)
      .all() as unknown as ModelDbRow[];
    const groups = new Map<string, RouterModelChannel[]>();
    for (const row of rows) {
      const list = groups.get(row.public_name) ?? [];
      list.push({
        id: row.id,
        providerId: row.provider_id,
        providerName: row.provider_name ?? '',
        providerProtocol: (row.provider_protocol ?? 'openai') as RouterProtocol,
        publicName: row.public_name,
        upstreamName: row.upstream_name,
        enabled: Boolean(row.enabled),
        archivedAt: row.archived_at,
        createdAt: row.created_at,
      });
      groups.set(row.public_name, list);
    }
    return [...groups.entries()].map(([publicName, channels]) => ({ publicName, channels }));
  }

  getModel(id: string): RouterModelChannel | null {
    const row = this.db
      .prepare(`
        SELECT m.*, p.name AS provider_name, p.protocol AS provider_protocol
        FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?
      `)
      .get(id) as ModelDbRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      providerId: row.provider_id,
      providerName: row.provider_name ?? '',
      providerProtocol: (row.provider_protocol ?? 'openai') as RouterProtocol,
      publicName: row.public_name,
      upstreamName: row.upstream_name,
      enabled: Boolean(row.enabled),
      archivedAt: row.archived_at,
      createdAt: row.created_at,
    };
  }

  saveModel(input: RouterModelInput): RouterModelChannel {
    const now = Date.now();
    if (input.id) {
      this.db
        .prepare('UPDATE models SET provider_id = ?, public_name = ?, upstream_name = ?, enabled = ? WHERE id = ?')
        .run(input.providerId, input.publicName, input.upstreamName, input.enabled ? 1 : 0, input.id);
      return this.getModel(input.id)!;
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO models (id, provider_id, public_name, upstream_name, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.providerId, input.publicName, input.upstreamName, input.enabled ? 1 : 0, now);
    return this.getModel(id)!;
  }

  setModelArchived(id: string, archived: boolean): void {
    this.db.prepare('UPDATE models SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, id);
  }

  deleteModel(id: string): void {
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  findRoutes(publicName: string): RouterRoute[] {
    const rows = this.db
      .prepare(`
        SELECT m.id AS model_id, m.provider_id, m.public_name, m.upstream_name,
          p.name AS provider_name, p.protocol AS provider_protocol,
          m.enabled AS model_enabled, p.enabled AS provider_enabled,
          m.archived_at AS model_archived, p.archived_at AS provider_archived
        FROM models m JOIN providers p ON p.id = m.provider_id
        WHERE m.public_name = ?
        ORDER BY m.created_at
      `)
      .all(publicName) as unknown as Array<{
      model_id: string;
      provider_id: string;
      public_name: string;
      upstream_name: string;
      provider_name: string;
      provider_protocol: string;
      model_enabled: number;
      provider_enabled: number;
      model_archived: number | null;
      provider_archived: number | null;
    }>;
    return rows
      .filter((row) => !row.model_archived && !row.provider_archived)
      .map((row) => ({
        modelId: row.model_id,
        providerId: row.provider_id,
        providerName: row.provider_name,
        providerProtocol: row.provider_protocol as RouterProtocol,
        publicName: row.public_name,
        upstreamModel: row.upstream_name,
        providerEnabled: Boolean(row.provider_enabled),
        modelEnabled: Boolean(row.model_enabled),
      }));
  }

  countModels(providerId: string): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM models WHERE provider_id = ? AND archived_at IS NULL')
      .get(providerId) as { n: number };
    return Number(row.n) || 0;
  }

  startLog(input: {
    requestId: string;
    publicModel: string;
    providerName: string;
    upstreamModel: string;
    providerId: string;
    modelId: string;
    client: string | null;
    path: string;
    stream: boolean;
    requestBody: string | null;
    requestHeaders: string | null;
    startedAt?: number;
  }): void {
    const now = input.startedAt ?? Date.now();
    this.db
      .prepare(`
        INSERT INTO request_logs (
          request_id, log_date, started_at, public_model, provider_name, upstream_model,
          provider_id, model_id, client, path, stream, request_body, request_headers
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.requestId,
        localDayKey(now),
        now,
        input.publicModel,
        input.providerName,
        input.upstreamModel,
        input.providerId,
        input.modelId,
        input.client,
        input.path,
        input.stream ? 1 : 0,
        input.requestBody,
        input.requestHeaders,
      );
  }

  finishLog(input: {
    requestId: string;
    status: number;
    stream: boolean;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    unrecognizedTokens: number;
    totalTokens: number;
    responseBody: string | null;
    responseHeaders: string | null;
    error: string | null;
    retryTrace: string | null;
  }): void {
    const row = this.db
      .prepare('SELECT * FROM request_logs WHERE request_id = ?')
      .get(input.requestId) as LogDbRow | undefined;
    if (!row) return;
    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - row.started_at);
    this.db
      .prepare(`
        UPDATE request_logs SET finished_at = ?, status = ?, duration_ms = ?, stream = ?,
          prompt_tokens = ?, completion_tokens = ?, reasoning_tokens = ?, cache_read_tokens = ?,
          cache_write_tokens = ?, unrecognized_tokens = ?, total_tokens = ?,
          response_body = ?, response_headers = ?, error = ?, retry_trace = ?, aggregated = 1
        WHERE request_id = ?
      `)
      .run(
        finishedAt,
        input.status,
        durationMs,
        input.stream ? 1 : 0,
        input.promptTokens,
        input.completionTokens,
        input.reasoningTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.unrecognizedTokens,
        input.totalTokens,
        input.responseBody,
        input.responseHeaders,
        input.error,
        input.retryTrace,
        input.requestId,
      );

    if (row.aggregated) return;
    const success = input.status >= 200 && input.status < 300;
    const totals: RouterUsageTotals = {
      requestCount: 1,
      successCount: success ? 1 : 0,
      failCount: success ? 0 : 1,
      durationMs,
      promptTokens: success ? input.promptTokens : 0,
      completionTokens: success ? input.completionTokens : 0,
      reasoningTokens: success ? input.reasoningTokens : 0,
      cacheReadTokens: success ? input.cacheReadTokens : 0,
      cacheWriteTokens: success ? input.cacheWriteTokens : 0,
      unrecognizedTokens: success ? input.unrecognizedTokens : 0,
      totalTokens: success ? input.totalTokens : 0,
    };
    this.addUsage(localDayKey(row.started_at), localHourKey(row.started_at), {
      providerName: row.provider_name,
      publicModel: row.public_model,
      providerId: row.provider_id,
      modelId: row.model_id,
      totals,
    });
  }

  private addUsage(
    date: string,
    hourKey: string,
    input: { providerName: string; publicModel: string; providerId: string | null; modelId: string | null; totals: RouterUsageTotals },
  ): void {
    const totals = input.totals;
    for (const table of ['usage_daily', 'usage_hourly'] as const) {
      const keyColumn = table === 'usage_daily' ? 'date' : 'hour_key';
      const keyValue = table === 'usage_daily' ? date : hourKey;
      this.db
        .prepare(`
          INSERT INTO ${table} (
            ${keyColumn}, provider_name, public_model, provider_id, model_id,
            request_count, success_count, fail_count, duration_ms,
            prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens,
            cache_write_tokens, unrecognized_tokens, total_tokens
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(${keyColumn}, provider_name, public_model) DO UPDATE SET
            request_count = request_count + excluded.request_count,
            success_count = success_count + excluded.success_count,
            fail_count = fail_count + excluded.fail_count,
            duration_ms = duration_ms + excluded.duration_ms,
            prompt_tokens = prompt_tokens + excluded.prompt_tokens,
            completion_tokens = completion_tokens + excluded.completion_tokens,
            reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
            unrecognized_tokens = unrecognized_tokens + excluded.unrecognized_tokens,
            total_tokens = total_tokens + excluded.total_tokens
        `)
        .run(
          keyValue,
          input.providerName,
          input.publicModel,
          input.providerId,
          input.modelId,
          totals.requestCount,
          totals.successCount,
          totals.failCount,
          totals.durationMs,
          totals.promptTokens,
          totals.completionTokens,
          totals.reasoningTokens,
          totals.cacheReadTokens,
          totals.cacheWriteTokens,
          totals.unrecognizedTokens,
          totals.totalTokens,
        );
    }
  }

  markPendingInterrupted(): void {
    const rows = this.db.prepare('SELECT request_id, started_at FROM request_logs WHERE finished_at IS NULL').all() as unknown as Array<{
      request_id: string;
      started_at: number;
    }>;
    for (const row of rows) {
      this.finishLog({
        requestId: row.request_id,
        status: 499,
        stream: false,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        unrecognizedTokens: 0,
        totalTokens: 0,
        responseBody: null,
        responseHeaders: null,
        error: '服务中断',
        retryTrace: null,
      });
    }
  }

  pruneLogs(days = 7): void {
    const cutoff = localDayKey(Date.now() - days * 24 * 60 * 60 * 1000);
    this.db.prepare('DELETE FROM request_logs WHERE log_date < ?').run(cutoff);
  }

  clearLogs(): void {
    this.db.prepare('DELETE FROM request_logs').run();
    this.db.prepare('DELETE FROM usage_hourly').run();
  }

  pruneUsage(days = 7): void {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    cutoff.setMinutes(0, 0, 0);
    this.db.prepare('DELETE FROM usage_hourly WHERE hour_key < ?').run(localHourKey(cutoff.getTime()));
  }

  getLog(id: number): RouterLogEntry | null {
    const row = this.db.prepare('SELECT * FROM request_logs WHERE id = ?').get(id) as LogDbRow | undefined;
    return row ? this.mapLog(row) : null;
  }

  listLogs(query: RouterLogQuery): RouterLogPage {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = Math.max(0, query.offset ?? 0);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (query.model) {
      conditions.push('public_model = ?');
      params.push(query.model);
    }
    if (query.status !== null && query.status !== undefined) {
      conditions.push('status = ?');
      params.push(query.status);
    }
    if (query.search) {
      conditions.push('(public_model LIKE ? OR provider_name LIKE ? OR error LIKE ?)');
      const needle = `%${query.search}%`;
      params.push(needle, needle, needle);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = Number(
      (this.db.prepare(`SELECT count(*) AS n FROM request_logs ${where}`).get(...params) as { n: number }).n,
    );
    const rows = this.db
      .prepare(`SELECT * FROM request_logs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as LogDbRow[];
    return { items: rows.map((row) => this.mapLog(row)), total };
  }

  private mapLog(row: LogDbRow): RouterLogEntry {
    return {
      id: row.id,
      requestId: row.request_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      publicModel: row.public_model,
      providerName: row.provider_name,
      upstreamModel: row.upstream_model,
      client: row.client,
      path: row.path,
      status: row.status,
      durationMs: row.duration_ms,
      stream: Boolean(row.stream),
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      reasoningTokens: row.reasoning_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      unrecognizedTokens: row.unrecognized_tokens,
      totalTokens: row.total_tokens,
      error: row.error,
      requestBody: row.request_body,
      requestHeaders: row.request_headers,
      responseBody: row.response_body,
      responseHeaders: row.response_headers,
      retryTrace: row.retry_trace,
    };
  }

  getUsage(range: RouterUsageRange): RouterUsageOverview {
    const now = Date.now();
    const todayStart = startOfLocalDay(now);
    const useHourly = range === 'today' || range === '24h';
    const days = range === '30d' ? 30 : 7;
    const startTs = range === 'today'
      ? todayStart
      : range === '24h'
        ? now - 23 * 60 * 60 * 1000
        : startOfLocalDay(now) - (days - 1) * 24 * 60 * 60 * 1000;
    const startKey = useHourly ? localHourKey(startTs) : localDayKey(startTs);
    const table = useHourly ? 'usage_hourly' : 'usage_daily';
    const keyColumn = useHourly ? 'hour_key' : 'date';
    const rows = this.db
      .prepare(`SELECT * FROM ${table} WHERE ${keyColumn} >= ? ORDER BY ${keyColumn}`)
      .all(startKey) as unknown as Array<Record<string, unknown>>;

    const totals = emptyTotals();
    const providers = new Map<string, RouterUsageTotals>();
    const models = new Map<string, RouterUsageTotals>();
    const buckets = new Map<string, RouterUsageTotals>();
    for (const row of rows) {
      const totalsRow: RouterUsageTotals = {
        requestCount: Number(row.request_count) || 0,
        successCount: Number(row.success_count) || 0,
        failCount: Number(row.fail_count) || 0,
        durationMs: Number(row.duration_ms) || 0,
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
        reasoningTokens: Number(row.reasoning_tokens) || 0,
        cacheReadTokens: Number(row.cache_read_tokens) || 0,
        cacheWriteTokens: Number(row.cache_write_tokens) || 0,
        unrecognizedTokens: Number(row.unrecognized_tokens) || 0,
        totalTokens: Number(row.total_tokens) || 0,
      };
      addTotals(totals, totalsRow);
      const providerKey = String(row.provider_name ?? '');
      const modelKey = String(row.public_model ?? '');
      const providerTotals = providers.get(providerKey) ?? emptyTotals();
      addTotals(providerTotals, totalsRow);
      providers.set(providerKey, providerTotals);
      const modelTotals = models.get(modelKey) ?? emptyTotals();
      addTotals(modelTotals, totalsRow);
      models.set(modelKey, modelTotals);
      const bucketKey = String(row[keyColumn] ?? '');
      const bucket = buckets.get(bucketKey) ?? emptyTotals();
      addTotals(bucket, totalsRow);
      buckets.set(bucketKey, bucket);
    }

    const series = this.buildSeries(range, buckets, now);
    return {
      range,
      totals,
      providers: [...providers.entries()]
        .map(([key, value]) => ({ key, ...value }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      models: [...models.entries()]
        .map(([key, value]) => ({ key, ...value }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
      series,
    };
  }

  private buildSeries(
    range: RouterUsageRange,
    buckets: Map<string, RouterUsageTotals>,
    now: number,
  ): RouterUsageSeries {
    const useHourly = range === 'today' || range === '24h';
    const keys: string[] = [];
    if (useHourly) {
      const start = range === 'today' ? startOfLocalDay(now) : now - 23 * 60 * 60 * 1000;
      const cursor = new Date(start);
      cursor.setMinutes(0, 0, 0);
      const end = new Date(now);
      while (cursor.getTime() <= end.getTime()) {
        keys.push(localHourKey(cursor.getTime()));
        cursor.setHours(cursor.getHours() + 1);
      }
    } else {
      const days = range === '30d' ? 30 : 7;
      const cursor = new Date(startOfLocalDay(now));
      cursor.setDate(cursor.getDate() - (days - 1));
      for (let index = 0; index < days; index += 1) {
        keys.push(localDayKey(cursor.getTime()));
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    return {
      granularity: useHourly ? 'hour' : 'day',
      buckets: keys,
      labels: keys.map((key) => (useHourly ? `${key.slice(11, 13)}:00` : key.slice(5))),
      requestCount: keys.map((key) => buckets.get(key)?.requestCount ?? 0),
      totalTokens: keys.map((key) => buckets.get(key)?.totalTokens ?? 0),
      cacheTokens: keys.map((key) => buckets.get(key)?.cacheReadTokens ?? 0),
    };
  }

  saveQuotaSnapshot(input: {
    providerId: string;
    snapshot: RouterQuotaSnapshot | null;
    error: string | null;
    queriedAt: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO quota_snapshots (provider_id, snapshot, error, queried_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET snapshot = excluded.snapshot, error = excluded.error, queried_at = excluded.queried_at
      `)
      .run(input.providerId, input.snapshot ? JSON.stringify(input.snapshot) : null, input.error, input.queriedAt);
  }

  listQuotaSnapshots(): Array<{ providerId: string; snapshot: RouterQuotaSnapshot | null; error: string | null; queriedAt: number }> {
    const rows = this.db.prepare('SELECT * FROM quota_snapshots').all() as unknown as Array<{
      provider_id: string;
      snapshot: string | null;
      error: string | null;
      queried_at: number;
    }>;
    return rows.map((row) => {
      let snapshot: RouterQuotaSnapshot | null = null;
      if (row.snapshot) {
        try {
          snapshot = JSON.parse(row.snapshot) as RouterQuotaSnapshot;
        } catch {
          snapshot = null;
        }
      }
      return { providerId: row.provider_id, snapshot, error: row.error, queriedAt: row.queried_at };
    });
  }

  getQuotaSnapshot(providerId: string): { snapshot: RouterQuotaSnapshot | null; queriedAt: number } | null {
    const row = this.db.prepare('SELECT * FROM quota_snapshots WHERE provider_id = ?').get(providerId) as
      | { snapshot: string | null; queried_at: number }
      | undefined;
    if (!row) return null;
    try {
      return {
        snapshot: row.snapshot ? (JSON.parse(row.snapshot) as RouterQuotaSnapshot) : null,
        queriedAt: row.queried_at,
      };
    } catch {
      return { snapshot: null, queriedAt: row.queried_at };
    }
  }
}

export type { RouterProvider };
