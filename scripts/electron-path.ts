import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function electronExecutablePath(): string {
  const value: unknown = require('electron');
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Unable to resolve the Electron executable path.');
  }
  return value;
}
