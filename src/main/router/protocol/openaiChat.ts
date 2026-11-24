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
  normalizeUsage,
  numberValue,
  parseArguments,
  stringValue,
  totalTokens,
} from './types';

function completionId(): string {
  return `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function parseContent(value: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; url: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const part = item as Record<string, unknown>;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    if (part.type === 'input_text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    if (part.type === 'image_url') {
      const image = part.image_url;
      const url = typeof image === 'string' ? image : image && typeof image === 'object' ? stringValue((image as Record<string, unknown>).url) : '';
      if (url) parts.push({ type: 'image', url });
    }
  }
  return parts;
}

function parseTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const tool = item as Record<string, unknown>;
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') return [];
    const record = fn as Record<string, unknown>;
    const name = stringValue(record.name);
    if (!name) return [];
    return [{ name, description: stringValue(record.description), parameters: record.parameters ?? { type: 'object', properties: {} } }];
  });
}

function parseToolChoice(value: unknown): Conversation['toolChoice'] {
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (value && typeof value === 'object') {
    const fn = (value as Record<string, unknown>).function;
    if (fn && typeof fn === 'object') {
      const name = stringValue((fn as Record<string, unknown>).name);
      if (name) return { name };
    }
  }
  return null;
}

function parseRequest(body: Record<string, unknown>): Conversation {
  if (!Array.isArray(body.messages)) throw new ProtocolError('messages must be an array');
  const system: string[] = [];
  const messages: ConversationMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const raw of body.messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as Record<string, unknown>;
    const role = stringValue(message.role);
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string'
        ? message.content
        : parseContent(message.content).map((part) => (part.type === 'text' ? part.text : '')).join('');
      if (text) system.push(text);
      continue;
    }
    if (role === 'user') {
      const content = parseContent(message.content);
      messages.push({ role: 'user', content, toolCalls: [] });
      continue;
    }
    if (role === 'assistant') {
      const content = parseContent(message.content);
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(message.tool_calls)) {
        for (const rawCall of message.tool_calls) {
          if (!rawCall || typeof rawCall !== 'object') continue;
          const call = rawCall as Record<string, unknown>;
          const fn = call.function && typeof call.function === 'object' ? (call.function as Record<string, unknown>) : {};
          const id = stringValue(call.id) || `call_${randomUUID().slice(0, 12)}`;
          const name = stringValue(fn.name);
          if (!name) continue;
          const args = parseArguments(fn.arguments);
          toolNames.set(id, name);
          toolCalls.push({ id, name, arguments: args });
        }
      }
      messages.push({ role: 'assistant', content, toolCalls });
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const id = stringValue(message.tool_call_id) || stringValue(message.name);
      if (!id) continue;
      const content = typeof message.content === 'string'
        ? message.content
        : parseContent(message.content).map((part) => (part.type === 'text' ? part.text : '')).join('');
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', result: { toolCallId: id, content } }],
        toolCalls: [],
      });
    }
  }

  return {
    stream: body.stream === true,
    system,
    messages,
    tools: parseTools(body.tools),
    toolChoice: parseToolChoice(body.tool_choice),
    temperature: numberValue(body.temperature),
    topP: numberValue(body.top_p),
    maxOutputTokens: numberValue(body.max_completion_tokens) ?? numberValue(body.max_tokens),
    stop: typeof body.stop === 'string' ? [body.stop] : Array.isArray(body.stop) ? body.stop.filter((item): item is string => typeof item === 'string') : [],
    reasoningEffort: stringValue(body.reasoning_effort) || null,
  };
}

function buildRequest(conversation: Conversation, model: string): { body: unknown; stream: boolean } {
  const messages: Array<Record<string, unknown>> = [];
  for (const text of conversation.system) messages.push({ role: 'system', content: text });
  for (const message of conversation.messages) {
    const textParts = message.content.filter((part): part is { type: 'text'; text: string } => part.type === 'text');
    const imageParts = message.content.filter((part): part is { type: 'image'; url: string } => part.type === 'image');
    const toolResults = message.content.filter((part): part is { type: 'tool_result'; result: { toolCallId: string; content: string } } => part.type === 'tool_result');
    if (message.role === 'user') {
      for (const result of toolResults) {
        messages.push({ role: 'tool', tool_call_id: result.result.toolCallId, content: result.result.content });
      }
      const content: unknown[] = [];
      for (const part of textParts) content.push({ type: 'text', text: part.text });
      for (const part of imageParts) content.push({ type: 'image_url', image_url: { url: part.url } });
      if (content.length > 0) {
        messages.push({
          role: 'user',
          content: content.length === 1 && textParts.length === 1 && imageParts.length === 0 ? textParts[0].text : content,
        });
      }
    } else {
      const entry: Record<string, unknown> = { role: 'assistant' };
      entry.content = textParts.map((part) => part.text).join('');
      if (message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      messages.push(entry);
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: conversation.stream,
  };
  if (conversation.tools.length > 0) {
    body.tools = conversation.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice =
      conversation.toolChoice === 'required'
        ? 'required'
        : conversation.toolChoice === 'none'
          ? 'none'
          : conversation.toolChoice && typeof conversation.toolChoice === 'object'
            ? { type: 'function', function: { name: conversation.toolChoice.name } }
            : 'auto';
  }
  if (conversation.maxOutputTokens !== null) body.max_tokens = conversation.maxOutputTokens;
  if (conversation.temperature !== null) body.temperature = conversation.temperature;
  if (conversation.topP !== null) body.top_p = conversation.topP;
  if (conversation.stop.length > 0) body.stop = conversation.stop;
  if (conversation.reasoningEffort) body.reasoning_effort = conversation.reasoningEffort;
  if (conversation.stream) body.stream_options = { include_usage: true };
  return { body, stream: conversation.stream };
}

function decodeResponse(payload: unknown): Completion {
  const data = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const choice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : {};
  const message = choice.message && typeof choice.message === 'object' ? (choice.message as Record<string, unknown>) : {};
  const content = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((part) => (part && typeof part === 'object' ? stringValue((part as Record<string, unknown>).text) : '')).join('')
      : '';
  const reasoning = stringValue(message.reasoning_content) || stringValue(message.reasoning);
  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const call = raw as Record<string, unknown>;
        const fn = call.function && typeof call.function === 'object' ? (call.function as Record<string, unknown>) : {};
        const name = stringValue(fn.name);
        if (!name) return [];
        return [{ id: stringValue(call.id) || `call_${randomUUID().slice(0, 12)}`, name, arguments: parseArguments(fn.arguments) }];
      })
    : [];
  const usageRaw = data.usage && typeof data.usage === 'object' ? (data.usage as Record<string, unknown>) : {};
  const prompt = numberValue(usageRaw.prompt_tokens) ?? 0;
  const promptDetails = usageRaw.prompt_tokens_details && typeof usageRaw.prompt_tokens_details === 'object'
    ? (usageRaw.prompt_tokens_details as Record<string, unknown>)
    : {};
  const cached = numberValue(promptDetails.cached_tokens) ?? 0;
  const completion = numberValue(usageRaw.completion_tokens) ?? 0;
  const completionDetails = usageRaw.completion_tokens_details && typeof usageRaw.completion_tokens_details === 'object'
    ? (usageRaw.completion_tokens_details as Record<string, unknown>)
    : {};
  const reasoningTokens = numberValue(completionDetails.reasoning_tokens) ?? 0;
  const usage: ApiUsage = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
    reasoningTokens,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
  return {
    content,
    reasoning,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : finishReason(choice.finish_reason),
    usage,
  };
}

function createStreamDecoder(onEvent: (event: StreamEvent) => void) {
  const parser = new SseParser();
  let finished = false;
  let reason: FinishReason = 'stop';
  let usage = emptyUsage();
  const tools = new Map<number, { id: string; name: string; started: boolean; pending: string }>();

  const startTool = (index: number) => {
    const tool = tools.get(index);
    if (!tool || tool.started || !tool.name) return;
    tool.started = true;
    onEvent({ type: 'tool_start', id: tool.id, name: tool.name });
    if (tool.pending) {
      onEvent({ type: 'tool_delta', id: tool.id, arguments: tool.pending });
      tool.pending = '';
    }
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    for (const tool of tools.values()) {
      if (tool.started) onEvent({ type: 'tool_end', id: tool.id });
    }
    onEvent({ type: 'finish', reason, usage });
  };

  const handle = (data: string) => {
    if (data === '[DONE]') {
      finish();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const chunk = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    if (chunk.error) {
      const error = chunk.error as Record<string, unknown>;
      onEvent({ type: 'error', message: stringValue(error.message) || 'Upstream error' });
      reason = 'error';
      finish();
      return;
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      const usageRaw = chunk.usage as Record<string, unknown>;
      const prompt = numberValue(usageRaw.prompt_tokens) ?? 0;
      const details = usageRaw.prompt_tokens_details && typeof usageRaw.prompt_tokens_details === 'object'
        ? (usageRaw.prompt_tokens_details as Record<string, unknown>)
        : {};
      const cached = numberValue(details.cached_tokens) ?? 0;
      const completionDetails = usageRaw.completion_tokens_details && typeof usageRaw.completion_tokens_details === 'object'
        ? (usageRaw.completion_tokens_details as Record<string, unknown>)
        : {};
      usage = {
        inputTokens: Math.max(0, prompt - cached),
        outputTokens: numberValue(usageRaw.completion_tokens) ?? usage.outputTokens,
        reasoningTokens: numberValue(completionDetails.reasoning_tokens) ?? usage.reasoningTokens,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
    if (!choice) return;
    const delta = choice.delta && typeof choice.delta === 'object' ? (choice.delta as Record<string, unknown>) : {};
    const content = stringValue(delta.content);
    if (content) onEvent({ type: 'text', text: content });
    const reasoning = stringValue(delta.reasoning_content) || stringValue(delta.reasoning);
    if (reasoning) onEvent({ type: 'reasoning', text: reasoning });
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        if (!raw || typeof raw !== 'object') continue;
        const call = raw as Record<string, unknown>;
        const index = numberValue(call.index) ?? 0;
        const fn = call.function && typeof call.function === 'object' ? (call.function as Record<string, unknown>) : {};
        const existing = tools.get(index) ?? {
          id: stringValue(call.id) || `call_${index}`,
          name: '',
          started: false,
          pending: '',
        };
        if (call.id) existing.id = stringValue(call.id);
        if (fn.name) existing.name = stringValue(fn.name);
        tools.set(index, existing);
        startTool(index);
        const argumentsDelta = stringValue(fn.arguments);
        if (argumentsDelta) {
          if (existing.started) onEvent({ type: 'tool_delta', id: existing.id, arguments: argumentsDelta });
          else existing.pending += argumentsDelta;
        }
      }
    }
    if (choice.finish_reason) {
      reason = finishReason(choice.finish_reason);
    }
  };

  return {
    push(chunk: string) {
      for (const message of parser.push(chunk)) handle(message.data);
    },
    end() {
      for (const message of parser.end()) handle(message.data);
      finish();
    },
  };
}

function encodeCompletion(model: string, completion: Completion): unknown {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: completion.content || (completion.toolCalls.length > 0 ? null : ''),
  };
  if (completion.reasoning) message.reasoning_content = completion.reasoning;
  if (completion.toolCalls.length > 0) {
    message.tool_calls = completion.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id: completionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: completion.toolCalls.length > 0 ? 'tool_calls' : completion.finishReason,
      },
    ],
    usage: {
      prompt_tokens:
        completion.usage.inputTokens + completion.usage.cacheReadTokens + completion.usage.cacheWriteTokens,
      completion_tokens: completion.usage.outputTokens,
      total_tokens: totalTokens(completion.usage),
      prompt_tokens_details: { cached_tokens: completion.usage.cacheReadTokens },
      completion_tokens_details: { reasoning_tokens: completion.usage.reasoningTokens },
    },
  };
}

function createClientStreamEncoder(write: (chunk: string) => void, model: string): ClientStreamEncoder {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let started = false;
  let finished = false;
  const toolIndexes = new Map<string, { index: number; name: string }>();
  let nextToolIndex = 0;

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
    write(
      sseData({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }),
    );
  };

  return {
    start() {
      if (started) return;
      started = true;
      chunk({ role: 'assistant', content: '' });
    },
    event(event) {
      if (finished) return;
      if (!started) this.start();
      if (event.type === 'text') {
        chunk({ content: event.text });
        return;
      }
      if (event.type === 'reasoning') {
        chunk({ reasoning_content: event.text });
        return;
      }
      if (event.type === 'tool_start') {
        const index = nextToolIndex++;
        toolIndexes.set(event.id, { index, name: event.name });
        chunk({
          tool_calls: [{ index, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }],
        });
        return;
      }
      if (event.type === 'tool_delta') {
        const tool = toolIndexes.get(event.id);
        if (!tool) return;
        chunk({ tool_calls: [{ index: tool.index, function: { arguments: event.arguments } }] });
        return;
      }
      if (event.type === 'error') {
        write(sseData({ error: { message: event.message, type: 'api_error' } }));
        return;
      }
      if (event.type === 'finish') {
        finished = true;
        chunk({}, event.reason);
        write(
          sseData({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: {
              prompt_tokens: event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens,
              completion_tokens: event.usage.outputTokens,
              total_tokens: totalTokens(event.usage),
              prompt_tokens_details: { cached_tokens: event.usage.cacheReadTokens },
              completion_tokens_details: { reasoning_tokens: event.usage.reasoningTokens },
            },
          }),
        );
        write('data: [DONE]\n\n');
      }
    },
    end() {
      if (!finished) {
        this.event({ type: 'finish', reason: 'stop', usage: emptyUsage() });
      }
    },
  };
}

export const openaiChatAdapter: ProtocolAdapter = {
  protocol: 'openai',
  upstreamPath: '/chat/completions',
  parseRequest,
  buildRequest,
  decodeResponse,
  createStreamDecoder,
  encodeCompletion,
  encodeError(message, code) {
    return { error: { message, type: 'invalid_request_error', code: code ?? 'invalid_request' } };
  },
  createClientStreamEncoder,
  writeError(write, message) {
    write(sseData({ error: { message, type: 'api_error' } }));
  },
  authHeaders(apiKey) {
    return { authorization: `Bearer ${apiKey}` };
  },
};
