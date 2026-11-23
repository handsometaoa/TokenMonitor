import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createDefaultSettings, DEFAULT_SPEED_UPSTREAM } from '../../shared/defaults';
import type { AppSettings, UpdateSettingsPatch } from '../../shared/types';

const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  theme: z.enum(['system', 'light', 'dark']),
  language: z.enum(['zh-CN', 'en']),
  refreshMinutes: z.number().int().min(1).max(60),
  notifications: z.object({
    enabled: z.boolean(),
    remainingThresholds: z.array(z.number().min(0).max(100)).max(4),
    rateLimited: z.boolean(),
    reset: z.boolean(),
    pace: z.boolean(),
  }),
  launchAtLogin: z.boolean(),
  startHidden: z.boolean(),
  hideOnBlur: z.boolean(),
  trayShowRemaining: z.boolean(),
  localUsageEnabled: z.boolean(),
  localDataPath: z.string().max(2000).nullable(),
  credentialSource: z.enum(['auto', 'manual']),
  orgId: z.string().max(300),
  speed: z.object({
    enabled: z.boolean(),
    upstreamBase: z.string().url(),
    configApplied: z.boolean(),
  }),
  onboardingCompleted: z.boolean(),
  windowBounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().min(320).max(2000),
      height: z.number().min(400).max(2000),
    })
    .nullable(),
});

export class SettingsStore extends EventEmitter {
  private readonly filePath: string;
  private settings: AppSettings;

  constructor(private readonly baseDir: string) {
    super();
    mkdirSync(baseDir, { recursive: true });
    this.filePath = join(baseDir, 'settings.json');
    this.settings = this.load();
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  update(patch: UpdateSettingsPatch): AppSettings {
    const current = this.settings;
    const merged: AppSettings = {
      ...current,
      ...patch,
      notifications: patch.notifications
        ? { ...current.notifications, ...patch.notifications }
        : current.notifications,
      speed: current.speed,
      schemaVersion: 1,
    };

    if (patch.credentialSource) merged.credentialSource = patch.credentialSource;
    if (patch.orgId !== undefined) merged.orgId = patch.orgId.trim();
    if (patch.localDataPath !== undefined) {
      merged.localDataPath = patch.localDataPath?.trim() || null;
    }

    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new Error(`Invalid settings: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
    }

    this.settings = parsed.data;
    this.persist();
    this.emit('changed', this.get());
    return this.get();
  }

  setSpeedConfig(patch: Partial<AppSettings['speed']>): AppSettings {
    const next = { ...this.settings, speed: { ...this.settings.speed, ...patch } };
    const parsed = settingsSchema.safeParse(next);
    if (!parsed.success) throw new Error('Invalid speed settings');
    this.settings = parsed.data;
    this.persist();
    this.emit('changed', this.get());
    return this.get();
  }

  private load(): AppSettings {
    const defaults = createDefaultSettings();
    if (!existsSync(this.filePath)) return defaults;

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      const parsed = settingsSchema.safeParse(raw);
      if (!parsed.success) throw new Error('schema mismatch');
      return {
        ...defaults,
        ...parsed.data,
        speed: {
          ...defaults.speed,
          ...parsed.data.speed,
          upstreamBase: parsed.data.speed.upstreamBase || DEFAULT_SPEED_UPSTREAM,
        },
      };
    } catch {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Ignore backup failure.
      }
      return defaults;
    }
  }

  private persist(): void {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
    renameSync(tempPath, this.filePath);
  }
}
