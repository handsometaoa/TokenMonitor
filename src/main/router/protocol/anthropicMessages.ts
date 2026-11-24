import { randomUUID } from 'node:crypto';
import { SseParser, sseData } from './sse';
import {
  type ApiUsage,
  type ClientStreamEncoder,
  type Completion,
  type Conversation,
  type ConversationMessage,
  type FinishReason,
  type ProtocolAdapter,
  ProtocolError,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
  dataUrlToAnthropicSource,
  emptyUsage,
  finishReason,
  numberValue,
  parseArguments,
  stringValue,
} from './types';

function messageId(): string {
  return `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function parseSystem(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const block = item as Record<string, unknown>;
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  });
}

function parseBlocks(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function parseTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const tool = item as Record<string, unknown>;
    const name = stringValue(tool.name);
    if (!name) return [];
    return [{ name, description: stringValue(tool.description), parameters: tool.input_schema ?? { type: 'object', properties: {} } }];
  });
}

function parseToolChoice(value: unknown): Conversation['toolChoice'] {
  if (!value || typeof value !== 'object') return null;
  const choice = value as Record<string, unknown>;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool') {
    const name = stringValue(choice.name);
    return name ? { name } : null;
  }
  return null;
}

function parseRequest(body: Record<string, unknown>): Conversation {
  if (!Array.isArray(body.messages)) throw new ProtocolError('messages must be an array');
  const system = parseSystem(body.system);
  const messages: ConversationMessage[] = [];
  for (const raw of body.messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, unknown>;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const parts: ConversationMessage['content'] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of parseBlocks(message.content)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && block.source && typeof block.source === 'object') {
        const source = block.source as Record<string, unknown>;
        if (source.type === 'base64' && typeof source.data === 'string') {
          const media = stringValue(source.media_type) || 'image/png';
          parts.push({ type: 'image', url: `data:${media};base64,${source.data}` });
        } else if (source.type === 'url' && typeof source.url === 'string') {
          parts.push({ type: 'image', url: source.url });
        }
      } else if (block.type === 'tool_use') {
        const id = stringValue(block.id) || `call_${randomUUID().slice(0, 12)}`;
        const name = stringValue(block.name);
        if (name) toolCalls.push({ id, name, arguments: parseArguments(block.input) });
      } else if (block.type === 'tool_result') {
        const id = stringValue(block.tool_use_id);
        if (id) {
          const content = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((item) => (item && typeof item === 'object' ? stringValue((item as Record<string, unknown>).text) : '')).join('')
              : '';
          parts.push({ type: 'tool_result', result: { toolCallId: id, content } });
        }
      }
    }
    messages.push({ role, content: parts, toolCalls });
  }
  const thinking = body.thinking && typeof body.thinking === 'object' ? (body.thinking as Record<string, unknown>) : {};
  const budget = numberValue(thinking.budget_tokens);
  return {
    stream: body.stream === true,
    system,
    messages,
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p),
    maxOutputTokens: numberValue(body.max_tokens),
    stop: Array.isArray(body.stop_sequences)
      ? body.stop_sequences.filter((item): item is string => typeof item === 'string')
      : [],
    reasoningEffort: budget === null ? null : budget >= 10_000 ? 'high' : budget >= 4_096 ? 'medium' : 'low',
  };
}

function buildRequest(conversation: Conversation, model: string): { body: unknown; stream: boolean } {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  for (const message of conversation.messages) {
    const content: unknown[] = [];
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text });
      }
      for (const call of message.toolCalls) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          const source = dataUrlToAnthropicSource(part.url);
          if (source) content.push({ type: 'image', source });
          else content.push({ type: 'image', source: { type: 'url', url: part.url } });
        } else if (part.type === 'tool_result') {
          content.push({
            type: 'tool_result',
            tool_use_id: part.result.toolCallId,
            content: part.result.content,
          });
        }
      }
    }
    if (content.length > 0) messages.push({ role: message.role, content });
  }

  let maxTokens = conversation.maxOutputTokens ?? 4096;
  let thinking: Record<string, unknown> | null = null;
  if (conversation.reasoningEffort) {
    const budget = conversation.reasoningEffort === 'high' ? 10_000 : conversation.reasoningEffort === 'medium' ? 4_096 : 1_024;
    thinking = { type: 'enabled', budget_tokens: budget };
    maxTokens = Math.max(maxTokens, budget + 1_024);
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: conversation.stream,
  };
  if (conversation.system.length > 0) body.system = conversation.system.join('\n\n');
  if (conversation.tools.length > 0) {
    body.tools = conversation.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    if (conversation.toolChoice === 'auto') body.tool_choice = { type: 'auto' };
    else if (conversation.toolChoice === 'required') body.tool_choice = { type: 'any' };
    else if (conversation.toolChoice && typeof conversation.toolChoice === 'object') {
      body.tool_choice = { type: 'tool', name: conversation.toolChoice.name };
    }
  }
  if (!thinking) {
    if (conversation.temperature !== null) body.temperature = conversation.temperature;
    if (conversation.topP !== null) body.top_p = conversation.topP;
  } else {
    body.thinking = thinking;
  }
  if (conversation.stop.length > 0) body.stop_sequences = conversation.stop;
  return { body, stream: conversation.stream };
}

function mapStopReason(value: unknown): FinishReason {
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'refusal') return 'content_filter';
  return finishReason(value);
}

function usageOf(raw: unknown): ApiUsage {
  const usage = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    inputTokens: numberValue(usage.input_tokens) ?? 0,
    outputTokens: numberValue(usage.output_tokens) ?? 0,
    reasoningTokens: 0,
    cacheReadTokens: numberValue(usage.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: numberValue(usage.cache_creation_input_tokens) ?? 0,
  };
}

function decodeResponse(payload: unknown): Completion {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'thinking' && typeof block.thinking === 'string') thinking.push(block.thinking);
    if (block.type === 'tool_use') {
      const name = stringValue(block.name);
      if (name) {
        toolCalls.push({
          id: stringValue(block.id) || `call_${randomUUID().slice(0, 12)}`,
          name,
          arguments: parseArguments(block.input),
        });
      }
    }
  }
  return {
    content: text.join(''),
    reasoning: thinking.join(''),
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : mapStopReason(data.stop_reason),
    usage: usageOf(data.usage),
  };
}

function createStreamDecoder(onEvent: (event: StreamEvent) => void) {
  const parser = new SseParser();
  let finished = false;
  let reason: FinishReason = 'stop';
  let usage = emptyUsage();
  const toolBlocks = new Map<number, { id: string; name: string }>();

  const finish = () => {
    if (finished) return;
    finished = true;
    for (const tool of toolBlocks.values()) {
      onEvent({ type: 'tool_end', id: tool.id });
    }
    onEvent({ type: 'finish', reason, usage });
  };

  const handle = (message: { event: string | null; data: string }) => {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message.data) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      payload = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = message.event ?? stringValue(payload.type);
    if (type === 'message_start') {
      const messageData = payload.message && typeof payload.message === 'object'
        ? (payload.message as Record<string, unknown>)
        : {};
      usage = { ...usage, ...usageOf(messageData.usage) };
      return;
    }
    if (type === 'content_block_start') {
      const index = numberValue(payload.index) ?? 0;
      const block = payload.content_block && typeof payload.content_block === 'object'
        ? (payload.content_block as Record<string, unknown>)
        : {};
      if (block.type === 'tool_use') {
        const id = stringValue(block.id) || `call_${index}`;
        const name = stringValue(block.name);
        toolBlocks.set(index, { id, name });
        if (name) onEvent({ type: 'tool_start', id, name });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const index = numberValue(payload.index) ?? 0;
      const delta = payload.delta && typeof payload.delta === 'object'
        ? (payload.delta as Record<string, unknown>)
        : {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        onEvent({ type: 'text', text: delta.text });
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        onEvent({ type: 'reasoning', text: delta.thinking });
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const tool = toolBlocks.get(index);
        if (tool) onEvent({ type: 'tool_delta', id: tool.id, arguments: delta.partial_json });
      }
      return;
    }
    if (type === 'content_block_stop') {
      const index = numberValue(payload.index) ?? 0;
      const tool = toolBlocks.get(index);
      if (tool) {
        onEvent({ type: 'tool_end', id: tool.id });
        toolBlocks.delete(index);
      }
      return;
    }
    if (type === 'message_delta') {
      const delta = payload.delta && typeof payload.delta === 'object'
        ? (payload.delta as Record<string, unknown>)
        : {};
      if (delta.stop_reason) reason = mapStopReason(delta.stop_reason);
      if (payload.usage) {
        const next = usageOf(payload.usage);
        if (next.inputTokens > 0) usage.inputTokens = next.inputTokens;
        if (next.outputTokens > 0) usage.outputTokens = next.outputTokens;
        if (next.cacheReadTokens > 0) usage.cacheReadTokens = next.cacheReadTokens;
        if (next.cacheWriteTokens > 0) usage.cacheWriteTokens = next.cacheWriteTokens;
      }
      return;
    }
    if (type === 'message_stop') {
      finish();
      return;
    }
    if (type === 'error') {
      const error = payload.error && typeof payload.error === 'object'
        ? (payload.error as Record<string, unknown>)
        : {};
      onEvent({ type: 'error', message: stringValue(error.message) || 'Upstream error' });
      reason = 'error';
      finish();
    }
  };

  return {
    push(chunk: string) {
      for (const message of parser.push(chunk)) handle(message);
    },
    end() {
      for (const message of parser.end()) handle(message);
      finish();
    },
  };
}

function encodeCompletion(model: string, completion: Completion): unknown {
  const content: unknown[] = [];
  if (completion.reasoning) content.push({ type: 'thinking', thinking: completion.reasoning, signature: '' });
  if (completion.content) content.push({ type: 'text', text: completion.content });
  for (const call of completion.toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.name, input });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason:
      completion.toolCalls.length > 0
        ? 'tool_use'
        : completion.finishReason === 'length'
          ? 'max_tokens'
          : completion.finishReason === 'content_filter'
            ? 'refusal'
            : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage.inputTokens,
      output_tokens: completion.usage.outputTokens,
      cache_read_input_tokens: completion.usage.cacheReadTokens,
      cache_creation_input_tokens: completion.usage.cacheWriteTokens,
    },
  };
}

function createClientStreamEncoder(write: (chunk: string) => void, model: string): ClientStreamEncoder {
  const id = messageId();
  let started = false;
  let finished = false;
  let blockIndex = -1;
  let blockType: 'text' | 'thinking' | 'tool' | null = null;
  let toolId = '';

  const start = () => {
    if (started) return;
    started = true;
    write(
      sseData(
        {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        'message_start',
      ),
    );
  };

  const closeBlock = () => {
    if (blockType === null) return;
    write(sseData({ type: 'content_block_stop', index: blockIndex }, 'content_block_stop'));
    blockType = null;
    toolId = '';
  };

  const openBlock = (type: 'text' | 'thinking' | 'tool', tool?: { id: string; name: string }) => {
    if (blockType === type && type !== 'tool') return;
    closeBlock();
    start();
    blockIndex += 1;
    blockType = type;
    if (type === 'text') {
      write(
        sseData(
          { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } },
          'content_block_start',
        ),
      );
    } else if (type === 'thinking') {
      write(
        sseData(
          { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking', thinking: '' } },
          'content_block_start',
        ),
      );
    } else if (tool) {
      toolId = tool.id;
      write(
        sseData(
          {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
          },
          'content_block_start',
        ),
      );
    }
  };

  return {
    start,
    event(event) {
      if (finished) return;
      if (event.type === 'text') {
        openBlock('text');
        write(
          sseData(
            { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: event.text } },
            'content_block_delta',
          ),
        );
        return;
      }
      if (event.type === 'reasoning') {
        openBlock('thinking');
        write(
          sseData(
            { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: event.text } },
            'content_block_delta',
          ),
        );
        return;
      }
      if (event.type === 'tool_start') {
        openBlock('tool', { id: event.id, name: event.name });
        return;
      }
      if (event.type === 'tool_delta') {
        if (blockType !== 'tool' || toolId !== event.id) return;
        write(
          sseData(
            { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: event.arguments } },
            'content_block_delta',
          ),
        );
        return;
      }
      if (event.type === 'tool_end') {
        if (blockType === 'tool' && toolId === event.id) closeBlock();
        return;
      }
      if (event.type === 'error') {
        start();
        write(
          sseData(
            { type: 'error', error: { type: 'api_error', message: event.message } },
            'error',
          ),
        );
        return;
      }
      if (event.type === 'finish') {
        if (finished) return;
        finished = true;
        start();
        closeBlock();
        write(
          sseData(
            {
              type: 'message_delta',
              delta: {
                stop_reason:
                  event.reason === 'length'
                    ? 'max_tokens'
                    : event.reason === 'tool_calls'
                      ? 'tool_use'
                      : event.reason === 'content_filter'
                        ? 'refusal'
                        : 'end_turn',
                stop_sequence: null,
              },
              usage: { output_tokens: event.usage.outputTokens },
            },
            'message_delta',
          ),
        );
        write(sseData({ type: 'message_stop' }, 'message_stop'));
      }
    },
    end() {
      if (!finished) {
        this.event({ type: 'finish', reason: 'stop', usage: emptyUsage() });
      }
    },
  };
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: 'anthropic',
  upstreamPath: '/messages',
  parseRequest,
  buildRequest,
  decodeResponse,
  createStreamDecoder,
  encodeCompletion,
  encodeError(message, code) {
    return {
      type: 'error',
      error: { type: code ?? 'invalid_request_error', message },
    };
  },
  createClientStreamEncoder,
  writeError(write, message) {
    write(sseData({ type: 'error', error: { type: 'api_error', message } }, 'error'));
  },
  authHeaders(apiKey) {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  },
};
