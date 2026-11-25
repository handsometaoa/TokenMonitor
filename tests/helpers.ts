import { isRecord, parseJson } from '../src/shared/validation';

export function defined<T>(value: T | null | undefined, message = 'Expected a defined value'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function parseRecord(text: string): Record<string, unknown> {
  const value = parseJson(text);
  if (!isRecord(value)) throw new Error('Expected a JSON object');
  return value;
}

export async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('Expected a JSON object response');
  return value;
}

export function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('Expected an array');
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('Expected an object array item');
    return item;
  });
}
