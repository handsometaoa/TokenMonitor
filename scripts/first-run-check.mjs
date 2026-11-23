import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'TokenMonitor.exe');
const app = await electron.launch({
  executablePath,
  args: [],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '0' },
});
const page = await app.firstWindow();
await page.waitForTimeout(1500);
const info = await page.evaluate(() => ({
  title: document.title,
  body: document.body.innerText.slice(0, 800),
  theme: document.documentElement.dataset.theme,
}));
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: join(process.cwd(), 'tmp', 'packaged-first-run.png') });
await app.close();
