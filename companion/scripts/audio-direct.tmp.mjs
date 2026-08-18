import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
const app = await electron.launch({
  executablePath: '/home/davidj/Claude Data/DS5_Bridge/companion/artifacts/installer/linux-unpacked/ds5-bridge',
  cwd: '/home/davidj/Claude Data/DS5_Bridge/companion',
  env: { ...process.env, DS5_BRIDGE_ALLOW_PARALLEL_AUTOMATION_INSTANCE: '1' }
});
let page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(6000);
const q = () => page.evaluate(() => window.bridge.getStatus().then((s) => ({ st: s?.state, audio: s?.status?.audioRecent, haptics: s?.status?.hapticsReady })));
console.log('before:', JSON.stringify(await q()));
const name = 'alsa_output.usb-Sony_Interactive_Entertainment_DualSense_Wireless_Controller-00.analog-surround-40';
const play = spawn('pw-play', ['--target', name, '/tmp/claude-1000/-home-davidj-Claude-Data/911cb285-e642-469f-a788-9a0396689185/scratchpad/tone.wav']);
play.stderr.on('data', (d) => console.log('[pw-play]', String(d).trim()));
for (let i = 0; i < 5; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`t+${i + 1}s:`, JSON.stringify(await q()));
}
play.kill();
await app.close();
