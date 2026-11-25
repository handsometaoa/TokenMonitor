import { createHash } from 'node:crypto';
import { asRecord } from '../../shared/validation';

/**
 * Session identity for the router.
 *
 * Headers are checked in priority order so a client-provided id always wins;
 * request metadata comes next; a fingerprint of the first user message is the
 * last resort for plain OpenAI SDK clients that have no session concept.
 * The key is stable across turns of the same conversation, which keeps upstream
 * session affinity and prompt-cache hits working.
 */
export function sessionKeyFrom(headers: Record<string, string | string[] | undefined>, body: unknown): string | null {
  for (const name of ['x-session-id', 'x-conversation-id', 'x-thread-id', 'x-opencode-session']) {
    const value = headers[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'string' && text.trim()) return `${name}:${text.trim()}`;
  }
  const record = asRecord(body);
  if (record) {
    const metadata = asRecord(record.metadata) ?? {};
    for (const value of [record.conversation_id, record.session_id, metadata.user_id, metadata.session_id]) {
      if (typeof value === 'string' && value.trim()) return `meta:${value.trim()}`;
    }
  }
  const fingerprint = fingerprintBody(body);
  return fingerprint ? `body:${fingerprint}` : null;
}

function fingerprintBody(body: unknown): string | null {
  const record = asRecord(body);
  if (!record) return null;
  let text = '';
  if (typeof record.input === 'string') text = record.input;
  if (!text && Array.isArray(record.messages)) {
    for (const message of record.messages) {
      const item = asRecord(message);
      if (!item || item.role !== 'user') continue;
      if (typeof item.content === 'string') {
        text = item.content;
        break;
      }
      if (Array.isArray(item.content)) {
        for (const part of item.content) {
          const block = asRecord(part);
          if (typeof block?.text === 'string' && block.text) {
            text = block.text;
            break;
          }
        }
      }
      if (text) break;
    }
  }
  if (!text) return null;
  return createHash('sha1').update(text.slice(0, 2000)).digest('hex').slice(0, 16);
}

/**
 * Derive a stable UUID from a session key so the same conversation keeps the
 * same OpenCode session (prompt-cache affinity) without inventing a new id per
 * request. Different conversations hash to different UUIDs.
 */
export function sessionIdFromKey(key: string): string {
  const hex = createHash('sha1').update(key).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}
