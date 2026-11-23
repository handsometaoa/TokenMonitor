/// <reference types="vite/client" />

import type { TokenMonitorApi } from '../../shared/api';

declare global {
  interface Window {
    tokenMonitor: TokenMonitorApi;
  }
}

export {};
