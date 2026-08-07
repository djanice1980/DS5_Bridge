import './stick-deadzone-scope.css';

/**
 * Zoomed view of a stick near centre, for choosing a deadzone by eye.
 *
 * A resting stick drifts by one or two counts out of 127. At true scale that is a pixel, which is
 * why the deadzone slider previously had to be set blind. This magnifies the region around centre
 * so the bounce is visible, and draws the candidate deadzone as a disc at the SAME magnification --
 * so "the dot stays inside the circle" is a fair comparison and answers the actual question: is
 * this deadzone big enough to swallow the drift?
 *
 * The view only ever zooms to fit the DEADZONE, never the live position. Zooming to fit the stick
 * would rescale the moment anyone nudged it, and the drift you were judging would change size
 * under you. A stick pushed past the view pins at the rim instead.
 */

/** View sizes the scope snaps between, as a fraction of full stick travel. */
const SCOPE_STEPS = [0.15, 0.25, 0.4, 0.65, 1];

const CENTRE = 50;
const RADIUS = 40;

/** Smallest view that leaves the deadzone disc inside the rim. Snapped, so dragging the slider
 *  rescales at a few known points rather than continuously. */
export function scopeDomain(deadzonePercent: number): number {
  const needed = (deadzonePercent / 100) / 0.8;
  return SCOPE_STEPS.find((step) => step >= needed) ?? 1;
}

/**
 * Samples that must agree before a stick counts as at rest, at the 40ms poll -- about a third of
 * a second. Long enough to outlast the bounce as a released stick snaps back and overshoots.
 */
const STILL_WINDOW = 8;

/**
 * How far apart those samples may sit and still count as still, in counts of 127.
 *
 * This is a SPREAD, not a distance from centre, so a stick resting off-centre still qualifies --
 * which matters, because a resting offset is exactly what the deadzone has to cover. Set above
 * ordinary jitter (a few counts) and far below what a stick covers while actually being moved.
 */
const STILL_SPREAD = 8 / 127;

/**
 * How far the window's centre of mass may shift from its first half to its second, in counts.
 *
 * Spread alone cannot tell a slow sweep from jitter: a stick creeping back a count per sample
 * stays within a small spread the whole way, so a healthy pad measured its own return journey.
 * Jitter oscillates about a point and shifts its halves barely at all; travel moves them apart no
 * matter how gently it is done.
 */
const STILL_TREND = 2 / 127;

export interface StickDrift {
  /** Furthest from centre the stick has RESTED, 0..1 of full travel. */
  peak: number;
  /** Whether the stick is currently sitting still, so the UI can say why nothing is counting. */
  settled: boolean;
  recent: Array<{ x: number; y: number }>;
}

export function createDrift(): StickDrift {
  return { peak: 0, settled: false, recent: [] };
}

export function resetDrift(drift: StickDrift): void {
  drift.peak = 0;
  drift.settled = false;
  drift.recent = [];
}

/**
 * Fold one sample into the peak, but only while the stick is AT REST. Mutates, because this runs
 * at the input poll rate.
 *
 * Measuring every sample measured the wrong thing: moving a stick and letting it snap back walks
 * it through the whole view, and each of those positions counted as drift, so a healthy pad
 * reported a peak the size of the view. Drift is where a stick SITS when nobody is touching it,
 * so the stick has to be still before anything counts.
 *
 * Samples beyond the view are ignored on top of that, for a thumb resting on a pushed stick: that
 * is a held position, not a resting one, and counting it would drive the suggestion toward a
 * deadzone the size of the whole travel. The UI states both rules, so neither is a silent one.
 */
export function recordDrift(drift: StickDrift, xByte: number, yByte: number, domain: number): void {
  const x = (xByte - 128) / 127;
  const y = (yByte - 128) / 127;

  drift.recent.push({ x, y });
  if (drift.recent.length > STILL_WINDOW) {
    drift.recent.shift();
  }
  if (drift.recent.length < STILL_WINDOW) {
    drift.settled = false;
    return;
  }

  const mean = (samples: Array<{ x: number; y: number }>) => ({
    x: samples.reduce((total, s) => total + s.x, 0) / samples.length,
    y: samples.reduce((total, s) => total + s.y, 0) / samples.length
  });

  const centre = mean(drift.recent);
  const spread = Math.max(...drift.recent.map((s) => Math.hypot(s.x - centre.x, s.y - centre.y)));

  const half = Math.floor(drift.recent.length / 2);
  const first = mean(drift.recent.slice(0, half));
  const second = mean(drift.recent.slice(half));
  const trend = Math.hypot(second.x - first.x, second.y - first.y);

  drift.settled = spread <= STILL_SPREAD && trend <= STILL_TREND;
  if (!drift.settled) {
    return;
  }

  const magnitude = Math.hypot(x, y);
  if (magnitude > domain) {
    return;
  }
  if (magnitude > drift.peak) {
    drift.peak = magnitude;
  }
}

/** One point of headroom over the worst bounce seen, so the peak sits inside rather than on the
 *  boundary. Zero drift stays zero -- a stick that does not wander needs no deadzone at all. */
export function suggestedDeadzonePercent(peak: number): number {
  if (peak <= 0) {
    return 0;
  }
  return Math.min(50, Math.ceil(peak * 100) + 1);
}

export function StickDeadzoneScope({
  label,
  x,
  y,
  deadzonePercent,
  peak,
  settled
}: {
  label: string;
  x: number;
  y: number;
  deadzonePercent: number;
  peak: number;
  settled: boolean;
}) {
  const domain = scopeDomain(deadzonePercent);
  const nx = (x - 128) / 127;
  const ny = (y - 128) / 127;
  const magnitude = Math.hypot(nx, ny);

  // Pinned at the rim rather than drawn outside the scope, and marked, so a stick held over is
  // obviously "off the scale" instead of quietly reading as the edge value.
  const pinned = magnitude > domain;
  const scale = (pinned ? domain / magnitude : 1) / domain;

  const deadzoneRadius = Math.min(RADIUS, ((deadzonePercent / 100) / domain) * RADIUS);
  const peakRadius = Math.min(RADIUS, (peak / domain) * RADIUS);
  const covered = deadzonePercent > 0 && peak * 100 <= deadzonePercent;

  return (
    <div className="dzscope">
      <svg viewBox="0 0 100 100" aria-label={`${label} stick, zoomed to ${Math.round(domain * 100)}% of travel`}>
        <circle cx={CENTRE} cy={CENTRE} r={RADIUS} className="dzscope-edge" />
        {/* Solid crosshair. A dashed one reads as a broken ring and makes centre hard to find. */}
        <line x1={CENTRE - RADIUS} y1={CENTRE} x2={CENTRE + RADIUS} y2={CENTRE} className="dzscope-cross" />
        <line x1={CENTRE} y1={CENTRE - RADIUS} x2={CENTRE} y2={CENTRE + RADIUS} className="dzscope-cross" />

        {deadzoneRadius > 0 ? (
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={deadzoneRadius}
            className={`dzscope-deadzone${covered ? ' is-covered' : ''}`}
          />
        ) : null}

        {/* The worst bounce so far, which is the number the deadzone actually has to clear -- the
            live dot alone only ever shows one instant of it. */}
        {peakRadius > 0 ? (
          <circle cx={CENTRE} cy={CENTRE} r={peakRadius} className="dzscope-peak" />
        ) : null}

        <circle
          cx={CENTRE + nx * scale * RADIUS}
          cy={CENTRE + ny * scale * RADIUS}
          r={2.2}
          className={`dzscope-cursor${pinned ? ' is-pinned' : ''}`}
        />
      </svg>
      <div className="dzscope-readout">
        <span className="dzscope-label">{label}</span>
        <span className="tester-mono">peak {(peak * 100).toFixed(1)}%</span>
        {/* Says WHY nothing is accumulating, so a moving stick does not look like a broken one. */}
        <span className={`dzscope-state${settled ? ' is-settled' : ''}`}>
          {settled ? 'measuring' : 'moving — not counting'}
        </span>
        <span className="dzscope-view">view &plusmn;{Math.round(domain * 100)}%</span>
      </div>
    </div>
  );
}
