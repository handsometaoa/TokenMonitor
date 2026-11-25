/**
 * Minimal structural HTTP types shared by every fetch call site (extra
 * providers, OpenCode API, router gateway). Deliberately narrower than the DOM
 * types so Electron `net.fetch`, `undici.fetch` and test doubles all satisfy
 * them without masking casts.
 */
export interface FetchRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  cache?: 'default' | 'no-store' | 'reload' | 'no-cache' | 'force-cache' | 'only-if-cached';
}

export interface FetchResponseHeaders {
  get(name: string): string | null;
  entries(): IterableIterator<[string, string]>;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers: FetchResponseHeaders;
  readonly body?: unknown;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
