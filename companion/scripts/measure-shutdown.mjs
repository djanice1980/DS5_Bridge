// How long does quit actually take, and where does it go?
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = await electron.launch({
  executablePath: path.join(root, 'artifacts', 'installer', 'linux-unpacked', 'ds5-bridge'),
  args: [],
  cwd: root,
  env: { ...process.env, DS5_BRIDGE_ALLOW_PARALLEL_AUTOMATION_INSTANCE: '1' }
});

const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.evaluate(() => localStorage.setItem('ds5bridge.startupTutorialCompleted.v1', '1'));
await page.reload();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(5000);

// Recreate a busy session: USB audio target + a test tone mid-flight.
const chip = page.locator('.bridge-direct-controller-target');
if (await chip.count()) {
  await chip.first().click();
  await page.waitForTimeout(1500);
  await page.locator('#control-tab-overview').click();
  await page.waitForTimeout(500);
  const speaker = page.locator('.overview-action-grid button', { hasText: 'Test Speaker' });
  if (!await speaker.isDisabled()) {
    await speaker.click();
    await page.waitForTimeout(400); // quit while the tone helper is running
    console.log('quitting mid-test');
  }
}

// Worst case: freeze every helper child so no stop can complete before its timeout.
const { execSync } = await import('node:child_process');
try {
  execSync('pkill -STOP -f "AudioHelper"');
  console.log('helper children frozen');
} catch { console.log('no helper children to freeze'); }

const electronProcess = app.process();
const started = Date.now();
await app.evaluate(({ app: electronApp }) => electronApp.quit());
await new Promise((resolve) => electronProcess.once('exit', resolve));
console.log(`quit took ${Date.now() - started} ms`);
