import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { electronExecutablePath } from './electron-path.js';

const outDir = join(process.cwd(), 'tmp');
const profile = join(outDir, `ui-speed-profile-${Date.now()}`);
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
  if (await page.locator('.router-float-panel').count()) {
    await page.locator('button[title="收起面板"]').first().click();
    await page.waitForTimeout(300);
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(700);

  const speedNav = page.getByRole('button', { name: /精确测速/ });
  if (await speedNav.count()) {
    await speedNav.first().click();
    await page.waitForTimeout(500);
    const toggle = page.getByRole('switch', { name: '启用精确测速' });
    console.log('toggle count', await toggle.count());
    await toggle.click();
    await page.waitForTimeout(1000);
  } else {
    console.log('Precise speed controls are not present in this build; capturing settings instead.');
  }
  await page.screenshot({ path: join(outDir, 'ui-speed-enabled.png') });
  console.log((await page.evaluate(() => document.body.innerText)).slice(0, 2400));
} finally {
  await app.close();
}
