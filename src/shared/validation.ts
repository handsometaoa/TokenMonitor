export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function safeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isSafeInteger(converted) ? converted : null;
  }
  return null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function nonEmptyString(value: unknown): string | null {
  const text = stringValue(value);
  return text !== null && text.trim().length > 0 ? text.trim() : null;
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
