import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterRepository } from '../src/main/router/db';
import { defined } from './helpers';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore Windows cleanup errors.
    }
  }
});

function repo(): RouterRepository {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-models-'));
  dirs.push(dir);
  return new RouterRepository(dir);
}

describe('router model groups', () => {
  it('renames a whole group and keeps request logs in sync', () => {
    const db = repo();
    const provider = db.saveProvider({
      name: 'Mock',
      protocol: 'openai',
      kind: 'custom',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });
    db.saveModel({ providerId: provider.id, publicName: 'old-model', upstreamName: 'upstream-1', enabled: true });
    const second = db.saveProvider({
      name: 'Mock 2',
      protocol: 'openai',
      kind: 'custom',
      baseUrl: 'https://api2.example.com/v1',
      enabled: true,
    });
    db.saveModel({ providerId: second.id, publicName: 'old-model', upstreamName: 'upstream-2', enabled: true });
    db.startLog({
      requestId: 'req-1',
      publicModel: 'old-model',
      providerName: 'Mock',
      upstreamModel: 'upstream-1',
      providerId: provider.id,
      modelId: 'model-1',
      client: 'test',
      path: '/v1/chat/completions',
      stream: false,
      requestBody: '{}',
      requestHeaders: '{}',
    });
    db.finishLog({
      requestId: 'req-1',
      status: 200,
      stream: false,
      promptTokens: 1,
      completionTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unrecognizedTokens: 0,
      totalTokens: 2,
      responseBody: '{}',
      responseHeaders: '{}',
      error: null,
      retryTrace: null,
    });

    db.renameModelGroup('old-model', 'new-model');
    expect(db.findRoutes('old-model')).toHaveLength(0);
    expect(db.findRoutes('new-model')).toHaveLength(2);
    expect(defined(db.listLogs({ limit: 10 }).items[0]).publicModel).toBe('new-model');
    db.close();
  });

  it('rejects renaming onto an existing group', () => {
    const db = repo();
    const provider = db.saveProvider({
      name: 'Mock',
      protocol: 'openai',
      kind: 'custom',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });
    db.saveModel({ providerId: provider.id, publicName: 'a', upstreamName: 'a-up', enabled: true });
    db.saveModel({ providerId: provider.id, publicName: 'b', upstreamName: 'b-up', enabled: true });
    expect(() => db.renameModelGroup('a', 'b')).toThrow('目标模型名已存在');
    db.close();
  });

  it('enables and disables all channels in a group', () => {
    const db = repo();
    const provider = db.saveProvider({
      name: 'Mock',
      protocol: 'openai',
      kind: 'custom',
      baseUrl: 'https://api.example.com/v1',
      enabled: true,
    });
    db.saveModel({ providerId: provider.id, publicName: 'grouped', upstreamName: 'one', enabled: true });
    db.setModelGroupEnabled('grouped', false);
    expect(defined(db.findRoutes('grouped')[0]).modelEnabled).toBe(false);
    db.setModelGroupEnabled('grouped', true);
    expect(defined(db.findRoutes('grouped')[0]).modelEnabled).toBe(true);
    db.close();
  });
});
