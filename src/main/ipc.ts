import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/api';
import type { AppController } from './appController';
import type { WindowManager } from './windowManager';

const settingsPatchSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  language: z.enum(['zh-CN', 'en']).optional(),
  refreshMinutes: z.number().int().min(1).max(60).optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      remainingThresholds: z.array(z.number().min(0).max(100)).max(4).optional(),
      rateLimited: z.boolean().optional(),
      reset: z.boolean().optional(),
      pace: z.boolean().optional(),
    })
    .optional(),
  launchAtLogin: z.boolean().optional(),
  startHidden: z.boolean().optional(),
  hideOnBlur: z.boolean().optional(),
  trayShowRemaining: z.boolean().optional(),
  localUsageEnabled: z.boolean().optional(),
  localDataPath: z.string().max(2000).nullable().optional(),
  credentialSource: z.enum(['auto', 'manual']).optional(),
  orgId: z.string().max(300).optional(),
  onboardingCompleted: z.boolean().optional(),
  windowBounds: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().min(320).max(2000),
      height: z.number().min(400).max(2000),
    })
    .nullable()
    .optional(),
});

function assertTrusted(event: IpcMainInvokeEvent, windows: WindowManager): void {
  if (!windows.isTrustedSender(event.sender.id)) {
    throw new Error('Untrusted IPC sender');
  }
}

function isAllowedExternal(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'opencode.ai' || parsed.hostname.endsWith('.opencode.ai')) return true;
    if (parsed.hostname === 'github.com' && parsed.pathname.startsWith('/steipete/CodexBar')) return true;
    if (['status.openai.com', 'status.claude.com', 'status.cursor.com', 'status.x.ai'].includes(parsed.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function registerIpc(
  controller: AppController,
  windows: WindowManager,
  quit: () => void,
): void {
  ipcMain.handle(IPC.getState, (event) => {
    assertTrusted(event, windows);
    return controller.getState();
  });

  ipcMain.handle(IPC.getAppInfo, (event) => {
    assertTrusted(event, windows);
    return controller.getAppInfo();
  });

  ipcMain.handle(IPC.refreshQuota, async (event) => {
    assertTrusted(event, windows);
    return controller.refreshQuota();
  });

  ipcMain.handle(IPC.refreshLocalUsage, async (event, range: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.enum(['today', '7d', '30d', 'all']).safeParse(range);
    if (!parsed.success) throw new Error('Invalid usage range');
    return controller.getLocalUsage(parsed.data);
  });

  ipcMain.handle(IPC.getSpeedSeries, async (event, range: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.enum(['7d', '30d']).safeParse(range);
    if (!parsed.success) throw new Error('Invalid speed range');
    return controller.getSpeedSeries(parsed.data);
  });

  ipcMain.handle(IPC.getHistoryMetrics, async (event, range: unknown, force: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.enum(['7d', '30d', 'all']).safeParse(range);
    const forceParsed = z.boolean().optional().safeParse(force);
    if (!parsed.success || !forceParsed.success) throw new Error('Invalid history range');
    return controller.getHistoryMetrics(parsed.data, forceParsed.data ?? false);
  });

  ipcMain.handle(IPC.getQuotaHistory, async (event, hours: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.number().int().min(1).max(24 * 90).safeParse(hours);
    if (!parsed.success) throw new Error('Invalid history range');
    return controller.getQuotaHistory(parsed.data);
  });

  ipcMain.handle(IPC.updateSettings, (event, patch: unknown) => {
    assertTrusted(event, windows);
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new Error('Invalid settings patch');
    return controller.updateSettings(parsed.data);
  });

  ipcMain.handle(IPC.detectCredential, (event) => {
    assertTrusted(event, windows);
    return controller.detectCredential();
  });

  ipcMain.handle(IPC.testAndSaveKey, async (event, key: unknown, orgId: unknown) => {
    assertTrusted(event, windows);
    const keyParsed = z.string().min(1).max(500).safeParse(key);
    const orgParsed = z.string().max(300).safeParse(orgId ?? '');
    if (!keyParsed.success || !orgParsed.success) throw new Error('Invalid credential');
    return controller.testAndSaveKey(keyParsed.data, orgParsed.data);
  });

  ipcMain.handle(IPC.useAutoCredential, async (event, orgId: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.string().max(300).safeParse(orgId ?? '');
    if (!parsed.success) throw new Error('Invalid organization id');
    return controller.useAutoCredential(parsed.data);
  });

  ipcMain.handle(IPC.clearCredential, (event) => {
    assertTrusted(event, windows);
    return controller.clearCredential();
  });

  ipcMain.handle(IPC.setProviderSecret, async (event, providerId: unknown, secret: unknown) => {
    assertTrusted(event, windows);
    const provider = z.enum(['codex', 'claude', 'cursor', 'zai', 'zcode']).safeParse(providerId);
    const value = z.string().min(1).max(16_000).safeParse(secret);
    if (!provider.success || !value.success) throw new Error('Invalid provider secret');
    return controller.setProviderSecret(provider.data, value.data);
  });

  ipcMain.handle(IPC.clearProviderSecret, async (event, providerId: unknown) => {
    assertTrusted(event, windows);
    const provider = z.enum(['codex', 'claude', 'cursor', 'zai', 'zcode']).safeParse(providerId);
    if (!provider.success) throw new Error('Invalid provider');
    return controller.clearProviderSecret(provider.data);
  });

  ipcMain.handle(IPC.chooseLocalDb, async (event) => {
    assertTrusted(event, windows);
    const options = {
      title: '选择 OpenCode 数据库',
      properties: ['openFile'] as const,
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const parent = windows.getMainWindow();
    const result = parent
      ? await dialog.showOpenDialog(parent, { ...options, properties: ['openFile'] })
      : await dialog.showOpenDialog({ ...options, properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    controller.updateSettings({ localDataPath: result.filePaths[0] });
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.setSpeedEnabled, async (event, enabled: unknown) => {
    assertTrusted(event, windows);
    if (typeof enabled !== 'boolean') throw new Error('Invalid speed setting');
    return controller.setSpeedEnabled(enabled);
  });

  ipcMain.handle(IPC.getSpeedConfig, (event) => {
    assertTrusted(event, windows);
    return controller.getSpeedConfig();
  });

  ipcMain.handle(IPC.testSpeedProxy, async (event) => {
    assertTrusted(event, windows);
    return controller.testSpeedProxy();
  });

  ipcMain.handle(IPC.clearSpeedSamples, async (event) => {
    assertTrusted(event, windows);
    return controller.clearSpeedSamples();
  });

  ipcMain.handle(IPC.clearQuotaHistory, (event) => {
    assertTrusted(event, windows);
    return controller.clearQuotaHistory();
  });

  const routerProtocolSchema = z.enum(['openai', 'openai-responses', 'anthropic']);
  const routerProviderKindSchema = z.enum([
    'custom',
    'openai',
    'anthropic',
    'deepseek',
    'zai',
    'opencode',
    'openrouter',
    'moonshot',
    'siliconflow',
    'groq',
    'xai',
    'google',
  ]);
  const routerProviderInputSchema = z.object({
    id: z.string().max(100).optional(),
    name: z.string().min(1).max(120),
    protocol: routerProtocolSchema,
    kind: routerProviderKindSchema,
    baseUrl: z.string().min(8).max(2000),
    apiKey: z.string().max(16_000).optional(),
    enabled: z.boolean(),
    quotaStrategyId: z.string().max(100).nullable().optional(),
    strategyConfig: z.record(z.string(), z.string()).optional(),
  });
  const routerModelInputSchema = z.object({
    id: z.string().max(100).optional(),
    providerId: z.string().min(1).max(100),
    publicName: z.string().min(1).max(200),
    upstreamName: z.string().min(1).max(200),
    enabled: z.boolean(),
  });
  const routerServicePatchSchema = z.object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1024).max(65_535).optional(),
    apiKey: z.string().max(500).optional(),
    proxyUrl: z.string().max(2000).optional(),
  });
  const routerBalancePatchSchema = z.object({
    enabled: z.boolean().optional(),
    sessionAffinity: z.boolean().optional(),
    quotaGuard: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(5).optional(),
  });
  const routerLogQuerySchema = z.object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    model: z.string().max(200).nullable().optional(),
    status: z.number().int().min(100).max(599).nullable().optional(),
    search: z.string().max(200).nullable().optional(),
  });

  ipcMain.handle(IPC.getRouterState, (event) => {
    assertTrusted(event, windows);
    return controller.getRouterState();
  });

  ipcMain.handle(IPC.listRouterProviders, (event, includeArchived: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.boolean().optional().safeParse(includeArchived);
    if (!parsed.success) throw new Error('Invalid provider filter');
    return controller.listRouterProviders(parsed.data ?? false);
  });

  ipcMain.handle(IPC.saveRouterProvider, (event, input: unknown) => {
    assertTrusted(event, windows);
    const parsed = routerProviderInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid router provider');
    return controller.saveRouterProvider(parsed.data);
  });

  ipcMain.handle(IPC.archiveRouterProvider, (event, id: unknown, archived: unknown) => {
    assertTrusted(event, windows);
    const idParsed = z.string().min(1).max(100).safeParse(id);
    const archivedParsed = z.boolean().safeParse(archived);
    if (!idParsed.success || !archivedParsed.success) throw new Error('Invalid provider archive request');
    return controller.archiveRouterProvider(idParsed.data, archivedParsed.data);
  });

  ipcMain.handle(IPC.deleteRouterProvider, (event, id: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.string().min(1).max(100).safeParse(id);
    if (!parsed.success) throw new Error('Invalid provider id');
    return controller.deleteRouterProvider(parsed.data);
  });

  ipcMain.handle(IPC.listRouterModels, (event, includeArchived: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.boolean().optional().safeParse(includeArchived);
    if (!parsed.success) throw new Error('Invalid model filter');
    return controller.listRouterModels(parsed.data ?? false);
  });

  ipcMain.handle(IPC.saveRouterModel, (event, input: unknown) => {
    assertTrusted(event, windows);
    const parsed = routerModelInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('Invalid router model');
    return controller.saveRouterModel(parsed.data);
  });

  ipcMain.handle(IPC.archiveRouterModel, (event, id: unknown, archived: unknown) => {
    assertTrusted(event, windows);
    const idParsed = z.string().min(1).max(100).safeParse(id);
    const archivedParsed = z.boolean().safeParse(archived);
    if (!idParsed.success || !archivedParsed.success) throw new Error('Invalid model archive request');
    return controller.archiveRouterModel(idParsed.data, archivedParsed.data);
  });

  ipcMain.handle(IPC.deleteRouterModel, (event, id: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.string().min(1).max(100).safeParse(id);
    if (!parsed.success) throw new Error('Invalid model id');
    return controller.deleteRouterModel(parsed.data);
  });

  ipcMain.handle(IPC.getRouterServiceConfig, (event) => {
    assertTrusted(event, windows);
    return controller.getRouterServiceConfig();
  });

  ipcMain.handle(IPC.saveRouterServiceConfig, async (event, patch: unknown) => {
    assertTrusted(event, windows);
    const parsed = routerServicePatchSchema.safeParse(patch);
    if (!parsed.success) throw new Error('Invalid router service config');
    return controller.saveRouterServiceConfig(parsed.data);
  });

  ipcMain.handle(IPC.regenerateRouterApiKey, async (event) => {
    assertTrusted(event, windows);
    return controller.regenerateRouterApiKey();
  });

  ipcMain.handle(IPC.getRouterBalance, (event) => {
    assertTrusted(event, windows);
    return controller.getRouterBalance();
  });

  ipcMain.handle(IPC.saveRouterBalance, (event, patch: unknown) => {
    assertTrusted(event, windows);
    const parsed = routerBalancePatchSchema.safeParse(patch);
    if (!parsed.success) throw new Error('Invalid router balance config');
    return controller.saveRouterBalance(parsed.data);
  });

  ipcMain.handle(IPC.getRouterUsage, (event, range: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.enum(['today', '24h', '7d', '30d']).safeParse(range);
    if (!parsed.success) throw new Error('Invalid router usage range');
    return controller.getRouterUsage(parsed.data);
  });

  ipcMain.handle(IPC.getRouterLogs, (event, query: unknown) => {
    assertTrusted(event, windows);
    const parsed = routerLogQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new Error('Invalid router log query');
    return controller.getRouterLogs(parsed.data);
  });

  ipcMain.handle(IPC.getRouterLog, (event, id: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.number().int().min(1).safeParse(id);
    if (!parsed.success) throw new Error('Invalid log id');
    return controller.getRouterLog(parsed.data);
  });

  ipcMain.handle(IPC.getRouterQuota, (event) => {
    assertTrusted(event, windows);
    return controller.getRouterQuota();
  });

  ipcMain.handle(IPC.refreshRouterQuota, async (event) => {
    assertTrusted(event, windows);
    return controller.refreshRouterQuota();
  });

  ipcMain.handle(IPC.getRouterQuotaStrategies, (event) => {
    assertTrusted(event, windows);
    return controller.getRouterQuotaStrategies();
  });

  ipcMain.handle(IPC.clearRouterLogs, (event) => {
    assertTrusted(event, windows);
    return controller.clearRouterLogs();
  });

  ipcMain.handle(IPC.openRouterWindow, (event) => {
    assertTrusted(event, windows);
    windows.showRouter();
  });

  ipcMain.handle(IPC.openSettings, (event) => {
    assertTrusted(event, windows);
    windows.showSettings();
  });

  ipcMain.handle(IPC.hideWindow, (event) => {
    assertTrusted(event, windows);
    windows.hideMain();
  });

  ipcMain.handle(IPC.openExternal, async (event, url: unknown) => {
    assertTrusted(event, windows);
    if (typeof url !== 'string' || !isAllowedExternal(url)) throw new Error('Blocked external URL');
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.setLaunchAtLogin, (event, enabled: unknown) => {
    assertTrusted(event, windows);
    if (typeof enabled !== 'boolean') throw new Error('Invalid login setting');
    return controller.setLaunchAtLogin(enabled);
  });

  ipcMain.handle(IPC.openDataFolder, async (event) => {
    assertTrusted(event, windows);
    await shell.openPath(app.getPath('userData'));
  });

  ipcMain.handle(IPC.quit, (event) => {
    assertTrusted(event, windows);
    quit();
  });
}
