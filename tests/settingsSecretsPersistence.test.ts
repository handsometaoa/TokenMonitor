import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialResolver } from '../src/main/services/credentials';
import { Logger } from '../src/main/services/logger';
import { ProviderSecretStore } from '../src/main/services/providerSecrets';
import { SecretStore } from '../src/main/services/secrets';
import { SettingsStore } from '../src/main/services/settings';
import { createDefaultSettings } from '../src/shared/defaults';

const storage = vi.hoisted(() => ({
  available: true,
  availabilityThrows: false,
  encrypt: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, 'utf8')),
  decrypt: vi.fn((value: Buffer) => {
    const text = value.toString('utf8');
    if (!text.startsWith('encrypted:')) throw new Error('Invalid ciphertext');
    return text.slice('encrypted:'.length);
  }),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => {
      if (storage.availabilityThrows) throw new Error('safeStorage unavailable');
      return storage.available;
    }),
    encryptString: storage.encrypt,
    decryptString: storage.decrypt,
  },
}));

const dirs: string[] = [];

beforeEach(() => {
  storage.available = true;
  storage.availabilityThrows = false;
  storage.encrypt.mockReset();
  storage.encrypt.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`, 'utf8'));
  storage.decrypt.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore Windows cleanup errors.
    }
  }
});

function setup(): { dir: string; logger: Logger } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-settings-secrets-'));
  dirs.push(dir);
  const logger = new Logger(dir);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return { dir, logger };
}

describe('settings persistence hardening', () => {
  it('uses object guards for nested settings while retaining corrupt-file backups', () => {
    const { dir } = setup();
    const initial = new SettingsStore(dir);
    initial.update({});
    const beforeInvalidNestedPatch = initial.get();
    Reflect.apply(initial.update, initial, [
      { notifications: null, homeCards: [], quotaVisibility: 'invalid' },
    ]);
    expect(initial.get()).toEqual(beforeInvalidNestedPatch);
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ ...initial.get(), homeCards: [], quotaVisibility: 'invalid' }),
    );

    const loaded = new SettingsStore(dir);
    const defaults = createDefaultSettings();
    expect(loaded.get().homeCards).toEqual(defaults.homeCards);
    expect(loaded.get().quotaVisibility).toEqual(defaults.quotaVisibility);
    expect(readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-'))).toBe(false);

    writeFileSync(join(dir, 'settings.json'), '{broken');
    const corrupt = new SettingsStore(dir);
    expect(corrupt.get()).toEqual(defaults);
    expect(readdirSync(dir).some((name) => name.startsWith('settings.json.corrupt-'))).toBe(true);
  });
});

describe('secret persistence hardening', () => {
  it('validates the secret envelope before attempting decryption', () => {
    const { dir, logger } = setup();
    const store = new SecretStore(dir, logger);
    expect(store.saveKey('sk-test')).toEqual({ persisted: true });

    writeFileSync(join(dir, 'secret.bin'), JSON.stringify({ version: 2, data: 'ciphertext' }));
    storage.decrypt.mockClear();
    const invalid = new SecretStore(dir, logger);
    expect(invalid.getKey()).toBeNull();
    expect(invalid.isPersisted()).toBe(false);
    expect(storage.decrypt).not.toHaveBeenCalled();
  });

  it('fails safely when safeStorage or credential encryption fails', () => {
    const { dir, logger } = setup();
    const store = new SecretStore(dir, logger);
    store.saveKey('sk-old');

    storage.available = false;
    expect(store.saveKey('sk-new')).toEqual({ persisted: false });
    expect(store.getKey()).toBe('sk-new');
    expect(store.isPersisted()).toBe(false);
    expect(existsSync(join(dir, 'secret.bin'))).toBe(false);

    storage.available = true;
    store.saveKey('sk-old');
    storage.encrypt.mockImplementation(() => {
      throw new Error('encryption failed');
    });
    expect(store.saveKey('sk-new')).toEqual({ persisted: false });
    expect(store.isPersisted()).toBe(false);
    expect(existsSync(join(dir, 'secret.bin'))).toBe(false);
  });

  it('uses own-property provider lookups and round-trips trimmed secrets', () => {
    const { dir, logger } = setup();
    const store = new ProviderSecretStore(dir, logger);
    expect(store.get('toString')).toBeNull();
    expect(store.get('__proto__')).toBeNull();
    expect(store.save('router:provider-1', '  sk-provider  ')).toEqual({ persisted: true });
    expect(store.get('router:provider-1')).toBe('sk-provider');

    const reloaded = new ProviderSecretStore(dir, logger);
    expect(reloaded.get('router:provider-1')).toBe('sk-provider');
    expect(reloaded.isPersisted()).toBe(true);
  });

  it('keeps provider persisted state failure-safe and removes stale files', () => {
    const { dir, logger } = setup();
    const store = new ProviderSecretStore(dir, logger);
    store.save('router:provider-1', 'sk-old');

    storage.availabilityThrows = true;
    expect(store.save('router:provider-1', 'sk-new')).toEqual({ persisted: false });
    expect(store.isPersisted()).toBe(false);
    expect(existsSync(join(dir, 'provider-secrets.bin'))).toBe(false);

    storage.availabilityThrows = false;
    store.save('router:provider-1', 'sk-old');
    storage.encrypt.mockImplementation(() => {
      throw new Error('encryption failed');
    });
    expect(store.save('router:provider-1', 'sk-new')).toEqual({ persisted: false });
    expect(store.isPersisted()).toBe(false);
    expect(existsSync(join(dir, 'provider-secrets.bin'))).toBe(false);

    storage.encrypt.mockImplementation((value: string) => Buffer.from(`encrypted:${value}`, 'utf8'));
    store.save('router:provider-1', 'sk-old');
    storage.available = false;
    store.clear('router:provider-1');
    expect(existsSync(join(dir, 'provider-secrets.bin'))).toBe(false);
    expect(store.isPersisted()).toBe(false);
  });
});

describe('credential auth-file guards', () => {
  it('ignores malformed entries and preserves valid OpenCode key detection', () => {
    const { dir, logger } = setup();
    const dataDir = join(dir, 'xdg-data');
    mkdirSync(join(dataDir, 'opencode'), { recursive: true });
    vi.stubEnv('XDG_DATA_HOME', dataDir);
    writeFileSync(
      join(dataDir, 'opencode', 'auth.json'),
      JSON.stringify({ broken: [], 'opencode-go': { key: '  sk-auth-test  ' } }),
    );
    const settings = new SettingsStore(dir);
    const secrets = new SecretStore(dir, logger);
    const credentials = new CredentialResolver(settings, secrets, logger);

    expect(credentials.detect()).toMatchObject({
      found: true,
      provider: 'opencode-go',
      masked: '•••• test',
    });
    expect(credentials.resolve()).toEqual({ key: 'sk-auth-test', kind: 'auth-file' });
  });
});
