import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { electronExecutablePath } from './electron-path.js';

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
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  await page.waitForTimeout(1600);

  if (await page.locator('.router-float-panel').count()) {
    await page.screenshot({ path: join(outDir, 'ui-demo-panel.png') });
    await page.locator('button[title="收起面板"]').first().click();
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.tokenMonitor.updateSettings({ onboardingCompleted: true }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'ui-demo-router.png') });

  await page.locator('button[title="展开 Token 面板"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, 'ui-demo-panel-open.png') });
  await page.locator('button[title="收起面板"]').first().click();
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
