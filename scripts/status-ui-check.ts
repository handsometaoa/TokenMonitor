import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { electronExecutablePath } from './electron-path.js';

async function waitForWindow(app: ElectronApplication, urlPart: string): Promise<Page> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = app.windows().find((window) => window.url().includes(urlPart));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Window containing "${urlPart}" did not appear.`);
}

const outDir = join(process.cwd(), 'tmp');
const profile = join(outDir, `status-ui-profile-${Date.now()}`);
await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronExecutablePath(),
  args: [`--user-data-dir=${profile}`, '.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '1' },
});
try {
  // firstWindow can race with the lightweight orb window on startup.
  const page = await waitForWindow(app, 'index.html');
  await page.waitForTimeout(1400);
  // Open the standalone panel window from the orb surface.
  const orbPage = await waitForWindow(app, 'orb.html');
  await orbPage.evaluate(() => window.tokenMonitor.togglePanel());
  const panelPage = await waitForWindow(app, 'panel.html');
  await panelPage.locator('.panel-scroll').waitFor({ timeout: 5000 });
  await panelPage.evaluate(() => {
    const scroll = document.querySelector('.panel-scroll');
    if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight;
  });
  await panelPage.waitForTimeout(400);
  await panelPage.screenshot({ path: join(outDir, 'ui-demo-status.png') });
  console.log((await page.evaluate(() => document.body.innerText)).slice(-1800));
} finally {
  await app.close();
}
