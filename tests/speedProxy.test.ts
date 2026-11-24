import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '../src/main/services/logger';
import { SettingsStore } from '../src/main/services/settings';
import { SpeedProxyService } from '../src/main/services/speedProxy';
import { SpeedStore } from '../src/main/services/speedStore';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('SpeedProxyService', () => {
  it('forwards SSE traffic and records upstream usage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-proxy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ usage: { input_tokens: 12, output_tokens: 50 } })}\n\n`);
        res.end();
      }, 35);
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const settings = new SettingsStore(dir);
    settings.setSpeedConfig({
      enabled: true,
      upstreamBase: `http://127.0.0.1:${upstreamPort}/zen/go/v1`,
      configApplied: false,
    });
    const logger = new Logger(dir);
    const store = new SpeedStore(dir, logger);
    const proxy = new SpeedProxyService(dir, settings, store, logger, false);
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const info = proxy.getConfigInfo();
    expect(info.running).toBe(true);
    expect(info.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[a-f0-9]+$/);

    const response = await fetch(`${info.proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-test' },
      body: JSON.stringify({ model: 'request-model', stream: true }),
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('output_tokens');

    await new Promise((resolve) => setTimeout(resolve, 120));
    const series = store.getSeries('7d');
    expect(series).toHaveLength(1);
    expect(series[0].model).toBe('request-model');
    expect(series[0].samples).toBe(1);
    expect(series[0].tokensPerSecond).toBeGreaterThan(0);
    expect(settings.get().speed.configApplied).toBe(true);
  });

  it('records TTFT even when upstream usage is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-proxy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`);
      setTimeout(() => res.end(), 30);
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const settings = new SettingsStore(dir);
    settings.setSpeedConfig({
      enabled: true,
      upstreamBase: `http://127.0.0.1:${upstreamPort}/zen/go/v1`,
      configApplied: false,
    });
    const logger = new Logger(dir);
    const store = new SpeedStore(dir, logger);
    const proxy = new SpeedProxyService(dir, settings, store, logger, false);
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const info = proxy.getConfigInfo();
    const response = await fetch(`${info.proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'ttft-model', stream: true }),
    });
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 120));

    const series = store.getSeries('7d');
    expect(series).toHaveLength(1);
    expect(series[0].model).toBe('ttft-model');
    expect(series[0].ttftMs).toBeGreaterThan(0);
    expect(series[0].tokensPerSecond).toBe(0);
  });
});
