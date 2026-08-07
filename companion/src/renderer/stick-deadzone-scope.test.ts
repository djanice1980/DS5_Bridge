import { describe, expect, it } from 'vitest';
import {
  createDrift,
  recordDrift,
  resetDrift,
  scopeDomain,
  suggestedDeadzonePercent,
  type StickDrift
} from './StickDeadzoneScope';

/** Convenience: a stick position that many counts from centre on the X axis. */
function atX(counts: number): [number, number] {
  return [128 + counts, 128];
}

/** Hold a stick still long enough for it to count as at rest. */
function rest(drift: StickDrift, counts: number, domain = 0.15): void {
  for (let sample = 0; sample < 12; sample += 1) {
    recordDrift(drift, 128 + counts, 128, domain);
  }
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
  it('counts nothing until the stick has been still for a while', () => {
    const drift = createDrift();
    recordDrift(drift, ...atX(4), 0.15);
    expect(drift.settled).toBe(false);
    expect(drift.peak).toBe(0);
  });

  it('keeps the furthest resting excursion, not the latest', () => {
    const drift = createDrift();
    rest(drift, 4);
    rest(drift, 1);
    expect(drift.peak).toBeCloseTo(4 / 127, 5);
  });

  it('ignores a stick being swept back to centre', () => {
    // The case that broke on real hardware: sweeping a healthy stick and letting it snap back
    // walked it through the whole view, and every position on the way counted as drift.
    const drift = createDrift();
    for (let counts = 18; counts >= 0; counts -= 1) {
      recordDrift(drift, ...atX(counts), 0.15);
    }
    expect(drift.peak).toBe(0);
  });

  it('measures the stick once it settles after that sweep', () => {
    const drift = createDrift();
    for (let counts = 18; counts >= 2; counts -= 1) {
      recordDrift(drift, ...atX(counts), 0.15);
    }
    rest(drift, 2);
    expect(drift.settled).toBe(true);
    expect(drift.peak).toBeCloseTo(2 / 127, 5);
  });

  it('still counts a stick that rests off-centre, which is the case worth catching', () => {
    const drift = createDrift();
    rest(drift, 9);
    expect(drift.peak).toBeCloseTo(9 / 127, 5);
  });

  it('counts a jittering stick, since jitter is not the same as being moved', () => {
    const drift = createDrift();
    for (let sample = 0; sample < 40; sample += 1) {
      recordDrift(drift, 128 + (sample % 2 === 0 ? 3 : -3), 128, 0.15);
    }
    expect(drift.peak).toBeCloseTo(3 / 127, 5);
  });

  it('ignores a stick held past the view', () => {
    const drift = createDrift();
    rest(drift, 127);
    expect(drift.peak).toBe(0);
  });

  it('measures distance from centre in both axes together', () => {
    const drift = createDrift();
    for (let sample = 0; sample < 12; sample += 1) {
      recordDrift(drift, 128 + 3, 128 + 4, 0.15);
    }
    expect(drift.peak).toBeCloseTo(5 / 127, 5);
  });

  it('forgets everything on reset', () => {
    const drift = createDrift();
    rest(drift, 6);
    resetDrift(drift);
    expect(drift.peak).toBe(0);
    expect(drift.settled).toBe(false);
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
