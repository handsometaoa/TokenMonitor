import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { electronExecutablePath } from './electron-path.js';

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
  const page = await app.firstWindow();
  await page.waitForTimeout(1400);
  if (!(await page.locator('.router-float-panel').count())) {
    await page.locator('button[title="展开 Token 面板"]').click();
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => {
    const scroll = document.querySelector('.panel-scroll');
    if (scroll instanceof HTMLElement) scroll.scrollTop = scroll.scrollHeight;
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, 'ui-demo-status.png') });
  console.log((await page.evaluate(() => document.body.innerText)).slice(-1800));
} finally {
  await app.close();
}
