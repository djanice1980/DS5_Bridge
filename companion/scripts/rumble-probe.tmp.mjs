import { _electron as electron } from 'playwright';
const app = await electron.launch({
  executablePath: '/home/davidj/Claude Data/DS5_Bridge/companion/artifacts/installer/linux-unpacked/ds5-bridge',
  cwd: '/home/davidj/Claude Data/DS5_Bridge/companion',
  env: { ...process.env, DS5_BRIDGE_ALLOW_PARALLEL_AUTOMATION_INSTANCE: '1' }
});
let page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(6000);
const s = await page.evaluate(() => window.bridge.getStatus());
console.log('state:', s?.state, 'controller:', s?.status?.controllerConnected);
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.bridge.testRumble?.() ?? window.bridge.testClassicRumble?.());
  await new Promise((r) => setTimeout(r, 1500));
}
const s2 = await page.evaluate(() => window.bridge.getStatus());
console.log('lastAck:', JSON.stringify(s2?.diagnostics?.lastAck), '| lastError:', s2?.diagnostics?.lastError);
await app.close();
