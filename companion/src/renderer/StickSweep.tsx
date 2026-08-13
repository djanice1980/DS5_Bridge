import './stick-sweep.css';

/**
 * Coverage trace for a stick, for the range calibration sweep.
 *
 * The controller learns its range from what the stick actually reaches while the session is
 * open, so a sweep that misses part of the circle teaches it a range that is wrong THERE and
 * nowhere else -- and nothing about the result says which part was missed. This draws how far
 * the stick has been pushed in each direction so far, which turns "sweep it around" into
 * something you can see the end of.
 *
 * The store gate is stricter than the picture. A range calibration that was stored after a
 * quick, partial wave produced sticks that were wrong at the rim, so a sector only COUNTS when
 * it is entered in order (its neighbour was the previous sector -- sweeping too fast skips
 * sectors and earns nothing), at rim deflection, at a bounded average pace -- and the
 * circle has to be completed twice, once clockwise and once counterclockwise. Two directions
 * because a pot reads slightly differently approaching from each side; the controller should
 * see both extremes.
 */

export const SWEEP_SECTORS = 48;
/** Only rim-level deflection teaches the controller anything about range. */
export const SWEEP_RIM_MAGNITUDE = 0.85;
/** Minimum AVERAGE time per sector: a full circle takes at least SWEEP_SECTORS * this (~1.5 s).
 *  Averaged over a window rather than checked per step, because sector-boundary jitter makes
 *  individual entry intervals wildly uneven even at a perfectly steady hand. */
export const SWEEP_MIN_SECTOR_MS = 30;
/** How many recent sector entries the pace average looks back over. Bounded so a slow start
 *  cannot bank time that a fast finish then spends. */
export const SWEEP_PACE_WINDOW = 8;

export interface DirectionalSweep {
  /** Furthest reach per sector, for the picture. Fills from 25% deflection like it always did. */
  sectors: number[];
  cw: boolean[];
  ccw: boolean[];
  lastSector: number | null;
  lastEntryAt: number | null;
  /** Direction of the current continuous run: 1 = CW, -1 = CCW, 0 = none. */
  chainDir: 1 | -1 | 0;
  /** Entry timestamps of the current run, newest last, capped at SWEEP_PACE_WINDOW. */
  chainEntries: number[];
}

export function createSweep(): DirectionalSweep {
  return {
    sectors: new Array<number>(SWEEP_SECTORS).fill(0),
    cw: new Array<boolean>(SWEEP_SECTORS).fill(false),
    ccw: new Array<boolean>(SWEEP_SECTORS).fill(false),
    lastSector: null,
    lastEntryAt: null,
    chainDir: 0,
    chainEntries: []
  };
}

/** Fold one sample into the trace. Mutates, because this runs at the input poll rate. */
export function recordSweep(sweep: DirectionalSweep, xByte: number, yByte: number, nowMs: number): void {
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
  if (magnitude > sweep.sectors[sector]) {
    sweep.sectors[sector] = magnitude;
  }

  // Directional credit only happens at the rim.
  if (magnitude < SWEEP_RIM_MAGNITUDE) {
    return;
  }
  if (sweep.lastSector === null || sweep.lastEntryAt === null) {
    sweep.lastSector = sector;
    sweep.lastEntryAt = nowMs;
    sweep.chainDir = 0;
    sweep.chainEntries = [nowMs];
    return;
  }
  if (sector === sweep.lastSector) {
    return;
  }

  const delta = (sector - sweep.lastSector + SWEEP_SECTORS) % SWEEP_SECTORS;
  const stepDir: 1 | -1 | 0 = delta === 1 ? 1 : delta === SWEEP_SECTORS - 1 ? -1 : 0;

  if (stepDir === 0 || (sweep.chainDir !== 0 && stepDir !== sweep.chainDir)) {
    // Skipped sectors (too fast for the poll rate to vouch for) or a direction change: the
    // run re-anchors here with nothing credited for what was jumped over.
    sweep.chainDir = stepDir;
    sweep.chainEntries = [nowMs];
  } else {
    sweep.chainDir = stepDir;
    sweep.chainEntries.push(nowMs);
    if (sweep.chainEntries.length > SWEEP_PACE_WINDOW) {
      sweep.chainEntries.shift();
    }
    // Average pace over the recent window. Individual steps jitter hugely at the sector
    // boundaries even for a steady hand, so per-step dwell is unenforceable; the average over
    // several sectors is what a human sweeping "about two seconds around" actually controls.
    const span = nowMs - sweep.chainEntries[0];
    const steps = sweep.chainEntries.length - 1;
    if (steps > 0 && span >= steps * SWEEP_MIN_SECTOR_MS) {
      if (stepDir === 1) {
        sweep.cw[sector] = true;
      } else {
        sweep.ccw[sector] = true;
      }
    }
  }

  sweep.lastSector = sector;
  sweep.lastEntryAt = nowMs;
}

/** How much of the circle has been reached at all, 0..1. For the picture. */
export function sweepCoverage(sweep: DirectionalSweep): number {
  return sweep.sectors.filter((value) => value > 0).length / SWEEP_SECTORS;
}

export function directionCoverage(visited: boolean[]): number {
  return visited.filter(Boolean).length / visited.length;
}

/** Both full passes done: once around clockwise AND once around counterclockwise. */
export function sweepIsComplete(sweep: DirectionalSweep): boolean {
  return sweep.cw.every(Boolean) && sweep.ccw.every(Boolean);
}

export function StickSweep({
  label,
  sweep,
  x,
  y
}: {
  label: string;
  sweep: DirectionalSweep;
  x: number;
  y: number;
}) {
  const RADIUS = 34;
  const CENTRE = 40;

  const points = sweep.sectors.map((magnitude, index) => {
    const angle = ((index + 0.5) / SWEEP_SECTORS) * Math.PI * 2 - Math.PI;
    const reach = magnitude * RADIUS;
    return `${(CENTRE + Math.cos(angle) * reach).toFixed(1)},${(CENTRE + Math.sin(angle) * reach).toFixed(1)}`;
  }).join(' ');

  const nx = (x - 128) / 127;
  const ny = (y - 128) / 127;
  const cwPercent = Math.round(directionCoverage(sweep.cw) * 100);
  const ccwPercent = Math.round(directionCoverage(sweep.ccw) * 100);

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
      <span className="tester-mono sweep-coverage">
        CW {cwPercent}% &middot; CCW {ccwPercent}%
      </span>
    </div>
  );
}
