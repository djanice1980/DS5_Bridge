// Phase 2 of the fw 1.6.77 hardware validation: the authenticated UF2 flow.
// Launches the app visibly, clicks Mount, logs the confirmation dialog state
// while the user enters the face-button sequence on the controller, waits for
// BOOTSEL, then flashes the given UF2 back. Run: node scripts/authenticated-mount-test.mjs <uf2>
import { _electron as electron } from 'playwright';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const uf2Path = process.argv[2];

function rp2350Device() {
  try {
    const out = execSync('lsblk -rno NAME,LABEL', { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
      const [name, ...rest] = line.split(' ');
      if (/RP2350|RPI-RP2/i.test(rest.join(' '))) return `/dev/${name}`;
    }
  } catch {}
  return null;
}

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
await page.waitForTimeout(4000);

const before = await page.evaluate(() => window.bridge.getStatus());
console.log(`bridge: fw ${before.status?.firmwareVersion} controller=${before.status?.controllerConnected}`);
if (!before.status?.controllerConnected) {
  console.error('FAIL: no controller connected through the bridge');
  await app.close();
  process.exit(1);
}

await page.locator('.sidebar-action-button', { hasText: 'Settings' }).click();
await page.waitForTimeout(500);
await page.locator('.pico-firmware-dual-action button', { hasText: 'Mount' }).click();
console.log('mount clicked; waiting for the confirmation dialog');

let lastLogged = '';
let sawDialog = false;
let shotTaken = false;
let device = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  device = rp2350Device();
  if (device) break;
  const snapshot = await page.evaluate(() => window.bridge.getStatus()).catch(() => null);
  const confirmation = snapshot?.bootloaderConfirmation;
  if (confirmation) {
    sawDialog = true;
    const line = `${confirmation.purpose}: [${confirmation.sequence.join(' ')}] progress=${confirmation.progress} mistakes=${confirmation.mistakes}`;
    if (line !== lastLogged) {
      lastLogged = line;
      console.log(line);
    }
    if (!shotTaken) {
      shotTaken = true;
      await page.screenshot({ path: '/tmp/claude-1000/uf2-confirmation.png' });
    }
  }
  await page.waitForTimeout(400);
}

await app.close().catch(() => {});

if (!device) {
  console.error(sawDialog
    ? 'FAIL: dialog shown but the bridge never reached BOOTSEL'
    : 'FAIL: the confirmation dialog never appeared');
  process.exit(1);
}
console.log(`PASS: authenticated entry reached BOOTSEL (${device})`);

if (uf2Path && fs.existsSync(uf2Path)) {
  const mountOut = execFileSync('udisksctl', ['mount', '-b', device], { encoding: 'utf8' });
  const mountPoint = mountOut.match(/at (\S+)/)?.[1];
  fs.copyFileSync(uf2Path, path.join(mountPoint, path.basename(uf2Path)));
  execSync('sync');
  console.log('firmware copied back; waiting for re-enumeration');
  for (let i = 0; i < 40; i += 1) {
    execSync('sleep 0.5');
    const lsusb = execSync('lsusb', { encoding: 'utf8' });
    if (/054c:0ce[67]|054c:0df2|054c:09cc|1209:db05/.test(lsusb)) {
      console.log('PASS: bridge back on the bus');
      process.exit(0);
    }
  }
  console.error('FAIL: bridge did not re-enumerate');
  process.exit(1);
}
