import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { Logger } from './logger';

type SecretMap = Record<string, string>;

export class ProviderSecretStore {
  private readonly filePath: string;
  private secrets: SecretMap = {};
  private persisted = false;

  constructor(
    baseDir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(baseDir, { recursive: true });
    this.filePath = join(baseDir, 'provider-secrets.bin');
    this.load();
  }

  get(providerId: string): string | null {
    return this.secrets[providerId]?.trim() || null;
  }

  has(providerId: string): boolean {
    return Boolean(this.get(providerId));
  }

  save(providerId: string, secret: string): { persisted: boolean } {
    const trimmed = secret.trim();
    if (!trimmed) throw new Error('Secret is empty');
    this.secrets = { ...this.secrets, [providerId]: trimmed };
    if (!safeStorage.isEncryptionAvailable()) {
      this.persisted = false;
      return { persisted: false };
    }

    const payload = safeStorage.encryptString(JSON.stringify(this.secrets)).toString('base64');
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.filePath);
    this.persisted = true;
    return { persisted: true };
  }

  clear(providerId: string): void {
    const next = { ...this.secrets };
    delete next[providerId];
    this.secrets = next;
    this.persistIfPossible();
  }

  clearAll(): void {
    this.secrets = {};
    this.persisted = false;
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
    } catch {
      // Ignore.
    }
  }

  isPersisted(): boolean {
    return this.persisted;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    if (!safeStorage.isEncryptionAvailable()) {
      this.logger.warn('Provider secrets file exists but safeStorage is unavailable.');
      return;
    }
    try {
      const base64 = readFileSync(this.filePath, 'utf8').trim();
      const decrypted = safeStorage.decryptString(Buffer.from(base64, 'base64'));
      const parsed = JSON.parse(decrypted) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.secrets = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([key, value]) => [key, value.trim()])
            .filter(([, value]) => Boolean(value)),
        );
        this.persisted = true;
      }
    } catch (error) {
      this.logger.error('Could not decrypt provider secrets.', error);
      this.secrets = {};
    }
  }

  private persistIfPossible(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      this.persisted = false;
      return;
    }
    if (Object.keys(this.secrets).length === 0) {
      try {
        if (existsSync(this.filePath)) unlinkSync(this.filePath);
      } catch {
        // Ignore.
      }
      this.persisted = false;
      return;
    }
    try {
      const payload = safeStorage.encryptString(JSON.stringify(this.secrets)).toString('base64');
      const temp = `${this.filePath}.tmp`;
      writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.filePath);
      this.persisted = true;
    } catch (error) {
      this.logger.error('Could not save provider secrets.', error);
    }
  }
}
