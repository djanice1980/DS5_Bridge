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
  'testHapticsUnavailable',
  'testRumbleUnavailable',
  'testSpeakerUnavailable',
  'testMicUnavailable',
  'testTriggersUnavailable',
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
