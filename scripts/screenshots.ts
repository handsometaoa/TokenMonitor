import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { electronExecutablePath } from './electron-path.js';

async function waitForWindow(app: ElectronApplication, urlPart: string): Promise<Page> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = app.windows().find((window) => window.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Window containing "${urlPart}" did not appear.`);
}

// ---------------------------------------------------------------------------
// Mock OpenAI-protocol upstream. The demo router gateway forwards synthetic
// client traffic here, so the console pages show realistic (fake) logs/usage.
// ---------------------------------------------------------------------------
interface ChatState {
  promptTokens: number;
  completionTokens: number;
}

function chatResponse(state: ChatState, model: string, stream: boolean): string {
  if (!stream) {
    return JSON.stringify({
      id: `chatcmpl-${randomUUID().slice(0, 8)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '好的，这是一条来自本地 mock 上游的回复。' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: state.promptTokens,
        completion_tokens: state.completionTokens,
        total_tokens: state.promptTokens + state.completionTokens,
      },
    });
  }
  const chunks = ['你好', '，这是', 'mock 上游', '的流式回复。'];
  const lines = chunks.map(
    (text) =>
      `data: ${JSON.stringify({
        id: `chatcmpl-${randomUUID().slice(0, 8)}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`,
  );
  lines.push(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID().slice(0, 8)}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: state.promptTokens,
        completion_tokens: state.completionTokens,
        total_tokens: state.promptTokens + state.completionTokens,
      },
    })}\n\n`,
  );
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function startMockUpstream(): Promise<number> {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.2-codex', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const body = await readJson(req);
    const model = typeof body.model === 'string' ? body.model : 'gpt-5.2-codex';
    const state: ChatState = {
      promptTokens: 900 + Math.floor(Math.random() * 2600),
      completionTokens: 350 + Math.floor(Math.random() * 1900),
    };
    // Simulate upstream latency before answering.
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.floor(Math.random() * 260)));
    if (url.startsWith('/v1/chat/completions')) {
      res.end(chatResponse(state, model, body.stream === true));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: `mock upstream has no route for ${url}` } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // Don't keep the Node process alive after the app is closed.
      server.unref();
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Screenshots, in two phases:
//   1) seed phase: settings + router providers/models + mock traffic, then quit
//      (router pages snapshot provider counts on mount, so the data has to
//      predate the capture session)
//   2) capture phase: relaunch the same profile, start the gateway, push a few
//      fresh requests, and screenshot every window/page
// Everything runs against a throwaway --user-data-dir profile; demo mode keeps
// traffic local except the mock upstream on loopback.
// ---------------------------------------------------------------------------
const outDir = join(process.cwd(), 'tmp', 'shots');
const profile = join(process.cwd(), 'tmp', 'shots-profile');
await mkdir(outDir, { recursive: true });
if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });

const upstreamPort = await startMockUpstream();
console.log(`mock upstream on 127.0.0.1:${upstreamPort}`);

function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const gatewayPort = await freeTcpPort();
console.log(`gateway port ${gatewayPort}`);

const launch = (): Promise<ElectronApplication> =>
  electron.launch({
    executablePath: electronExecutablePath(),
    args: [`--user-data-dir=${profile}`, '.'],
    cwd: process.cwd(),
    env: { ...process.env, TOKENMONITOR_DEMO: '1' },
  });

const openRouter = async (app: ElectronApplication): Promise<Page> => {
  const page = await waitForWindow(app, 'index.html');
  await page.waitForTimeout(1800);
  return page;
};

async function pushTraffic(port: number, apiKey: string): Promise<void> {
  const gateway = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  const call = async (path: string, payload: unknown): Promise<void> => {
    try {
      const response = await fetch(`${gateway}${path}`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(payload),
      });
      await response.text();
      console.log('request', path, response.status);
    } catch (error) {
      console.log('request failed', path, error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  };
  await call('/v1/chat/completions', { model: 'gpt-5.2-codex', stream: true, messages: [{ role: 'user', content: '总结这段日志里的错误模式。' }] });
  await call('/v1/chat/completions', { model: 'gpt-5.2-codex', messages: [{ role: 'user', content: '把这段 README 翻译成英文。' }] });
  await call('/v1/messages', { model: 'claude-sonnet-4-5', max_tokens: 512, messages: [{ role: 'user', content: '审查这个组件的可访问性。' }] });
  await call('/v1/chat/completions', { model: 'gpt-5.2-codex', stream: true, messages: [{ role: 'user', content: '解释 pace 节奏预测的逻辑。' }] });
  await call('/v1/responses', { model: 'gpt-5.2-codex', input: '生成一份 CHANGELOG 摘要。' });
  await call('/v1/chat/completions', { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '列出本周待办。' }] });
  await call('/v1/chat/completions', { model: 'gpt-5.2-codex', stream: true, messages: [{ role: 'user', content: '给额度卡片写三条文案。' }] });
  // One unmatched model so the logs page shows a failure row too.
  await call('/v1/chat/completions', { model: 'gpt-5.2-codex-mini', messages: [{ role: 'user', content: '这条会失败。' }] });
}

// -- Phase 1: seed settings, router config and traffic -----------------------
{
  const app = await launch();
  try {
    const page = await openRouter(app);
    await page.evaluate(() =>
      window.tokenMonitor.updateSettings({
        onboardingCompleted: true,
        theme: 'dark',
        quotaVisibility: {
          'agent:opencode': true,
          'agent:codex': true,
          'agent:claude': true,
          'agent:cursor': true,
          'agent:zai': true,
        },
      }),
    );
    await page.waitForTimeout(600);
    await page.evaluate(() => window.tokenMonitor.refreshQuota());
    await page.waitForTimeout(600);

    // Seed two router providers + model channels pointing at the mock upstream.
    // 'gpt-5.2-codex' exists on both providers, forming a load-balanced channel group.
    const seeded = await page.evaluate(
      async (port) => {
        const baseUrl = `http://127.0.0.1:${port}/v1`;
        const primary = await window.tokenMonitor.saveRouterProvider({
          name: 'Demo Go 上游',
          protocol: 'openai',
          kind: 'openai',
          baseUrl,
          apiKey: 'sk-mock-upstream-key',
          enabled: true,
        });
        const backup = await window.tokenMonitor.saveRouterProvider({
          name: 'Demo 备用上游',
          protocol: 'openai',
          kind: 'openai',
          baseUrl,
          apiKey: 'sk-mock-upstream-key',
          enabled: true,
        });
        const primaryId = primary.find((provider) => provider.name === 'Demo Go 上游')?.id ?? '';
        const backupId = backup.find((provider) => provider.name === 'Demo 备用上游')?.id ?? '';
        await window.tokenMonitor.saveRouterModel({ providerId: primaryId, publicName: 'gpt-5.2-codex', upstreamName: 'gpt-5.2-codex', enabled: true });
        await window.tokenMonitor.saveRouterModel({ providerId: primaryId, publicName: 'claude-sonnet-4-5', upstreamName: 'claude-sonnet-4-5', enabled: true });
        await window.tokenMonitor.saveRouterModel({ providerId: backupId, publicName: 'gpt-5.2-codex', upstreamName: 'gpt-5.2-codex', enabled: true });
        return { providers: primary.length, models: (await window.tokenMonitor.listRouterModels(false)).length };
      },
      upstreamPort,
    );
    console.log('seeded providers', seeded.providers, 'models', seeded.models);

    // Enable the local gateway on a free port so this never fights a locally
    // running instance; the key is generated here and reused in phase 2.
    const config = await page.evaluate(
      (port) => window.tokenMonitor.saveRouterServiceConfig({ enabled: true, port }),
      gatewayPort,
    );
    await page.waitForTimeout(900);
    const state = await page.evaluate(() => window.tokenMonitor.getRouterState());
    console.log('gateway enabled, port', config.port, 'state', state.service.state);

    await pushTraffic(config.port, config.apiKey);
    await page.waitForTimeout(1200);
  } finally {
    await app.close();
  }
  console.log('phase 1 done');
}

// -- Phase 2: capture --------------------------------------------------------
const app = await launch();
try {
  const page = await openRouter(app);

  // Demo skips gateway autostart; toggling the persisted config starts it.
  const config = await page.evaluate(() => window.tokenMonitor.saveRouterServiceConfig({ enabled: true }));
  await page.waitForTimeout(900);
  await pushTraffic(config.port, config.apiKey);
  await page.waitForTimeout(1800);

  const nav = async (name: string, settle: number, file: string): Promise<void> => {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(settle);
    await page.screenshot({ path: join(outDir, file) });
    console.log('captured', file);
  };

  await nav('概览', 1100, 'router-overview.png');
  await nav('提供商', 900, 'router-providers.png');
  await nav('模型路由', 900, 'router-models.png');
  await nav('本地网关', 900, 'router-service.png');
  await nav('请求日志', 1100, 'router-logs.png');
  await nav('用量统计', 1100, 'router-usage.png');
  await nav('余量', 1100, 'router-quota.png');

  // App settings overlay shares the main window.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, 'settings.png') });
  console.log('captured settings.png');
  await page.getByRole('button', { name: '返回路由台' }).click();
  await page.waitForTimeout(300);

  // The Token panel is its own window now: toggle it from the orb surface.
  const orbPage = await waitForWindow(app, 'orb.html');
  await orbPage.evaluate(() => window.tokenMonitor.togglePanel());
  const panelPage = await waitForWindow(app, 'panel.html');
  await panelPage.locator('.panel-shell').waitFor({ timeout: 5000 });
  await panelPage.waitForTimeout(900);
  await panelPage.screenshot({ path: join(outDir, 'panel-home.png') });
  console.log('captured panel-home.png');

  await panelPage.getByRole('button', { name: '额度', exact: true }).click();
  await panelPage.waitForTimeout(800);
  await panelPage.screenshot({ path: join(outDir, 'panel-quota.png') });
  console.log('captured panel-quota.png');

  await panelPage.evaluate(() => window.tokenMonitor.hidePanel());
  await page.waitForTimeout(400);

  // Orb close-up; the window background is transparent.
  await orbPage.screenshot({ path: join(outDir, 'orb.png'), omitBackground: true });
  console.log('captured orb.png');

  console.log('Screenshots written to', outDir);
} finally {
  await app.close();
}
