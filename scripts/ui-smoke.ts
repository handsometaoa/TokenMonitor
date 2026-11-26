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

const demo = process.argv.includes('--demo');
const outDir = join(process.cwd(), 'tmp');
const profile = join(outDir, `smoke-profile-${Date.now()}`);
await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronExecutablePath(),
  args: [`--user-data-dir=${profile}`, '.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: demo ? '1' : '0' },
});

try {
  // firstWindow can race with the lightweight orb window on startup; the
  // router console is always the index.html page.
  const page = await waitForWindow(app, 'index.html');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.waitForTimeout(1600);

  await page.evaluate(() => window.tokenMonitor.updateSettings({ onboardingCompleted: true }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'ui-demo-router.png') });

  // The Token panel is its own window now: toggle it from the orb surface,
  // capture it, then collapse it again.
  const orbPage = await waitForWindow(app, 'orb.html');
  await orbPage.evaluate(() => window.tokenMonitor.togglePanel());
  const panelPage = await waitForWindow(app, 'panel.html');
  await panelPage.locator('.panel-shell').waitFor({ timeout: 5000 });
  await panelPage.waitForTimeout(400);
  await panelPage.screenshot({ path: join(outDir, 'ui-demo-panel-open.png') });
  await panelPage.evaluate(() => window.tokenMonitor.hidePanel());
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: '用量统计', exact: true }).click();
  await page.waitForTimeout(900);
  const slots = page.locator('.router-bar-slot');
  if (await slots.count()) {
    await slots.nth((await slots.count()) - 1).hover();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: join(outDir, 'ui-demo-usage.png') });

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'ui-demo-settings.png') });
  await page.getByRole('button', { name: '返回路由台' }).click();
  await page.waitForTimeout(300);

  if (errors.length > 0) {
    throw new Error(`Renderer errors:\n${errors.join('\n')}`);
  }
  console.log('UI smoke test passed.');
} finally {
  await app.close();
}
