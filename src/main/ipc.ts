import { app, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC } from '../shared/api';
import { routerProtocolSchema, routerProviderKindSchema, routerUsageRangeSchema } from '../shared/routerSchemas';
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
  homeCards: z
    .object({
      quota: z.boolean().optional(),
      health: z.boolean().optional(),
      trend: z.boolean().optional(),
      recent: z.boolean().optional(),
    })
    .optional(),
  homeCardOrder: z.array(z.enum(['quota', 'health', 'trend', 'recent'])).max(4).optional(),
  quotaVisibility: z.record(z.string(), z.boolean()).optional(),
  trayShowRouterQuota: z.boolean().optional(),
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
  orbEnabled: z.boolean().optional(),
  orbTargetKey: z.string().max(100).nullable().optional(),
  orbQuotaView: z.enum(['all', 'money', 'hours', 'week', 'month']).optional(),
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

  ipcMain.handle(IPC.clearQuotaHistory, (event) => {
    assertTrusted(event, windows);
    return controller.clearQuotaHistory();
  });

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
    captureBodies: z.boolean().optional(),
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

  ipcMain.handle(IPC.renameRouterModelGroup, (event, from: unknown, to: unknown) => {
    assertTrusted(event, windows);
    const fromParsed = z.string().min(1).max(200).safeParse(from);
    const toParsed = z.string().min(1).max(200).safeParse(to);
    if (!fromParsed.success || !toParsed.success) throw new Error('Invalid model group name');
    return controller.renameRouterModelGroup(fromParsed.data, toParsed.data);
  });

  ipcMain.handle(IPC.setRouterModelGroupEnabled, (event, publicName: unknown, enabled: unknown) => {
    assertTrusted(event, windows);
    const nameParsed = z.string().min(1).max(200).safeParse(publicName);
    const enabledParsed = z.boolean().safeParse(enabled);
    if (!nameParsed.success || !enabledParsed.success) throw new Error('Invalid model group update');
    return controller.setRouterModelGroupEnabled(nameParsed.data, enabledParsed.data);
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
    const parsed = routerUsageRangeSchema.safeParse(range);
    if (!parsed.success) throw new Error('Invalid router usage range');
    return controller.getRouterUsage(parsed.data);
  });

  ipcMain.handle(IPC.getRouterActivity, (event, days: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.number().int().min(1).max(90).safeParse(days);
    if (!parsed.success) throw new Error('Invalid router activity range');
    return controller.getRouterActivity(parsed.data);
  });

  ipcMain.handle(IPC.getRouterFlow, (event, days: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.number().int().min(1).max(7).safeParse(days);
    if (!parsed.success) throw new Error('Invalid router flow range');
    return controller.getRouterFlow(parsed.data);
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

  ipcMain.handle(IPC.listRouterProviderModels, async (event, providerId: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.string().min(1).max(100).safeParse(providerId);
    if (!parsed.success) throw new Error('Invalid provider id');
    return controller.listRouterProviderModels(parsed.data);
  });

  ipcMain.handle(IPC.testRouterModels, async (event, publicName: unknown) => {
    assertTrusted(event, windows);
    const parsed = z.string().max(200).nullable().optional().safeParse(publicName ?? null);
    if (!parsed.success) throw new Error('Invalid model name');
    return controller.testRouterModels(parsed.data ?? null);
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

  ipcMain.handle(IPC.togglePanel, (event) => {
    assertTrusted(event, windows);
    windows.togglePanel(windows.getOrbBounds());
  });

  ipcMain.handle(IPC.hidePanel, (event) => {
    assertTrusted(event, windows);
    windows.hidePanel();
  });

  ipcMain.handle(IPC.orbDragStart, (event) => {
    assertTrusted(event, windows);
    windows.startOrbDrag();
  });

  ipcMain.handle(IPC.orbDragEnd, (event) => {
    assertTrusted(event, windows);
    windows.endOrbDrag();
  });

  ipcMain.handle(IPC.orbResetPosition, (event) => {
    assertTrusted(event, windows);
    windows.resetOrbPosition();
  });

  ipcMain.handle(IPC.orbContextMenu, (event) => {
    assertTrusted(event, windows);
    const orb = windows.getOrbWindow();
    if (!orb) return;
    const settings = controller.getState().settings;
    const zh = settings.language === 'zh-CN';
    const viewItem = (view: 'all' | 'money' | 'hours' | 'week' | 'month', label: string): Electron.MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: settings.orbQuotaView === view,
      click: () => {
        controller.updateSettings({ orbQuotaView: view });
      },
    });
    const menu = Menu.buildFromTemplate([
      {
        label: zh ? '展示口径' : 'Quota view',
        enabled: false,
      },
      viewItem('all', zh ? '全部窗口最低' : 'Lowest window'),
      viewItem('money', zh ? '金额' : 'Balance'),
      viewItem('hours', zh ? '5 小时窗口' : '5-hour window'),
      viewItem('week', zh ? '周窗口' : 'Weekly window'),
      viewItem('month', zh ? '月窗口' : 'Monthly window'),
      { type: 'separator' },
      {
        label: zh ? '打开面板' : 'Open dashboard',
        click: () => {
          windows.togglePanel(windows.getOrbBounds());
        },
      },
      {
        label: zh ? '设置…' : 'Settings…',
        click: () => {
          windows.showSettings();
        },
      },
      { type: 'separator' },
      {
        label: zh ? '隐藏悬浮球' : 'Hide floating orb',
        click: () => {
          controller.updateSettings({ orbEnabled: false });
        },
      },
    ]);
    menu.popup({ window: orb });
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
