import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'ui');
const tabs = ['Haptics', 'Audio', 'Triggers', 'Lighting', 'System'];

await mkdir(outputDir, { recursive: true });
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const app = await electron.launch({ args: ['.'], cwd: root });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.hero-card', { timeout: 10000 });
  await page.waitForTimeout(250);

  for (const tab of tabs) {
    await page.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: path.join(outputDir, `${tab.toLowerCase()}.png`),
      animations: 'disabled'
    });

    if (tab === 'Audio') {
      await page.getByRole('button', { name: 'Mic' }).click();
      await page.waitForTimeout(150);
      await page.screenshot({
        path: path.join(outputDir, 'audio-mic.png'),
        animations: 'disabled'
      });
    }
  }
} finally {
  await app.close();
}
