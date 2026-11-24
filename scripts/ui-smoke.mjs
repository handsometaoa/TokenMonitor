import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const demo = process.argv.includes('--demo');
const outDir = join(process.cwd(), 'tmp');
await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: demo ? '1' : '0' },
});

const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
await page.waitForTimeout(1400);

if (demo) {
  await page.screenshot({ path: join(outDir, 'ui-demo.png') });
  await page.getByRole('button', { name: /本地用量/ }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(outDir, 'ui-demo-local.png') });
  await page.getByRole('button', { name: /TTFT/ }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, 'ui-demo-speed.png') });
} else {
  const skip = page.getByRole('button', { name: /稍后设置/ });
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForTimeout(400);
  }
  await page.getByRole('button', { name: /本地用量/ }).click();
  await page.waitForTimeout(800);
  const viewAll = page.getByRole('tab', { name: '全部', exact: true });
  if (await viewAll.count()) {
    await viewAll.first().click();
    await page.waitForTimeout(1200);
  }
  await page.screenshot({ path: join(outDir, 'ui-local-all.png') });
  const info = await page.evaluate(() => ({
    scrollTop: document.querySelector('.panel-scroll')?.scrollTop,
    scrollHeight: document.querySelector('.panel-scroll')?.scrollHeight,
    clientHeight: document.querySelector('.panel-scroll')?.clientHeight,
    theme: document.documentElement.dataset.theme,
  }));
  console.log(JSON.stringify(info, null, 2));

  const settingsButton = page.getByTitle('设置').first();
  if (await settingsButton.count()) {
    const windowPromise = app.waitForEvent('window', { timeout: 5000 }).catch(() => null);
    await settingsButton.click();
    const settings = await windowPromise;
    if (settings) {
      await settings.waitForTimeout(1000);
      await settings.screenshot({ path: join(outDir, 'ui-settings-connection.png') });
      const speedNav = settings.getByRole('button', { name: /精确测速/ });
      if (await speedNav.count()) {
        await speedNav.first().click();
        await settings.waitForTimeout(500);
        await settings.screenshot({ path: join(outDir, 'ui-settings-speed.png') });
      }
    }
  }
}

if (errors.length) console.log('RENDERER_ERRORS', JSON.stringify(errors, null, 2));
await app.close();
