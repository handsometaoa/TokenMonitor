import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { RouterProtocol, RouterServiceConfig } from '../../shared/routerTypes';
import { asRecord, isRecord, parseJson, stringValue } from '../../shared/validation';
import type { Logger } from '../services/logger';
import type { ProviderSecretStore } from '../services/providerSecrets';
import type { FetchRequestInit, FetchResponse } from '../../shared/fetch';
import { RouterBalancer, type RouterFailureKind } from './balancer';
import { sessionIdFromKey, sessionKeyFrom } from './session';
import type { RouterRepository, RouterRoute } from './db';
import { adapterFor } from './protocol/registry';
import type { ApiUsage, Conversation, ProtocolAdapter, StreamEvent } from './protocol/types';
import { ProtocolError, emptyUsage, totalTokens } from './protocol/types';

export type RouterFetch = (input: string, init?: RouterRequestInit) => Promise<Response>;
export type RouterRequestInit = FetchRequestInit;

interface AttemptTrace {
  provider: string;
  model: string;
  status: number | null;
  error: string | null;
}

interface FinishInfo {
  status: number;
  usage: ApiUsage;
  error: string | null;
  responseBody: string | null;
  responseHeaders: Record<string, string>;
  retryTrace: AttemptTrace[];
  ttftMs?: number | null;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const FIRST_BYTE_TIMEOUT_MS = 60_000;

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-type',
  'accept',
  'accept-encoding',
  'authorization',
  'x-api-key',
  'cookie',
  'origin',
  'referer',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-dest',
]);

const SENSITIVE_LOG_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'set-cookie']);

function protocolForPath(path: string): RouterProtocol | null {
  if (path === '/v1/chat/completions') return 'openai';
  if (path === '/v1/messages') return 'anthropic';
  if (path === '/v1/responses') return 'openai-responses';
  return null;
}

/**
 * OpenCode Go advertises an OpenAI-compatible surface but additionally expects
 * `x-opencode-session` for session affinity and prompt-cache routing. Standard
 * OpenAI clients never send it, so the gateway supplies one when proxying here.
 */
function isOpenCodeTarget(route: RouterRoute): boolean {
  return route.providerKind === 'opencode' || /opencode\.ai/i.test(route.providerBaseUrl);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function clientName(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const first = userAgent.trim().split(/\s+/)[0] ?? '';
  const name = first.split('/')[0]?.trim();
  return name || null;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(char)) cjk += 1;
  }
  const other = Math.max(0, text.length - cjk);
  return cjk + Math.ceil(other / 4);
}

/** Rough per-category input composition, estimated from the parsed conversation (client side). */
interface RequestBreakdown {
  system: number;
  tools: number;
  user: number;
  toolResults: number;
  assistant: number;
}

function estimateBreakdown(conversation: Conversation): RequestBreakdown {
  let system = 0;
  for (const block of conversation.system) system += estimateTokens(block);
  let tools = 0;
  for (const tool of conversation.tools) tools += estimateTokens(JSON.stringify(tool));
  let user = 0;
  let toolResults = 0;
  let assistant = 0;
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      for (const part of message.content) {
        if (part.type === 'text') user += estimateTokens(part.text);
        else if (part.type === 'tool_result')
          toolResults += estimateTokens(
            typeof part.result.content === 'string' ? part.result.content : JSON.stringify(part.result.content ?? ''),
          );
      }
    } else {
      for (const part of message.content) {
        if (part.type === 'text') assistant += estimateTokens(part.text);
      }
      for (const call of message.toolCalls) assistant += estimateTokens(`${call.name} ${call.arguments}`);
    }
  }
  return { system, tools, user, toolResults, assistant };
}

function capture(value: string, limit = MAX_CAPTURE_BYTES): string {
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]` : value;
}

function sanitizeHeaders(headers: Record<string, string | string[] | undefined>): string {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_LOG_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.join(', ');
  }
  return JSON.stringify(result);
}

function responseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!SENSITIVE_LOG_HEADERS.has(key.toLowerCase())) result[key] = value;
  });
  return result;
}

interface ResponseBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

function responseBodyReader(body: unknown): ResponseBodyReader | null {
  const stream = asRecord(body);
  if (!stream || typeof stream.getReader !== 'function') return null;
  const reader: unknown = stream.getReader();
  const readerRecord = asRecord(reader);
  const read = readerRecord?.read;
  if (!readerRecord || typeof read !== 'function') return null;
  return {
    async read() {
      const result: unknown = await read.call(readerRecord);
      const chunk = asRecord(result);
      if (!chunk) throw new TypeError('Upstream returned an invalid stream chunk');
      return {
        done: chunk.done === true,
        value: chunk.value instanceof Uint8Array ? chunk.value : undefined,
      };
    },
  };
}

function translateUndiciResponse(source: FetchResponse): Response {
  const headers = new Headers(Object.fromEntries(source.headers.entries()));
  const reader = responseBodyReader(source.body);
  const body = reader
    ? new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else if (chunk.value) controller.enqueue(chunk.value);
        },
      })
    : null;
  return new Response(body, { status: source.status, statusText: source.statusText, headers });
}

function upstreamClientMessage(status: number, body: string): string {
  try {
    const parsed = parseJson(body);
    const record = asRecord(parsed);
    if (record) {
      const message = stringValue(record.message);
      if (message) return message;
      const nested = stringValue(asRecord(record.error)?.message);
      if (nested) return nested;
    }
  } catch {
    // Not JSON; fall through to the raw summary.
  }
  const summary = body.trim().slice(0, 240);
  return summary || `Upstream returned HTTP ${status}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ProtocolError('Request body exceeds 32MB', 'payload_too_large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function setCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

export class RouterGateway {
  private server: Server | null = null;
  private active = 0;
  private error: string | null = null;
  private startedAt: number | null = null;
  private proxy: { url: string; agent: ProxyAgent } | null = null;

  constructor(
    private readonly repo: RouterRepository,
    private readonly secrets: Pick<ProviderSecretStore, 'get'>,
    private readonly balancer: RouterBalancer,
    private readonly logger: Logger,
    private readonly fetchImpl: RouterFetch,
    private readonly getConfig: () => RouterServiceConfig,
  ) {}

  async start(): Promise<void> {
    await this.stop();
    const config = this.getConfig();
    if (!config.enabled) {
      this.error = null;
      return;
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      server.once('error', (error) => {
        this.error = error.message;
        this.logger.error('Router gateway failed to listen.', error);
        resolve();
      });
      server.listen(config.port, '127.0.0.1', () => {
        this.error = null;
        this.startedAt = Date.now();
        this.logger.info(`Router gateway listening on 127.0.0.1:${config.port}.`);
        resolve();
      });
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startedAt = null;
    if (this.proxy) {
      const agent = this.proxy.agent;
      this.proxy = null;
      await agent.close().catch(() => undefined);
    }
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  getStatus(): { running: boolean; port: number | null; error: string | null; startedAt: number | null; activeRequests: number } {
    const address = this.server?.address();
    return {
      running: Boolean(this.server?.listening),
      port: typeof address === 'object' && address ? address.port : null,
      error: this.error,
      startedAt: this.startedAt,
      activeRequests: this.active,
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const config = this.getConfig();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (!this.authorized(req, config.apiKey)) {
      this.logLocal(req, path, 401, 'invalid api key', null);
      sendJson(res, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return;
    }

    if (req.method === 'GET' && path === '/v1/models') {
      this.handleModels(res);
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
      return;
    }
    const protocol = protocolForPath(path);
    if (!protocol) {
      sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
      return;
    }

    this.active += 1;
    try {
      await this.handleCompletion(req, res, protocol, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Router error';
      this.logger.error('Router request failed.', error);
      if (!res.headersSent) {
        const status = error instanceof ProtocolError ? error.status : 500;
        sendJson(res, status, adapterFor(protocol).encodeError(message, error instanceof ProtocolError ? error.code : 'api_error'));
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      this.active = Math.max(0, this.active - 1);
    }
  }

  private authorized(req: IncomingMessage, apiKey: string): boolean {
    if (!apiKey) return false;
    const bearer = req.headers.authorization;
    const token = typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : '';
    const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
    return token === apiKey || xApiKey === apiKey;
  }

  private handleModels(res: ServerResponse): void {
    const groups = this.repo.listModelGroups();
    const data = groups
      .filter((group) => this.repo.findRoutes(group.publicName).some((route) => route.modelEnabled && route.providerEnabled))
      .map((group) => ({
        id: group.publicName,
        object: 'model',
        created: Math.floor((group.channels[0]?.createdAt ?? Date.now()) / 1000),
        owned_by: 'local-router',
      }));
    sendJson(res, 200, { object: 'list', data });
  }

  private async handleCompletion(
    req: IncomingMessage,
    res: ServerResponse,
    protocol: RouterProtocol,
    path: string,
  ): Promise<void> {
    const config = this.getConfig();
    const entryAdapter = adapterFor(protocol);
    const requestUrl = new URL(req.url ?? path, 'http://127.0.0.1');
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      const parsed = parseJson(raw.toString('utf8'));
      const record = asRecord(parsed);
      if (!record) throw new ProtocolError('Request body must be an object');
      body = record;
    } catch (error) {
      const message = error instanceof ProtocolError ? error.message : 'Invalid JSON body';
      this.logLocal(req, path, 400, message, raw.toString('utf8'));
      sendJson(res, 400, entryAdapter.encodeError(message, 'invalid_request'));
      return;
    }

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      this.logLocal(req, path, 400, 'Missing model', JSON.stringify(body));
      sendJson(res, 400, entryAdapter.encodeError('Missing model', 'invalid_request'));
      return;
    }

    const routes = this.repo.findRoutes(model);
    const enabled = routes.filter((route) => route.modelEnabled && route.providerEnabled);
    if (enabled.length === 0) {
      const message = routes.length > 0 ? `Model "${model}" is disabled` : `Model "${model}" is not mapped`;
      this.logLocal(req, path, 404, message, JSON.stringify(body));
      sendJson(res, 404, entryAdapter.encodeError(message, 'model_not_found'));
      return;
    }

    let conversation;
    try {
      conversation = entryAdapter.parseRequest(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request';
      this.logLocal(req, path, 400, message, JSON.stringify(body));
      sendJson(res, 400, entryAdapter.encodeError(message, 'invalid_request'));
      return;
    }
    const breakdown = estimateBreakdown(conversation);

    const sessionKey = sessionKeyFrom(req.headers, body);
    const balance = this.repo.getBalanceConfig();
    let candidates = this.balancer.orderCandidates(enabled, balance, sessionKey);
    if (candidates.length === 0) {
      const message = 'All mapped channels are unavailable';
      this.logLocal(req, path, 503, message, JSON.stringify(body));
      sendJson(res, 503, entryAdapter.encodeError(message, 'all_channels_unavailable'));
      return;
    }
    candidates = candidates.slice(0, Math.max(1, balance.maxAttempts));

    const requestId = randomUUID();
    const startedAt = Date.now();
    const streamWanted = body.stream === true;
    const attempts: AttemptTrace[] = [];
    let lastError = 'No upstream channel available';

    for (const route of candidates) {
      const apiKey = this.secrets.get(this.secretKey(route.providerId));
      if (!apiKey) {
        this.balancer.recordFailure(route.providerId, 'auth', '缺少 API Key');
        attempts.push({ provider: route.providerName, model: route.upstreamModel, status: null, error: '缺少 API Key' });
        lastError = `Provider ${route.providerName} has no API key`;
        continue;
      }
      const upstreamAdapter = adapterFor(route.providerProtocol);
      const sameProtocol = route.providerProtocol === protocol;
      let wireBody: unknown;
      let stream = streamWanted;
      try {
        if (sameProtocol) {
          wireBody = { ...body, model: route.upstreamModel };
        } else {
          const built = upstreamAdapter.buildRequest(conversation, route.upstreamModel);
          wireBody = built.body;
          stream = built.stream;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not build upstream request';
        attempts.push({ provider: route.providerName, model: route.upstreamModel, status: null, error: message });
        lastError = message;
        continue;
      }

      const headers = this.upstreamHeaders(req, upstreamAdapter.authHeaders(apiKey), stream);
      // OpenCode Go requires a session id. Clients may omit it (plain OpenAI SDKs
      // never send it), so fill one in rather than failing the request upstream.
      if (!headers['x-opencode-session'] && isOpenCodeTarget(route)) {
        const sessionKey = sessionKeyFrom(req.headers, body);
        headers['x-opencode-session'] = sessionKey ? sessionIdFromKey(sessionKey) : randomUUID();
      }
      const requestBodyText = JSON.stringify(wireBody);
      const url = `${joinUrl(this.providerBaseUrl(route.providerId), upstreamAdapter.upstreamPath)}${sameProtocol ? requestUrl.search : ''}`;

      let upstream: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('First byte timeout')), FIRST_BYTE_TIMEOUT_MS);
      try {
        upstream = await this.fetchUpstream(url, {
          method: 'POST',
          headers,
          body: requestBodyText,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : 'Upstream request failed';
        this.balancer.recordFailure(route.providerId, 'network', message);
        attempts.push({ provider: route.providerName, model: route.upstreamModel, status: null, error: message });
        lastError = message;
        continue;
      }
      clearTimeout(timer);

      if (upstream.status >= 400) {
        const errorText = await upstream.text().catch(() => '');
        const retryable = upstream.status === 401 || upstream.status === 403 || upstream.status === 429 || upstream.status >= 500;
        const kind: RouterFailureKind =
          upstream.status === 401 || upstream.status === 403 ? 'auth' : upstream.status === 429 ? 'quota' : 'server';
        if (retryable) this.balancer.recordFailure(route.providerId, kind, `HTTP ${upstream.status}: ${errorText.slice(0, 200)}`);
        attempts.push({
          provider: route.providerName,
          model: route.upstreamModel,
          status: upstream.status,
          error: capture(errorText, 500),
        });
        lastError = `Upstream ${route.providerName} (HTTP ${upstream.status}): ${upstreamClientMessage(upstream.status, errorText)}`;
        if (retryable) continue;
        this.finishAttempt(res, req, path, requestId, startedAt, route, {
          status: upstream.status,
          usage: emptyUsage(),
          error: lastError,
          responseBody: capture(errorText),
          responseHeaders: responseHeaders(upstream.headers),
          retryTrace: attempts,
        }, requestBodyText, body, stream, sameProtocol, entryAdapter, upstream, null, headers);
        return;
      }

      if (stream) {
        const firstByteAt = Date.now();
        const result = await this.streamUpstream(
          req,
          res,
          path,
          requestId,
          startedAt,
          route,
          upstream,
          requestBodyText,
          body,
          sameProtocol,
          entryAdapter,
          upstreamAdapter,
          attempts,
          sessionKey,
          firstByteAt - startedAt,
          breakdown,
          headers,
        );
        if (result.committed) return;
        lastError = result.error;
        continue;
      }

      const responseText = await upstream.text();
      let parsed: unknown = null;
      try {
        parsed = responseText ? parseJson(responseText) : null;
      } catch {
        parsed = null;
      }
      if (!sameProtocol && !isRecord(parsed)) {
        const message = `Upstream ${route.providerName} returned an invalid JSON response`;
        this.balancer.recordFailure(route.providerId, 'server', message);
        this.finishAttempt(
          res,
          req,
          path,
          requestId,
          startedAt,
          route,
          {
            status: 502,
            usage: emptyUsage(),
            error: message,
            responseBody: this.bodyForLog(responseText),
            responseHeaders: responseHeaders(upstream.headers),
            retryTrace: attempts,
          },
          requestBodyText,
          body,
          false,
          sameProtocol,
          entryAdapter,
          upstream,
          null,
          headers,
        );
        return;
      }
      let usage = emptyUsage();
      try {
        if (parsed) usage = upstreamAdapter.decodeResponse(parsed).usage;
      } catch {
        // Keep zero usage.
      }
      if (totalTokens(usage) === 0) {
        usage = {
          inputTokens: estimateTokens(requestBodyText),
          outputTokens: estimateTokens(responseText),
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
      }
      if (totalTokens(usage) === 0) {
        usage = { ...emptyUsage(), inputTokens: 1 };
      }
      this.balancer.recordSuccess(route.providerId);
      this.balancer.bindSession(sessionKey, route.providerId);

      let clientBody = responseText;
      let contentType = upstream.headers.get('content-type') ?? 'application/json';
      if (!sameProtocol && parsed) {
        try {
          const completion = upstreamAdapter.decodeResponse(parsed);
          clientBody = JSON.stringify(entryAdapter.encodeCompletion(route.upstreamModel, completion));
          contentType = 'application/json; charset=utf-8';
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Protocol conversion failed';
          this.balancer.recordFailure(route.providerId, 'server', message);
          this.finishAttempt(
            res,
            req,
            path,
            requestId,
            startedAt,
            route,
            {
              status: 502,
              usage: emptyUsage(),
              error: message,
              responseBody: this.bodyForLog(responseText),
              responseHeaders: responseHeaders(upstream.headers),
              retryTrace: attempts,
            },
            requestBodyText,
            body,
            false,
            sameProtocol,
            entryAdapter,
            upstream,
            null,
            headers,
          );
          return;
        }
      }
      this.repo.startLog({
        requestId,
        publicModel: model,
        providerName: route.providerName,
        upstreamModel: route.upstreamModel,
        providerId: route.providerId,
        modelId: route.modelId,
        client: clientName(req.headers['user-agent']),
        path,
        stream: false,
        requestBody: this.bodyForLog(requestBodyText),
        requestHeaders: this.logHeaders(headers),
        startedAt,
      });
      res.writeHead(upstream.status, {
        'content-type': contentType,
        'access-control-allow-origin': '*',
      });
      res.end(clientBody);
      this.repo.finishLog({
        requestId,
        status: upstream.status,
        stream: false,
        ttftMs: Date.now() - startedAt,
        breakdown,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        unrecognizedTokens: 0,
        totalTokens: totalTokens(usage),
        responseBody: this.bodyForLog(responseText),
        responseHeaders: JSON.stringify(responseHeaders(upstream.headers)),
        error: upstream.status >= 400 ? capture(responseText, 500) : null,
        retryTrace: attempts.length > 0 ? JSON.stringify(attempts) : null,
      });
      return;
    }

    this.logLocal(req, path, 502, lastError, JSON.stringify(body), attempts);
    sendJson(res, 502, entryAdapter.encodeError(lastError, 'upstream_error'));
  }

  private async streamUpstream(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    requestId: string,
    startedAt: number,
    route: RouterRoute,
    upstream: Response,
    requestBodyText: string,
    originalBody: Record<string, unknown>,
    sameProtocol: boolean,
    entryAdapter: ProtocolAdapter,
    upstreamAdapter: ProtocolAdapter,
    attempts: AttemptTrace[],
    sessionKey: string | null,
    ttftMs: number | null,
    breakdown: RequestBreakdown | null,
    headers: Record<string, string>,
  ): Promise<{ committed: boolean; error: string }> {
    const reader = upstream.body?.getReader();
    if (!reader) return { committed: false, error: 'Upstream returned no stream body' };
    let firstChunk: Uint8Array | null = null;
    try {
      while (!firstChunk) {
        const read = await reader.read();
        if (read.done) break;
        if (read.value && read.value.length > 0) firstChunk = read.value;
      }
    } catch (error) {
      return { committed: false, error: error instanceof Error ? error.message : 'Upstream stream failed' };
    }
    if (!firstChunk) {
      return { committed: false, error: 'Upstream stream ended before first chunk' };
    }

    const usage = emptyUsage();
    let responseText = '';
    const appendResponse = (text: string) => {
      if (responseText.length >= MAX_CAPTURE_BYTES) return;
      responseText += text.slice(0, MAX_CAPTURE_BYTES - responseText.length);
    };
    const decoderText = new TextDecoder();
    let finished = false;
    let clientClosed = false;

    this.repo.startLog({
      requestId,
      publicModel: typeof originalBody.model === 'string' ? originalBody.model : route.publicName,
      providerName: route.providerName,
      upstreamModel: route.upstreamModel,
      providerId: route.providerId,
      modelId: route.modelId,
      client: clientName(req.headers['user-agent']),
      path,
      stream: true,
      requestBody: this.bodyForLog(requestBodyText),
      requestHeaders: this.logHeaders(headers),
      startedAt,
    });

    res.writeHead(upstream.status, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.flushHeaders?.();

    const clientEncoder = entryAdapter.createClientStreamEncoder((chunk) => {
      if (!clientClosed && !res.writableEnded) res.write(chunk);
    }, route.upstreamModel);

    const onEvent = (event: StreamEvent) => {
      if (event.type === 'finish') {
        usage.inputTokens = event.usage.inputTokens;
        usage.outputTokens = event.usage.outputTokens;
        usage.reasoningTokens = event.usage.reasoningTokens;
        usage.cacheReadTokens = event.usage.cacheReadTokens;
        usage.cacheWriteTokens = event.usage.cacheWriteTokens;
        finished = true;
        if (!sameProtocol) clientEncoder.event(event);
        return;
      }
      if (event.type === 'error') {
        if (!sameProtocol) clientEncoder.event(event);
        return;
      }
      if (!sameProtocol) clientEncoder.event(event);
    };

    const decoder = upstreamAdapter.createStreamDecoder(onEvent);
    res.on('close', () => {
      if (!res.writableEnded) clientClosed = true;
    });

    try {
      const chunk = decoderText.decode(firstChunk);
      appendResponse(chunk);
      if (sameProtocol) res.write(firstChunk);
      decoder.push(chunk);
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        if (!read.value || read.value.length === 0) continue;
        const text = decoderText.decode(read.value);
        appendResponse(text);
        if (sameProtocol) res.write(read.value);
        decoder.push(text);
      }
      decoder.end();
      if (!sameProtocol) clientEncoder.end();
      if (!res.writableEnded) res.end();
      if (clientClosed) {
        this.repo.finishLog({
          requestId,
          status: 499,
          stream: true,
          ttftMs,
          breakdown,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          unrecognizedTokens: 0,
          totalTokens: 0,
          responseBody: responseText,
          responseHeaders: JSON.stringify(responseHeaders(upstream.headers)),
          error: 'Client disconnected',
          retryTrace: attempts.length > 0 ? JSON.stringify(attempts) : null,
        });
        return { committed: true, error: '' };
      }
      if (totalTokens(usage) === 0) {
        usage.inputTokens = estimateTokens(requestBodyText);
        usage.outputTokens = estimateTokens(responseText);
      }
      this.balancer.recordSuccess(route.providerId);
      this.balancer.bindSession(sessionKey, route.providerId);
      this.repo.finishLog({
        requestId,
        status: upstream.status,
        stream: true,
        ttftMs,
        breakdown,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        unrecognizedTokens: 0,
        totalTokens: totalTokens(usage),
        responseBody: responseText,
        responseHeaders: JSON.stringify(responseHeaders(upstream.headers)),
        error: finished ? null : 'Upstream stream ended unexpectedly',
        retryTrace: attempts.length > 0 ? JSON.stringify(attempts) : null,
      });
      return { committed: true, error: '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Upstream stream failed';
      try {
        if (!sameProtocol) clientEncoder.event({ type: 'error', message });
        else entryAdapter.writeError((chunk) => res.write(chunk), message);
      } catch {
        // Ignore write errors.
      }
      if (!res.writableEnded) res.end();
      this.repo.finishLog({
        requestId,
        status: clientClosed ? 499 : 502,
        stream: true,
        ttftMs,
        breakdown,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        reasoningTokens: 0,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        unrecognizedTokens: 0,
        totalTokens: totalTokens(usage),
        responseBody: responseText,
        responseHeaders: JSON.stringify(responseHeaders(upstream.headers)),
        error: clientClosed ? 'Client disconnected' : message,
        retryTrace: attempts.length > 0 ? JSON.stringify(attempts) : null,
      });
      return { committed: true, error: message };
    }
  }

  private finishAttempt(
    res: ServerResponse,
    req: IncomingMessage,
    path: string,
    requestId: string,
    startedAt: number,
    route: RouterRoute,
    info: FinishInfo,
    requestBodyText: string,
    originalBody: Record<string, unknown>,
    stream: boolean,
    sameProtocol: boolean,
    entryAdapter: ProtocolAdapter,
    upstream: Response,
    _parsed: unknown,
    headers: Record<string, string>,
  ): void {
    this.repo.startLog({
      requestId,
      publicModel: typeof originalBody.model === 'string' ? originalBody.model : route.publicName,
      providerName: route.providerName,
      upstreamModel: route.upstreamModel,
      providerId: route.providerId,
      modelId: route.modelId,
      client: clientName(req.headers['user-agent']),
      path,
      stream,
      requestBody: this.bodyForLog(requestBodyText),
      requestHeaders: this.logHeaders(headers),
      startedAt,
    });
    if (!sameProtocol) {
      const message = info.error ?? `Upstream ${route.providerName} returned HTTP ${info.status}`;
      sendJson(res, info.status, entryAdapter.encodeError(message, 'upstream_error'));
    } else {
      res.writeHead(info.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'access-control-allow-origin': '*',
      });
      res.end(info.responseBody ?? '');
    }
    this.repo.finishLog({
      requestId,
      status: info.status,
      stream,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unrecognizedTokens: 0,
      totalTokens: 0,
      responseBody: this.bodyForLog(info.responseBody),
      responseHeaders: JSON.stringify(info.responseHeaders),
      error: info.error,
      retryTrace: info.retryTrace.length > 0 ? JSON.stringify(info.retryTrace) : null,
    });
  }

  private logLocal(
    req: IncomingMessage,
    path: string,
    status: number,
    error: string,
    body: string | null,
    attempts: AttemptTrace[] = [],
  ): void {
    try {
      const requestId = randomUUID();
      this.repo.startLog({
        requestId,
        publicModel: '-',
        providerName: 'local-router',
        upstreamModel: '-',
        providerId: '',
        modelId: '',
        client: clientName(req.headers['user-agent']),
        path,
        stream: false,
        requestBody: this.bodyForLog(body),
        requestHeaders: sanitizeHeaders(req.headers),
      });
      this.repo.finishLog({
        requestId,
        status,
        stream: false,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        unrecognizedTokens: 0,
        totalTokens: 0,
        responseBody: null,
        responseHeaders: null,
        error,
        retryTrace: attempts.length > 0 ? JSON.stringify(attempts) : null,
      });
    } catch (logError) {
      this.logger.error('Could not write router local log.', logError);
    }
  }

  private upstreamHeaders(
    req: IncomingMessage,
    auth: Record<string, string>,
    stream: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(key.toLowerCase())) continue;
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }
    headers['content-type'] = 'application/json';
    headers.accept = stream ? 'text/event-stream' : 'application/json';
    headers['accept-encoding'] = 'identity';
    for (const [key, value] of Object.entries(auth)) headers[key] = value;
    return headers;
  }

  private logHeaders(headers: Record<string, string>): string {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (SENSITIVE_LOG_HEADERS.has(key.toLowerCase())) continue;
      sanitized[key] = value;
    }
    return JSON.stringify(sanitized);
  }

  private providerBaseUrl(providerId: string): string {
    const provider = this.repo.getProvider(providerId);
    return provider?.baseUrl ?? '';
  }

  private secretKey(providerId: string): string {
    return `router:${providerId}`;
  }

  private bodyForLog(value: string | null): string | null {
    if (!this.getConfig().captureBodies) return null;
    return value === null ? null : capture(value);
  }

  private async fetchUpstream(url: string, init: RouterRequestInit): Promise<Response> {
    const proxyUrl = this.getConfig().proxyUrl.trim();
    if (!proxyUrl) return this.fetchImpl(url, init);
    if (!this.proxy || this.proxy.url !== proxyUrl) {
      if (this.proxy) await this.proxy.agent.close().catch(() => undefined);
      this.proxy = { url: proxyUrl, agent: new ProxyAgent(proxyUrl) };
    }
    return translateUndiciResponse(await undiciFetch(url, { ...init, dispatcher: this.proxy.agent }));
  }
}
