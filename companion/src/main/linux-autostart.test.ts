import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyLinuxLaunchAtStartup,
  buildAutostartDesktopEntry,
  linuxAutostartDesktopPath
} from './linux-autostart';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ds5-autostart-'));
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

describe('Linux autostart', () => {
  it('builds a desktop entry that launches into the tray', () => {
    const entry = buildAutostartDesktopEntry({
      execPath: '/opt/DS5 Bridge/ds5-bridge',
      args: ['--start-in-tray']
    });

    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Exec="/opt/DS5 Bridge/ds5-bridge" "--start-in-tray"');
    expect(entry).toContain('Name=DS5 Bridge');
  });

  it('escapes Exec-reserved characters in paths', () => {
    const entry = buildAutostartDesktopEntry({
      execPath: '/tmp/we"ird$path`x\\y',
      args: []
    });

    expect(entry).toContain('Exec="/tmp/we\\"ird\\$path\\`x\\\\y"');
  });

  it('prefers the AppImage path over the inner executable', () => {
    const entry = buildAutostartDesktopEntry({
      execPath: '/tmp/.mount_ds5/ds5-bridge',
      args: ['--start-in-tray'],
      appImagePath: '/home/user/Apps/DS5-Bridge.AppImage'
    });

    expect(entry).toContain('Exec="/home/user/Apps/DS5-Bridge.AppImage" "--start-in-tray"');
  });

  it('writes and removes the autostart file', () => {
    const configHome = tempDir();
    const options = {
      execPath: '/usr/bin/ds5-bridge',
      args: ['--start-in-tray'],
      configHome
    };

    applyLinuxLaunchAtStartup(true, options);
    const desktopPath = linuxAutostartDesktopPath(configHome);
    expect(existsSync(desktopPath)).toBe(true);
    expect(readFileSync(desktopPath, 'utf8')).toContain('X-GNOME-Autostart-enabled=true');

    applyLinuxLaunchAtStartup(false, options);
    expect(existsSync(desktopPath)).toBe(false);
  });

  it('disabling without an existing file is a no-op', () => {
    const configHome = tempDir();
    expect(() => applyLinuxLaunchAtStartup(false, {
      execPath: '/usr/bin/ds5-bridge',
      args: [],
      configHome
    })).not.toThrow();
  });
});
