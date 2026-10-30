// Phase 1 of the fw 1.6.77 hardware validation: mount UF2 mode through the NEW
// companion build (firmware 1.6.76 is pre-authentication, so this live-tests the
// coordinator's plain-command fallback), then copy the 1.6.77 UF2 onto the
// RP2350 drive. Run from companion/: node scripts/flash-bootloader-test.mjs <uf2>
import { _electron as electron } from 'playwright';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const uf2Path = process.argv[2];
if (!uf2Path || !fs.existsSync(uf2Path)) {
  console.error('usage: node scripts/flash-bootloader-test.mjs <firmware.uf2>');
  process.exit(2);
}

function rp2350Device() {
  try {
    const out = execSync('lsblk -rno NAME,LABEL', { encoding: 'utf8' });
    for (const line of out.trim().split('\n')) {
      const [name, ...rest] = line.split(' ');
      const label = rest.join(' ');
      if (/RP2350|RPI-RP2/i.test(label)) return `/dev/${name}`;
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

// Open Bridge Settings and press Mount.
await page.locator('.sidebar-action-button', { hasText: 'Settings' }).click();
await page.waitForTimeout(600);
const mount = page.locator('.pico-firmware-dual-action button', { hasText: 'Mount' });
await mount.click();
console.log('mount clicked');

// The bridge drops off the bus and returns as an RP2350 mass-storage drive.
let device = null;
for (let i = 0; i < 60; i += 1) {
  await page.waitForTimeout(500);
  device = rp2350Device();
  if (device) break;
}
await app.close().catch(() => {});
if (!device) {
  console.error('FAIL: RP2350 drive never appeared');
  process.exit(1);
}
console.log(`bootloader drive: ${device}`);

// Mount via udisks (user session, no root), copy, let the Pico reboot itself.
const mountOut = execFileSync('udisksctl', ['mount', '-b', device], { encoding: 'utf8' });
const mountPoint = mountOut.match(/at (\S+)/)?.[1];
if (!mountPoint) {
  console.error(`FAIL: could not mount ${device}: ${mountOut}`);
  process.exit(1);
}
console.log(`mounted at ${mountPoint}`);
fs.copyFileSync(uf2Path, path.join(mountPoint, path.basename(uf2Path)));
execSync('sync');
console.log('UF2 copied; waiting for the bridge to re-enumerate');

for (let i = 0; i < 40; i += 1) {
  execSync('sleep 0.5');
  try {
    const lsusb = execSync('lsusb', { encoding: 'utf8' });
    if (/054c:0ce[67]|054c:0df2|054c:09cc|1209:db05/.test(lsusb)) {
      console.log('PASS: bridge is back on the bus');
      process.exit(0);
    }
  } catch {}
}
console.error('FAIL: bridge did not re-enumerate within 20s');
process.exit(1);
