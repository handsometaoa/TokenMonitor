import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderSecretStore } from '../src/main/services/providerSecrets';
import { Logger } from '../src/main/services/logger';
import { RouterRepository } from '../src/main/router/db';
import { RouterBalancer } from '../src/main/router/balancer';
import { RouterGateway } from '../src/main/router/gateway';

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

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function upstreamServer(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    void listen(server).then((port) => resolve({ server, port }));
  });
}

async function setup(options: {
  protocol: 'openai' | 'anthropic' | 'openai-responses';
  upstreamPort: number;
  apiKey?: string;
  balance?: boolean;
  captureBodies?: boolean;
}): Promise<{
  repo: RouterRepository;
  gateway: RouterGateway;
  port: number;
  providerId: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'tokenmonitor-router-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = new RouterRepository(dir);
  const logger = new Logger(dir);
  const port = await freePort();
  const apiKey = 'sk-router-test-key';
  repo.setServiceConfig({
    enabled: true,
    port,
    apiKey,
    proxyUrl: '',
    captureBodies: options.captureBodies ?? true,
  });
  repo.setBalanceConfig({
    enabled: options.balance ?? false,
    sessionAffinity: false,
    quotaGuard: false,
    maxAttempts: 2,
  });
  const provider = repo.saveProvider({
    name: 'mock-upstream',
    protocol: options.protocol,
    kind: 'custom',
    baseUrl: `http://127.0.0.1:${options.upstreamPort}/v1`,
    enabled: true,
  });
  repo.saveModel({
    providerId: provider.id,
    publicName: 'test-model',
    upstreamName: 'upstream-model',
    enabled: true,
  });
  const secrets = new Map<string, string>();
  if (options.apiKey !== '') secrets.set(`router:${provider.id}`, options.apiKey ?? 'sk-upstream');
  const fakeSecrets = {
    get: (id: string) => secrets.get(id) ?? null,
  } as unknown as ProviderSecretStore;
  const gateway = new RouterGateway(repo, fakeSecrets, new RouterBalancer(repo), logger, (input, init) => fetch(input, init), () => repo.getServiceConfig());
  await gateway.start();
  cleanups.push(() => repo.close());
  cleanups.push(() => gateway.stop());
  return { repo, gateway, port, providerId: provider.id };
}

function wait(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RouterGateway', () => {
  it('passes through OpenAI chat requests and records usage', async () => {
    const { server, port: upstreamPort } = await upstreamServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string };
        expect(parsed.model).toBe('upstream-model');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { repo, port } = await setup({ protocol: 'openai', upstreamPort });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-router-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe('hello');

    await wait();
    const logs = repo.listLogs({ limit: 10 });
    expect(logs.total).toBe(1);
    expect(logs.items[0].status).toBe(200);
    expect(logs.items[0].publicModel).toBe('test-model');
    expect(logs.items[0].totalTokens).toBe(15);
    expect(logs.items[0].providerName).toBe('mock-upstream');
    const usage = repo.getUsage('today');
    expect(usage.totals.requestCount).toBe(1);
    expect(usage.totals.totalTokens).toBe(15);
  });

  it('converts OpenAI chat to Anthropic messages and back', async () => {
    let captured: Record<string, unknown> | null = null;
    const { server, port: upstreamPort } = await upstreamServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        captured = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'converted' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 8, output_tokens: 4 },
          }),
        );
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { repo, port } = await setup({ protocol: 'anthropic', upstreamPort });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-router-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 64,
      }),
    });
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe('converted');
    expect(body.usage.prompt_tokens).toBe(8);
    expect(body.usage.completion_tokens).toBe(4);
    expect(captured).toMatchObject({ model: 'upstream-model', system: 'be brief', max_tokens: 64 });
    const messages = captured?.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');

    await wait();
    const logs = repo.listLogs({ limit: 10 });
    expect(logs.items[0].status).toBe(200);
    expect(logs.items[0].totalTokens).toBe(12);
  });

  it('passes through OpenAI streaming SSE', async () => {
    const { server, port: upstreamPort } = await upstreamServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\r\n\r\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello' } }] })}\r\n\r\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          })}\r\n\r\n`,
        );
        res.end('data: [DONE]\r\n\r\n');
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { repo, port } = await setup({ protocol: 'openai', upstreamPort });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-router-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('hello');
    expect(text).toContain('[DONE]');

    await wait();
    const logs = repo.listLogs({ limit: 10 });
    expect(logs.items[0].status).toBe(200);
    expect(logs.items[0].stream).toBe(true);
    expect(logs.items[0].totalTokens).toBe(10);
  });

  it('converts Anthropic streaming events to OpenAI SSE', async () => {
    const { server, port: upstreamPort } = await upstreamServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events: Array<[string, unknown]> = [
          ['message_start', { type: 'message_start', message: { usage: { input_tokens: 9 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'converted' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
          ['message_stop', { type: 'message_stop' }],
        ];
        for (const [event, payload] of events) {
          res.write(`event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`);
        }
        res.end();
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { repo, port } = await setup({ protocol: 'anthropic', upstreamPort });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-router-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('converted');
    expect(text).toContain('[DONE]');

    await wait();
    const logs = repo.listLogs({ limit: 10 });
    expect(logs.items[0].status).toBe(200);
    expect(logs.items[0].totalTokens).toBe(11);
  });

  it('omits request and response bodies when body capture is disabled', async () => {
    const { server, port: upstreamPort } = await upstreamServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: 'quiet' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      });
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const { repo, port } = await setup({ protocol: 'openai', upstreamPort, captureBodies: false });

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-router-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'secret prompt' }] }),
    });
    expect(response.status).toBe(200);
    await wait();
    const log = repo.listLogs({ limit: 1 }).items[0];
    expect(log.totalTokens).toBe(5);
    expect(log.requestBody).toBeNull();
    expect(log.responseBody).toBeNull();
  });

  it('rejects invalid local API keys without calling upstream', async () => {
    const { port } = await setup({ protocol: 'openai', upstreamPort: 1 });
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });
});
