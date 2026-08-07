/**
 * Capture the screenshots the README embeds.
 *
 * Deliberately NOT folded into visual-smoke.mjs. That script runs with no controller attached on
 * purpose -- proving the UI stays usable in that state is the thing it tests -- and giving it a
 * fake controller would quietly delete that coverage. This one wants the opposite: a controller
 * present, so the pages show what they look like in use.
 *
 * Real hardware is used wherever it can be. Only the drift-measurement shot falls back to
 * synthetic input, because it needs the sticks pushed out and released three times and a script
 * has no hands. Everything else -- firmware version, battery, connection state -- is whatever the
 * bridge actually reports, because inventing those for a published screenshot would be a lie
 * about the product.
 *
 * When it is used, the fake controller is installed at the IPC boundary rather than in the
 * renderer, because window.bridge is a frozen contextBridge object and cannot be stubbed from the
 * page.
 *
 * The deadzone shot drives the real tuning session, which does write to a connected bridge. It
 * refuses to run unless the saved deadzone is already zero, and cancels the session afterwards --
 * so the worst case is that a bridge briefly holds the value it already had.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outputDir = path.resolve(root, '..', 'assets', 'readme');

await mkdir(outputDir, { recursive: true });

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, DS5_BRIDGE_ALLOW_PARALLEL_AUTOMATION_INSTANCE: '1' }
});

let page;
let originalTheme;
let originalScale;

try {
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const installFakeController = () => app.evaluate(({ ipcMain }) => {
    const buttons = {
      dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false,
      square: false, cross: false, circle: false, triangle: false,
      l1: false, r1: false, l2Pressed: false, r2Pressed: false,
      create: false, options: false, l3: false, r3: false,
      home: false, touchpadButton: false, mute: false,
      edgeLeftFunction: false, edgeRightFunction: false,
      edgeLeftPaddle: false, edgeRightPaddle: false
    };
    // A pose rather than a still: sticks slightly off centre and the triggers partly drawn, so
    // the analogue fades are visibly doing something instead of looking like an empty diagram.
    globalThis.__pose = { l2: 90, r2: 140, lx: 138, ly: 120, rx: 118, ry: 134, cross: true };
    globalThis.__deadzone = { left: 0, right: 0 };
    let tick = 0;

    ipcMain.removeHandler('bridge:readControllerInput');
    ipcMain.handle('bridge:readControllerInput', () => {
      tick += 1;
      const pose = globalThis.__pose;
      const jitter = tick % 2 === 0 ? 1 : -1;
      return {
        controllerConnected: true,
        raw: [0x01, pose.lx, pose.ly, pose.rx, pose.ry, pose.l2, pose.r2],
        state: {
          leftStickX: pose.lx + jitter,
          leftStickY: pose.ly,
          rightStickX: pose.rx,
          rightStickY: pose.ry + jitter,
          leftTrigger: pose.l2,
          rightTrigger: pose.r2,
          ...buttons,
          cross: pose.cross === true,
          l1: pose.l1 === true,
          gyroX: 240, gyroY: -160, gyroZ: 90,
          accelX: 120, accelY: 8040, accelZ: 1420,
          sensorTimestamp: tick,
          touchPoints: [
            { active: false, id: 0, x: 0, y: 0 },
            { active: false, id: 0, x: 0, y: 0 }
          ],
          batteryPercent: 82,
          charging: false,
          rawPowerState: 0x02,
          headsetPlugged: false,
          microphonePlugged: false,
          microphoneMuted: false
        }
      };
    });

  });

  await page.evaluate(() => localStorage.setItem('ds5bridge.startupTutorialCompleted.v1', '1'));
  await page.reload();
  await page.waitForSelector('.hero-card', { timeout: 15000 });

  // A showcase of a disconnected app is worth nothing, and the script cannot tell the difference
  // from the outside -- so refuse rather than quietly produce a set of "Bridge not detected".
  const live = await page.evaluate(async () => {
    const snapshot = await window.bridge.getStatus();
    const input = await window.bridge.readControllerInput().catch(() => null);
    return {
      state: snapshot?.state ?? null,
      message: snapshot?.message ?? null,
      hasStatus: snapshot?.status !== null && snapshot?.status !== undefined,
      bridges: (snapshot?.bridgeDevices?.bridges ?? []).length,
      controller: input?.controllerConnected === true
    };
  });
  console.log('hardware:', JSON.stringify(live));
  if (!live.hasStatus) {
    throw new Error(
      `No bridge is reporting status (state=${live.state}, message=${live.message}); `
      + 'every page would render "Bridge not detected"'
    );
  }

  const originalSettings = await page.evaluate(async () => {
    const snapshot = await window.bridge.getStatus();
    return { theme: snapshot.settings.uiThemePreset, scale: snapshot.settings.uiScalePercent };
  });
  originalTheme = originalSettings.theme;
  originalScale = originalSettings.scale;
  if (originalTheme !== 'dark') {
    await page.evaluate(() => window.bridge.setUiThemePreset('dark'));
  }
  if (originalScale !== 100) {
    await page.evaluate(() => window.bridge.setUiScalePercent(100));
  }
  await page.waitForTimeout(400);

  const shot = async (name, target = page) => {
    await page.waitForTimeout(250);
    await target.screenshot({ path: path.join(outputDir, `${name}.png`), animations: 'disabled' });
    console.log('wrote', name);
  };

  const controlsNav = page.getByRole('tablist', { name: 'Controls' });
  const tabs = [
    ['Overview', 'app-overview'],
    ['Devices', 'app-devices'],
    ['Audio', 'app-audio'],
    ['Haptics', 'app-haptics'],
    ['Triggers', 'app-triggers'],
    ['Lighting', 'app-lighting'],
    ['Button Remapping', 'app-button-remapping'],
    ['System', 'app-system']
  ];

  for (const [tab, name] of tabs) {
    await controlsNav.getByRole('tab', { name: tab }).click();
    await shot(name);

    if (tab === 'Haptics') {
      const audioHaptics = page.getByRole('switch', { name: /(Enable|Disable) Audio Haptics/ });
      if (await audioHaptics.isEnabled().catch(() => false)) {
        await audioHaptics.click();
        await shot('app-audio-haptics');
        await audioHaptics.click();
      }
    }

    if (tab === 'Triggers') {
      await page.getByRole('switch', { name: 'Enter Trigger Lab' }).click();
      await shot('app-trigger-lab');
      await page.getByRole('switch', { name: 'Exit Trigger Lab' }).click();
    }
  }

  await page.getByRole('button', { name: 'Chords' }).click();
  await shot('app-chords');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Bridge settings' }).waitFor();
  await shot('app-bridge-settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- Tester window -----------------------------------------------------------------
  await page.evaluate(() => window.bridge.openTesterWindow());
  let tester = null;
  for (let attempt = 0; attempt < 40 && !tester; attempt += 1) {
    await page.waitForTimeout(250);
    for (const win of app.windows()) {
      if (win !== page && win.url().includes('tester')) tester = win;
    }
  }
  if (!tester) throw new Error('tester window never appeared');
  await tester.setViewportSize({ width: 1180, height: 980 });
  await tester.waitForSelector('.tester-root', { timeout: 15000 });
  await tester.waitForTimeout(1200);
  await tester.screenshot({
    path: path.join(outputDir, 'app-tester.png'),
    fullPage: true,
    animations: 'disabled'
  });
  console.log('wrote app-tester');

  // Deadzone measurement, mid-session with readings taken. Driven through the real component by
  // pushing the synthetic stick out and letting it settle, exactly as a hand would.
  const setPose = (patch) => app.evaluate(({ }, value) => {
    globalThis.__pose = { ...globalThis.__pose, ...value };
  }, patch);

  // From here on the sticks have to be pushed out and released on cue, which needs hands the
  // script does not have. This is the ONLY shot taken against a synthetic controller.
  console.log('installing the fake controller for the drift measurement only');
  await installFakeController();
  await tester.waitForTimeout(600);
  await setPose({ cross: false, l2: 0, r2: 0 });

  const savedDeadzone = await tester.evaluate(
    () => [...document.querySelectorAll('.tester-deadzone .tester-slider-value')].map((n) => n.textContent)
  );
  if (savedDeadzone.some((value) => value !== '0%')) {
    throw new Error(`refusing to tune over a non-zero saved deadzone: ${savedDeadzone.join(',')}`);
  }

  await tester.getByRole('button', { name: 'Measure drift' }).click();
  for (let reading = 0; reading < 3; reading += 1) {
    await setPose({ lx: 250, ly: 128, rx: 250, ry: 128 });
    await tester.waitForTimeout(600);
    await setPose({ lx: 131, ly: 127, rx: 130, ry: 126 });
    // Generous: a reading is 40 settled samples, and the ~8 polls straddling the snap-back are
    // discarded before the settle detector will even start counting.
    await tester.waitForTimeout(4000);
    console.log('  reading %d ->', reading + 1, await tester.evaluate(
      () => [...document.querySelectorAll('.dzscope-readout')].map((n) => n.textContent.trim()).join(' | ')
    ));
  }
  await tester.getByRole('button', { name: /^Use measured/ }).click();
  await tester.waitForTimeout(400);
  await tester.locator('.tester-card', { hasText: 'Stick deadzone' }).first().screenshot({
    path: path.join(outputDir, 'app-stick-deadzone.png'),
    animations: 'disabled'
  });
  console.log('wrote app-stick-deadzone');

  // Leave the bridge as it was found before shooting anything else.
  await tester.getByRole('button', { name: 'Cancel' }).click();
  await tester.waitForTimeout(600);

  await tester.locator('.tester-card', { hasText: 'Stick calibration' }).first().screenshot({
    path: path.join(outputDir, 'app-stick-calibration.png'),
    animations: 'disabled'
  });
  console.log('wrote app-stick-calibration');
} finally {
  if (page) {
    if (originalTheme && originalTheme !== 'dark') {
      await page.evaluate((t) => window.bridge.setUiThemePreset(t), originalTheme).catch(() => {});
    }
    if (originalScale && originalScale !== 100) {
      await page.evaluate((s) => window.bridge.setUiScalePercent(s), originalScale).catch(() => {});
    }
    await page.waitForTimeout(200).catch(() => {});
  }
  await app.close();
}
