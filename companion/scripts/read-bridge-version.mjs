// Read what the app shows for the connected bridge after the 1.6.77 flash.
import { _electron as electron } from 'playwright';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
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

const snapshot = await page.evaluate(() => window.bridge.getStatus());
console.log(JSON.stringify({
  state: snapshot.state,
  message: snapshot.message,
  firmware: snapshot.status?.firmwareVersion ?? null,
  protocol: snapshot.diagnostics?.protocolVersion ?? null,
  watchdog: snapshot.status?.watchdog ?? snapshot.diagnostics?.watchdog ?? null
}, null, 1));
await page.screenshot({ path: '/tmp/claude-1000/bridge-177.png' });
await app.close();
