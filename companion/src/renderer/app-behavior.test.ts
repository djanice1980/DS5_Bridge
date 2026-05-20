import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.tsx'), 'utf8');

function extractFunction(name: string): string {
  const start = appSource.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = appSource.indexOf('\n  function ', start + 1);
  return appSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
}

describe('renderer behavior guards', () => {
  it('requires explicit confirmation before disabling Host Encoding', () => {
    const toggleFunction = extractFunction('toggleHostEncodedAudioEnabled');
    const confirmFunction = extractFunction('confirmDisableHostEncoding');

    expect(toggleFunction).toContain('setHostEncodingDisableConfirmVisible(true)');
    expect(toggleFunction).not.toContain('setHostEncodedAudioEnabled(false)');
    expect(confirmFunction).toContain('setHostEncodedAudioEnabled(false)');
    expect(appSource).toContain('Disable Host Encoding?');
    expect(appSource).toContain('Turning it off may cause audio stuttering.');
  });
});
