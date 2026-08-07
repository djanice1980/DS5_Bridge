import './stick-sweep.css';

/**
 * Coverage trace for a stick, for the range calibration sweep.
 *
 * The controller learns its range from what the stick actually reaches while the session is open,
 * so a sweep that misses part of the circle teaches it a range that is wrong THERE and nowhere
 * else -- and nothing about the result says which part was missed. This draws how far the stick
 * has been pushed in each direction so far, which turns "sweep it around" into something you can
 * see the end of.
 *
 * Kept as max-per-sector rather than a path history: what matters is the FURTHEST the stick
 * reached in each direction, not the route it took getting there.
 */

export const SWEEP_SECTORS = 48;

export function createSweep(): number[] {
  return new Array<number>(SWEEP_SECTORS).fill(0);
}

/** Fold one sample into the trace. Mutates, because this runs at the input poll rate. */
export function recordSweep(sectors: number[], xByte: number, yByte: number): void {
  const x = (xByte - 128) / 127;
  const y = (yByte - 128) / 127;
  const magnitude = Math.min(1, Math.hypot(x, y));
  // Near the centre the angle is meaningless -- noise would smear a resting stick across every
  // sector and make an untouched stick look swept.
  if (magnitude < 0.25) {
    return;
  }
  const angle = Math.atan2(y, x);
  const sector = Math.floor(((angle + Math.PI) / (Math.PI * 2)) * SWEEP_SECTORS) % SWEEP_SECTORS;
  if (magnitude > sectors[sector]) {
    sectors[sector] = magnitude;
  }
}

/** How much of the circle has been reached at all, 0..1. */
export function sweepCoverage(sectors: number[]): number {
  return sectors.filter((value) => value > 0).length / SWEEP_SECTORS;
}

export function StickSweep({
  label,
  sectors,
  x,
  y
}: {
  label: string;
  sectors: number[];
  x: number;
  y: number;
}) {
  const RADIUS = 34;
  const CENTRE = 40;

  const points = sectors.map((magnitude, index) => {
    const angle = ((index + 0.5) / SWEEP_SECTORS) * Math.PI * 2 - Math.PI;
    const reach = magnitude * RADIUS;
    return `${(CENTRE + Math.cos(angle) * reach).toFixed(1)},${(CENTRE + Math.sin(angle) * reach).toFixed(1)}`;
  }).join(' ');

  const nx = (x - 128) / 127;
  const ny = (y - 128) / 127;
  const coverage = Math.round(sweepCoverage(sectors) * 100);

  return (
    <div className="sweep">
      <svg viewBox="0 0 80 80" aria-label={`${label} stick coverage`}>
        <circle cx={CENTRE} cy={CENTRE} r={RADIUS} className="sweep-edge" />
        <circle cx={CENTRE} cy={CENTRE} r={RADIUS * 0.66} className="sweep-edge sweep-edge-inner" />
        {/* Filled reach so far. Gaps are the point: they are the directions still to cover. */}
        <polygon points={points} className="sweep-area" />
        <circle
          cx={CENTRE + nx * RADIUS}
          cy={CENTRE + ny * RADIUS}
          r={3.5}
          className="sweep-cursor"
        />
      </svg>
      <span className="sweep-label">{label}</span>
      <span className="tester-mono sweep-coverage">{coverage}%</span>
    </div>
  );
}
