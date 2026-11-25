import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterBalancer } from '../src/main/router/balancer';
import { RouterRepository } from '../src/main/router/db';
import { RouterGateway } from '../src/main/router/gateway';
import { Logger } from '../src/main/services/logger';
import { asRecord } from '../src/shared/validation';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startGateway(
  baseUrl: string,
  proxyUrl = '',
  providerKind: 'custom' | 'opencode' = 'custom',
): Promise<{ port: number; repo: RouterRepository }> {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-boundary-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = new RouterRepository(dir);
  const port = await freePort();
  repo.setServiceConfig({ enabled: true, port, apiKey: 'router-key', proxyUrl, captureBodies: false });
  repo.setBalanceConfig({ enabled: false, sessionAffinity: false, quotaGuard: false, maxAttempts: 1 });
  const provider = repo.saveProvider({
    name: 'boundary-upstream',
    protocol: 'anthropic',
    kind: providerKind,
    baseUrl,
    enabled: true,
  });
  repo.saveModel({ providerId: provider.id, publicName: 'test-model', upstreamName: 'upstream-model', enabled: true });
  const secrets = { get: (id: string) => (id === `router:${provider.id}` ? 'upstream-key' : null) };
  const gateway = new RouterGateway(
    repo,
    secrets,
    new RouterBalancer(repo),
    new Logger(dir),
    (input, init) => fetch(input, init),
    () => repo.getServiceConfig(),
  );
  await gateway.start();
  cleanups.push(() => gateway.stop());
  cleanups.push(() => repo.close());
  return { port, repo };
}

describe('gateway external boundaries', () => {
  it('rejects an array-shaped upstream response instead of decoding it as an object', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ type: 'text', text: 'unexpected' }]));
      });
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const { port } = await startGateway(`http://127.0.0.1:${upstreamPort}/v1`);

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer router-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const payload: unknown = await response.json();
    expect(response.status).toBe(502);
    expect(asRecord(payload)?.error).toMatchObject({
      message: expect.stringContaining('invalid JSON response'),
      code: 'upstream_error',
    });
  });

  it('streams through the explicit Undici proxy-response translation', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n');
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"proxied"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const proxy = createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      const target = new URL(`http://${req.url ?? ''}`);
      const upstreamSocket = connect(Number(target.port), target.hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstreamSocket.destroy());
    });
    const proxyPort = await listen(proxy);
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const { port } = await startGateway(
      `http://127.0.0.1:${upstreamPort}/v1`,
      `http://127.0.0.1:${proxyPort}`,
    );

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer router-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('proxied');
    expect(text).toContain('[DONE]');
  });

  it('supplies x-opencode-session when the client omits it', async () => {
    let seenSession: string | undefined;
    const upstream = createServer((req, res) => {
      seenSession = typeof req.headers['x-opencode-session'] === 'string' ? req.headers['x-opencode-session'] : undefined;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const { port } = await startGateway(`http://127.0.0.1:${upstreamPort}/v1`, '', 'opencode');

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer router-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(seenSession).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('preserves a client-supplied OpenCode session id', async () => {
    let seenSession: string | undefined;
    const upstream = createServer((req, res) => {
      seenSession = typeof req.headers['x-opencode-session'] === 'string' ? req.headers['x-opencode-session'] : undefined;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

    const { port } = await startGateway(`http://127.0.0.1:${upstreamPort}/v1`, '', 'opencode');

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer router-key',
        'content-type': 'application/json',
        'x-opencode-session': 'client-session-abc',
      },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(seenSession).toBe('client-session-abc');
  });
});
