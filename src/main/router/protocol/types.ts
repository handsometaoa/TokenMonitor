import type { RouterProtocol } from '../../../shared/routerTypes';
import { finiteNumber, stringValue as nullableStringValue } from '../../../shared/validation';

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface ApiUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'tool_result'; result: ToolResult };

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: ContentPart[];
  toolCalls: ToolCall[];
}

export interface Conversation {
  stream: boolean;
  system: string[];
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  toolChoice: 'auto' | 'none' | 'required' | { name: string } | null;
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  stop: string[];
  reasoningEffort: string | null;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_delta'; id: string; arguments: string }
  | { type: 'tool_end'; id: string }
  | { type: 'finish'; reason: FinishReason; usage: ApiUsage }
  | { type: 'error'; message: string };

export interface Completion {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  usage: ApiUsage;
}

export interface WireRequest {
  protocol: RouterProtocol;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  stream: boolean;
}

export interface UpstreamStreamDecoder {
  push(chunk: string): void;
  end(): void;
}

export interface ClientStreamEncoder {
  start(): void;
  event(event: StreamEvent): void;
  end(): void;
}

export interface ProtocolAdapter {
  protocol: RouterProtocol;
  upstreamPath: string;
  parseRequest(body: Record<string, unknown>): Conversation;
  buildRequest(conversation: Conversation, model: string): { body: unknown; stream: boolean };
  decodeResponse(payload: unknown): Completion;
  createStreamDecoder(onEvent: (event: StreamEvent) => void): UpstreamStreamDecoder;
  encodeCompletion(model: string, completion: Completion): unknown;
  encodeError(message: string, code?: string): unknown;
  createClientStreamEncoder(write: (chunk: string) => void, model: string): ClientStreamEncoder;
  writeError(write: (chunk: string) => void, message: string): void;
  authHeaders(apiKey: string): Record<string, string>;
}

export class ProtocolError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code = 'invalid_request', status = 400) {
    super(message);
    this.name = 'ProtocolError';
    this.status = status;
    this.code = code;
  }
}

export function emptyUsage(): ApiUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export function normalizeUsage(usage: Partial<ApiUsage> | null | undefined): ApiUsage {
  const base = emptyUsage();
  if (!usage) return base;
  base.inputTokens = finite(usage.inputTokens);
  base.outputTokens = finite(usage.outputTokens);
  base.reasoningTokens = finite(usage.reasoningTokens);
  base.cacheReadTokens = finite(usage.cacheReadTokens);
  base.cacheWriteTokens = finite(usage.cacheWriteTokens);
  return base;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function totalTokens(usage: ApiUsage): number {
  // outputTokens already includes reasoning tokens for OpenAI/Anthropic/Responses.
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function finishReason(value: unknown): FinishReason {
  if (value === 'length' || value === 'max_tokens' || value === 'max_output_tokens') return 'length';
  if (value === 'tool_calls' || value === 'tool_use') return 'tool_calls';
  if (value === 'content_filter' || value === 'refusal') return 'content_filter';
  if (value === 'error') return 'error';
  return 'stop';
}

export function stringValue(value: unknown): string {
  return nullableStringValue(value) ?? '';
}

export function numberValue(value: unknown): number | null {
  return finiteNumber(value);
}

export function parseArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' ? serialized : '{}';
    } catch {
      return '{}';
    }
  }
  return '{}';
}

export function dataUrlToAnthropicSource(url: string): Record<string, unknown> | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { type: 'base64', media_type: match[1], data: match[2] };
}
