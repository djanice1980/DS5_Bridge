import { _electron as electron } from 'playwright';
const app = await electron.launch({
  executablePath: '/home/davidj/Claude Data/DS5_Bridge/companion/artifacts/installer/linux-unpacked/ds5-bridge',
  cwd: '/home/davidj/Claude Data/DS5_Bridge/companion',
  env: { ...process.env, DS5_BRIDGE_ALLOW_PARALLEL_AUTOMATION_INSTANCE: '1' }
});
let page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.evaluate(() => localStorage.setItem('ds5bridge.startupTutorialCompleted.v1', '1'));
await page.reload();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(6000);

const s = await page.evaluate(() => window.bridge.getStatus());
console.log('STATE:', s?.state, '| fw:', s?.status?.firmwareVersion, '| proto:', s?.status?.protocolVersion,
  '| controller:', s?.status?.controllerConnected, '| type:', s?.status?.controllerType,
  '| audioRecent:', s?.status?.audioRecent, '| hapticsReady:', s?.status?.hapticsReady);
console.log('watchdog:', s?.diagnostics?.lastWatchdogHang, '| uptime:', s?.diagnostics?.uptimeSeconds, '| lastError:', s?.diagnostics?.lastError);

// Speaker test through the bridge, then pull the audio debug ring.
const before = await page.evaluate(() => window.bridge.getAudioDebugSnapshot?.() ?? null).catch(() => null);
await page.evaluate(() => window.bridge.testSpeaker?.() ?? window.bridge.playSpeakerTest?.());
await new Promise((r) => setTimeout(r, 6000));
const s2 = await page.evaluate(() => window.bridge.getStatus());
console.log('after test: audioRecent:', s2?.status?.audioRecent, '| lastAck:', JSON.stringify(s2?.diagnostics?.lastAck), '| lastError:', s2?.diagnostics?.lastError);
const dbg = s2?.audioDebugLines ?? s2?.diagnostics?.audioDebugLines ?? [];
console.log('--- audio debug tail ---');
for (const l of dbg.slice(-30)) console.log(l);
await app.close();
