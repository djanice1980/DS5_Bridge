import { describe, expect, it } from 'vitest';
import {
  createDrift,
  recordDrift,
  scopeDomain,
  suggestedDeadzonePercent
} from './StickDeadzoneScope';

/** Convenience: a stick position that many counts from centre on the X axis. */
function atX(counts: number): [number, number] {
  return [128 + counts, 128];
}

describe('scopeDomain', () => {
  it('zooms in hard when no deadzone is set, since drift is a couple of counts', () => {
    expect(scopeDomain(0)).toBe(0.15);
  });

  it('keeps the deadzone disc inside the rim as it grows', () => {
    for (let percent = 0; percent <= 50; percent += 1) {
      const domain = scopeDomain(percent);
      expect(percent / 100).toBeLessThanOrEqual(domain);
    }
  });

  it('snaps between a few sizes rather than rescaling continuously', () => {
    // Dragging the slider must not resize the view on every step, or the drift being judged
    // changes size under the user.
    const sizes = new Set<number>();
    for (let percent = 0; percent <= 50; percent += 1) {
      sizes.add(scopeDomain(percent));
    }
    expect(sizes.size).toBeLessThanOrEqual(5);
  });
});

describe('recordDrift', () => {
  it('keeps the furthest resting excursion, not the latest', () => {
    const drift = createDrift();
    recordDrift(drift, ...atX(4), 0.15);
    recordDrift(drift, ...atX(1), 0.15);
    expect(drift.peak).toBeCloseTo(4 / 127, 5);
  });

  it('ignores samples past the view, which are someone moving the stick', () => {
    const drift = createDrift();
    recordDrift(drift, ...atX(127), 0.15);
    expect(drift.peak).toBe(0);
  });

  it('measures distance from centre in both axes together', () => {
    const drift = createDrift();
    recordDrift(drift, 128 + 3, 128 + 4, 0.15);
    expect(drift.peak).toBeCloseTo(5 / 127, 5);
  });
});

describe('suggestedDeadzonePercent', () => {
  it('leaves a stick that does not wander alone', () => {
    expect(suggestedDeadzonePercent(0)).toBe(0);
  });

  it('clears the worst bounce seen rather than landing on it', () => {
    const peak = 0.032;
    const suggestion = suggestedDeadzonePercent(peak);
    expect(suggestion).toBeGreaterThan(peak * 100);
  });

  it('never exceeds the slider, so the suggestion is always settable', () => {
    expect(suggestedDeadzonePercent(1)).toBeLessThanOrEqual(50);
  });
});
