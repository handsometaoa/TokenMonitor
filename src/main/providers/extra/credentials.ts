import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExtraProviderId } from '../../../shared/types';
import { asRecord, nonEmptyString, parseJson } from '../../../shared/validation';
import type { ProviderSecretStore } from '../../services/providerSecrets';
import type { ExtraProviderCredential } from './types';

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return asRecord(parseJson(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

function codexCredential(): ExtraProviderCredential | null {
  const paths = [
    join(codexHome(), 'auth.json'),
    join(homedir(), '.config', 'codex', 'auth.json'),
    join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
  ];
  for (const path of paths) {
    const json = readJson(path);
    if (!json) continue;
    const tokens = asRecord(json.tokens);
    const access = nonEmptyString(tokens?.access_token) ?? nonEmptyString(tokens?.accessToken);
    if (access) {
      return {
        providerId: 'codex',
        value: access,
        source: 'auth-file',
        accountId: nonEmptyString(tokens?.account_id) ?? nonEmptyString(tokens?.accountId) ?? undefined,
      };
    }
    const openAiKey = nonEmptyString(json.OPENAI_API_KEY);
    if (openAiKey) {
      return { providerId: 'codex', value: openAiKey, source: 'auth-file' };
    }
    const openCodeOpenAI = asRecord(json.openai);
    if (openCodeOpenAI && nonEmptyString(openCodeOpenAI.type)?.toLowerCase() === 'oauth') {
      const accessToken = nonEmptyString(openCodeOpenAI.access);
      if (accessToken) {
        return {
          providerId: 'codex',
          value: accessToken,
          source: 'auth-file',
          accountId: nonEmptyString(openCodeOpenAI.accountId) ?? undefined,
        };
      }
    }
  }
  return null;
}

function claudeCredential(): ExtraProviderCredential | null {
  const envToken =
    process.env.CLAUDE_OAUTH_TOKEN?.trim() ||
    process.env.CODEXBAR_CLAUDE_OAUTH_TOKEN?.trim() ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return { providerId: 'claude', value: envToken, source: 'env' };
  }

  const configRoot = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const paths = [
    join(configRoot, '.credentials.json'),
    join(process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() || configRoot, '.credentials.json'),
    join(homedir(), '.claude', '.credentials.json'),
  ];
  for (const path of paths) {
    const json = readJson(path);
    if (!json) continue;
    const oauth = asRecord(json.claudeAiOauth);
    const accessToken = nonEmptyString(oauth?.accessToken) ?? nonEmptyString(oauth?.access_token);
    if (accessToken) {
      return {
        providerId: 'claude',
        value: accessToken,
        source: 'auth-file',
        planLabel: nonEmptyString(oauth?.subscriptionType) ?? nonEmptyString(oauth?.rateLimitTier) ?? undefined,
      };
    }
  }
  return null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const encoded = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    return asRecord(parseJson(Buffer.from(padded, 'base64').toString('utf8')));
  } catch {
    return null;
  }
}

function cursorCookieFromToken(token: string): string | null {
  const payload = jwtPayload(token);
  const subject = nonEmptyString(payload?.sub);
  const userID = subject?.split('|').filter(Boolean).pop();
  if (!userID) return null;
  return `WorkosCursorSessionToken=${encodeURIComponent(`${userID}::${token}`)}`;
}

function cursorLocalToken(): string | null {
  const candidates = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'state.vscdb') : '',
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'Cursor', 'User', 'globalStorage', 'state.vscdb') : '',
    join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  ].filter(Boolean);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
      const row: unknown = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1").get();
      const value = asRecord(row)?.value;
      if (typeof value === 'string' && value.trim() && !value.startsWith('cursor-safe-storage:')) {
        return value.trim();
      }
      if (Buffer.isBuffer(value)) {
        const decoded = value.toString('utf8').trim();
        if (decoded && !decoded.startsWith('cursor-safe-storage:')) return decoded;
      }
    } catch {
      // Try next candidate.
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore.
      }
    }
  }
  return null;
}

function cursorCredential(): ExtraProviderCredential | null {
  const env = process.env.CURSOR_COOKIE?.trim() || process.env.CURSOR_SESSION_TOKEN?.trim();
  if (env) {
    return { providerId: 'cursor', value: env.includes('=') ? env : cursorCookieFromToken(env) ?? env, source: 'env' };
  }
  const token = cursorLocalToken();
  if (!token) return null;
  const cookie = token.includes('=') ? token : cursorCookieFromToken(token);
  return cookie ? { providerId: 'cursor', value: cookie, source: 'auth-file' } : null;
}

const ZAI_ENV_KEYS = [
  'Z_AI_API_KEY',
  'BIGMODEL_API_KEY',
  'ZHIPU_API_KEY',
  'ZHIPUAI_API_KEY',
  'GLM_API_KEY',
] as const;

function zcodeConfig(): Record<string, unknown> | null {
  return readJson(join(homedir(), '.zcode', 'v2', 'config.json'));
}

function enabledZcodeProviders(config: Record<string, unknown> | null): Array<{ id: string; provider: Record<string, unknown> }> {
  const providers = asRecord(config?.provider);
  if (!providers) return [];
  const result: Array<{ id: string; provider: Record<string, unknown> }> = [];
  for (const [id, raw] of Object.entries(providers)) {
    const provider = asRecord(raw);
    if (!provider) continue;
    const options = asRecord(provider.options);
    const apiKey = nonEmptyString(options?.apiKey);
    if (apiKey && provider.enabled !== false) result.push({ id, provider });
  }
  return result;
}

function zaiCredential(): ExtraProviderCredential | null {
  for (const keyName of ZAI_ENV_KEYS) {
    const value = process.env[keyName]?.trim();
    if (!value) continue;
    const region =
      process.env.Z_AI_REGION === 'bigmodel-cn' || keyName !== 'Z_AI_API_KEY' ? 'bigmodel-cn' : 'global';
    return { providerId: 'zai', value, source: 'env', region };
  }

  const candidates = enabledZcodeProviders(zcodeConfig());
  for (const { id, provider } of candidates) {
    if (!id.includes('builtin:zai')) continue;
    const options = asRecord(provider.options);
    const apiKey = nonEmptyString(options?.apiKey);
    if (!apiKey) continue;
    return {
      providerId: 'zai',
      value: apiKey,
      source: 'zcode',
      region: 'global',
      planLabel: nonEmptyString(provider.name) ?? undefined,
      organizationId: process.env.BIGMODEL_ORGANIZATION?.trim() || undefined,
      projectId: process.env.BIGMODEL_PROJECT?.trim() || undefined,
    };
  }
  return null;
}

function zcodeCredential(): ExtraProviderCredential | null {
  const config = zcodeConfig();
  const candidates = enabledZcodeProviders(config);
  const preferred = [
    ...candidates.filter(({ id }) => id === 'builtin:bigmodel-coding-plan'),
    ...candidates.filter(({ id }) => id === 'builtin:zai-coding-plan'),
    ...candidates.filter(({ id }) => id.includes('coding-plan')),
  ];
  const chosen = preferred[0];
  if (!chosen) return null;
  const options = asRecord(chosen.provider.options);
  const apiKey = nonEmptyString(options?.apiKey);
  if (!apiKey) return null;
  const baseURL = nonEmptyString(options?.baseURL) ?? '';
  const region = baseURL.includes('open.bigmodel.cn') || chosen.id.includes('bigmodel') ? 'bigmodel-cn' : 'global';
  const cache = readJson(join(homedir(), '.zcode', 'v2', 'coding-plan-cache.json'));
  const cacheEntry = asRecord(asRecord(cache?.entryStatus)?.items);
  const chosenEntry = asRecord(cacheEntry?.[chosen.id]);
  const status = nonEmptyString(chosenEntry?.status);
  const planLabel =
    status === 'available'
      ? chosen.id.includes('bigmodel')
        ? 'BigModel Coding Plan'
        : 'ZCode Coding Plan'
      : nonEmptyString(chosen.provider.name) ?? undefined;
  return {
    providerId: 'zcode',
    value: apiKey,
    source: 'zcode',
    region,
    planLabel,
    organizationId: process.env.BIGMODEL_ORGANIZATION?.trim() || undefined,
    projectId: process.env.BIGMODEL_PROJECT?.trim() || undefined,
  };
}

function manualCredential(providerId: ExtraProviderId, secret: string): ExtraProviderCredential {
  if (providerId === 'cursor') {
    return {
      providerId,
      value: secret.includes('=') ? secret : cursorCookieFromToken(secret) ?? secret,
      source: 'manual',
    };
  }
  if (providerId === 'zai' || providerId === 'zcode') {
    // Team plans may need the BigModel Organization/Project selectors. Accept either a
    // bare API key or a JSON object: { "apiKey": "...", "organizationId": "...", "projectId": "..." }
    try {
      const parsed = asRecord(parseJson(secret));
      if (parsed) {
        const apiKey = nonEmptyString(parsed.apiKey) ?? nonEmptyString(parsed.key);
        if (apiKey) {
          const region = nonEmptyString(parsed.region);
          return {
            providerId,
            value: apiKey,
            source: 'manual',
            region:
              region === 'bigmodel-cn' || region === 'global'
                ? region
                : process.env.Z_AI_REGION === 'bigmodel-cn'
                  ? 'bigmodel-cn'
                  : 'global',
            organizationId: nonEmptyString(parsed.organizationId) ?? undefined,
            projectId: nonEmptyString(parsed.projectId) ?? undefined,
          };
        }
      }
    } catch {
      // Bare key below.
    }
    return {
      providerId,
      value: secret,
      source: 'manual',
      region: process.env.Z_AI_REGION === 'bigmodel-cn' ? 'bigmodel-cn' : 'global',
      organizationId: process.env.BIGMODEL_ORGANIZATION?.trim() || undefined,
      projectId: process.env.BIGMODEL_PROJECT?.trim() || undefined,
    };
  }
  return { providerId, value: secret, source: 'manual' };
}

export function resolveExtraCredential(
  providerId: ExtraProviderId,
  secrets: ProviderSecretStore,
): ExtraProviderCredential | null {
  const manual = secrets.get(providerId);
  if (manual) return manualCredential(providerId, manual);

  switch (providerId) {
    case 'codex':
      return codexCredential();
    case 'claude':
      return claudeCredential();
    case 'cursor':
      return cursorCredential();
    case 'zai':
      return zaiCredential();
    case 'zcode':
      return zcodeCredential();
    default:
      return null;
  }
}

export function resolveExtraCredentialStatus(
  providerId: ExtraProviderId,
  secrets: ProviderSecretStore,
): { configured: boolean; source: 'manual' | 'auto' | 'env' | 'auth-file' | 'zcode' | 'none' } {
  const credential = resolveExtraCredential(providerId, secrets);
  if (!credential) return { configured: false, source: 'none' };
  return {
    configured: true,
    source: credential.source === 'manual' ? 'manual' : credential.source,
  };
}
