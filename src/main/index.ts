import { app, net, powerMonitor } from 'electron';
import { AppController } from './appController';
import type { FetchLike } from './providers/opencodeGo/api';
import { registerIpc } from './ipc';
import { TrayManager } from './tray';
import { WindowManager } from './windowManager';

const demo = process.env.TOKENMONITOR_DEMO === '1' || process.argv.includes('--demo');
const launchedHidden = process.argv.includes('--hidden');
let controller: AppController | null = null;
let windows: WindowManager | null = null;
let tray: TrayManager | null = null;
let quitting = false;
let cleanedUp = false;
let initiateShutdown: (() => Promise<void>) | null = null;

app.setName('TokenMonitor');
app.setAppUserModelId('com.tokenmonitor.app');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    windows?.showMain();
  });

  app.whenReady().then(async () => {
    const baseDir = app.getPath('userData');
    const fetchImpl: FetchLike = (input, init) => net.fetch(input, init);
    const showWindow = () => windows?.showMain();

    controller = new AppController(baseDir, demo, fetchImpl, showWindow);
    windows = new WindowManager(() => tray?.getBounds() ?? null);

    const shutdown = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      quitting = true;
      windows?.setQuitting(true);
      try {
        await controller?.stop();
      } catch {
        // Continue shutting down even if a service fails to stop cleanly.
      }
      tray?.destroy();
      app.quit();
    };
    initiateShutdown = shutdown;

    const quit = async () => {
      if (quitting) return;
      await shutdown();
    };

    const currentController = controller;
    const currentWindows = windows;
    tray = new TrayManager(currentController, currentWindows, quit);

    currentWindows.createMainWindow();
    currentWindows.installApplicationMenu();
    tray.create();
    registerIpc(currentController, currentWindows, quit);

    currentController.on('state', () => {
      if (quitting) return;
      const state = currentController.getState();
      currentWindows.broadcast(state);
      tray?.update();
    });

    currentController.start();
    powerMonitor.on('resume', () => {
      void currentController.refreshQuota();
    });

    const state = currentController.getState();
    if (!launchedHidden && (!state.settings.startHidden || !state.settings.onboardingCompleted || demo)) {
      currentWindows.showMain();
    }

    if (process.env.TOKENMONITOR_OPEN_DEVTOOLS === '1') {
      currentWindows.getMainWindow()?.webContents.openDevTools({ mode: 'detach' });
    }

    currentController.logger.info(`TokenMonitor started (demo=${demo}, data=${baseDir}).`);
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });

  app.on('activate', () => {
    windows?.showMain();
  });

  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    if (initiateShutdown) {
      void initiateShutdown();
    } else {
      cleanedUp = true;
      app.quit();
    }
  });
}

process.on('uncaughtException', (error) => {
  controller?.logger.error('Uncaught exception.', error instanceof Error ? error.stack ?? error : error);
});

process.on('unhandledRejection', (reason) => {
  controller?.logger.error('Unhandled rejection.', reason instanceof Error ? reason.stack ?? reason : reason);
});
