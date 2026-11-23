import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Transform } from 'node:stream';
import type { SpeedConfigInfo, SpeedStatus } from '../../shared/types';
import { openCodeConfigCandidates, openCodeConfigDir } from '../paths';
import type { Logger } from './logger';
import type { SettingsStore } from './settings';
import type { SpeedStore, SpeedSampleRecord } from './speedStore';

interface ProxyConfigFile {
  port: number | null;
  secret: string;
}

interface ParserState {
  model: string | null;
  outputTokens: number;
  inputTokens: number;
  contentType: string;
  encoding: string;
  text: string;
  jsonBuffer: string;
  decoder: Transform | null;
  stopped: boolean;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SSE_BUFFER = 256 * 1024;

function numberFrom(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

function extractUsage(value: unknown): { input: number; output: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usage =
    (record.usage && typeof record.usage === 'object' ? record.usage : null) ??
    ((record.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined) ??
    ((record.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined);
  if (!usage || typeof usage !== 'object') return null;
  const usageRecord = usage as Record<string, unknown>;
  const output = numberFrom(
    usageRecord.output_tokens,
    usageRecord.completion_tokens,
    usageRecord.outputTokens,
    usageRecord.output,
  );
  const input = numberFrom(usageRecord.input_tokens, usageRecord.prompt_tokens, usageRecord.inputTokens, usageRecord.input);
  if (output === 0 && input === 0) return null;
  return { input, output };
}

function extractModel(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const direct = [record.model, record.modelID, (record.message as Record<string, unknown> | undefined)?.model];
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

function modelFromPayload(payload: unknown, state: ParserState): void {
  const model = extractModel(payload);
  if (model) state.model = model;
  const usage = extractUsage(payload);
  if (usage) {
    state.outputTokens = Math.max(state.outputTokens, usage.output);
    state.inputTokens = Math.max(state.inputTokens, usage.input);
  }
}

function pushParser(state: ParserState, chunk: Buffer): void {
  if (state.stopped) return;
  const text = chunk.toString('utf8');
  if (state.contentType.includes('text/event-stream')) {
    state.text += text;
    if (state.text.length > MAX_SSE_BUFFER) {
      const index = state.text.lastIndexOf('\n');
      state.text = index >= 0 ? state.text.slice(index + 1) : '';
    }
    const lines = state.text.split('\n');
    state.text = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload) as unknown;
        modelFromPayload(json, state);
      } catch {
        // Partial or non-JSON event; ignore.
      }
    }
    return;
  }

  if (state.contentType.includes('application/json')) {
    state.jsonBuffer += text;
    if (state.jsonBuffer.length > MAX_JSON_BYTES) {
      state.stopped = true;
      state.jsonBuffer = '';
    }
  }
}

function finishParser(state: ParserState): void {
  if (state.stopped) return;
  if (state.contentType.includes('application/json') && state.jsonBuffer) {
    try {
      modelFromPayload(JSON.parse(state.jsonBuffer) as unknown, state);
    } catch {
      // Ignore malformed response.
    }
    state.jsonBuffer = '';
  }
}

function decoderFor(encoding: string): Transform | null {
  const normalized = encoding.toLowerCase().trim();
  if (!normalized || normalized === 'identity') return null;
  if (normalized === 'gzip' || normalized === 'x-gzip') return createGunzip();
  if (normalized === 'deflate') return createInflate();
  if (normalized === 'br') return createBrotliDecompress();
  return null;
}

function localDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export class SpeedProxyService extends EventEmitter {
  private readonly configPath: string;
  private config: ProxyConfigFile;
  private server: Server | null = null;
  private running = false;
  private error: string | null = null;
  private appliedMarked = false;

  constructor(
    private readonly baseDir: string,
    private readonly settings: SettingsStore,
    private readonly store: SpeedStore,
    private readonly logger: Logger,
    private readonly demo: boolean,
  ) {
    super();
    mkdirSync(baseDir, { recursive: true });
    this.configPath = join(baseDir, 'speed-proxy.json');
    this.config = this.loadConfig();
  }

  async start(): Promise<void> {
    if (this.demo) {
      this.running = true;
      this.emit('status');
      return;
    }
    if (this.server) return;

    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.logger.error('Speed proxy request failed.', error);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        res.end('TokenMonitor proxy error');
      });
    });
    this.server = server;

    await new Promise<void>((resolve) => {
      let attemptedFallback = false;
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && !attemptedFallback && this.config.port) {
          attemptedFallback = true;
          server.listen(0, '127.0.0.1');
          return;
        }
        this.error = error instanceof Error ? error.message : '代理启动失败。';
        this.logger.error('Speed proxy failed to start.', error);
        this.running = false;
        this.server = null;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', () => {
        server.off('error', onError);
        const address = server.address();
        if (address && typeof address === 'object') {
          const port = address.port;
          const changed = this.config.port !== null && this.config.port !== port;
          this.config.port = port;
          this.saveConfig();
          this.running = true;
          this.error = null;
          if (changed) {
            this.appliedMarked = false;
            this.settings.setSpeedConfig({ configApplied: false });
          }
          this.logger.info(`Speed proxy listening on 127.0.0.1:${port}.`);
          this.emit('status');
          resolve();
        } else {
          this.error = '代理未获得有效端口。';
          this.running = false;
          resolve();
        }
      });
      server.listen(this.config.port ?? 0, '127.0.0.1');
    });
  }

  async stop(): Promise<void> {
    this.appliedMarked = false;
    if (this.demo) {
      this.running = false;
      this.emit('status');
      return;
    }
    const server = this.server;
    this.server = null;
    this.running = false;
    this.emit('status');
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getStatus(): SpeedStatus {
    const storeStatus = this.store.getStatus();
    return {
      enabled: this.settings.get().speed.enabled,
      running: this.running,
      port: this.running ? this.config.port : null,
      upstreamBase: this.settings.get().speed.upstreamBase,
      sampleCount: storeStatus.sampleCount,
      lastSampleAt: storeStatus.lastSampleAt,
      configApplied: this.settings.get().speed.configApplied,
      error: this.error,
    };
  }

  getConfigInfo(): SpeedConfigInfo {
    const proxyUrl = this.proxyUrl();
    const snippet = this.buildSnippet(proxyUrl);
    return {
      proxyUrl,
      snippet,
      configPathHint: openCodeConfigCandidates().join(' 或 ') || openCodeConfigDir(),
      applied: this.settings.get().speed.configApplied,
      running: this.running,
    };
  }

  markApplied(): void {
    if (this.appliedMarked) return;
    this.appliedMarked = true;
    if (!this.settings.get().speed.configApplied) {
      this.settings.setSpeedConfig({ configApplied: true });
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: this.running, service: 'tokenmonitor-speed-proxy' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const prefix = `/p/${this.config.secret}`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    this.markApplied();
    const upstream = new URL(this.settings.get().speed.upstreamBase);
    const incomingPath = url.pathname.slice(prefix.length) || '/';
    const upstreamPath = upstream.pathname.replace(/\/$/, '');
    const targetPath = incomingPath.startsWith(upstreamPath)
      ? incomingPath
      : `${upstreamPath}${incomingPath.startsWith('/') ? '' : '/'}${incomingPath}`;
    const target = new URL(`${targetPath}${url.search}`, upstream.origin);
    const startedAt = Date.now();
    let requestModel: string | null = null;

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding'].includes(name.toLowerCase())) continue;
      headers[name] = value;
    }
    headers.host = upstream.host;

    const requestFn = upstream.protocol === 'http:' ? httpRequest : httpsRequest;
    const upstreamReq = requestFn(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: target.pathname + target.search,
        headers,
        rejectUnauthorized: true,
      },
      (upstreamRes) => {
        const headersAt = Date.now();
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          if (['connection', 'keep-alive', 'transfer-encoding', 'proxy-connection'].includes(name.toLowerCase())) continue;
          responseHeaders[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);

        const state: ParserState = {
          model: null,
          outputTokens: 0,
          inputTokens: 0,
          contentType: String(upstreamRes.headers['content-type'] ?? ''),
          encoding: String(upstreamRes.headers['content-encoding'] ?? ''),
          text: '',
          jsonBuffer: '',
          decoder: null,
          stopped: false,
        };

        if (state.contentType.includes('text/event-stream') || state.contentType.includes('application/json')) {
          if (!state.encoding || state.encoding === 'identity') {
            // Parse directly.
          } else {
            const decoder = decoderFor(state.encoding);
            if (decoder) {
              state.decoder = decoder;
              decoder.on('data', (chunk: Buffer) => pushParser(state, chunk));
              decoder.on('error', () => {
                state.stopped = true;
              });
            } else {
              state.stopped = true;
            }
          }
        } else {
          state.stopped = true;
        }

        let firstChunkAt: number | null = null;
        let lastChunkAt: number | null = null;
        upstreamRes.on('data', (chunk: Buffer) => {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          lastChunkAt = Date.now();
          if (state.decoder) state.decoder.write(chunk);
          else pushParser(state, chunk);
        });
        let finalized = false;
          const finalize = () => {
            if (finalized) return;
            finalized = true;
            finishParser(state);
            this.recordSample(startedAt, headersAt, firstChunkAt, lastChunkAt, state, requestModel);
          };
        upstreamRes.on('end', () => {
          if (state.decoder) {
            state.decoder.once('end', finalize);
            state.decoder.once('error', finalize);
            state.decoder.end();
          } else {
            finalize();
          }
        });
        upstreamRes.on('error', (error) => {
          this.logger.error('Speed proxy upstream response error.', error);
        });
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.setTimeout(10 * 60 * 1000, () => {
      upstreamReq.destroy(new Error('Upstream timeout'));
    });
    upstreamReq.on('error', (error) => {
      this.logger.error('Speed proxy upstream request error.', error);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Upstream error');
      } else {
        res.end();
      }
    });
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });

    const sniffer = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (requestModel === null) {
          const text = chunk.toString('utf8', 0, Math.min(chunk.length, 64 * 1024));
          const match = /"(?:model|modelID)"\s*:\s*"([^"]+)"/.exec(text);
          if (match?.[1]) requestModel = match[1];
        }
        this.push(chunk);
        callback();
      },
    });
    req.pipe(sniffer).pipe(upstreamReq);
  }

  private recordSample(
    startedAt: number,
    headersAt: number,
    firstChunkAt: number | null,
    lastChunkAt: number | null,
    state: ParserState,
    requestModel: string | null,
  ): void {
    if (state.outputTokens <= 0) return;
    const first = firstChunkAt ?? headersAt;
    const last = lastChunkAt ?? headersAt;
    const durationMs = Math.max(1, last - first);
    const ttftMs = Math.max(0, first - startedAt);
    const record: SpeedSampleRecord = {
      ts: Date.now(),
      provider: 'opencode-go',
      model: state.model ?? requestModel ?? 'unknown',
      ttftMs,
      durationMs,
      outputTokens: state.outputTokens,
      inputTokens: state.inputTokens,
      tokenSource: 'upstream',
    };
    this.store.append(record);
    this.logger.info(`Speed sample: ${record.model} ${record.outputTokens} tokens in ${durationMs}ms.`);
    this.emit('sample', record);
    this.emit('status');
  }

  private proxyUrl(): string {
    const port = this.config.port ?? 0;
    return `http://127.0.0.1:${port}/p/${this.config.secret}`;
  }

  private buildSnippet(proxyUrl: string): string {
    const singular = {
      provider: {
        opencode: {
          options: {
            baseURL: proxyUrl,
          },
        },
      },
    };
    const plural = {
      providers: {
        opencode: {
          settings: {
            baseURL: proxyUrl,
          },
        },
      },
    };
    return [
      '// 方式 A：当前 OpenCode 使用 provider（单数）配置时，合并以下片段',
      JSON.stringify(singular, null, 2),
      '',
      '// 方式 B：使用 providers（复数）配置时，合并以下片段',
      JSON.stringify(plural, null, 2),
      '',
      '// Provider ID 可能是 opencode 或 opencode-go；请按本机 opencode.json 中已有的 ID 调整。',
      '// 不要删除原有的 API Key、登录信息或其他 Provider 配置。',
      '// 代理关闭或 TokenMonitor 退出后，请恢复原配置或关闭测速。',
    ].join('\n');
  }

  private loadConfig(): ProxyConfigFile {
    if (existsSync(this.configPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as Partial<ProxyConfigFile>;
        if (typeof parsed.secret === 'string' && parsed.secret.length >= 16) {
          return {
            secret: parsed.secret,
            port: typeof parsed.port === 'number' ? parsed.port : null,
          };
        }
      } catch {
        // Generate a new config below.
      }
    }
    return { port: null, secret: randomBytes(24).toString('hex') };
  }

  private saveConfig(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (error) {
      this.logger.error('Could not save speed proxy config.', error);
    }
  }
}

export function speedSampleDayKey(ts: number): string {
  return localDayKey(ts);
}
