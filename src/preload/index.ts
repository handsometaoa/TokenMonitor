import { contextBridge, ipcRenderer } from 'electron';
import { APP_NAVIGATE, IPC, type TokenMonitorApi } from '../shared/api';
import type { AppState } from '../shared/types';

const api: TokenMonitorApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  refreshQuota: () => ipcRenderer.invoke(IPC.refreshQuota),
  getQuotaHistory: (hours) => ipcRenderer.invoke(IPC.getQuotaHistory, hours),
  getRouterState: () => ipcRenderer.invoke(IPC.getRouterState),
  listRouterProviders: (includeArchived) => ipcRenderer.invoke(IPC.listRouterProviders, includeArchived),
  saveRouterProvider: (input) => ipcRenderer.invoke(IPC.saveRouterProvider, input),
  archiveRouterProvider: (id, archived) => ipcRenderer.invoke(IPC.archiveRouterProvider, id, archived),
  deleteRouterProvider: (id) => ipcRenderer.invoke(IPC.deleteRouterProvider, id),
  listRouterModels: (includeArchived) => ipcRenderer.invoke(IPC.listRouterModels, includeArchived),
  saveRouterModel: (input) => ipcRenderer.invoke(IPC.saveRouterModel, input),
  archiveRouterModel: (id, archived) => ipcRenderer.invoke(IPC.archiveRouterModel, id, archived),
  deleteRouterModel: (id) => ipcRenderer.invoke(IPC.deleteRouterModel, id),
  renameRouterModelGroup: (from, to) => ipcRenderer.invoke(IPC.renameRouterModelGroup, from, to),
  setRouterModelGroupEnabled: (publicName, enabled) =>
    ipcRenderer.invoke(IPC.setRouterModelGroupEnabled, publicName, enabled),
  listRouterProviderModels: (providerId) => ipcRenderer.invoke(IPC.listRouterProviderModels, providerId),
  testRouterModels: (publicName) => ipcRenderer.invoke(IPC.testRouterModels, publicName ?? null),
  getRouterServiceConfig: () => ipcRenderer.invoke(IPC.getRouterServiceConfig),
  saveRouterServiceConfig: (patch) => ipcRenderer.invoke(IPC.saveRouterServiceConfig, patch),
  regenerateRouterApiKey: () => ipcRenderer.invoke(IPC.regenerateRouterApiKey),
  getRouterBalance: () => ipcRenderer.invoke(IPC.getRouterBalance),
  saveRouterBalance: (patch) => ipcRenderer.invoke(IPC.saveRouterBalance, patch),
  getRouterUsage: (range) => ipcRenderer.invoke(IPC.getRouterUsage, range),
  getRouterActivity: (days) => ipcRenderer.invoke(IPC.getRouterActivity, days),
  getRouterFlow: (days) => ipcRenderer.invoke(IPC.getRouterFlow, days),
  getRouterLogs: (query) => ipcRenderer.invoke(IPC.getRouterLogs, query),
  getRouterLog: (id) => ipcRenderer.invoke(IPC.getRouterLog, id),
  getRouterQuota: () => ipcRenderer.invoke(IPC.getRouterQuota),
  refreshRouterQuota: () => ipcRenderer.invoke(IPC.refreshRouterQuota),
  getRouterQuotaStrategies: () => ipcRenderer.invoke(IPC.getRouterQuotaStrategies),
  clearRouterLogs: () => ipcRenderer.invoke(IPC.clearRouterLogs),
  openRouterWindow: () => ipcRenderer.invoke(IPC.openRouterWindow),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  detectCredential: () => ipcRenderer.invoke(IPC.detectCredential),
  testAndSaveKey: (key, orgId) => ipcRenderer.invoke(IPC.testAndSaveKey, key, orgId),
  useAutoCredential: (orgId) => ipcRenderer.invoke(IPC.useAutoCredential, orgId),
  clearCredential: () => ipcRenderer.invoke(IPC.clearCredential),
  setProviderSecret: (providerId, secret) => ipcRenderer.invoke(IPC.setProviderSecret, providerId, secret),
  clearProviderSecret: (providerId) => ipcRenderer.invoke(IPC.clearProviderSecret, providerId),
  clearQuotaHistory: () => ipcRenderer.invoke(IPC.clearQuotaHistory),
  openSettings: () => ipcRenderer.invoke(IPC.openSettings),
  hideWindow: () => ipcRenderer.invoke(IPC.hideWindow),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  openDataFolder: () => ipcRenderer.invoke(IPC.openDataFolder),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke(IPC.setLaunchAtLogin, enabled),
  quit: () => ipcRenderer.invoke(IPC.quit),
  onStateChanged: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler);
  },
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, target: 'router' | 'settings' | 'panel') => listener(target);
    ipcRenderer.on(APP_NAVIGATE, handler);
    return () => ipcRenderer.removeListener(APP_NAVIGATE, handler);
  },
};

contextBridge.exposeInMainWorld('tokenMonitor', api);
