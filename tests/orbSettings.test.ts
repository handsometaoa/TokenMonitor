import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/main/services/settings';

function setup(): string {
  return mkdtempSync(join(tmpdir(), 'tokenmonitor-orb-settings-'));
}

describe('orb settings persistence', () => {
  it('defaults to an enabled orb without a pinned position or target', () => {
    const dir = setup();
    try {
      const store = new SettingsStore(dir);
      expect(store.get().orbEnabled).toBe(true);
      expect(store.get().orbPosition).toBeNull();
      expect(store.get().orbTargetKey).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips orb fields across reloads', () => {
    const dir = setup();
    try {
      const store = new SettingsStore(dir);
      store.update({ orbTargetKey: 'agent:codex', orbPosition: { x: 120, y: 80 } });

      const reloaded = new SettingsStore(dir);
      expect(reloaded.get().orbTargetKey).toBe('agent:codex');
      expect(reloaded.get().orbPosition).toEqual({ x: 120, y: 80 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
