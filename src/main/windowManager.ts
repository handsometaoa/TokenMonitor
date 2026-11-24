import { app, BrowserWindow, nativeTheme, Notification, screen, shell } from 'electron';
import { join } from 'node:path';
import type { AppState } from '../shared/types';

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private settingsWindow: BrowserWindow | null = null;
  private routerWindow: BrowserWindow | null = null;
  private pendingShow = false;
  private quitting = false;
  private closeNoticeShown = false;
  private readonly trustedIds = new Set<number>();

  constructor(
    private readonly getTrayBounds: () => Electron.Rectangle | null,
    private readonly getState: () => AppState,
  ) {}

  createMainWindow(): BrowserWindow {
    if (this.mainWindow) return this.mainWindow;
    const icon = join(app.getAppPath(), 'resources', 'icons', 'app.png');
    const window = new BrowserWindow({
      width: 480,
      height: 720,
      minWidth: 430,
      minHeight: 620,
      show: false,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f4f2ee',
      icon,
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    this.mainWindow = window;
    const webContentsId = window.webContents.id;
    this.trustedIds.add(webContentsId);
    window.setMenuBarVisibility(false);

    window.on('ready-to-show', () => {
      if (this.pendingShow) {
        this.pendingShow = false;
        this.showMain();
      }
    });

    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
      if (!this.closeNoticeShown) {
        this.closeNoticeShown = true;
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: 'TokenMonitor 仍在运行',
            body: '应用已最小化到系统托盘，点击托盘图标可重新打开。',
            silent: true,
          });
          notification.on('click', () => this.showMain());
          notification.show();
        }
      }
    });

    window.on('blur', () => {
      if (!this.getState().settings.hideOnBlur) return;
      if (this.settingsWindow && !this.settingsWindow.isDestroyed() && this.settingsWindow.isVisible()) return;
      setTimeout(() => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed() && !window.isFocused() && !window.webContents.isDevToolsOpened()) {
          if (!this.settingsWindow || this.settingsWindow.isDestroyed() || !this.settingsWindow.isVisible()) window.hide();
        }
      }, 120);
    });

    window.on('closed', () => {
      this.trustedIds.delete(webContentsId);
      this.mainWindow = null;
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://opencode.ai') || url.startsWith('https://console.opencode.ai')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      void window.loadURL(devUrl);
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'));
    }
    return window;
  }

  showMain(): void {
    const window = this.mainWindow ?? this.createMainWindow();
    if (!window.isVisible()) this.positionMainWindow(window);
    if (window.isMinimized()) window.restore();
    if (window.webContents.isLoading()) {
      this.pendingShow = true;
      return;
    }
    window.show();
    window.focus();
  }

  toggleMain(): void {
    const window = this.mainWindow;
    if (window && window.isVisible() && window.isFocused()) {
      window.hide();
      return;
    }
    this.showMain();
  }

  hideMain(): void {
    this.mainWindow?.hide();
  }

  showSettings(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (this.settingsWindow.isMinimized()) this.settingsWindow.restore();
      this.settingsWindow.show();
      this.settingsWindow.focus();
      return;
    }

    const window = new BrowserWindow({
      width: 900,
      height: 680,
      minWidth: 760,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f4f2ee',
      title: 'TokenMonitor 设置',
      icon: join(app.getAppPath(), 'resources', 'icons', 'app.png'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    this.settingsWindow = window;
    const webContentsId = window.webContents.id;
    this.trustedIds.add(webContentsId);
    window.once('ready-to-show', () => {
      window.show();
      window.focus();
    });
    window.on('closed', () => {
      this.trustedIds.delete(webContentsId);
      this.settingsWindow = null;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://opencode.ai') || url.startsWith('https://console.opencode.ai')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      void window.loadURL(`${devUrl}#settings`);
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'settings' });
    }
  }

  showRouter(): void {
    if (this.routerWindow && !this.routerWindow.isDestroyed()) {
      if (this.routerWindow.isMinimized()) this.routerWindow.restore();
      this.routerWindow.show();
      this.routerWindow.focus();
      return;
    }

    const window = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 980,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f4f2ee',
      title: 'TokenMonitor AI Router',
      icon: join(app.getAppPath(), 'resources', 'icons', 'app.png'),
      webPreferences: {
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    this.routerWindow = window;
    const webContentsId = window.webContents.id;
    this.trustedIds.add(webContentsId);
    window.once('ready-to-show', () => {
      window.show();
      window.focus();
    });
    window.on('closed', () => {
      this.trustedIds.delete(webContentsId);
      this.routerWindow = null;
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });

    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      void window.loadURL(`${devUrl}#router`);
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'router' });
    }
  }

  broadcast(state: AppState): void {
    for (const window of [this.mainWindow, this.settingsWindow, this.routerWindow]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('app:state-changed', state);
      }
    }
  }

  isTrustedSender(webContentsId: number): boolean {
    return this.trustedIds.has(webContentsId);
  }

  setQuitting(value: boolean): void {
    this.quitting = value;
  }

  isQuitting(): boolean {
    return this.quitting;
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  getTrayBoundsForPositioning(): Electron.Rectangle | null {
    return this.getTrayBounds();
  }

  private positionMainWindow(window: BrowserWindow): void {
    const bounds = window.getBounds();
    const trayBounds = this.getTrayBounds();
    if (!trayBounds) {
      if (window.isVisible()) return;
      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      window.setPosition(
        Math.round(area.x + (area.width - bounds.width) / 2),
        Math.round(area.y + (area.height - bounds.height) / 2),
      );
      return;
    }

    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
    const area = display.workArea;
    const margin = 8;
    const x = Math.min(
      Math.max(trayBounds.x + Math.round(trayBounds.width / 2 - bounds.width / 2), area.x + margin),
      area.x + area.width - bounds.width - margin,
    );
    const trayAtBottom = trayBounds.y + trayBounds.height / 2 > area.y + area.height / 2;
    const preferredY = trayAtBottom ? trayBounds.y - bounds.height - margin : trayBounds.y + trayBounds.height + margin;
    const y = Math.min(Math.max(preferredY, area.y + margin), area.y + area.height - bounds.height - margin);
    window.setPosition(Math.round(x), Math.round(y));
  }
}
