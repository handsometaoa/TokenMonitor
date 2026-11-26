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

const outDir = join(process.cwd(), 'tmp');
const profile = join(outDir, `provider-settings-profile-${Date.now()}`);
await mkdir(outDir, { recursive: true });

const app = await electron.launch({
  executablePath: electronExecutablePath(),
  args: [`--user-data-dir=${profile}`, '.'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '1' },
});
try {
  // firstWindow can race with the lightweight orb window on startup.
  const page = await waitForWindow(app, 'index.html');
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(outDir, 'ui-demo-providers.png') });
  console.log((await page.evaluate(() => document.body.innerText)).slice(0, 1600));
} finally {
  await app.close();
}
