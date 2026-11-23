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

    items.push({ type: 'separator' });
    items.push({
      label: zh ? '打开面板' : 'Open dashboard',
      click: () => this.windows.showMain(),
    });
    items.push({
      label: zh ? '立即刷新' : 'Refresh now',
      enabled: state.credentials.configured || state.demo,
      click: () => {
        void this.controller.refreshQuota();
      },
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
    if (!state.credentials.configured) return zh ? 'TokenMonitor · 未配置 OpenCode Go Key' : 'TokenMonitor · API key not configured';
    const snapshot = state.quota.snapshot;
    if (!snapshot) {
      return state.quota.error?.message ?? (zh ? 'TokenMonitor · 暂无数据' : 'TokenMonitor · no data');
    }
    const parts = snapshot.windows.map((window) => {
      const value = state.settings.trayShowRemaining ? window.remainingPercent : window.usedPercent;
      return `${this.windowLabel(window.id, zh)} ${Math.round(value)}%`;
    });
    const stale = state.quota.stale ? (zh ? ' · 数据过期' : ' · stale') : '';
    return `TokenMonitor · ${parts.join(' · ')}${stale}`;
  }

  private iconState(state: AppState): IconState {
    if (!state.credentials.configured) return 'off';
    if (!state.quota.snapshot) return state.quota.error ? 'stale' : 'off';
    if (state.quota.stale || state.quota.error) return 'stale';
    const windows = state.quota.snapshot.windows;
    if (windows.some((window) => window.status === 'rate-limited' || window.remainingPercent <= 5)) return 'danger';
    if (windows.some((window) => window.remainingPercent <= 20)) return 'warn';
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
