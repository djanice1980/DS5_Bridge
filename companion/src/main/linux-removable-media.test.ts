import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linuxRemovableMediaRoots } from './linux-removable-media';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ds5-media-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('Linux removable media roots', () => {
  it('lists mounted volume directories under the media bases', () => {
    const base = tempDir();
    mkdirSync(path.join(base, 'RP2350'));
    mkdirSync(path.join(base, 'USB-STICK'));
    writeFileSync(path.join(base, 'not-a-dir.txt'), 'x');

    const roots = linuxRemovableMediaRoots([base]);

    expect(roots).toContain(path.join(base, 'RP2350'));
    expect(roots).toContain(path.join(base, 'USB-STICK'));
    expect(roots).not.toContain(path.join(base, 'not-a-dir.txt'));
  });

  it('ignores missing base directories', () => {
    const base = tempDir();
    const missing = path.join(base, 'does-not-exist');

    expect(linuxRemovableMediaRoots([missing])).toEqual([]);
  });

  it('merges roots from multiple bases', () => {
    const baseA = tempDir();
    const baseB = tempDir();
    mkdirSync(path.join(baseA, 'RPI-RP2'));
    mkdirSync(path.join(baseB, 'RP2350'));

    const roots = linuxRemovableMediaRoots([baseA, baseB]);

    expect(roots).toEqual([
      path.join(baseA, 'RPI-RP2'),
      path.join(baseB, 'RP2350')
    ]);
  });
});
