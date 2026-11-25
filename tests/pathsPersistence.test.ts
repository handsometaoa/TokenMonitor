import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFilePath, openCodeConfigCandidates, openCodeConfigDir, openCodeDataDir, resolveOpenCodeDbPath } from '../src/main/paths';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('OpenCode path persistence', () => {
  it('falls back to defaults for empty, relative, or whitespace XDG overrides', () => {
    for (const value of ['', 'relative/path', '   ']) {
      vi.stubEnv('XDG_DATA_HOME', value);
      vi.stubEnv('XDG_CONFIG_HOME', value);
      expect(openCodeDataDir()).toBe(join(homedir(), '.local', 'share', 'opencode'));
      expect(openCodeConfigDir()).toBe(join(homedir(), '.config', 'opencode'));
      expect(authFilePath()).toBe(join(homedir(), '.local', 'share', 'opencode', 'auth.json'));
      expect(openCodeConfigCandidates()).toEqual([
        join(homedir(), '.config', 'opencode', 'opencode.json'),
        join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
      ]);
    }
  });

  it('preserves valid absolute XDG overrides and relative database overrides', () => {
    const dataHome = join(tmpdir(), 'tokenmonitor-xdg-data');
    const configHome = join(tmpdir(), 'tokenmonitor-xdg-config');
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.stubEnv('OPENCODE_DB', 'custom.db');

    expect(openCodeDataDir()).toBe(join(dataHome, 'opencode'));
    expect(openCodeConfigDir()).toBe(join(configHome, 'opencode'));
    expect(resolveOpenCodeDbPath()).toBe(resolve(join(dataHome, 'opencode'), 'custom.db'));
  });
});
