import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const outDir = join(process.cwd(), 'tmp');
await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronPath,
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '0' },
});
const page = await app.firstWindow();
await page.waitForTimeout(1200);

const settingsPromise = app.waitForEvent('window', { timeout: 5000 });
await page.getByTitle('设置').first().click();
const settings = await settingsPromise;
await settings.waitForTimeout(800);
await settings.getByRole('button', { name: /精确测速/ }).click();
await settings.waitForTimeout(500);

const toggle = settings.getByRole('switch', { name: '启用精确测速' });
console.log('toggle count', await toggle.count());
await toggle.click();
await settings.waitForTimeout(1200);
await settings.screenshot({ path: join(outDir, 'ui-speed-enabled.png') });

const body = await settings.evaluate(() => document.body.innerText);
console.log(body.slice(0, 2400));

const testButton = settings.getByRole('button', { name: /测试代理/ });
if (await testButton.count()) {
  await testButton.first().click();
  await settings.waitForTimeout(500);
}
await settings.screenshot({ path: join(outDir, 'ui-speed-tested.png') });

const toggleAfter = settings.getByRole('switch', { name: '启用精确测速' });
if (await toggleAfter.count()) {
  await toggleAfter.click();
  await settings.waitForTimeout(500);
}

await app.close();
