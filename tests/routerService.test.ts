import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterService } from '../src/main/router/service';
import type { RouterFetch } from '../src/main/router/gateway';
import { Logger } from '../src/main/services/logger';
import { defined } from './helpers';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore Windows cleanup errors.
    }
  }
});

describe('router service config', () => {
  it('generates an API key before validating a previously empty config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-service-'));
    dirs.push(dir);
    const fetchImpl: RouterFetch = async () => {
      throw new Error('Unexpected fetch');
    };
    const service = new RouterService(
      dir,
      new Logger(dir),
      {
        get: () => null,
        save: () => ({ persisted: false }),
        clear: () => undefined,
      },
      fetchImpl,
      false,
    );
    try {
      const state = await service.saveServiceConfig({ enabled: false, port: 8787 });
      expect(state.service.config.enabled).toBe(false);
      expect(state.service.config.apiKey.length).toBeGreaterThanOrEqual(12);
    } finally {
      await service.stop();
    }
  });

  it('adds an OpenCode session header to model probe requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-service-'));
    dirs.push(dir);
    const secrets = new Map<string, string>();
    let capturedHeaders: Record<string, string> | null = null;
    const fetchImpl: RouterFetch = async (_input, init) => {
      capturedHeaders = init?.headers ?? null;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const service = new RouterService(
      dir,
      new Logger(dir),
      {
        get: (id: string) => secrets.get(id) ?? null,
        save: (id: string, value: string) => {
          secrets.set(id, value);
          return { persisted: false };
        },
        clear: (id: string) => {
          secrets.delete(id);
        },
      },
      fetchImpl,
      false,
    );
    try {
      const [provider] = service.saveProvider({
        name: 'OpenCode Go',
        protocol: 'openai',
        kind: 'opencode',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        enabled: true,
      });
      const savedProvider = defined(provider);
      secrets.set(`router:${savedProvider.id}`, 'sk-opencode-test-key');
      service.saveModel({
        providerId: savedProvider.id,
        publicName: 'test-model',
        upstreamName: 'upstream-model',
        enabled: true,
      });
      const [result] = await service.testModelRoutes(null);
      expect(defined(result).ok).toBe(true);
      expect(capturedHeaders?.['x-opencode-session']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      await service.stop();
    }
  });
});
