import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'ui');
const tabs = ['Overview', 'Audio', 'Haptics', 'Triggers', 'Lighting', 'Button Remapping', 'System'];
const remapProfileName = process.env.VISUAL_SMOKE_REMAP_PROFILE?.trim();

await mkdir(outputDir, { recursive: true });
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const app = await electron.launch({ args: ['.'], cwd: root });

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.hero-card', { timeout: 10000 });
  await page.waitForTimeout(250);
  const controlsNav = page.getByRole('tablist', { name: 'Controls' });

  for (const tab of tabs) {
    await controlsNav.getByRole('tab', { name: tab }).click();
    await page.waitForTimeout(150);

    if (tab === 'Button Remapping' && remapProfileName) {
      const profileSelect = page.getByLabel('Button remapping profile');
      await profileSelect.click();
      await page.getByRole('option', { name: remapProfileName, exact: true }).click();
      await page.waitForTimeout(150);
    }

    await page.screenshot({
      path: path.join(outputDir, `${tab.toLowerCase().replace(/\s+/g, '-')}.png`),
      animations: 'disabled'
    });

    if (tab === 'Audio') {
      await page.locator('.control-page:not([hidden]) .audio-mode-selector button').filter({ hasText: 'Mic' }).click();
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
