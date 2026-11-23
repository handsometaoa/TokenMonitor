import { createRequire } from 'node:module';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '1' },
});
const page = await app.firstWindow();
await page.waitForTimeout(1200);
const settingsPromise = app.waitForEvent('window', { timeout: 5000 });
await page.getByTitle('设置').first().click();
const settings = await settingsPromise;
await settings.waitForTimeout(700);
await settings.getByRole('button', { name: /多 Provider/ }).click();
await settings.waitForTimeout(500);
await settings.screenshot({ path: join(process.cwd(), 'tmp', 'ui-demo-providers.png') });
console.log((await settings.evaluate(() => document.body.innerText)).slice(0, 1600));
await app.close();
