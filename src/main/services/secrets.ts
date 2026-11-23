import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { Logger } from './logger';

interface SecretFile {
  version: 1;
  data: string;
}

export class SecretStore {
  private readonly filePath: string;
  private memoryKey: string | null = null;
  private persisted = false;

  constructor(
    private readonly baseDir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(baseDir, { recursive: true });
    this.filePath = join(baseDir, 'secret.bin');
    this.load();
  }

  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  hasKey(): boolean {
    return Boolean(this.memoryKey);
  }

  isPersisted(): boolean {
    return this.persisted;
  }

  getKey(): string | null {
    return this.memoryKey;
  }

  saveKey(key: string): { persisted: boolean } {
    this.memoryKey = key;
    if (!this.isAvailable()) {
      this.persisted = false;
      this.removeFile();
      return { persisted: false };
    }

    const encrypted = safeStorage.encryptString(key).toString('base64');
    const payload: SecretFile = { version: 1, data: encrypted };
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, this.filePath);
    this.persisted = true;
    return { persisted: true };
  }

  clear(): void {
    this.memoryKey = null;
    this.persisted = false;
    this.removeFile();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    if (!this.isAvailable()) {
      this.logger.warn('Encrypted credential file exists but safeStorage is unavailable.');
      return;
    }

    try {
      const payload = JSON.parse(readFileSync(this.filePath, 'utf8')) as SecretFile;
      if (payload.version !== 1 || typeof payload.data !== 'string') return;
      this.memoryKey = safeStorage.decryptString(Buffer.from(payload.data, 'base64'));
      this.persisted = true;
    } catch (error) {
      this.logger.error('Could not decrypt stored credential.', error);
      this.memoryKey = null;
      this.persisted = false;
    }
  }

  private removeFile(): void {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath);
    } catch {
      // Ignore.
    }
  }
}
