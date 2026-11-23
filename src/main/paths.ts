import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function openCodeDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  return xdgData ? join(xdgData, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
}

export function openCodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  return xdgConfig ? join(xdgConfig, 'opencode') : join(homedir(), '.config', 'opencode');
}

export function authFilePath(): string {
  return join(openCodeDataDir(), 'auth.json');
}

export function resolveOpenCodeDbPath(explicitPath?: string | null): string {
  if (explicitPath && explicitPath.trim()) {
    return explicitPath;
  }

  const envDb = process.env.OPENCODE_DB;
  if (envDb) {
    if (isAbsolute(envDb)) return envDb;
    return resolve(openCodeDataDir(), envDb);
  }

  return join(openCodeDataDir(), 'opencode.db');
}

export function findOpenCodeDbCandidates(explicitPath?: string | null): string[] {
  const preferred = resolveOpenCodeDbPath(explicitPath);
  const candidates = new Set<string>();
  if (existsSync(preferred)) {
    candidates.add(preferred);
  }

  const dataDir = openCodeDataDir();
  try {
    for (const name of readdirSync(dataDir)) {
      if (/^opencode(?:-[^.]+)?\.db$/i.test(name)) {
        candidates.add(join(dataDir, name));
      }
    }
  } catch {
    // Data directory does not exist.
  }

  return [...candidates];
}

export function openCodeConfigCandidates(): string[] {
  const dir = openCodeConfigDir();
  return [join(dir, 'opencode.json'), join(dir, 'opencode.jsonc')];
}
