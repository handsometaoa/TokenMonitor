import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function redact(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/\b(user_[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/\b(OPENCODE(?:_GO)?_API_KEY=)[^\s]+/g, '$1[redacted]');
}

export class Logger {
  private readonly filePath: string;

  constructor(baseDir: string) {
    const dir = join(baseDir, 'logs');
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'main.log');
    this.rotateIfNeeded();
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? ` ${error.name}: ${error.message}` : error ? ` ${String(error)}` : '';
    this.write('ERROR', `${message}${detail}`);
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} [${level}] ${redact(message)}\n`;
    try {
      appendFileSync(this.filePath, line, 'utf8');
    } catch {
      // Logging must never break the app.
    }
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.log(line.trimEnd());
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.filePath)) return;
      if (statSync(this.filePath).size <= MAX_LOG_BYTES) return;
      const rotated = `${this.filePath}.old`;
      try {
        renameSync(this.filePath, rotated);
      } catch {
        // Ignore rotation failures; append continues.
      }
    } catch {
      // Ignore.
    }
  }
}
