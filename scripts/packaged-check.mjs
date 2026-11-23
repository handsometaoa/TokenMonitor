import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const outDir = join(process.cwd(), 'tmp');
await mkdir(outDir, { recursive: true });
const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'TokenMonitor.exe');
const real = process.argv.includes('--real');

const app = await electron.launch({
  executablePath,
  args: real ? [] : ['--demo'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '0' },
});
const page = await app.firstWindow();
await page.waitForTimeout(1500);

const mainInfo = await app.evaluate(async ({ app, nativeImage }) => {
  const base = `${app.getAppPath()}/resources/icons`;
  const ico = nativeImage.createFromPath(`${base}/tray-normal.ico`);
  const png = nativeImage.createFromPath(`${base}/tray-normal.png`);
  return {
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    version: app.getVersion(),
    packaged: app.isPackaged,
    icoEmpty: ico.isEmpty(),
    pngEmpty: png.isEmpty(),
    pngSize: png.getSize(),
  };
});
console.log(JSON.stringify(mainInfo, null, 2));

await page.getByRole('button', { name: /本地用量/ }).click();
await page.waitForTimeout(500);
const all = page.getByRole('tab', { name: '全部', exact: true });
if (await all.count()) await all.first().click();
await page.waitForTimeout(1200);
const body = await page.evaluate(() => document.body.innerText.slice(0, 1600));
console.log('LOCAL_BODY\n' + body);
await page.screenshot({ path: join(outDir, 'packaged-local.png') });

await app.close();
