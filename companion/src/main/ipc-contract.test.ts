import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const preloadSource = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const bridgeServiceSource = readFileSync(new URL('./bridge-service.ts', import.meta.url), 'utf8');

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

describe('IPC contract', () => {
  it('keeps every preload invoke channel backed by exactly one main handler', () => {
    const preloadChannels = matches(preloadSource, /ipcRenderer\.invoke\('([^']+)'/g);
    const mainChannels = matches(mainSource, /ipcMain\.handle\('([^']+)'/g);

    expect(duplicateValues(preloadChannels)).toEqual([]);
    expect(duplicateValues(mainChannels)).toEqual([]);
    expect(uniqueSorted(preloadChannels)).toEqual(uniqueSorted(mainChannels));
  });

  it('returns unsubscribe functions for renderer event subscriptions', () => {
    expect(preloadSource).toContain("ipcRenderer.on('window:maximizedChanged', listener)");
    expect(preloadSource).toContain("ipcRenderer.removeListener('window:maximizedChanged', listener)");
    expect(preloadSource).toContain("ipcRenderer.on('bridge:snapshot', listener)");
    expect(preloadSource).toContain("ipcRenderer.removeListener('bridge:snapshot', listener)");
    expect(mainSource).toContain("sendToMainWindow('bridge:snapshot', snapshot)");
    expect(mainSource).toContain("mainWindow.webContents.send('window:maximizedChanged', mainWindow.isMaximized())");
  });

  it('maps chord keyboard shortcuts to Windows virtual-key codes', () => {
    const keyCodeStart = bridgeServiceSource.indexOf('const VIRTUAL_KEY_CODES');
    expect(keyCodeStart).toBeGreaterThanOrEqual(0);
    const keyCodeEnd = bridgeServiceSource.indexOf('const MEDIA_ACTION_KEY_CODES', keyCodeStart);
    expect(keyCodeEnd).toBeGreaterThan(keyCodeStart);
    const keyCodeSource = bridgeServiceSource.slice(keyCodeStart, keyCodeEnd);

    expect(keyCodeSource).toContain('PRINTSCREEN: 0x2c');
    expect(keyCodeSource).toContain('PRTSC: 0x2c');
    expect(keyCodeSource).toContain('PRTSCN: 0x2c');
    expect(keyCodeSource).toContain('VIRTUAL_KEY_CODES[`NUMPAD${index}`] = 0x60 + index');
    expect(bridgeServiceSource).toContain('function normalizeVirtualKeyName');
  });

  it('exposes Pico firmware mount, flash, and nuke actions', () => {
    expect(preloadSource).toContain("ipcRenderer.invoke('bridge:mountPicoBootloader')");
    expect(preloadSource).toContain("ipcRenderer.invoke('bridge:flashPicoFirmware')");
    expect(preloadSource).toContain("ipcRenderer.invoke('bridge:nukePicoFlash')");
    expect(mainSource).toContain("ipcMain.handle('bridge:mountPicoBootloader'");
    expect(mainSource).toContain("ipcMain.handle('bridge:flashPicoFirmware'");
    expect(mainSource).toContain("ipcMain.handle('bridge:nukePicoFlash'");
    expect(mainSource).toContain('function picoFirmwareErrorMessage(error: unknown): string');
    expect(mainSource).toContain('function runPicoFirmwareIpcAction(');
    expect(mainSource).toContain("return 'No companion bridge is connected. Connect the companion bridge, then try again.';");
    expect(bridgeServiceSource).toContain('async mountPicoBootloader(): Promise<void>');
    expect(bridgeServiceSource).toContain('COMMAND_ID.ENTER_BOOTLOADER');
  });
});
