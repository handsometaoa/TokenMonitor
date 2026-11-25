import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

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
try {
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

  await page.getByRole('button', { name: '用量统计', exact: true }).click();
  await page.waitForTimeout(1200);
  const body = await page.evaluate(() => document.body.innerText.slice(0, 1600));
  console.log('USAGE_BODY\n' + body);
  await page.screenshot({ path: join(outDir, 'packaged-usage.png') });
} finally {
  await app.close();
}
