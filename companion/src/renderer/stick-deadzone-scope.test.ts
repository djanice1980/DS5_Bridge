import { describe, expect, it } from 'vitest';
import {
  createDrift,
  recordDrift,
  resetDrift,
  scopeDomain,
  suggestedDeadzonePercent,
  type StickDrift
} from './StickDeadzoneScope';

const DOMAIN = 0.15;

/** Push the stick right out, which is the gesture that arms a measurement. */
function push(drift: StickDrift): void {
  recordDrift(drift, 128 + 120, 128, DOMAIN);
}

/** Hold the stick at a fixed offset for a number of polls. */
function hold(drift: StickDrift, counts: number, samples: number): void {
  for (let sample = 0; sample < samples; sample += 1) {
    recordDrift(drift, 128 + counts, 128, DOMAIN);
  }
}

/** Push out, release, and let it sit until the reading freezes. */
function measureAt(counts: number): StickDrift {
  const drift = createDrift();
  push(drift);
  hold(drift, counts, 70);
  return drift;
}

describe('scopeDomain', () => {
  it('zooms in hard when no deadzone is set, since drift is a couple of counts', () => {
    expect(scopeDomain(0)).toBe(0.15);
  });

  it('keeps the deadzone disc inside the rim as it grows', () => {
    for (let percent = 0; percent <= 50; percent += 1) {
      expect(percent / 100).toBeLessThanOrEqual(scopeDomain(percent));
    }
  });

  it('snaps between a few sizes rather than rescaling continuously', () => {
    const sizes = new Set<number>();
    for (let percent = 0; percent <= 50; percent += 1) {
      sizes.add(scopeDomain(percent));
    }
    expect(sizes.size).toBeLessThanOrEqual(5);
  });
});

describe('recordDrift', () => {
  it('measures nothing until the stick has been pushed out', () => {
    const drift = createDrift();
    hold(drift, 4, 70);
    expect(drift.phase).toBe('idle');
    expect(drift.peak).toBe(0);
  });

  it('measures where the stick came to rest after a release', () => {
    const drift = measureAt(4);
    expect(drift.phase).toBe('done');
    expect(drift.peak).toBeCloseTo(4 / 127, 5);
  });

  it('ignores the return journey itself', () => {
    // The first hardware failure: a swept stick measured every position it passed through.
    const drift = createDrift();
    push(drift);
    for (let counts = 40; counts >= 3; counts -= 1) {
      recordDrift(drift, 128 + counts, 128, DOMAIN);
    }
    hold(drift, 3, 70);
    expect(drift.peak).toBeCloseTo(3 / 127, 5);
  });

  it('cannot be thrown off by moving the stick slowly afterwards', () => {
    // The second hardware failure: slow movement is locally identical to rest, so no stillness
    // test can reject it. A frozen reading does not care.
    const drift = measureAt(3);
    expect(drift.peak).toBeCloseTo(3 / 127, 5);
    for (let step = 0; step < 60; step += 1) {
      recordDrift(drift, 128 + 3 + Math.floor(step / 4), 128, DOMAIN);
    }
    expect(drift.phase).toBe('done');
    expect(drift.peak).toBeCloseTo(3 / 127, 5);
  });

  it('discards the previous reading when the stick is pushed out again', () => {
    const drift = measureAt(9);
    expect(drift.peak).toBeCloseTo(9 / 127, 5);
    push(drift);
    expect(drift.peak).toBe(0);
    expect(drift.phase).toBe('returning');
    hold(drift, 2, 70);
    expect(drift.peak).toBeCloseTo(2 / 127, 5);
  });

  it('waits out the bounce before it starts counting', () => {
    const drift = createDrift();
    push(drift);
    // Overshoot back and forth across centre, as a released stick does.
    for (const counts of [-14, 10, -7, 5, -3, 2, -1]) {
      recordDrift(drift, 128 + counts, 128, DOMAIN);
    }
    expect(drift.phase).toBe('returning');
    hold(drift, 1, 70);
    expect(drift.peak).toBeCloseTo(1 / 127, 5);
  });

  it('still catches a stick that rests off centre, which is the case worth finding', () => {
    expect(measureAt(9).peak).toBeCloseTo(9 / 127, 5);
  });

  it('counts a jittering stick, since jitter is not the same as being moved', () => {
    const drift = createDrift();
    push(drift);
    for (let sample = 0; sample < 90; sample += 1) {
      recordDrift(drift, 128 + (sample % 2 === 0 ? 3 : -3), 128, DOMAIN);
    }
    expect(drift.peak).toBeCloseTo(3 / 127, 5);
  });

  it('does not count a thumb resting on the stick out past the view', () => {
    const drift = createDrift();
    push(drift);
    hold(drift, 25, 70);
    expect(drift.peak).toBe(0);
    expect(drift.phase).toBe('returning');
  });

  it('measures distance from centre in both axes together', () => {
    const drift = createDrift();
    push(drift);
    for (let sample = 0; sample < 70; sample += 1) {
      recordDrift(drift, 128 + 3, 128 + 4, DOMAIN);
    }
    expect(drift.peak).toBeCloseTo(5 / 127, 5);
  });

  it('forgets everything on reset', () => {
    const drift = measureAt(6);
    resetDrift(drift);
    expect(drift.peak).toBe(0);
    expect(drift.phase).toBe('idle');
    expect(drift.armed).toBe(false);
  });
});

describe('suggestedDeadzonePercent', () => {
  it('leaves a stick that does not wander alone', () => {
    expect(suggestedDeadzonePercent(0)).toBe(0);
  });

  it('clears the worst bounce seen rather than landing on it', () => {
    const peak = 0.032;
    expect(suggestedDeadzonePercent(peak)).toBeGreaterThan(peak * 100);
  });

  it('never exceeds the slider, so the suggestion is always settable', () => {
    expect(suggestedDeadzonePercent(1)).toBeLessThanOrEqual(50);
  });
});
