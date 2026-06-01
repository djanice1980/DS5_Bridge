import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const preloadSource = readFileSync(new URL('../preload.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function uniqueMatches(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1] ?? ''))].sort();
}

describe('IPC contract', () => {
  it('keeps every preload invoke channel backed by exactly one main handler', () => {
    const preloadChannels = uniqueMatches(preloadSource, /ipcRenderer\.invoke\('([^']+)'/g);
    const mainChannels = uniqueMatches(mainSource, /ipcMain\.handle\('([^']+)'/g);

    expect(preloadChannels).toHaveLength(63);
    expect(mainChannels).toHaveLength(63);
    expect(preloadChannels).toEqual(mainChannels);
  });

  it('returns unsubscribe functions for renderer event subscriptions', () => {
    expect(preloadSource).toContain("ipcRenderer.on('window:maximizedChanged', listener)");
    expect(preloadSource).toContain("ipcRenderer.removeListener('window:maximizedChanged', listener)");
    expect(preloadSource).toContain("ipcRenderer.on('bridge:snapshot', listener)");
    expect(preloadSource).toContain("ipcRenderer.removeListener('bridge:snapshot', listener)");
    expect(mainSource).toContain("sendToMainWindow('bridge:snapshot', snapshot)");
    expect(mainSource).toContain("mainWindow.webContents.send('window:maximizedChanged', mainWindow.isMaximized())");
  });
});
