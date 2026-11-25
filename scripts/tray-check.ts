import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

const executablePath = join(process.cwd(), 'release', 'win-unpacked', 'TokenMonitor.exe');
const app = await electron.launch({
  executablePath,
  args: ['--demo'],
  cwd: process.cwd(),
  env: { ...process.env, TOKENMONITOR_DEMO: '0' },
});
try {
  const page = await app.firstWindow();
  await page.waitForTimeout(1200);
  console.log('window visible', await page.evaluate(() => document.visibilityState));
  await page.evaluate(() => window.tokenMonitor.hideWindow());
  console.log('hidden');
  await new Promise((resolve) => setTimeout(resolve, 120_000));
} finally {
  await app.close();
}
