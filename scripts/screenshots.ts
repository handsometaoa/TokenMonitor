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

// Capture docs screenshots from the demo build: mock quota / usage / speed data,
// no real network. Output goes to tmp/shots/; copy the keepers into docs/screenshots/.
const outDir = join(process.cwd(), 'tmp', 'shots');
const profile = join(process.cwd(), 'tmp', `shots-profile-${Date.now()}`);
await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronExecutablePath(),
  args: [`--user-data-dir=${profile}`, '.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '1' },
});

try {
  // firstWindow can race with the lightweight orb window on startup; the
  // router console is always the index.html page.
  const page = await waitForWindow(app, 'index.html');
  await page.waitForTimeout(1800);
  await page.evaluate(() => window.tokenMonitor.updateSettings({ onboardingCompleted: true }));
  await page.waitForTimeout(600);

  const nav = async (name: string, settle: number, file: string): Promise<void> => {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(settle);
    await page.screenshot({ path: join(outDir, file) });
    console.log('captured', file);
  };

  await nav('概览', 900, 'router-overview.png');
  await nav('提供商', 900, 'router-providers.png');
  await nav('模型路由', 900, 'router-models.png');
  await nav('本地网关', 900, 'router-service.png');
  await nav('请求日志', 900, 'router-logs.png');
  await nav('用量统计', 1100, 'router-usage.png');
  await nav('余量', 1100, 'router-quota.png');

  // App settings overlay shares the main window.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, 'settings.png') });
  console.log('captured settings.png');
  await page.getByRole('button', { name: '返回路由台' }).click();
  await page.waitForTimeout(300);

  // The Token panel is its own window now: toggle it from the orb surface.
  const orbPage = await waitForWindow(app, 'orb.html');
  await orbPage.evaluate(() => window.tokenMonitor.togglePanel());
  const panelPage = await waitForWindow(app, 'panel.html');
  await panelPage.locator('.panel-shell').waitFor({ timeout: 5000 });
  await panelPage.waitForTimeout(800);
  await panelPage.screenshot({ path: join(outDir, 'panel-home.png') });
  console.log('captured panel-home.png');

  await panelPage.getByRole('button', { name: '额度', exact: true }).click();
  await panelPage.waitForTimeout(800);
  await panelPage.screenshot({ path: join(outDir, 'panel-quota.png') });
  console.log('captured panel-quota.png');

  await panelPage.evaluate(() => window.tokenMonitor.hidePanel());
  await page.waitForTimeout(400);

  // Orb close-up; the window background is transparent.
  await orbPage.screenshot({ path: join(outDir, 'orb.png'), omitBackground: true });
  console.log('captured orb.png');

  console.log('Screenshots written to', outDir);
} finally {
  await app.close();
}
