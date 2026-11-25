import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  asRecord,
  finiteNumber,
  nonEmptyString,
  parseJson,
  safeInteger,
  stringValue,
} from '../../shared/validation';
import {
  routerBalanceConfigSchema,
  routerProviderKindSchema,
  routerProtocolSchema,
  routerQuotaSnapshotSchema,
  routerServiceConfigSchema,
} from '../../shared/routerSchemas';
import type {
  RouterActivityDay,
  RouterBalanceConfig,
  RouterClientProviderFlow,
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
  RouterUsageBreakdown,
  RouterUsageRange,
  RouterUsageSeries,
  RouterUsageTotals,
} from '../../shared/routerTypes';
import { DEFAULT_ROUTER_BALANCE, DEFAULT_ROUTER_PORT } from '../../shared/routerTypes';

const SCHEMA_VERSION = 4;

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

const integerColumn = z.preprocess((value) => safeInteger(value), z.number().int());
const nullableIntegerColumn = integerColumn.nullable();
const flagColumn = z.preprocess((value) => {
  const integer = safeInteger(value);
  return integer === 0 ? false : integer === 1 ? true : null;
}, z.boolean());
const textColumn = z.string();
const nullableTextColumn = textColumn.nullable();

const providerRowSchema = z.object({
  id: textColumn,
  name: textColumn,
  protocol: routerProtocolSchema,
  kind: routerProviderKindSchema,
  base_url: textColumn,
  quota_strategy_id: nullableTextColumn,
  strategy_config: nullableTextColumn,
  enabled: flagColumn,
  archived_at: nullableIntegerColumn,
  created_at: integerColumn,
  updated_at: integerColumn,
});

const modelRowSchema = z.object({
  id: textColumn,
  provider_id: textColumn,
  public_name: textColumn,
  upstream_name: textColumn,
  enabled: flagColumn,
  archived_at: nullableIntegerColumn,
  created_at: integerColumn,
  provider_name: textColumn,
  provider_protocol: routerProtocolSchema,
});

const logRowSchema = z.object({
  id: integerColumn,
  request_id: textColumn,
  started_at: integerColumn,
  finished_at: nullableIntegerColumn,
  public_model: textColumn,
  provider_name: textColumn,
  upstream_model: textColumn,
  provider_id: nullableTextColumn,
  model_id: nullableTextColumn,
  client: nullableTextColumn,
  path: textColumn,
  status: nullableIntegerColumn,
  duration_ms: nullableIntegerColumn,
  ttft_ms: nullableIntegerColumn,
  stream: flagColumn,
  prompt_tokens: integerColumn,
  completion_tokens: integerColumn,
  reasoning_tokens: integerColumn,
  cache_read_tokens: integerColumn,
  cache_write_tokens: integerColumn,
  unrecognized_tokens: integerColumn,
  total_tokens: integerColumn,
  token_breakdown: nullableTextColumn,
  error: nullableTextColumn,
  request_body: nullableTextColumn,
  request_headers: nullableTextColumn,
  response_body: nullableTextColumn,
  response_headers: nullableTextColumn,
  retry_trace: nullableTextColumn,
  aggregated: flagColumn,
});

const routeRowSchema = z.object({
  model_id: textColumn,
  provider_id: textColumn,
  public_name: textColumn,
  upstream_name: textColumn,
  provider_name: textColumn,
  provider_protocol: routerProtocolSchema,
  model_enabled: flagColumn,
  provider_enabled: flagColumn,
  model_archived: nullableIntegerColumn,
  provider_archived: nullableIntegerColumn,
});

const usageRowSchema = z.object({
  date: textColumn.optional(),
  hour_key: textColumn.optional(),
  provider_name: textColumn,
  public_model: textColumn,
  request_count: integerColumn,
  success_count: integerColumn,
  fail_count: integerColumn,
  duration_ms: integerColumn,
  ttft_ms: integerColumn,
  ttft_samples: integerColumn,
  generation_ms: integerColumn,
  prompt_tokens: integerColumn,
  completion_tokens: integerColumn,
  reasoning_tokens: integerColumn,
  cache_read_tokens: integerColumn,
  cache_write_tokens: integerColumn,
  unrecognized_tokens: integerColumn,
  total_tokens: integerColumn,
});

const quotaSnapshotRowSchema = z.object({
  provider_id: textColumn,
  snapshot: nullableTextColumn,
  error: nullableTextColumn,
  queried_at: integerColumn,
});

const countRowSchema = z.object({ n: integerColumn });
const settingRowSchema = z.object({ value: textColumn });
const pendingLogRowSchema = z.object({ request_id: textColumn, started_at: integerColumn });
const activityRowSchema = z.object({
  date: textColumn,
  request_count: nullableIntegerColumn,
  total_tokens: nullableIntegerColumn,
});
const flowRowSchema = z.object({
  client_key: textColumn,
  provider_name: textColumn,
  request_count: integerColumn,
});
const breakdownRowSchema = z.object({
  system: nullableIntegerColumn,
  tools: nullableIntegerColumn,
  user: nullableIntegerColumn,
  toolResults: nullableIntegerColumn,
  assistant: nullableIntegerColumn,
  reasoning: nullableIntegerColumn,
  reply: nullableIntegerColumn,
});
const tableInfoRowSchema = z.object({
  cid: integerColumn,
  name: textColumn,
  type: textColumn,
  notnull: integerColumn,
  dflt_value: z.unknown().nullable(),
  pk: integerColumn,
});

type ProviderDbRow = z.infer<typeof providerRowSchema>;
type ModelDbRow = z.infer<typeof modelRowSchema>;
type LogDbRow = z.infer<typeof logRowSchema>;

function parseRow<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseRows<T>(schema: z.ZodType<T>, values: unknown[]): T[] {
  const rows: T[] = [];
  for (const value of values) {
    const row = parseRow(schema, value);
    if (row) rows.push(row);
  }
  return rows;
}

function mapProvider(row: ProviderDbRow): RouterProviderRow {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    kind: row.kind,
    baseUrl: row.base_url,
    quotaStrategyId: row.quota_strategy_id,
    strategyConfig: parseConfig(row.strategy_config),
    enabled: row.enabled,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModel(row: ModelDbRow): RouterModelChannel {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerProtocol: row.provider_protocol,
    publicName: row.public_name,
    upstreamName: row.upstream_name,
    enabled: row.enabled,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

function parseQuotaSnapshot(value: string | null): RouterQuotaSnapshot | null {
  if (value === null) return null;
  try {
    const parsed = routerQuotaSnapshotSchema.safeParse(parseJson(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const EMPTY_TOTALS: RouterUsageTotals = {
  requestCount: 0,
  successCount: 0,
  failCount: 0,
  durationMs: 0,
  ttftMs: 0,
  ttftSamples: 0,
  generationMs: 0,
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
    const parsed = asRecord(parseJson(value));
    if (!parsed) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => stringValue(entry[1]) !== null)
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
  target.ttftMs += source.ttftMs;
  target.ttftSamples += source.ttftSamples;
  target.generationMs += source.generationMs;
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
    try {
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore.
    }
  }

  private migrate(): void {
    const versionRow = parseRow(z.object({ user_version: integerColumn }), this.db.prepare('PRAGMA user_version').get());
    if (!versionRow || versionRow.user_version < 0) {
      throw new Error('Invalid router database schema version.');
    }
    const version = versionRow.user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(`Unsupported router database schema version: ${version}`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.createSchema();
      this.addColumnIfMissing('request_logs', 'ttft_ms', 'INTEGER');
      this.addColumnIfMissing('request_logs', 'token_breakdown', 'TEXT');
      for (const table of ['usage_daily', 'usage_hourly'] as const) {
        this.addColumnIfMissing(table, 'ttft_ms', 'INTEGER NOT NULL DEFAULT 0');
        this.addColumnIfMissing(table, 'ttft_samples', 'INTEGER NOT NULL DEFAULT 0');
        this.addColumnIfMissing(table, 'generation_ms', 'INTEGER NOT NULL DEFAULT 0');
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the migration error.
      }
      throw error;
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = parseRows(tableInfoRowSchema, this.db.prepare(`PRAGMA table_info(${table})`).all());
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  private createSchema(): void {
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
        ttft_ms INTEGER,
        stream INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        unrecognized_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        token_breakdown TEXT,
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
        ttft_ms INTEGER NOT NULL DEFAULT 0,
        ttft_samples INTEGER NOT NULL DEFAULT 0,
        generation_ms INTEGER NOT NULL DEFAULT 0,
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
        ttft_ms INTEGER NOT NULL DEFAULT 0,
        ttft_samples INTEGER NOT NULL DEFAULT 0,
        generation_ms INTEGER NOT NULL DEFAULT 0,
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
    `);
  }

  getSetting(key: string): string | null {
    const row = parseRow(settingRowSchema, this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key));
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getServiceConfig(): RouterServiceConfig {
    const defaults: RouterServiceConfig = {
      enabled: false,
      port: DEFAULT_ROUTER_PORT,
      apiKey: '',
      proxyUrl: '',
      captureBodies: true,
    };
    const raw = this.getSetting('router.service');
    if (raw) {
      try {
        const value = asRecord(parseJson(raw));
        if (!value) return defaults;
        // Keep the legacy coercions: only literal false disables flags, numeric
        // strings are accepted for the port, and zero/NaN selects the default.
        const candidate: RouterServiceConfig = {
          enabled: value.enabled !== false,
          port: Number(value.port) || DEFAULT_ROUTER_PORT,
          apiKey: stringValue(value.apiKey) ?? '',
          proxyUrl: stringValue(value.proxyUrl) ?? '',
          captureBodies: value.captureBodies !== false,
        };
        const parsed = routerServiceConfigSchema.safeParse(candidate);
        return parsed.success ? parsed.data : defaults;
      } catch {
        // Fall through to defaults.
      }
    }
    return defaults;
  }

  setServiceConfig(config: RouterServiceConfig): void {
    this.setSetting('router.service', JSON.stringify(config));
  }

  getBalanceConfig(): RouterBalanceConfig {
    const raw = this.getSetting('router.balancing');
    if (raw) {
      try {
        const value = asRecord(parseJson(raw));
        if (!value) return { ...DEFAULT_ROUTER_BALANCE };
        const candidate: RouterBalanceConfig = {
          enabled: value.enabled !== false,
          sessionAffinity: value.sessionAffinity !== false,
          quotaGuard: value.quotaGuard !== false,
          maxAttempts: Math.min(5, Math.max(1, Number(value.maxAttempts) || 3)),
        };
        const parsed = routerBalanceConfigSchema.safeParse(candidate);
        return parsed.success ? parsed.data : { ...DEFAULT_ROUTER_BALANCE };
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
    const rows = parseRows(
      providerRowSchema,
      this.db
        .prepare(`SELECT * FROM providers ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY created_at`)
        .all(),
    );
    return rows.map(mapProvider);
  }

  getProvider(id: string): RouterProviderRow | null {
    const row = parseRow(providerRowSchema, this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id));
    return row ? mapProvider(row) : null;
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
    const saved = this.getProvider(id);
    if (!saved) throw new Error('Provider could not be read after saving.');
    return saved;
  }

  setProviderArchived(id: string, archived: boolean): void {
    const now = Date.now();
    const existing = this.getProvider(id);
    this.db.prepare('UPDATE providers SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? now : null, now, id);
    if (archived) {
      // Cascade so archived providers no longer expose their channels.
      this.db.prepare('UPDATE models SET archived_at = ? WHERE provider_id = ? AND archived_at IS NULL').run(now, id);
      return;
    }
    // Restore only channels that were archived together with the provider; keep
    // channels archived manually (or earlier) as they were.
    if (existing?.archivedAt) {
      this.db.prepare('UPDATE models SET archived_at = NULL WHERE provider_id = ? AND archived_at = ?').run(id, existing.archivedAt);
    }
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  listModelGroups(includeArchived = false): Array<{ publicName: string; channels: RouterModelChannel[] }> {
    const where = includeArchived ? '' : 'WHERE m.archived_at IS NULL AND p.archived_at IS NULL';
    const rows = parseRows(
      modelRowSchema,
      this.db
        .prepare(`
          SELECT m.*, p.name AS provider_name, p.protocol AS provider_protocol
          FROM models m JOIN providers p ON p.id = m.provider_id
          ${where}
          ORDER BY m.public_name, m.created_at
        `)
        .all(),
    );
    const groups = new Map<string, RouterModelChannel[]>();
    for (const row of rows) {
      const list = groups.get(row.public_name) ?? [];
      list.push(mapModel(row));
      groups.set(row.public_name, list);
    }
    return [...groups.entries()].map(([publicName, channels]) => ({ publicName, channels }));
  }

  getModel(id: string): RouterModelChannel | null {
    const row = parseRow(
      modelRowSchema,
      this.db
        .prepare(`
          SELECT m.*, p.name AS provider_name, p.protocol AS provider_protocol
          FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?
        `)
        .get(id),
    );
    return row ? mapModel(row) : null;
  }

  saveModel(input: RouterModelInput): RouterModelChannel {
    const now = Date.now();
    if (input.id) {
      this.db
        .prepare('UPDATE models SET provider_id = ?, public_name = ?, upstream_name = ?, enabled = ? WHERE id = ?')
        .run(input.providerId, input.publicName, input.upstreamName, input.enabled ? 1 : 0, input.id);
      const saved = this.getModel(input.id);
      if (!saved) throw new Error('Model could not be read after saving.');
      return saved;
    }
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO models (id, provider_id, public_name, upstream_name, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.providerId, input.publicName, input.upstreamName, input.enabled ? 1 : 0, now);
    const saved = this.getModel(id);
    if (!saved) throw new Error('Model could not be read after saving.');
    return saved;
  }

  setModelArchived(id: string, archived: boolean): void {
    this.db.prepare('UPDATE models SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, id);
  }

  renameModelGroup(from: string, to: string): void {
    const target = parseRow(
      countRowSchema,
      this.db.prepare('SELECT count(*) AS n FROM models WHERE public_name = ?').get(to),
    );
    if ((target?.n ?? 0) > 0) throw new Error('目标模型名已存在');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE models SET public_name = ? WHERE public_name = ?').run(to, from);
      this.db.prepare('UPDATE request_logs SET public_model = ? WHERE public_model = ?').run(to, from);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setModelGroupEnabled(publicName: string, enabled: boolean): void {
    this.db.prepare('UPDATE models SET enabled = ? WHERE public_name = ?').run(enabled ? 1 : 0, publicName);
  }

  deleteModel(id: string): void {
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  findRoutes(publicName: string): RouterRoute[] {
    const rows = parseRows(
      routeRowSchema,
      this.db
        .prepare(`
          SELECT m.id AS model_id, m.provider_id, m.public_name, m.upstream_name,
            p.name AS provider_name, p.protocol AS provider_protocol,
            m.enabled AS model_enabled, p.enabled AS provider_enabled,
            m.archived_at AS model_archived, p.archived_at AS provider_archived
          FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE m.public_name = ?
          ORDER BY m.created_at
        `)
        .all(publicName),
    );
    return rows
      .filter((row) => row.model_archived === null && row.provider_archived === null)
      .map((row) => ({
        modelId: row.model_id,
        providerId: row.provider_id,
        providerName: row.provider_name,
        providerProtocol: row.provider_protocol,
        publicName: row.public_name,
        upstreamModel: row.upstream_name,
        providerEnabled: row.provider_enabled,
        modelEnabled: row.model_enabled,
      }));
  }

  countModels(providerId: string): number {
    const row = parseRow(
      countRowSchema,
      this.db
        .prepare('SELECT count(*) AS n FROM models WHERE provider_id = ? AND archived_at IS NULL')
        .get(providerId),
    );
    return row?.n ?? 0;
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
    ttftMs?: number | null;
    breakdown?: {
      system: number;
      tools: number;
      user: number;
      toolResults: number;
      assistant: number;
    } | null;
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
    const row = parseRow(
      logRowSchema,
      this.db.prepare('SELECT * FROM request_logs WHERE request_id = ?').get(input.requestId),
    );
    if (!row) return;
    const finishedAt = Date.now();
    const durationMs = Math.max(0, finishedAt - row.started_at);
    const ttftMs = input.ttftMs != null ? Math.max(0, Math.round(input.ttftMs)) : null;
    // Token composition: output side exact from usage; input side estimated by the gateway.
    const tokenBreakdown = input.breakdown
      ? JSON.stringify({
          ...input.breakdown,
          reasoning: input.status >= 200 && input.status < 300 ? input.reasoningTokens : 0,
          reply: Math.max(0, (input.status >= 200 && input.status < 300 ? input.completionTokens : 0) - (input.status >= 200 && input.status < 300 ? input.reasoningTokens : 0)),
        })
      : null;
    this.db
      .prepare(`
        UPDATE request_logs SET finished_at = ?, status = ?, duration_ms = ?, ttft_ms = ?, stream = ?,
          prompt_tokens = ?, completion_tokens = ?, reasoning_tokens = ?, cache_read_tokens = ?,
          cache_write_tokens = ?, unrecognized_tokens = ?, total_tokens = ?, token_breakdown = ?,
          response_body = ?, response_headers = ?, error = ?, retry_trace = ?, aggregated = 1
        WHERE request_id = ?
      `)
      .run(
        finishedAt,
        input.status,
        durationMs,
        ttftMs,
        input.stream ? 1 : 0,
        input.promptTokens,
        input.completionTokens,
        input.reasoningTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.unrecognizedTokens,
        input.totalTokens,
        tokenBreakdown,
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
      ttftMs: ttftMs ?? 0,
      ttftSamples: ttftMs != null ? 1 : 0,
      generationMs: success && ttftMs != null ? Math.max(0, durationMs - ttftMs) : 0,
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
            request_count, success_count, fail_count, duration_ms, ttft_ms, ttft_samples, generation_ms,
            prompt_tokens, completion_tokens, reasoning_tokens, cache_read_tokens,
            cache_write_tokens, unrecognized_tokens, total_tokens
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(${keyColumn}, provider_name, public_model) DO UPDATE SET
            request_count = request_count + excluded.request_count,
            success_count = success_count + excluded.success_count,
            fail_count = fail_count + excluded.fail_count,
            duration_ms = duration_ms + excluded.duration_ms,
            ttft_ms = ttft_ms + excluded.ttft_ms,
            ttft_samples = ttft_samples + excluded.ttft_samples,
            generation_ms = generation_ms + excluded.generation_ms,
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
          totals.ttftMs,
          totals.ttftSamples,
          totals.generationMs,
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
    const rows = parseRows(
      pendingLogRowSchema,
      this.db.prepare('SELECT request_id, started_at FROM request_logs WHERE finished_at IS NULL').all(),
    );
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
    const row = parseRow(logRowSchema, this.db.prepare('SELECT * FROM request_logs WHERE id = ?').get(id));
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
    const count = parseRow(
      countRowSchema,
      this.db.prepare(`SELECT count(*) AS n FROM request_logs ${where}`).get(...params),
    );
    const rows = parseRows(
      logRowSchema,
      this.db
        .prepare(`SELECT * FROM request_logs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset),
    );
    return { items: rows.map((row) => this.mapLog(row)), total: count?.n ?? 0 };
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
      ttftMs: row.ttft_ms,
      stream: row.stream,
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
    const rows = parseRows(
      usageRowSchema,
      this.db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn} >= ? ORDER BY ${keyColumn}`).all(startKey),
    );

    const totals = emptyTotals();
    const providers = new Map<string, RouterUsageTotals>();
    const models = new Map<string, RouterUsageTotals>();
    const buckets = new Map<string, RouterUsageTotals>();
    for (const row of rows) {
      const bucketKey = nonEmptyString(row[keyColumn]);
      if (!bucketKey) continue;
      const totalsRow: RouterUsageTotals = {
        requestCount: row.request_count,
        successCount: row.success_count,
        failCount: row.fail_count,
        durationMs: row.duration_ms,
        ttftMs: row.ttft_ms,
        ttftSamples: row.ttft_samples,
        generationMs: row.generation_ms,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        reasoningTokens: row.reasoning_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        unrecognizedTokens: row.unrecognized_tokens,
        totalTokens: row.total_tokens,
      };
      addTotals(totals, totalsRow);
      const providerKey = row.provider_name;
      const modelKey = row.public_model;
      const providerTotals = providers.get(providerKey) ?? emptyTotals();
      addTotals(providerTotals, totalsRow);
      providers.set(providerKey, providerTotals);
      const modelTotals = models.get(modelKey) ?? emptyTotals();
      addTotals(modelTotals, totalsRow);
      models.set(modelKey, modelTotals);
      const bucket = buckets.get(bucketKey) ?? emptyTotals();
      addTotals(bucket, totalsRow);
      buckets.set(bucketKey, bucket);
    }

    const series = this.buildSeries(range, buckets, now);

    const rawBreakdownRow = this.db
      .prepare(
        `SELECT
          SUM(CAST(json_extract(token_breakdown,'$.system') AS INTEGER)) AS system,
          SUM(CAST(json_extract(token_breakdown,'$.tools') AS INTEGER)) AS tools,
          SUM(CAST(json_extract(token_breakdown,'$.user') AS INTEGER)) AS user,
          SUM(CAST(json_extract(token_breakdown,'$.toolResults') AS INTEGER)) AS toolResults,
          SUM(CAST(json_extract(token_breakdown,'$.assistant') AS INTEGER)) AS assistant,
          SUM(CAST(json_extract(token_breakdown,'$.reasoning') AS INTEGER)) AS reasoning,
          SUM(CAST(json_extract(token_breakdown,'$.reply') AS INTEGER)) AS reply
        FROM request_logs
        WHERE started_at >= ? AND token_breakdown IS NOT NULL
          AND json_valid(token_breakdown) AND json_type(token_breakdown) = 'object'`,
      )
      .get(startTs);
    const breakdownRow = parseRow(breakdownRowSchema, rawBreakdownRow);
    const breakdown: RouterUsageBreakdown = {
      system: finiteNumber(breakdownRow?.system) ?? 0,
      tools: finiteNumber(breakdownRow?.tools) ?? 0,
      user: finiteNumber(breakdownRow?.user) ?? 0,
      toolResults: finiteNumber(breakdownRow?.toolResults) ?? 0,
      assistant: finiteNumber(breakdownRow?.assistant) ?? 0,
      reasoning: finiteNumber(breakdownRow?.reasoning) ?? 0,
      reply: finiteNumber(breakdownRow?.reply) ?? 0,
    };

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
      breakdown: breakdown.system + breakdown.tools + breakdown.user + breakdown.toolResults + breakdown.assistant + breakdown.reasoning + breakdown.reply > 0
        ? breakdown
        : null,
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

  getUsageActivity(days: number): RouterActivityDay[] {
    const span = Math.min(90, Math.max(1, Math.floor(Number(days)) || 1));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (span - 1));
    const startKey = localDayKey(start.getTime());
    const rows = parseRows(
      activityRowSchema,
      this.db
        .prepare(`
          SELECT date, SUM(request_count) AS request_count, SUM(total_tokens) AS total_tokens
          FROM usage_daily WHERE date >= ? GROUP BY date
        `)
        .all(startKey),
    );
    const buckets = new Map<string, { requestCount: number; totalTokens: number }>();
    for (const row of rows) {
      buckets.set(row.date, {
        requestCount: row.request_count ?? 0,
        totalTokens: row.total_tokens ?? 0,
      });
    }
    const result: RouterActivityDay[] = [];
    const cursor = new Date(start);
    for (let index = 0; index < span; index += 1) {
      const key = localDayKey(cursor.getTime());
      const bucket = buckets.get(key);
      result.push({ date: key, requestCount: bucket?.requestCount ?? 0, totalTokens: bucket?.totalTokens ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }

  getClientProviderFlow(days: number): RouterClientProviderFlow[] {
    // Request logs are retained for 7 days, so the flow window is capped there.
    const span = Math.min(7, Math.max(1, Math.floor(Number(days)) || 1));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (span - 1));
    const cutoff = localDayKey(start.getTime());
    const rows = parseRows(
      flowRowSchema,
      this.db
        .prepare(`
          SELECT COALESCE(NULLIF(client, ''), 'unknown') AS client_key, provider_name, count(*) AS request_count
          FROM request_logs WHERE log_date >= ?
          GROUP BY 1, 2
          ORDER BY request_count DESC, 1, 2
        `)
        .all(cutoff),
    );
    return rows
      .map((row) => ({
        client: row.client_key,
        providerName: row.provider_name,
        requestCount: row.request_count,
      }))
      .filter((row) => row.requestCount > 0);
  }

  saveQuotaSnapshot(input: {
    providerId: string;
    snapshot: RouterQuotaSnapshot | null;
    error: string | null;
    queriedAt: number;
  }): void {
    let snapshot: string | null = null;
    if (input.snapshot !== null) {
      const parsed = routerQuotaSnapshotSchema.safeParse(input.snapshot);
      if (!parsed.success) throw new Error('Invalid router quota snapshot.');
      snapshot = JSON.stringify(parsed.data);
    }
    this.db
      .prepare(`
        INSERT INTO quota_snapshots (provider_id, snapshot, error, queried_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET snapshot = excluded.snapshot, error = excluded.error, queried_at = excluded.queried_at
      `)
      .run(input.providerId, snapshot, input.error, input.queriedAt);
  }

  listQuotaSnapshots(): Array<{ providerId: string; snapshot: RouterQuotaSnapshot | null; error: string | null; queriedAt: number }> {
    const rows = parseRows(quotaSnapshotRowSchema, this.db.prepare('SELECT * FROM quota_snapshots').all());
    return rows.map((row) => ({
      providerId: row.provider_id,
      snapshot: parseQuotaSnapshot(row.snapshot),
      error: row.error,
      queriedAt: row.queried_at,
    }));
  }

  getQuotaSnapshot(providerId: string): { snapshot: RouterQuotaSnapshot | null; queriedAt: number } | null {
    const row = parseRow(
      quotaSnapshotRowSchema,
      this.db.prepare('SELECT * FROM quota_snapshots WHERE provider_id = ?').get(providerId),
    );
    if (!row) return null;
    return { snapshot: parseQuotaSnapshot(row.snapshot), queriedAt: row.queried_at };
  }
}

export type { RouterProvider };
