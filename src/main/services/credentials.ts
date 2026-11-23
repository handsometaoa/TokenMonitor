import { existsSync, readFileSync } from 'node:fs';
import { authFilePath } from '../paths';
import type { Logger } from './logger';
import type { SecretStore } from './secrets';
import type { SettingsStore } from './settings';
import type {
  CredentialDetection,
  CredentialKind,
  CredentialStatus,
} from '../../shared/types';

export interface ResolvedCredential {
  key: string;
  kind: Exclude<CredentialKind, 'none'>;
}

interface AuthFileEntry {
  type?: unknown;
  key?: unknown;
  access?: unknown;
}

const ENV_NAMES = ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'] as const;

export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '••••';
  return `•••• ${trimmed.slice(-4)}`;
}

function extractOpenCodeEntry(raw: unknown): { provider: string; key: string; kind: CredentialKind } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, AuthFileEntry>;
  const keys = Object.keys(record);
  const ordered = [
    ...keys.filter((key) => /^opencode-go$/i.test(key)),
    ...keys.filter((key) => /^opencode$/i.test(key)),
    ...keys.filter((key) => /opencode/i.test(key) && !/^opencode(?:-go)?$/i.test(key)),
  ];

  for (const provider of ordered) {
    const entry = record[provider];
    if (!entry || typeof entry !== 'object') continue;
    const apiKey = typeof entry.key === 'string' ? entry.key.trim() : '';
    if (apiKey) return { provider, key: apiKey, kind: 'auth-file' };
    const access = typeof entry.access === 'string' ? entry.access.trim() : '';
    if (access) return { provider, key: access, kind: 'auth-file' };
  }
  return null;
}

function readAuthFile(): { available: boolean; entry: ReturnType<typeof extractOpenCodeEntry> } {
  const path = authFilePath();
  if (!existsSync(path)) return { available: false, entry: null };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return { available: true, entry: extractOpenCodeEntry(raw) };
  } catch {
    return { available: true, entry: null };
  }
}

function readEnvKey(): { key: string; name: string } | null {
  for (const name of ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, name };
  }
  return null;
}

export class CredentialResolver {
  constructor(
    private readonly settings: SettingsStore,
    private readonly secrets: SecretStore,
    private readonly logger: Logger,
  ) {}

  resolve(): ResolvedCredential | null {
    const current = this.settings.get();
    if (current.credentialSource === 'manual') {
      const key = this.secrets.getKey()?.trim();
      return key ? { key, kind: 'manual' } : null;
    }

    const env = readEnvKey();
    if (env) return { key: env.key, kind: 'env' };

    const auth = readAuthFile();
    if (auth.entry) return { key: auth.entry.key, kind: 'auth-file' };
    return null;
  }

  status(): CredentialStatus {
    const current = this.settings.get();
    const env = readEnvKey();
    const auth = readAuthFile();
    const resolved = this.resolve();

    return {
      configured: Boolean(resolved),
      kind: resolved?.kind ?? 'none',
      masked: resolved ? maskSecret(resolved.key) : null,
      persisted: current.credentialSource === 'manual' ? this.secrets.isPersisted() : false,
      envAvailable: Boolean(env),
      authFileAvailable: auth.available,
      authFileHasOpenCode: Boolean(auth.entry),
    };
  }

  detect(): CredentialDetection {
    const auth = readAuthFile();
    if (!auth.available) {
      return {
        found: false,
        masked: null,
        provider: null,
        message: `未找到 OpenCode 凭证文件：${authFilePath()}`,
      };
    }
    if (!auth.entry) {
      return {
        found: false,
        masked: null,
        provider: null,
        message: '凭证文件中没有可用的 OpenCode Key。',
      };
    }
    return {
      found: true,
      masked: maskSecret(auth.entry.key),
      provider: auth.entry.provider,
      message: `检测到 OpenCode 凭证（${auth.entry.provider}）。`,
    };
  }

  saveManual(key: string, orgId: string): { persisted: boolean } {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('API Key 不能为空');
    const result = this.secrets.saveKey(trimmed);
    this.settings.update({ credentialSource: 'manual', orgId, onboardingCompleted: true });
    this.logger.info(`Saved manual OpenCode credential (${result.persisted ? 'encrypted' : 'session-only'}).`);
    return result;
  }

  useAuto(orgId: string): void {
    this.settings.update({ credentialSource: 'auto', orgId, onboardingCompleted: true });
  }

  clear(): void {
    this.secrets.clear();
    this.settings.update({ credentialSource: 'auto', orgId: '' });
  }
}
