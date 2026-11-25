import { app, BrowserWindow, Menu, nativeTheme, Notification, screen, shell } from 'electron';
import { join } from 'node:path';
import type { AppState } from '../shared/types';
import { APP_NAVIGATE } from '../shared/api';

const isMac = process.platform === 'darwin';

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private pendingShow = false;
  private quitting = false;
  private closeNoticeShown = false;
  private readonly trustedIds = new Set<number>();

  constructor(private readonly getTrayBounds: () => Electron.Rectangle | null) {}

  createMainWindow(): BrowserWindow {
    if (this.mainWindow) return this.mainWindow;
    const icon = join(app.getAppPath(), 'resources', 'icons', 'app.png');
    const window = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 980,
      minHeight: 640,
      show: false,
      // macOS keeps the native traffic lights (inset over our header); other
      // platforms render the custom titlebar instead.
      ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : { frame: false }),
      resizable: true,
      skipTaskbar: false,
      hasShadow: true,
      title: 'TokenMonitor AI Router',
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
    if (isMac) window.setWindowButtonVisibility(true);

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

  /**
   * macOS needs a native application menu; without one Cmd+Q, Cmd+H and the
   * About/Edit shortcuts do nothing because the default menu is removed by
   * `setMenuBarVisibility(false)`.
   */
  installApplicationMenu(): void {
    if (!isMac) return;
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          {
            label: '设置…',
            accelerator: 'Command+,',
            click: () => this.showSettings(),
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          {
            label: '打开主窗口',
            accelerator: 'Command+0',
            click: () => this.showMain(),
          },
          { type: 'separator' },
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  showSettings(): void {
    this.navigateMainWindow('settings');
  }

  showRouter(): void {
    this.navigateMainWindow('router');
  }

  showPanel(): void {
    this.navigateMainWindow('panel');
  }

  /** Settings and the router both live in the single main window. */
  private navigateMainWindow(target: 'router' | 'settings' | 'panel'): void {
    const window = this.mainWindow ?? this.createMainWindow();
    this.showMain();
    const send = () => {
      if (!window.isDestroyed()) window.webContents.send(APP_NAVIGATE, target);
    };
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
    else send();
  }

  broadcast(state: AppState): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('app:state-changed', state);
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
    const display = trayBounds
      ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
      : screen.getPrimaryDisplay();
    const area = display.workArea;
    const margin = 16;
    // As the main interface the window is large; center it and shrink to fit
    // small work areas instead of positioning it next to the tray icon.
    const width = Math.min(bounds.width, area.width - margin * 2);
    const height = Math.min(bounds.height, area.height - margin * 2);
    if (width !== bounds.width || height !== bounds.height) window.setSize(width, height);
    window.setPosition(
      Math.round(area.x + (area.width - width) / 2),
      Math.round(area.y + (area.height - height) / 2),
    );
  }
}
