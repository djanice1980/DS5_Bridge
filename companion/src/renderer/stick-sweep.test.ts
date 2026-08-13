import { describe, expect, it } from 'vitest';
import {
  SWEEP_MIN_SECTOR_MS,
  SWEEP_SECTORS,
  createSweep,
  directionCoverage,
  recordSweep,
  sweepCoverage,
  sweepIsComplete
} from './StickSweep';

// Stick bytes for a point at `angle` radians and `magnitude` 0..1, matching recordSweep's
// decode ((byte - 128) / 127).
function stickBytes(angle: number, magnitude: number): { x: number; y: number } {
  return {
    x: Math.round(128 + Math.cos(angle) * magnitude * 127),
    y: Math.round(128 + Math.sin(angle) * magnitude * 127)
  };
}

// Sweep one full circle, sampling several times per sector so sector transitions are always
// adjacent, with `msPerSector` between entries. direction +1 = increasing angle.
function sweepCircle(
  sweep: ReturnType<typeof createSweep>,
  options: { direction: 1 | -1; magnitude?: number; msPerSector?: number; startMs?: number }
): number {
  const { direction, magnitude = 0.95, msPerSector = SWEEP_MIN_SECTOR_MS + 10, startMs = 10_000 } = options;
  const samplesPerSector = 3;
  let now = startMs;
  const totalSamples = SWEEP_SECTORS * samplesPerSector + samplesPerSector;
  for (let index = 0; index <= totalSamples; index += 1) {
    const angle = -Math.PI + direction * ((index / samplesPerSector) / SWEEP_SECTORS) * Math.PI * 2;
    const { x, y } = stickBytes(angle, magnitude);
    recordSweep(sweep, x, y, now);
    now += msPerSector / samplesPerSector;
  }
  return now;
}

describe('directional sweep', () => {
  it('one slow clockwise circle completes CW and leaves CCW empty', () => {
    const sweep = createSweep();
    sweepCircle(sweep, { direction: 1 });

    expect(directionCoverage(sweep.cw)).toBe(1);
    expect(directionCoverage(sweep.ccw)).toBe(0);
    expect(sweepIsComplete(sweep)).toBe(false);
  });

  it('a circle each way completes the sweep', () => {
    const sweep = createSweep();
    const after = sweepCircle(sweep, { direction: 1 });
    sweepCircle(sweep, { direction: -1, startMs: after + 500 });

    expect(sweepIsComplete(sweep)).toBe(true);
  });

  it('sweeping too fast earns nothing', () => {
    const sweep = createSweep();
    // Entries far quicker than the minimum dwell: the chain never accrues.
    sweepCircle(sweep, { direction: 1, msPerSector: 5 });

    expect(directionCoverage(sweep.cw)).toBe(0);
    // The picture still fills in -- the trace is display, the credit is the gate.
    expect(sweepCoverage(sweep)).toBeGreaterThan(0.9);
  });

  it('jumping across the circle credits nothing for the skipped sectors', () => {
    const sweep = createSweep();
    let now = 10_000;
    // Alternate between two opposite rim points, slowly: never adjacent, never credited.
    for (let index = 0; index < 40; index += 1) {
      const { x, y } = stickBytes(index % 2 === 0 ? 0 : Math.PI, 0.95);
      recordSweep(sweep, x, y, now);
      now += 100;
    }
    expect(directionCoverage(sweep.cw)).toBe(0);
    expect(directionCoverage(sweep.ccw)).toBe(0);
  });

  it('sub-rim deflection draws the trace but never counts', () => {
    const sweep = createSweep();
    sweepCircle(sweep, { direction: 1, magnitude: 0.6 });

    expect(sweepCoverage(sweep)).toBeGreaterThan(0.9);
    expect(directionCoverage(sweep.cw)).toBe(0);
  });

  it('a resting stick records nothing at all', () => {
    const sweep = createSweep();
    recordSweep(sweep, 128, 128, 1000);
    recordSweep(sweep, 130, 126, 1050);

    expect(sweepCoverage(sweep)).toBe(0);
    expect(directionCoverage(sweep.cw)).toBe(0);
  });
});
