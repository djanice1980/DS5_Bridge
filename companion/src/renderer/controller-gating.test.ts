import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Controls that ACT ON THE CONTROLLER must require a controller, not just a bridge. That
// distinction did not exist while the bridge disappeared along with the controller, and it
// became wrong the moment companion-only enumeration kept the bridge on the bus with nothing
// attached: every test button stayed live with no controller to act on.
//
// The first sweep missed all of these because it rewrote the inline `disabled={!connected}`
// pattern, and the test buttons gate through NAMED predicates instead. So the guard is on the
// predicate definitions, which is the thing that actually decides.
const SOURCE = readFileSync(join(__dirname, 'App.tsx'), 'utf8');

const CONTROLLER_PREDICATES = [
  // The two audio test predicates gate through *ViaBridge variants: with audio & haptics aimed
  // at a USB-connected controller the helper talks straight to that controller's sink, so a
  // bridge-attached controller is not required -- but a controller still is, and the ternary
  // shape asserted below keeps the bridge path exactly as strict as before.
  'testHapticsUnavailableViaBridge',
  'testRumbleUnavailableViaBridge',
  'testSpeakerUnavailableViaBridge',
  'testMicUnavailableViaBridge',
  'testTriggersUnavailableViaBridge',
  'audioReactiveHapticsControlDisabled',
  'audioReactiveHapticsBlocked'
];

describe('controller-facing controls', () => {
  it.each(CONTROLLER_PREDICATES)('%s requires an attached controller', (name) => {
    const match = SOURCE.match(new RegExp(`const ${name} =\\s*([^\\n]+)`));
    expect(match, `${name} is no longer defined in App.tsx`).not.toBeNull();
    // `connected` alone means the BRIDGE is present, which is true with no controller.
    expect(match![1]).not.toMatch(/^!connected\b/);
    expect(match![1]).toMatch(/^!controllerControlsAvailable\b/);
  });

  it.each([
    ['testHapticsUnavailable', 'testHapticsUnavailableViaBridge'],
    ['testSpeakerUnavailable', 'testSpeakerUnavailableViaBridge'],
    ['testMicUnavailable', 'testMicUnavailableViaBridge'],
    ['testRumbleUnavailable', 'testRumbleUnavailableViaBridge'],
    ['testTriggersUnavailable', 'testTriggersUnavailableViaBridge']
  ])('%s only relaxes for a USB audio target, never for a bare bridge', (name, base) => {
    // The USB arm must still be a real gate (pending action / test lock), and the non-USB arm
    // must be the bridge predicate this file already vets. Whitespace-normalised so formatting
    // cannot break the guard.
    const flat = SOURCE.replace(/\s+/g, ' ');
    const pattern = new RegExp(
      `const ${name} = audioTargetUsb \\? pendingAction !== null \\|\\| \\w+ : ${base};`
    );
    expect(flat).toMatch(pattern);
  });

  it('keeps one definition of "a controller is attached"', () => {
    // Two independent spellings is how half these controls ended up gated on the bridge.
    expect(SOURCE).toContain('const controllerControlsAvailable = connected && controllerConnected;');
    expect(SOURCE).toContain('const controllerAttached = controllerControlsAvailable;');
  });

  it('leaves pair and forget gated on the bridge only', () => {
    // These exist precisely FOR the no-controller state; requiring a controller would make
    // them unusable exactly when they are needed.
    expect(SOURCE).toMatch(/disabled=\{!connected \|\| pendingAction !== null\}\s*\n\s*onClick=\{forgetControllerPairings\}/);
  });
});
