import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function extractFunction(name: string): string {
  const start = mainSource.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFunction = mainSource.indexOf('\nfunction ', start + 1);
  return mainSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
}

describe('main window behavior', () => {
  it('keeps the user-chosen window size on restore and only re-asserts zoom', () => {
    const showWindowCentered = extractFunction('showWindowCentered');
    const restoreMainWindowScale = extractFunction('restoreMainWindowScale');
    const currentUiScalePercent = extractFunction('currentUiScalePercent');

    expect(currentUiScalePercent).toContain('bridgeService?.getSnapshot().settings.uiScalePercent');
    // Restore must NOT reset the window size (that was the snap-back-to-default bug);
    // it only re-asserts the zoom so the UI still fills whatever size the user set.
    expect(restoreMainWindowScale).toContain('setZoomFactor(fitZoomForBounds(bounds.width, bounds.height))');
    expect(restoreMainWindowScale).toContain('window.isMaximized() || window.isFullScreen()');
    expect(restoreMainWindowScale).not.toContain('applyWindowScale(');
    expect(showWindowCentered.indexOf('restoreMainWindowScale(false);')).toBeGreaterThanOrEqual(0);
    expect(showWindowCentered.indexOf('restoreMainWindowScale(false);')).toBeLessThan(
      showWindowCentered.indexOf('const display = screen.getPrimaryDisplay();')
    );

    expect(mainSource).toContain("mainWindow.on('show', () => scheduleMainWindowScaleRestore(false));");
    expect(mainSource).toContain("mainWindow.on('restore', () => scheduleMainWindowScaleRestore(false));");
    expect(mainSource).toContain("mainWindow.on('focus', () => scheduleMainWindowScaleRestore(false));");
    expect(mainSource).toContain("powerMonitor.on('resume', () => scheduleMainWindowScaleRestore(true));");
    expect(mainSource).toContain("powerMonitor.on('unlock-screen', () => scheduleMainWindowScaleRestore(true));");
    expect(mainSource).toContain("screen.on('display-metrics-changed', () => scheduleMainWindowScaleRestore(true));");
  });
});
