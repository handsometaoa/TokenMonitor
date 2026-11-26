import { app, BrowserWindow, Menu, nativeTheme, Notification, screen, shell } from 'electron';
import { join } from 'node:path';
import type { AppSettings, AppState, OrbPosition } from '../shared/types';
import { APP_NAVIGATE } from '../shared/api';

const isMac = process.platform === 'darwin';

const ORB_SIZE = 64;
const PANEL_WIDTH = 470;
const PANEL_HEIGHT = 680;

type RendererPage = 'index' | 'orb' | 'panel';

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private orbWindow: BrowserWindow | null = null;
  private panelWindow: BrowserWindow | null = null;
  private orbDragTimer: NodeJS.Timeout | null = null;
  private orbDragOffset: { x: number; y: number } | null = null;
  private pendingShow = false;
  private quitting = false;
  private closeNoticeShown = false;
  private readonly trustedIds = new Set<number>();

  /** Wired in index.ts; persists the orb position after a drag ends. */
  orbPositionPersist: ((position: OrbPosition) => void) | null = null;

  constructor(
    private readonly getTrayBounds: () => Electron.Rectangle | null,
    private readonly getSettings: () => AppSettings,
  ) {}

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
      webPreferences: this.webPreferences(),
    });
    this.mainWindow = window;
    this.trust(window);
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
      this.trustedIds.delete(window.webContents.id);
      this.mainWindow = null;
    });

    this.guardNavigation(window);
    this.loadPage(window, 'index');
    return window;
  }

  /**
   * Always-on-top floating orb: a small transparent circle showing live speed
   * and/or provider quota. Not focusable so clicking it never steals focus
   * from (or blurs) the expanded panel.
   */
  createOrbWindow(): BrowserWindow {
    if (this.orbWindow) return this.orbWindow;
    const window = new BrowserWindow({
      width: ORB_SIZE,
      height: ORB_SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences: this.webPreferences(),
    });
    this.orbWindow = window;
    this.trust(window);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    window.on('ready-to-show', () => {
      if (!window.isDestroyed() && !window.isVisible()) window.showInactive();
    });

    window.on('closed', () => {
      this.trustedIds.delete(window.webContents.id);
      this.orbWindow = null;
    });

    this.guardNavigation(window);
    this.loadPage(window, 'orb');

    const saved = this.getSettings().orbPosition;
    if (saved) this.placeOrb(window, saved.x, saved.y);
    else {
      const spot = this.defaultOrbSpot();
      this.placeOrb(window, spot.x, spot.y);
    }
    return window;
  }

  applyOrbVisibility(enabled: boolean): void {
    if (!enabled) {
      this.orbWindow?.hide();
      return;
    }
    const window = this.orbWindow ?? this.createOrbWindow();
    if (!window.isVisible() && !window.webContents.isLoading()) window.showInactive();
  }

  getOrbBounds(): Electron.Rectangle | null {
    const window = this.orbWindow;
    if (!window || window.isDestroyed() || !window.isVisible()) return null;
    return window.getBounds();
  }

  /**
   * Main-process drag loop: while the renderer reports a drag, poll the cursor
   * every ~10ms and pin the orb to it. This follows the cursor exactly —
   * per-event IPC from the renderer is far too laggy to feel attached.
   */
  startOrbDrag(): void {
    const window = this.orbWindow;
    if (!window || this.orbDragTimer) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    this.orbDragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    this.orbDragTimer = setInterval(() => {
      const target = this.orbWindow;
      if (!target || target.isDestroyed() || !target.isVisible() || !this.orbDragOffset) {
        this.stopOrbDragLoop();
        return;
      }
      const point = screen.getCursorScreenPoint();
      this.placeOrb(target, point.x - this.orbDragOffset.x, point.y - this.orbDragOffset.y);
    }, 10);
    this.orbDragTimer.unref?.();
  }

  private stopOrbDragLoop(): void {
    if (this.orbDragTimer) {
      clearInterval(this.orbDragTimer);
      this.orbDragTimer = null;
    }
    this.orbDragOffset = null;
  }

  /** Called when the renderer reports the drag ending; persists the position. */
  endOrbDrag(): void {
    this.stopOrbDragLoop();
    const window = this.orbWindow;
    if (!window || !this.orbPositionPersist) return;
    const bounds = window.getBounds();
    this.orbPositionPersist({ x: bounds.x, y: bounds.y });
  }

  resetOrbPosition(): void {
    const window = this.orbWindow;
    if (!window) return;
    const spot = this.defaultOrbSpot();
    this.placeOrb(window, spot.x, spot.y);
    this.endOrbDrag();
  }

  /** Independent panel window: anchored flyout that auto-hides on blur. */
  createPanelWindow(): BrowserWindow {
    if (this.panelWindow) return this.panelWindow;
    const window = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: true,
      title: 'TokenMonitor 面板',
      webPreferences: this.webPreferences(),
    });
    this.panelWindow = window;
    this.trust(window);

    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });

    window.on('blur', () => {
      if (!window.isDestroyed() && this.getSettings().hideOnBlur && window.isVisible()) window.hide();
    });

    window.on('closed', () => {
      this.trustedIds.delete(window.webContents.id);
      this.panelWindow = null;
    });

    this.guardNavigation(window);
    this.loadPage(window, 'panel');
    return window;
  }

  showPanel(anchor?: Electron.Rectangle | null): void {
    const window = this.panelWindow ?? this.createPanelWindow();
    if (!window.isVisible()) this.positionPanelNear(window, anchor ?? this.getTrayBounds());
    if (window.webContents.isLoading()) {
      window.once('ready-to-show', () => {
        window.show();
        window.focus();
      });
      return;
    }
    window.show();
    window.focus();
  }

  togglePanel(anchor?: Electron.Rectangle | null): void {
    const window = this.panelWindow;
    if (window && window.isVisible() && window.isFocused()) {
      window.hide();
      return;
    }
    this.showPanel(anchor);
  }

  hidePanel(): void {
    this.panelWindow?.hide();
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

  broadcast(state: AppState): void {
    for (const window of [this.mainWindow, this.panelWindow, this.orbWindow]) {
      if (window && !window.isDestroyed()) {
        window.webContents.send('app:state-changed', state);
      }
    }
  }

  /** Settings and the router both live in the single main window. */
  private navigateMainWindow(target: 'router' | 'settings'): void {
    const window = this.mainWindow ?? this.createMainWindow();
    this.showMain();
    const send = () => {
      if (!window.isDestroyed()) window.webContents.send(APP_NAVIGATE, target);
    };
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
    else send();
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

  getOrbWindow(): BrowserWindow | null {
    return this.orbWindow;
  }

  getTrayBoundsForPositioning(): Electron.Rectangle | null {
    return this.getTrayBounds();
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    };
  }

  private trust(window: BrowserWindow): void {
    this.trustedIds.add(window.webContents.id);
  }

  /** Keep every renderer inside its own page: no navigations, no window.open. */
  private guardNavigation(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
  }

  private loadPage(window: BrowserWindow, page: RendererPage): void {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      void window.loadURL(`${devUrl}/${page}.html`);
    } else {
      void window.loadFile(join(__dirname, '../renderer', `${page}.html`));
    }
  }

  private defaultOrbSpot(): OrbPosition {
    const trayBounds = this.getTrayBounds();
    const display = trayBounds
      ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
      : screen.getPrimaryDisplay();
    const area = display.workArea;
    return {
      x: area.x + area.width - ORB_SIZE - 24,
      y: area.y + 96,
    };
  }

  private placeOrb(window: BrowserWindow, x: number, y: number): void {
    const display = screen.getDisplayNearestPoint({ x: x + ORB_SIZE / 2, y: y + ORB_SIZE / 2 });
    const area = display.workArea;
    const clampedX = Math.min(Math.max(x, area.x), area.x + area.width - ORB_SIZE);
    const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - ORB_SIZE);
    window.setPosition(Math.round(clampedX), Math.round(clampedY));
  }

  /**
   * Anchor the panel around the trigger (tray icon or orb): horizontally
   * centered on the anchor, above it when the anchor sits in the lower half
   * of the display (Windows taskbar) and below it otherwise (macOS menu bar).
   */
  private positionPanelNear(window: BrowserWindow, anchor: Electron.Rectangle | null): void {
    const bounds = window.getBounds();
    const display = anchor
      ? screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y })
      : screen.getPrimaryDisplay();
    const area = display.workArea;
    const margin = 12;
    const gap = 8;

    let x: number;
    let y: number;
    if (anchor) {
      const anchorCenterY = anchor.y + anchor.height / 2;
      const below = anchorCenterY < area.y + area.height / 2;
      x = Math.round(anchor.x + anchor.width / 2 - bounds.width / 2);
      y = below ? Math.round(anchor.y + anchor.height + gap) : Math.round(anchor.y - gap - bounds.height);
    } else {
      x = Math.round(area.x + area.width - bounds.width - margin);
      y = Math.round(area.y + margin);
    }
    x = Math.min(Math.max(x, area.x + margin), area.x + area.width - bounds.width - margin);
    y = Math.min(Math.max(y, area.y + margin), area.y + area.height - bounds.height - margin);
    window.setPosition(x, y, false);
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
