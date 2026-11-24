import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { AppState, ProviderSnapshot } from '../shared/types';
import type { AppController } from './appController';
import type { WindowManager } from './windowManager';

type IconState = 'normal' | 'warn' | 'danger' | 'stale' | 'off';

export class TrayManager {
  private tray: Tray | null = null;
  private lastBounds: Electron.Rectangle | null = null;

  constructor(
    private readonly controller: AppController,
    private readonly windows: WindowManager,
    private readonly onQuit: () => void,
  ) {}

  create(): void {
    if (this.tray) return;
    const icon = this.iconFor(this.iconState(this.controller.getState()));
    this.tray = new Tray(icon);
    this.tray.setToolTip('TokenMonitor');
    this.tray.on('click', (_event, bounds) => {
      if (bounds) this.lastBounds = bounds;
      this.windows.toggleMain();
    });
    this.tray.on('right-click', () => {
      this.refreshMenu();
      if (this.tray && this.menu) this.tray.popUpContextMenu(this.menu);
    });
    this.refreshMenu();
    this.update();
  }

  private menu: Menu | null = null;

  update(): void {
    if (!this.tray) return;
    const state = this.controller.getState();
    const iconState = this.iconState(state);
    this.tray.setImage(this.iconFor(iconState));
    this.tray.setToolTip(this.tooltip(state));
    this.refreshMenu();
  }

  getBounds(): Electron.Rectangle | null {
    if (this.tray) {
      try {
        return this.tray.getBounds();
      } catch {
        return this.lastBounds;
      }
    }
    return this.lastBounds;
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const state = this.controller.getState();
    const language = state.settings.language;
    const zh = language === 'zh-CN';
    const snapshot = state.quota.snapshot;
    const items: MenuItemConstructorOptions[] = [];

    items.push({
      label: state.demo ? (zh ? 'OpenCode Go（演示数据）' : 'OpenCode Go (demo)') : 'OpenCode Go',
      enabled: false,
    });

    if (snapshot) {
      for (const window of snapshot.windows) {
        const value = state.settings.trayShowRemaining ? window.remainingPercent : window.usedPercent;
        const label = state.settings.trayShowRemaining ? (zh ? '剩余' : 'left') : zh ? '已用' : 'used';
        items.push({
          label: `${this.windowLabel(window.id, zh)}  ${label} ${Math.round(value)}%`,
          enabled: false,
        });
      }
    } else if (!state.credentials.configured) {
      items.push({ label: zh ? '未配置 API Key' : 'API key not configured', enabled: false });
    } else if (state.quota.error) {
      items.push({ label: state.quota.error.message, enabled: false });
    }

    const extraProviders = state.extraProviders.filter((provider) => provider.configured);
    if (extraProviders.length) {
      items.push({ type: 'separator' });
      for (const provider of extraProviders) {
        const remaining = provider.snapshot?.windows.length
          ? Math.min(...provider.snapshot.windows.map((window) => window.remainingPercent))
          : null;
        const suffix =
          remaining === null
            ? provider.error?.code === 'not-configured'
              ? zh
                ? '未连接'
                : 'not connected'
              : zh
                ? '等待数据'
                : 'waiting'
            : `${zh ? '最低剩余' : 'lowest left'} ${Math.round(remaining)}%`;
        items.push({
          label: `${provider.providerName} · ${suffix}`,
          enabled: false,
        });
      }
    }

    items.push({ type: 'separator' });
    items.push({
      label: zh ? '打开面板' : 'Open dashboard',
      click: () => this.windows.showMain(),
    });
    items.push({
      label: `AI Router · ${
        state.router.service.state === 'running'
          ? zh
            ? `运行中 · ${state.router.usageToday.requests} 请求`
            : `running · ${state.router.usageToday.requests} req`
          : state.router.service.state === 'error'
            ? zh
              ? '异常'
              : 'error'
            : zh
              ? '已停止'
              : 'stopped'
      }`,
      enabled: false,
    });
    items.push({
      label: zh ? '立即刷新' : 'Refresh now',
      enabled: state.credentials.configured || state.demo,
      click: () => {
        void this.controller.refreshQuota();
      },
    });
    items.push({
      label: zh ? '路由控制台…' : 'AI Router…',
      click: () => this.windows.showRouter(),
    });
    items.push({
      label: zh ? '设置…' : 'Settings…',
      click: () => this.windows.showSettings(),
    });
    items.push({ type: 'separator' });
    items.push({
      label: zh ? '开机启动' : 'Launch at login',
      type: 'checkbox',
      checked: state.settings.launchAtLogin,
      click: (item) => {
        this.controller.setLaunchAtLogin(item.checked);
      },
    });
    items.push({ type: 'separator' });
    items.push({
      label: zh ? '退出 TokenMonitor' : 'Quit TokenMonitor',
      click: () => this.onQuit(),
    });

    this.menu = Menu.buildFromTemplate(items);
  }

  private tooltip(state: AppState): string {
    const zh = state.settings.language === 'zh-CN';
    const parts: string[] = [];
    parts.push(
      state.router.service.state === 'running'
        ? `${zh ? '路由' : 'Router'} ${state.router.usageToday.requests}${zh ? ' 请求' : ' req'}`
        : `${zh ? '路由' : 'Router'} ${zh ? '已停止' : 'off'}`,
    );
    const snapshot = state.quota.snapshot;
    if (snapshot) {
      for (const window of snapshot.windows) {
        const value = state.settings.trayShowRemaining ? window.remainingPercent : window.usedPercent;
        parts.push(`${this.windowLabel(window.id, zh)} ${Math.round(value)}%`);
      }
    }

    for (const provider of state.extraProviders.filter((item) => item.configured && item.snapshot)) {
      if (parts.length >= 4) break;
      const remaining = Math.min(...provider.snapshot!.windows.map((window) => window.remainingPercent));
      parts.push(`${provider.providerName} ${Math.round(remaining)}%`);
    }

    if (parts.length === 0) {
      return state.quota.error?.message ?? (zh ? 'TokenMonitor · 暂无数据' : 'TokenMonitor · no data');
    }
    const stale =
      state.quota.stale || state.extraProviders.some((provider) => provider.configured && provider.stale)
        ? zh
          ? ' · 数据过期'
          : ' · stale'
        : '';
    return `TokenMonitor · ${parts.join(' · ')}${stale}`;
  }

  private iconState(state: AppState): IconState {
    const extraConfigured = state.extraProviders.filter((provider) => provider.configured);
    if (state.router.service.state === 'error') return 'stale';
    if (!state.credentials.configured && extraConfigured.length === 0) return 'off';

    const extraWindows = extraConfigured.flatMap((provider) => provider.snapshot?.windows ?? []);
    const openCodeWindows = state.quota.snapshot?.windows ?? [];
    const windows = [...openCodeWindows, ...extraWindows];
    if (windows.length === 0) {
      const hasError = Boolean(state.quota.error) || extraConfigured.some((provider) => provider.error);
      return hasError ? 'stale' : 'off';
    }
    const stale =
      state.quota.stale ||
      Boolean(state.quota.error) ||
      extraConfigured.some((provider) => provider.stale || Boolean(provider.snapshot && provider.error));
    if (stale) return 'stale';
    if (windows.some((window) => window.status === 'rate-limited' || window.remainingPercent <= 5)) return 'danger';
    if (state.serviceStatuses.some((status) => status.indicator === 'major' || status.indicator === 'critical')) {
      return 'danger';
    }
    if (windows.some((window) => window.remainingPercent <= 20)) return 'warn';
    if (state.serviceStatuses.some((status) => status.indicator === 'minor' || status.incidentCount > 0)) {
      return 'warn';
    }
    return 'normal';
  }

  private iconFor(state: IconState): Electron.NativeImage {
    const base = join(app.getAppPath(), 'resources', 'icons');
    const candidates = [
      join(base, `tray-${state}.ico`),
      join(base, `tray-${state}.png`),
      join(base, '@2x', `tray-${state}.png`),
      join(base, 'tray-normal.png'),
    ];
    for (const candidate of candidates) {
      try {
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) return image;
      } catch {
        // Try next.
      }
    }
    return nativeImage.createEmpty();
  }

  private windowLabel(id: 'rolling' | 'weekly' | 'monthly', zh: boolean): string {
    if (zh) return id === 'rolling' ? '5 小时' : id === 'weekly' ? '每周' : '每月';
    return id === 'rolling' ? '5-hour' : id === 'weekly' ? 'Weekly' : 'Monthly';
  }
}
