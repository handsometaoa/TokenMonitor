import { describe, expect, it } from 'vitest';
import { anthropicMessagesAdapter } from '../src/main/router/protocol/anthropicMessages';
import { openaiChatAdapter } from '../src/main/router/protocol/openaiChat';
import { openaiResponsesAdapter } from '../src/main/router/protocol/openaiResponses';
import { sseData } from '../src/main/router/protocol/sse';
import type { StreamEvent } from '../src/main/router/protocol/types';

function decodeEvents(
  adapter: typeof openaiChatAdapter | typeof anthropicMessagesAdapter | typeof openaiResponsesAdapter,
  messages: Array<{ event: string; payload: unknown }>,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const decoder = adapter.createStreamDecoder((event) => events.push(event));
  decoder.push(messages.map(({ event, payload }) => sseData(payload, event)).join(''));
  decoder.end();
  return events;
}

describe('protocol external boundaries', () => {
  it('excludes array-shaped records while preserving unknown tool schemas', () => {
    const chat = openaiChatAdapter.parseRequest({
      messages: [[], { role: 'assistant', content: [[]], tool_calls: [[]] }],
      tools: [[], { type: 'function', function: { name: 'chat_tool', parameters: ['schema'] } }],
    });
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.toolCalls).toEqual([]);
    expect(chat.tools[0]?.parameters).toEqual(['schema']);

    const anthropic = anthropicMessagesAdapter.parseRequest({
      messages: [[], { role: 'user', content: [[]] }],
      tools: [[], { name: 'anthropic_tool', input_schema: ['schema'] }],
    });
    expect(anthropic.messages).toHaveLength(1);
    expect(anthropic.tools[0]?.parameters).toEqual(['schema']);

    const responses = openaiResponsesAdapter.parseRequest({
      input: [[], { type: 'message', role: 'user', content: [[]] }],
      tools: [[], { type: 'function', name: 'responses_tool', parameters: false }],
    });
    expect(responses.messages).toHaveLength(1);
    expect(responses.tools[0]?.parameters).toBe(false);
  });

  it('keeps intentional finite fractional and negative number handling', () => {
    const conversation = openaiChatAdapter.parseRequest({
      messages: [],
      temperature: -0.5,
      top_p: 0.25,
      max_tokens: 0,
    });
    expect(conversation.temperature).toBe(-0.5);
    expect(conversation.topP).toBe(0.25);
    expect(conversation.maxOutputTokens).toBe(0);
  });

  it('reports readable stream errors for array-shaped error values', () => {
    const chat = decodeEvents(openaiChatAdapter, [{ event: '', payload: { error: ['bad'] } }]);
    const anthropic = decodeEvents(anthropicMessagesAdapter, [{ event: 'error', payload: { error: [] } }]);
    const responses = decodeEvents(openaiResponsesAdapter, [{ event: 'error', payload: { error: [] } }]);
    expect(chat).toContainEqual({ type: 'error', message: 'Upstream error' });
    expect(anthropic).toContainEqual({ type: 'error', message: 'Upstream error' });
    expect(responses).toContainEqual({ type: 'error', message: 'Upstream error' });
  });

  it('does not collide streamed Responses function calls that omit IDs', () => {
    const events = decodeEvents(openaiResponsesAdapter, [
      {
        event: 'response.output_item.added',
        payload: { output_index: 0, item: { type: 'function_call', name: 'first' } },
      },
      {
        event: 'response.function_call_arguments.delta',
        payload: { output_index: 0, delta: '{"first":1}' },
      },
      {
        event: 'response.output_item.added',
        payload: { output_index: 1, item: { type: 'function_call', name: 'second' } },
      },
      {
        event: 'response.function_call_arguments.delta',
        payload: { output_index: 1, delta: '{"second":2}' },
      },
      {
        event: 'response.output_item.done',
        payload: { output_index: 0, item: { type: 'function_call', name: 'first' } },
      },
      {
        event: 'response.output_item.done',
        payload: { output_index: 1, item: { type: 'function_call', name: 'second' } },
      },
    ]);
    const starts = events.filter((event): event is Extract<StreamEvent, { type: 'tool_start' }> => event.type === 'tool_start');
    const ids = new Map(starts.map((event) => [event.name, event.id]));
    expect(ids.size).toBe(2);
    expect(new Set(ids.values()).size).toBe(2);
    expect(events).toContainEqual({ type: 'tool_delta', id: ids.get('first'), arguments: '{"first":1}' });
    expect(events).toContainEqual({ type: 'tool_delta', id: ids.get('second'), arguments: '{"second":2}' });
    const ends = events.filter((event): event is Extract<StreamEvent, { type: 'tool_end' }> => event.type === 'tool_end');
    expect(new Set(ends.map((event) => event.id))).toEqual(new Set(ids.values()));
  });
});
