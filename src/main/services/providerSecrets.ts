import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { isRecord, nonEmptyString, parseJson } from '../../shared/validation';
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
    if (!Object.hasOwn(this.secrets, providerId)) return null;
    const value: unknown = this.secrets[providerId];
    return nonEmptyString(value);
  }

  has(providerId: string): boolean {
    return Boolean(this.get(providerId));
  }

  save(providerId: string, secret: string): { persisted: boolean } {
    const trimmed = secret.trim();
    if (!trimmed) throw new Error('Secret is empty');
    this.secrets = { ...this.secrets, [providerId]: trimmed };
    this.persistIfPossible();
    return { persisted: this.persisted };
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
    this.removeFile();
  }

  isPersisted(): boolean {
    return this.persisted;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    if (!this.isEncryptionAvailable()) {
      this.logger.warn('Provider secrets file exists but safeStorage is unavailable.');
      return;
    }
    try {
      const base64 = readFileSync(this.filePath, 'utf8').trim();
      const decrypted = safeStorage.decryptString(Buffer.from(base64, 'base64'));
      const parsed: unknown = parseJson(decrypted);
      if (isRecord(parsed)) {
        const entries: Array<[string, string]> = [];
        for (const [key, value] of Object.entries(parsed)) {
          const secret = nonEmptyString(value);
          if (secret) entries.push([key, secret]);
        }
        this.secrets = Object.fromEntries(entries);
        this.persisted = true;
      }
    } catch (error) {
      this.logger.error('Could not decrypt provider secrets.', error);
      this.secrets = {};
      this.persisted = false;
    }
  }

  private isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private persistIfPossible(): void {
    if (!this.isEncryptionAvailable()) {
      this.persisted = false;
      this.removeFile();
      return;
    }
    if (Object.keys(this.secrets).length === 0) {
      this.removeFile();
      this.persisted = false;
      return;
    }
    const temp = `${this.filePath}.tmp`;
    try {
      const payload = safeStorage.encryptString(JSON.stringify(this.secrets)).toString('base64');
      writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.filePath);
      this.persisted = true;
    } catch (error) {
      this.persisted = false;
      this.removeFile();
      this.logger.error('Could not save provider secrets.', error);
    }
  }

  private removeFile(): void {
    for (const path of [this.filePath, `${this.filePath}.tmp`]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Ignore.
      }
    }
  }
}
