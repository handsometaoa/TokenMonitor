export interface SseMessage {
  event: string | null;
  data: string;
}

export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replaceAll('\r\n', '\n');
    const messages: SseMessage[] = [];
    let boundary = this.findBoundary();
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const message = this.parseBlock(block);
      if (message) messages.push(message);
      boundary = this.findBoundary();
    }
    return messages;
  }

  end(): SseMessage[] {
    const remainder = this.buffer.trim();
    this.buffer = '';
    if (!remainder) return [];
    const message = this.parseBlock(remainder);
    return message ? [message] : [];
  }

  private findBoundary(): number {
    const lf = this.buffer.indexOf('\n\n');
    const crlf = this.buffer.indexOf('\r\n\r\n');
    if (lf < 0 && crlf < 0) return -1;
    if (lf < 0) return crlf;
    if (crlf < 0) return lf;
    return Math.min(lf, crlf);
  }

  private parseBlock(block: string): SseMessage | null {
    const lines = block.replaceAll('\r\n', '\n').split('\n');
    let event: string | null = null;
    const data: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^\s/, ''));
      }
    }
    if (data.length === 0) return null;
    return { event, data: data.join('\n') };
  }
}

export function sseData(payload: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`;
}
