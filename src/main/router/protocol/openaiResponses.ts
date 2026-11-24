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
  emptyUsage,
  finishReason,
  numberValue,
  parseArguments,
  stringValue,
  totalTokens,
} from './types';

function responseId(): string {
  return `resp_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function itemId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function parseInputContent(value: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : '';
      if (url) parts.push({ type: 'image', url });
    }
  }
  return parts;
}

function parseTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const tool = raw as Record<string, unknown>;
    if (tool.type !== 'function') {
      throw new ProtocolError(`Unsupported tool type: ${stringValue(tool.type)}`);
    }
    const name = stringValue(tool.name);
    if (!name) return [];
    return [{ name, description: stringValue(tool.description), parameters: tool.parameters ?? { type: 'object', properties: {} } }];
  });
}

function parseToolChoice(value: unknown): Conversation['toolChoice'] {
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (value && typeof value === 'object') {
    const choice = value as Record<string, unknown>;
    const name = stringValue(choice.name);
    if (name) return { name };
  }
  return null;
}

function parseRequest(body: Record<string, unknown>): Conversation {
  const system: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) system.push(body.instructions);
  const messages: ConversationMessage[] = [];
  const input = body.input;
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: [{ type: 'text', text: input }], toolCalls: [] });
  } else if (Array.isArray(input)) {
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const type = stringValue(item.type);
      if (type === 'message' || (!type && item.role)) {
        const role = stringValue(item.role);
        const content = parseInputContent(item.content);
        if (role === 'system' || role === 'developer') {
          system.push(content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
        } else if (role === 'assistant') {
          messages.push({ role: 'assistant', content, toolCalls: [] });
        } else {
          messages.push({ role: 'user', content, toolCalls: [] });
        }
      } else if (type === 'function_call') {
        const id = stringValue(item.call_id) || stringValue(item.id) || `call_${randomUUID().slice(0, 12)}`;
        const name = stringValue(item.name);
        if (name) {
          const call: ToolCall = { id, name, arguments: parseArguments(item.arguments) };
          const last = messages[messages.length - 1];
          if (last && last.role === 'assistant') last.toolCalls.push(call);
          else messages.push({ role: 'assistant', content: [], toolCalls: [call] });
        }
      } else if (type === 'function_call_output') {
        const id = stringValue(item.call_id);
        if (id) {
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                result: { toolCallId: id, content: stringValue(item.output) },
              },
            ],
            toolCalls: [],
          });
        }
      }
    }
  }

  const reasoning = body.reasoning && typeof body.reasoning === 'object'
    ? (body.reasoning as Record<string, unknown>)
    : {};
  return {
    stream: body.stream === true,
    system,
    messages,
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p),
    maxOutputTokens: numberValue(body.max_output_tokens),
    stop: [],
    reasoningEffort: stringValue(reasoning.effort) || null,
  };
}

function buildRequest(conversation: Conversation, model: string): { body: unknown; stream: boolean } {
  const input: unknown[] = [];
  for (const message of conversation.messages) {
    if (message.role === 'user') {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'input_text', text: part.text });
        else if (part.type === 'image') content.push({ type: 'input_image', image_url: part.url });
        else if (part.type === 'tool_result') {
          input.push({ type: 'function_call_output', call_id: part.result.toolCallId, output: part.result.content });
        }
      }
      if (content.length > 0) input.push({ type: 'message', role: 'user', content });
    } else {
      const content: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'output_text', text: part.text });
      }
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content });
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }
  }

  const body: Record<string, unknown> = {
    model,
    input,
    stream: conversation.stream,
    store: false,
  };
  if (conversation.system.length > 0) body.instructions = conversation.system.join('\n\n');
  if (conversation.tools.length > 0) {
    body.tools = conversation.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    body.tool_choice =
      conversation.toolChoice === 'required'
        ? 'required'
        : conversation.toolChoice === 'none'
          ? 'none'
          : conversation.toolChoice && typeof conversation.toolChoice === 'object'
            ? { type: 'function', name: conversation.toolChoice.name }
            : 'auto';
  }
  if (conversation.maxOutputTokens !== null) body.max_output_tokens = conversation.maxOutputTokens;
  if (conversation.temperature !== null) body.temperature = conversation.temperature;
  if (conversation.topP !== null) body.top_p = conversation.topP;
  if (conversation.reasoningEffort) body.reasoning = { effort: conversation.reasoningEffort };
  return { body, stream: conversation.stream };
}

function usageOf(raw: unknown): ApiUsage {
  const usage = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? (usage.input_tokens_details as Record<string, unknown>)
    : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? (usage.output_tokens_details as Record<string, unknown>)
    : {};
  const input = numberValue(usage.input_tokens) ?? 0;
  const cached = numberValue(inputDetails.cached_tokens) ?? 0;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: numberValue(usage.output_tokens) ?? 0,
    reasoningTokens: numberValue(outputDetails.reasoning_tokens) ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

function decodeResponse(payload: unknown): Completion {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const output = Array.isArray(data.output) ? data.output : [];
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const raw of output) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part || typeof part !== 'object') continue;
        const block = part as Record<string, unknown>;
        if (block.type === 'output_text' && typeof block.text === 'string') text.push(block.text);
        if (block.type === 'refusal' && typeof block.refusal === 'string') text.push(block.refusal);
      }
    }
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (part && typeof part === 'object') reasoning.push(stringValue((part as Record<string, unknown>).text));
      }
    }
    if (item.type === 'function_call') {
      const name = stringValue(item.name);
      if (name) {
        toolCalls.push({
          id: stringValue(item.call_id) || stringValue(item.id) || `call_${randomUUID().slice(0, 12)}`,
          name,
          arguments: parseArguments(item.arguments),
        });
      }
    }
  }
  let reason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  if (data.status === 'incomplete') {
    const details = data.incomplete_details && typeof data.incomplete_details === 'object'
      ? (data.incomplete_details as Record<string, unknown>)
      : {};
    if (details.reason === 'max_output_tokens') reason = 'length';
  }
  if (data.status === 'failed') reason = 'error';
  return {
    content: text.join(''),
    reasoning: reasoning.join(''),
    toolCalls,
    finishReason: reason,
    usage: usageOf(data.usage),
  };
}

function createStreamDecoder(onEvent: (event: StreamEvent) => void) {
  const parser = new SseParser();
  let finished = false;
  let reason: FinishReason = 'stop';
  let usage = emptyUsage();
  const items = new Map<string, { id: string; name: string; started: boolean }>();

  const finish = () => {
    if (finished) return;
    finished = true;
    for (const item of items.values()) {
      if (item.started) onEvent({ type: 'tool_end', id: item.id });
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
    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      onEvent({ type: 'text', text: payload.delta });
      return;
    }
    if (
      (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
      typeof payload.delta === 'string'
    ) {
      onEvent({ type: 'reasoning', text: payload.delta });
      return;
    }
    if (type === 'response.refusal.delta' && typeof payload.delta === 'string') {
      onEvent({ type: 'text', text: payload.delta });
      return;
    }
    if (type === 'response.output_item.added') {
      const item = payload.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : {};
      if (item.type === 'function_call') {
        const id = stringValue(item.call_id) || stringValue(item.id) || `call_${randomUUID().slice(0, 12)}`;
        const name = stringValue(item.name);
        if (name) {
          items.set(stringValue(item.id), { id, name, started: true });
          onEvent({ type: 'tool_start', id, name });
        }
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
      const item = items.get(stringValue(payload.item_id));
      if (item) onEvent({ type: 'tool_delta', id: item.id, arguments: payload.delta });
      return;
    }
    if (type === 'response.output_item.done') {
      const item = payload.item && typeof payload.item === 'object' ? (payload.item as Record<string, unknown>) : {};
      if (item.type === 'function_call') {
        const id = stringValue(item.call_id) || stringValue(item.id);
        const existing = items.get(stringValue(item.id));
        if (existing) {
          onEvent({ type: 'tool_end', id: existing.id });
          items.delete(stringValue(item.id));
        } else if (id) {
          onEvent({ type: 'tool_end', id });
        }
      }
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = payload.response && typeof payload.response === 'object'
        ? (payload.response as Record<string, unknown>)
        : payload;
      usage = usageOf(response.usage);
      if (type === 'response.incomplete') {
        const details = response.incomplete_details && typeof response.incomplete_details === 'object'
          ? (response.incomplete_details as Record<string, unknown>)
          : {};
        if (details.reason === 'max_output_tokens') reason = 'length';
      }
      finish();
      return;
    }
    if (type === 'response.failed') {
      const response = payload.response && typeof payload.response === 'object'
        ? (payload.response as Record<string, unknown>)
        : {};
      const error = response.error && typeof response.error === 'object'
        ? (response.error as Record<string, unknown>)
        : {};
      onEvent({ type: 'error', message: stringValue(error.message) || 'Upstream response failed' });
      reason = 'error';
      finish();
      return;
    }
    if (type === 'error') {
      const error = payload.error && typeof payload.error === 'object'
        ? (payload.error as Record<string, unknown>)
        : payload;
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
  const output: unknown[] = [];
  if (completion.reasoning) {
    output.push({
      type: 'reasoning',
      id: itemId('rs'),
      summary: [{ type: 'summary_text', text: completion.reasoning }],
    });
  }
  if (completion.content) {
    output.push({
      type: 'message',
      id: itemId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: completion.content, annotations: [] }],
    });
  }
  for (const call of completion.toolCalls) {
    output.push({
      type: 'function_call',
      id: itemId('fc'),
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    });
  }
  return {
    id: responseId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: completion.finishReason === 'error' ? 'failed' : 'completed',
    model,
    output,
    usage: {
      input_tokens: completion.usage.inputTokens + completion.usage.cacheReadTokens,
      input_tokens_details: { cached_tokens: completion.usage.cacheReadTokens },
      output_tokens: completion.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: completion.usage.reasoningTokens },
      total_tokens: totalTokens(completion.usage),
    },
    error: null,
  };
}

function createClientStreamEncoder(write: (chunk: string) => void, model: string): ClientStreamEncoder {
  const id = responseId();
  const createdAt = Math.floor(Date.now() / 1000);
  let started = false;
  let finished = false;
  let outputIndex = 0;
  let current: { type: 'text' | 'reasoning' | 'tool'; id: string; text: string; callId?: string; name?: string; arguments: string } | null = null;
  const output: unknown[] = [];

  const start = () => {
    if (started) return;
    started = true;
    write(
      sseData(
        {
          type: 'response.created',
          response: {
            id,
            object: 'response',
            created_at: createdAt,
            status: 'in_progress',
            model,
            output: [],
            usage: null,
          },
        },
        'response.created',
      ),
    );
  };

  const closeCurrent = () => {
    if (!current) return;
    if (current.type === 'text') {
      write(
        sseData(
          { type: 'response.output_text.done', item_id: current.id, output_index: outputIndex, content_index: 0, text: current.text },
          'response.output_text.done',
        ),
      );
      write(
        sseData(
          { type: 'response.content_part.done', item_id: current.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: current.text, annotations: [] } },
          'response.content_part.done',
        ),
      );
      const item = {
        type: 'message',
        id: current.id,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: current.text, annotations: [] }],
      };
      output.push(item);
      write(
        sseData(
          { type: 'response.output_item.done', output_index: outputIndex, item },
          'response.output_item.done',
        ),
      );
    } else if (current.type === 'reasoning') {
      write(
        sseData(
          { type: 'response.reasoning_summary_text.done', item_id: current.id, output_index: outputIndex, summary_index: 0, text: current.text },
          'response.reasoning_summary_text.done',
        ),
      );
      const item = {
        type: 'reasoning',
        id: current.id,
        summary: [{ type: 'summary_text', text: current.text }],
      };
      output.push(item);
      write(
        sseData(
          { type: 'response.output_item.done', output_index: outputIndex, item },
          'response.output_item.done',
        ),
      );
    } else if (current.type === 'tool') {
      const item = {
        type: 'function_call',
        id: current.id,
        call_id: current.callId ?? current.id,
        name: current.name ?? '',
        arguments: current.arguments,
        status: 'completed',
      };
      output.push(item);
      write(
        sseData(
          { type: 'response.output_item.done', output_index: outputIndex, item },
          'response.output_item.done',
        ),
      );
    }
    current = null;
  };

  const open = (type: 'text' | 'reasoning' | 'tool', tool?: { id: string; name: string }) => {
    if (current && current.type === type && type !== 'tool') return;
    closeCurrent();
    start();
    outputIndex = output.length;
    if (type === 'text') {
      const item = { type: 'message', id: itemId('msg'), status: 'in_progress', role: 'assistant', content: [] };
      current = { type, id: item.id, text: '', arguments: '' };
      write(
        sseData(
          { type: 'response.output_item.added', output_index: outputIndex, item },
          'response.output_item.added',
        ),
      );
      write(
        sseData(
          { type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          'response.content_part.added',
        ),
      );
    } else if (type === 'reasoning') {
      const item = { type: 'reasoning', id: itemId('rs'), summary: [] };
      current = { type, id: item.id, text: '', arguments: '' };
      write(
        sseData(
          { type: 'response.output_item.added', output_index: outputIndex, item },
          'response.output_item.added',
        ),
      );
      write(
        sseData(
          { type: 'response.reasoning_summary_part.added', item_id: item.id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } },
          'response.reasoning_summary_part.added',
        ),
      );
    } else if (tool) {
      const item = {
        type: 'function_call',
        id: itemId('fc'),
        call_id: tool.id,
        name: tool.name,
        arguments: '',
        status: 'in_progress',
      };
      current = { type, id: item.id, text: '', callId: tool.id, name: tool.name, arguments: '' };
      write(
        sseData(
          { type: 'response.output_item.added', output_index: outputIndex, item },
          'response.output_item.added',
        ),
      );
    }
  };

  return {
    start,
    event(event) {
      if (finished) return;
      if (event.type === 'text') {
        open('text');
        if (!current) return;
        current.text += event.text;
        write(
          sseData(
            { type: 'response.output_text.delta', item_id: current.id, output_index: outputIndex, content_index: 0, delta: event.text },
            'response.output_text.delta',
          ),
        );
        return;
      }
      if (event.type === 'reasoning') {
        open('reasoning');
        if (!current) return;
        current.text += event.text;
        write(
          sseData(
            { type: 'response.reasoning_summary_text.delta', item_id: current.id, output_index: outputIndex, summary_index: 0, delta: event.text },
            'response.reasoning_summary_text.delta',
          ),
        );
        return;
      }
      if (event.type === 'tool_start') {
        open('tool', { id: event.id, name: event.name });
        return;
      }
      if (event.type === 'tool_delta') {
        if (!current || current.type !== 'tool' || current.callId !== event.id) return;
        current.arguments += event.arguments;
        write(
          sseData(
            { type: 'response.function_call_arguments.delta', item_id: current.id, output_index: outputIndex, delta: event.arguments },
            'response.function_call_arguments.delta',
          ),
        );
        return;
      }
      if (event.type === 'tool_end') {
        if (current && current.type === 'tool' && current.callId === event.id) closeCurrent();
        return;
      }
      if (event.type === 'error') {
        start();
        write(
          sseData(
            { type: 'response.failed', response: { id, status: 'failed', error: { code: 'api_error', message: event.message } } },
            'response.failed',
          ),
        );
        return;
      }
      if (event.type === 'finish') {
        if (finished) return;
        finished = true;
        start();
        closeCurrent();
        write(
          sseData(
            {
              type: 'response.completed',
              response: {
                id,
                object: 'response',
                created_at: createdAt,
                status: 'completed',
                model,
                output,
                usage: {
                  input_tokens: event.usage.inputTokens + event.usage.cacheReadTokens,
                  input_tokens_details: { cached_tokens: event.usage.cacheReadTokens },
                  output_tokens: event.usage.outputTokens,
                  output_tokens_details: { reasoning_tokens: event.usage.reasoningTokens },
                  total_tokens: totalTokens(event.usage),
                },
                error: null,
              },
            },
            'response.completed',
          ),
        );
      }
    },
    end() {
      if (!finished) {
        this.event({ type: 'finish', reason: 'stop', usage: emptyUsage() });
      }
    },
  };
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  protocol: 'openai-responses',
  upstreamPath: '/responses',
  parseRequest,
  buildRequest,
  decodeResponse,
  createStreamDecoder,
  encodeCompletion,
  encodeError(message, code) {
    return { error: { message, code: code ?? 'invalid_request' } };
  },
  createClientStreamEncoder,
  writeError(write, message) {
    write(sseData({ type: 'error', error: { code: 'api_error', message } }, 'error'));
  },
  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` };
  },
};
