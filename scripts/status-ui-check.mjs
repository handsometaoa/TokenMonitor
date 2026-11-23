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
await page.evaluate(() => {
  const scroll = document.querySelector('.panel-scroll');
  if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight;
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(process.cwd(), 'tmp', 'ui-demo-status.png') });
console.log((await page.evaluate(() => document.body.innerText)).slice(-1800));
await app.close();
