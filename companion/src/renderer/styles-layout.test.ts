/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const normalizedStyles = styles.replace(/\s+/g, ' ').trim();

function cssBlock(selector: string, requiredText?: string): string {
  const normalizedRequiredText = requiredText?.replace(/\s+/g, ' ').trim();
  let searchFrom = 0;
  while (searchFrom < styles.length) {
    const selectorIndex = styles.indexOf(selector, searchFrom);
    if (selectorIndex === -1) {
      break;
    }
    const blockStart = styles.indexOf('{', selectorIndex);
    const blockEnd = styles.indexOf('}', blockStart);
    if (blockStart === -1 || blockEnd === -1) {
      break;
    }
    const block = styles.slice(blockStart + 1, blockEnd);
    const normalizedBlock = block.replace(/\s+/g, ' ').trim();
    if (!normalizedRequiredText || normalizedBlock.includes(normalizedRequiredText)) {
      return block;
    }
    searchFrom = blockEnd + 1;
  }

  if (requiredText) {
    throw new Error(`Missing CSS block for ${selector} containing ${requiredText}`);
  } else {
    throw new Error(`Missing CSS block for ${selector}`);
  }
}

describe('companion layout CSS', () => {
  it('keeps feature cards content-sized instead of viewport-stretched', () => {
    expect(normalizedStyles).not.toContain('--app-base-width');
    expect(normalizedStyles).not.toContain('transform: scale(var(--app-scale))');
    expect(cssBlock('.shell', 'width: 100vw;')).toContain('width: 100vw;');
    expect(cssBlock('.shell', 'height: 100vh;')).toContain('height: 100vh;');
    expect(cssBlock('.app-content', 'width: 100%;')).toContain('width: 100%;');
    expect(cssBlock('.app-content', 'grid-template-rows: minmax(0, 1fr);')).toContain(
      'grid-template-rows: minmax(0, 1fr);'
    );
    expect(cssBlock('.control-panel.flat-control-panel', 'height: 100%;')).toContain('height: 100%;');
    expect(cssBlock('.control-pages', 'min-height: 0;')).toContain('min-height: 0;');
    expect(cssBlock('.control-page', 'grid-template-rows: auto minmax(var(--feature-card-height), auto);')).toContain(
      'grid-template-rows: auto minmax(var(--feature-card-height), auto);'
    );
    expect(cssBlock('.control-page', 'visibility: hidden;')).toContain('visibility: hidden;');
    expect(cssBlock('.control-page', 'pointer-events: none;')).toContain('pointer-events: none;');
    expect(cssBlock('.control-page.active', 'visibility: visible;')).toContain('visibility: visible;');
    expect(cssBlock('.control-page.active', 'pointer-events: auto;')).toContain('pointer-events: auto;');
    expect(cssBlock('.feature-card-grid', 'height: auto;')).toContain('height: auto;');
  });

  it('animates the battery meter with transform instead of layout width', () => {
    expect(cssBlock('.battery-track div', 'transform: scaleX(var(--battery-scale, 0));')).toContain(
      'transform: scaleX(var(--battery-scale, 0));'
    );
    expect(cssBlock('.battery-track div', 'transition: transform 180ms ease, background 180ms ease;')).toContain(
      'transition: transform 180ms ease, background 180ms ease;'
    );
    expect(normalizedStyles).not.toContain('transition: width');
  });

  it('keeps system columns equal height on the shared card height', () => {
    expect(cssBlock('.system-page .feature-card-grid', 'align-items: stretch;')).toContain('align-items: stretch;');
    expect(cssBlock('.system-page .system-card', 'align-self: stretch;')).toContain('align-self: stretch;');
    expect(normalizedStyles).toContain('.lighting-page .feature-card, .system-page .system-card');
    expect(cssBlock('.device-diagnostics', 'flex: 1 1 0;')).toContain('flex: 1 1 0;');
    expect(cssBlock('.device-diagnostics', 'overflow: auto;')).toContain('overflow: auto;');
  });

  it('keeps test card statuses aligned and gives lighting color metadata enough room', () => {
    const sharedRows = '--feature-status-grid-rows: var(--feature-card-header-height) 76px var(--action-height) var(--action-height) minmax(40px, 1fr);';
    expect(cssBlock('.feature-card', sharedRows)).toContain(sharedRows);
    expect(normalizedStyles).toContain('--feature-card-header-height: 66px;');
    expect(cssBlock('.feature-card-title', 'min-height: var(--feature-card-header-height);')).toContain(
      'min-height: var(--feature-card-header-height);'
    );
    expect(cssBlock('.test-card', 'grid-template-rows: var(--feature-status-grid-rows);')).toContain(
      'grid-template-rows: var(--feature-status-grid-rows);'
    );
    expect(cssBlock('.behavior-card', 'grid-template-rows: var(--feature-status-grid-rows);')).toContain(
      'grid-template-rows: var(--feature-status-grid-rows);'
    );
    expect(cssBlock('.behavior-card .feature-card-title', 'align-self: start;')).toContain('align-self: start;');
    expect(cssBlock('.test-card .feature-status', 'grid-row: 5;')).toContain('grid-row: 5;');
    expect(cssBlock('.behavior-card .lighting-status', 'grid-row: 5;')).toContain('grid-row: 5;');
    expect(cssBlock('.behavior-card .light-color-panel', 'grid-row: 3 / 5;')).toContain('grid-row: 3 / 5;');
    expect(cssBlock('.light-color-meta', 'grid-row: 3;')).toContain('grid-row: 3;');
  });

  it('keeps system card subtitles short enough for shared headers', () => {
    expect(appSource).toContain("'Firmware'");
    expect(appSource).toContain("'Debug Data'");
    expect(appSource).not.toContain('Firmware and polling.');
    expect(appSource).not.toContain('Protocol and debug data.');
  });
});
