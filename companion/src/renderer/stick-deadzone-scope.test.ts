import { describe, expect, it } from 'vitest';
import {
  READING_DISAGREEMENT_LIMIT,
  createDrift,
  driftDisagreement,
  driftEstimate,
  driftIsComplete,
  recordDrift,
  resetDrift,
  scopeDomain,
  suggestedDeadzonePercent,
  type StickDrift
} from './StickDeadzoneScope';

const DOMAIN = 0.15;

/**
 * A rising sensor clock, so samples look fresh. Shared across a drift so a test never
 * accidentally replays a timestamp and trips the stale-feed guard.
 */
function feed() {
  let clock = 0;
  return {
    push(drift: StickDrift): void {
      clock += 1;
      recordDrift(drift, 128 + 120, 128, DOMAIN, clock);
    },
    hold(drift: StickDrift, counts: number, samples: number, jitter = false): void {
      for (let sample = 0; sample < samples; sample += 1) {
        clock += 1;
        const wobble = jitter ? (sample % 2 === 0 ? 1 : -1) : 0;
        recordDrift(drift, 128 + counts + wobble, 128, DOMAIN, clock);
      }
    },
    creep(drift: StickDrift, from: number, perSample: number, samples: number): void {
      for (let sample = 0; sample < samples; sample += 1) {
        clock += 1;
        recordDrift(drift, 128 + Math.round(from + perSample * sample), 128, DOMAIN, clock);
      }
    },
    /** One clean push-and-release that comes to rest at the given offset. */
    reading(drift: StickDrift, counts: number): void {
      this.push(drift);
      this.hold(drift, counts, 60);
    }
  };
}

/** Three clean readings, which is a complete measurement. */
function measured(counts: number | number[]): StickDrift {
  const drift = createDrift();
  const input = feed();
  const values = Array.isArray(counts) ? counts : [counts, counts, counts];
  for (const value of values) {
    input.reading(drift, value);
  }
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

describe('a clean measurement', () => {
  it('needs three readings before it will offer a result', () => {
    const drift = createDrift();
    const input = feed();
    input.reading(drift, 4);
    expect(driftIsComplete(drift)).toBe(false);
    input.reading(drift, 4);
    expect(driftIsComplete(drift)).toBe(false);
    input.reading(drift, 4);
    expect(driftIsComplete(drift)).toBe(true);
    expect(drift.phase).toBe('done');
  });

  it('measures where the stick came to rest', () => {
    expect(driftEstimate(measured(4))).toBeCloseTo(4 / 127, 5);
  });

  it('measures nothing at all until the stick has been pushed out', () => {
    const drift = createDrift();
    feed().hold(drift, 4, 200);
    expect(drift.phase).toBe('idle');
    expect(drift.readings).toHaveLength(0);
  });

  it('ignores the return journey rather than measuring it', () => {
    const drift = createDrift();
    const input = feed();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      input.push(drift);
      input.creep(drift, 18, -1, 16);
      input.hold(drift, 3, 60);
    }
    expect(driftEstimate(drift)).toBeCloseTo(3 / 127, 5);
  });

  it('waits out the bounce as the stick snaps back', () => {
    const drift = createDrift();
    const input = feed();
    input.push(drift);
    for (const counts of [-14, 10, -7, 5, -3, 2, -1]) {
      recordDrift(drift, 128 + counts, 128, DOMAIN, 1000 + counts);
    }
    expect(drift.phase).toBe('returning');
  });

  it('still catches a stick that genuinely rests off centre', () => {
    expect(driftEstimate(measured(9))).toBeCloseTo(9 / 127, 5);
  });

  it('counts a jittering stick, since jitter is not movement', () => {
    const drift = createDrift();
    const input = feed();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      input.push(drift);
      input.hold(drift, 3, 60, true);
    }
    expect(driftIsComplete(drift)).toBe(true);
    expect(driftEstimate(drift)).toBeCloseTo(4 / 127, 5);
  });
});

describe('mistakes a person will actually make', () => {
  it('throws away a reading taken while the stick was creeping', () => {
    // Slow movement is locally identical to rest, so it cannot be rejected sample by sample. It
    // is caught across the whole reading instead, where a third of a count per sample is obvious.
    const drift = createDrift();
    const input = feed();
    input.push(drift);
    input.creep(drift, 1, 0.34, 60);
    expect(drift.phase).toBe('rejected');
    expect(drift.rejectedBecause).toBe('it was still moving');
    expect(drift.readings).toHaveLength(0);
  });

  it('cannot be nudged by moving the stick after a measurement is finished', () => {
    const drift = measured(3);
    feed().creep(drift, 3, 0.2, 80);
    expect(driftIsComplete(drift)).toBe(true);
    expect(driftEstimate(drift)).toBeCloseTo(3 / 127, 5);
  });

  it('survives one reading contaminated by a thumb left on the stick', () => {
    const drift = measured([2, 11, 2]);
    expect(driftEstimate(drift)).toBeCloseTo(2 / 127, 5);
  });

  it('says so when the readings disagree, rather than quietly averaging them', () => {
    const drift = measured([2, 11, 2]);
    expect(driftDisagreement(drift)).toBeGreaterThan(READING_DISAGREEMENT_LIMIT);
  });

  it('does not cry disagreement over ordinary variation between releases', () => {
    const drift = measured([3, 4, 3]);
    expect(driftDisagreement(drift)).toBeLessThanOrEqual(READING_DISAGREEMENT_LIMIT);
  });

  it('refuses to measure a thumb holding the stick out past the view', () => {
    const drift = createDrift();
    const input = feed();
    input.push(drift);
    input.hold(drift, 25, 80);
    expect(drift.readings).toHaveLength(0);
    expect(drift.phase).toBe('returning');
  });

  it('rejects a dead link instead of reading it as a perfectly steady stick', () => {
    // A feed that stopped updating is the stillest signal there is, and stillness is exactly what
    // this looks for. Only the controller's own clock can tell the two apart.
    const drift = createDrift();
    const input = feed();
    input.push(drift);
    for (let sample = 0; sample < 60; sample += 1) {
      recordDrift(drift, 128 + 3, 128, DOMAIN, 4242);
    }
    expect(drift.phase).toBe('rejected');
    expect(drift.rejectedBecause).toBe('the controller stopped sending');
    expect(drift.readings).toHaveLength(0);
  });

  it('starts a fresh reading whenever the stick is pushed out again', () => {
    const drift = createDrift();
    const input = feed();
    input.reading(drift, 9);
    expect(drift.readings).toHaveLength(1);
    input.push(drift);
    expect(drift.phase).toBe('returning');
    input.hold(drift, 2, 60);
    expect(drift.readings).toEqual([
      expect.closeTo(9 / 127, 5),
      expect.closeTo(2 / 127, 5)
    ]);
  });

  it('keeps only the last three readings, so early fumbles age out', () => {
    const drift = measured([9, 9, 2]);
    const input = feed();
    input.reading(drift, 2);
    input.reading(drift, 2);
    expect(drift.readings).toHaveLength(3);
    expect(driftEstimate(drift)).toBeCloseTo(2 / 127, 5);
  });

  it('forgets everything on reset', () => {
    const drift = measured(6);
    resetDrift(drift);
    expect(drift.readings).toHaveLength(0);
    expect(drift.phase).toBe('idle');
    expect(drift.armed).toBe(false);
    expect(driftIsComplete(drift)).toBe(false);
  });
});

describe('suggestedDeadzonePercent', () => {
  it('leaves a stick that does not wander alone', () => {
    expect(suggestedDeadzonePercent(0)).toBe(0);
  });

  it('clears the worst bounce seen rather than landing on it', () => {
    expect(suggestedDeadzonePercent(0.032)).toBeGreaterThan(3.2);
  });

  it('never exceeds the slider, so the suggestion is always settable', () => {
    expect(suggestedDeadzonePercent(1)).toBeLessThanOrEqual(50);
  });
});
