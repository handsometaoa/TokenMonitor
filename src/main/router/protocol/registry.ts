import type { RouterProtocol } from '../../../shared/routerTypes';
import type { ProtocolAdapter } from './types';
import { anthropicMessagesAdapter } from './anthropicMessages';
import { openaiChatAdapter } from './openaiChat';
import { openaiResponsesAdapter } from './openaiResponses';

export const protocolAdapters: Record<RouterProtocol, ProtocolAdapter> = {
  openai: openaiChatAdapter,
  anthropic: anthropicMessagesAdapter,
  'openai-responses': openaiResponsesAdapter,
};

export function adapterFor(protocol: RouterProtocol): ProtocolAdapter {
  return protocolAdapters[protocol];
}
