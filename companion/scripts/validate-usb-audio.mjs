// End-to-end validation of USB audio targeting against real hardware: clicks the sidebar
// "use for audio" chip, confirms the target took, confirms the Overview test buttons enable,
// fires Test Speaker and verifies a playback stream appears in PipeWire, fires Test Haptics,
// and saves a screenshot. Requires a packaged build (npm run package:linux) and a
// USB-connected controller.
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

try {
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.log(`[renderer:${message.type()}]`, message.text());
    }
  });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => {
    localStorage.setItem('ds5bridge.startupTutorialCompleted.v1', '1');
  });
  // Reload so the app boots with the flag: setting it after mount races the tour's first
  // render, and its backdrop swallows every click when it wins.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000); // let the census settle

  const chip = page.locator('.bridge-direct-controller-target');
  console.log('chip count:', await chip.count());
  if (await chip.count() === 0) {
    console.log('NO CHIP RENDERED — directControllers empty or gated off');
  } else {
    console.log('chip text before:', await chip.first().innerText());
    await chip.first().click();
    await page.waitForTimeout(2500);
    console.log('chip text after :', await chip.first().innerText());
    const state = await page.evaluate(async () => {
      const snapshot = await window.bridge.getStatus();
      return { audioTargetPath: snapshot?.bridgeDevices?.audioTargetPath ?? null };
    });
    console.log('audioTargetPath:', state.audioTargetPath);

    // Overview: the audio test buttons must be enabled under a USB target.
    await page.locator('#control-tab-overview').click();
    await page.waitForTimeout(800);
    const speakerButton = page.locator('.overview-action-grid button', { hasText: 'Test Speaker' });
    const hapticsButton = page.locator('.overview-action-grid button', { hasText: 'Test Haptics' });
    console.log('Test Speaker disabled:', await speakerButton.isDisabled());
    console.log('Test Haptics disabled:', await hapticsButton.isDisabled());

    if (!await speakerButton.isDisabled()) {
      const { execSync } = await import('node:child_process');
      await speakerButton.click();
      await page.waitForTimeout(1500);
      // While the tone plays, the helper's pw-play stream should exist and point at the
      // controller's sink.
      const streams = execSync('pw-dump', { encoding: 'utf8' });
      const hasPlayStream = /pw-play|AudioHelper/.test(streams);
      console.log('playback stream visible in PipeWire:', hasPlayStream);
      await page.waitForTimeout(2500);
    }
    if (!await hapticsButton.isDisabled()) {
      await hapticsButton.click();
      await page.waitForTimeout(2500);
      console.log('haptics test clicked without error');
    }

    const micButton = page.locator('.overview-action-grid button', { hasText: 'Listen Mic' });
    const micTimeState = await page.evaluate(async () => {
      const snapshot = await window.bridge.getStatus();
      return {
        audioTargetPath: snapshot?.bridgeDevices?.audioTargetPath ?? null,
        directCount: snapshot?.bridgeDevices?.directControllers?.length ?? 0
      };
    });
    console.log('state at mic check:', JSON.stringify(micTimeState));
    console.log('at mic check -- speaker/haptics/mic disabled:',
      await speakerButton.isDisabled(), await hapticsButton.isDisabled(), await micButton.isDisabled());
    await page.waitForTimeout(8000);
    console.log('after 8s settle -- speaker/haptics/mic disabled:',
      await speakerButton.isDisabled(), await hapticsButton.isDisabled(), await micButton.isDisabled());
    if (!await micButton.isDisabled()) {
      const { execSync } = await import('node:child_process');
      await micButton.click();
      await page.waitForTimeout(2000);
      // getUserMedia shows up as a capture stream in PipeWire while the listen runs.
      const dump = execSync('pw-dump', { encoding: 'utf8' });
      const captureLive = /"Stream\/Input\/Audio"/.test(dump);
      console.log('capture stream visible in PipeWire:', captureLive);
      await page.waitForTimeout(4000);
    }
    // Phase 3: outputs over the cable, driven through the real IPC surface.
    const outputs = await page.evaluate(async () => {
      const results = {};
      try { await window.bridge.testAdaptiveTriggers('weapon', 'both'); results.triggers = 'ok'; }
      catch (error) { results.triggers = String(error); }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try { await window.bridge.testClassicRumble(); results.rumble = 'ok'; }
      catch (error) { results.rumble = String(error); }
      return results;
    });
    console.log('USB outputs:', JSON.stringify(outputs));
    await page.waitForTimeout(1200);

    await page.screenshot({ path: 'artifacts/ui/usb-audio-validated.png' });
    console.log('screenshot saved');
  }
} finally {
  await app.close();
}
