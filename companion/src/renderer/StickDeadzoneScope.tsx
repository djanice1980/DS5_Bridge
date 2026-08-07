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

/**
 * How far out the stick must go to arm a measurement, as a fraction of full travel.
 *
 * Deliberately far past anything drift could reach, so pushing it out is unambiguously a gesture
 * and not something a resting stick can do by accident.
 */
const ARM_TRAVEL = 0.4;

/** Samples measured after a release before a reading is taken, at the 40ms poll -- about 1.6s. */
const MEASURE_SAMPLES = 40;

/**
 * How far the measuring window's centre of mass may shift between its halves, in counts.
 *
 * The same test as STILL_TREND over a far longer baseline, and that is the whole point. Slow
 * movement beats an eight-sample window because it barely moves it: a third of a count per sample
 * shifts the halves by about one count, which is inside any threshold that still accepts jitter.
 * Across forty samples the same movement shifts them by seven. A reading that fails this is
 * REJECTED rather than trimmed -- the stick was moving, so there is no measurement to salvage.
 */
const MEASURE_TREND = 2.5 / 127;

/**
 * Readings that must agree before a result is offered.
 *
 * One reading cannot be checked. A thumb still resting on a "released" stick sits perfectly still
 * and is indistinguishable from drift in every sample it produces -- but it does not land in the
 * same place twice. Taking the middle of three readings survives one bad one, and the spread
 * across them is shown so a bad one is visible rather than merely outvoted.
 */
const REQUIRED_READINGS = 3;

/** Readings further apart than this mean something other than the stick is being measured. */
export const READING_DISAGREEMENT_LIMIT = 4 / 127;

export type DriftPhase = 'idle' | 'returning' | 'measuring' | 'rejected' | 'done';

export const DRIFT_PHASE_LABEL: Record<DriftPhase, string> = {
  idle: 'push it out and let go',
  returning: 'waiting for it to settle',
  measuring: 'measuring',
  rejected: 'discarded',
  done: 'done'
};

export interface StickDrift {
  /** One completed reading per release, each the furthest the stick sat from centre. */
  readings: number[];
  phase: DriftPhase;
  /** Why the last reading was thrown away, shown so a discard is never silent. */
  rejectedBecause: string | null;
  /** Set by pushing the stick out; cleared when a reading completes or is rejected. */
  armed: boolean;
  /** Settle detector, for waiting out the bounce. */
  recent: Array<{ x: number; y: number }>;
  /** Samples of the reading in progress, checked as a whole before the reading is accepted. */
  window: Array<{ x: number; y: number }>;
  lastTimestamp: number | null;
  /** Consecutive samples the controller has not refreshed. */
  stale: number;
}

export function createDrift(): StickDrift {
  return {
    readings: [],
    phase: 'idle',
    rejectedBecause: null,
    armed: false,
    recent: [],
    window: [],
    lastTimestamp: null,
    stale: 0
  };
}

export function resetDrift(drift: StickDrift): void {
  const fresh = createDrift();
  Object.assign(drift, fresh);
}

/**
 * The drift to design around: the MIDDLE of the readings, not the worst.
 *
 * The worst would hand a whole session to one contaminated reading, which is exactly the failure
 * repetition is here to survive. The individual readings are on screen, so a genuinely worse one
 * is still visible and can still be dialled in by hand.
 */
export function driftEstimate(drift: StickDrift): number {
  if (drift.readings.length === 0) {
    return 0;
  }
  const sorted = [...drift.readings].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** How far apart the readings are. Large means something other than the stick was measured. */
export function driftDisagreement(drift: StickDrift): number {
  if (drift.readings.length < 2) {
    return 0;
  }
  return Math.max(...drift.readings) - Math.min(...drift.readings);
}

export function driftIsComplete(drift: StickDrift): boolean {
  return drift.readings.length >= REQUIRED_READINGS;
}

/**
 * Advance the measurement for one sample. Mutates, because this runs at the input poll rate.
 *
 * Measuring continuously cannot work, and two rounds of it on real hardware showed why. Every
 * sample counted meant a stick swept and released measured its own return journey. Gating on
 * stillness fixed that case and not the general one: slow movement is LOCALLY IDENTICAL to rest,
 * so a stick eased outward a third of a count per sample reads as sitting still no matter how the
 * window is tuned, and it inflated the reading again.
 *
 * So this stops inferring intent from the signal and takes it from the gesture instead. Push a
 * stick out past ARM_TRAVEL and the previous reading is discarded; let go, and once it has
 * settled it is measured for a fixed window and the result freezes. Nothing before the push and
 * nothing after the window can affect it, which is what makes a slow hand harmless: creeping the
 * stick outward afterwards cannot touch a finished reading, and creeping it out far enough to
 * matter re-arms and starts over.
 */
export function recordDrift(
  drift: StickDrift,
  xByte: number,
  yByte: number,
  domain: number,
  timestamp: number
): void {
  const x = (xByte - 128) / 127;
  const y = (yByte - 128) / 127;
  const magnitude = Math.hypot(x, y);

  /**
   * A frozen feed is perfectly still, and stillness is what this whole thing looks for -- so a
   * dropped link would read as the steadiest stick ever measured and freeze a result on it. The
   * controller's own sensor clock is the only thing here that can tell a still stick from a dead
   * one.
   */
  if (timestamp === drift.lastTimestamp) {
    drift.stale += 1;
    if (drift.stale > STILL_WINDOW) {
      reject(drift, 'the controller stopped sending');
    }
    return;
  }
  drift.lastTimestamp = timestamp;
  drift.stale = 0;

  // A deliberate push starts a fresh reading. Every push is the reset, so a reading taken wrong
  // is never something to clear -- only something to take again.
  if (magnitude > ARM_TRAVEL) {
    drift.phase = 'returning';
    drift.rejectedBecause = null;
    drift.armed = true;
    drift.recent = [];
    drift.window = [];
    return;
  }

  if (!drift.armed) {
    return;
  }

  drift.recent.push({ x, y });
  if (drift.recent.length > STILL_WINDOW) {
    drift.recent.shift();
  }
  if (drift.recent.length < STILL_WINDOW) {
    return;
  }

  const centre = mean(drift.recent);
  const spread = Math.max(...drift.recent.map((s) => Math.hypot(s.x - centre.x, s.y - centre.y)));
  const settled = spread <= STILL_SPREAD && trendOf(drift.recent) <= STILL_TREND;

  // Still bouncing back, or a thumb is holding it out past the view. Either way it is not yet
  // sitting where it will end up, so the reading has not started.
  if (!settled || magnitude > domain) {
    drift.phase = 'returning';
    drift.window = [];
    return;
  }

  drift.phase = 'measuring';
  drift.window.push({ x, y });
  if (drift.window.length < MEASURE_SAMPLES) {
    return;
  }

  // The whole window is judged at once, on a baseline long enough that movement slow enough to
  // hide inside the settle detector cannot hide here.
  if (trendOf(drift.window) > MEASURE_TREND) {
    reject(drift, 'it was still moving');
    return;
  }

  drift.readings.push(Math.max(...drift.window.map((s) => Math.hypot(s.x, s.y))));
  if (drift.readings.length > REQUIRED_READINGS) {
    drift.readings.shift();
  }
  drift.phase = driftIsComplete(drift) ? 'done' : 'returning';
  drift.armed = false;
  drift.window = [];
  drift.recent = [];
}

function mean(samples: Array<{ x: number; y: number }>): { x: number; y: number } {
  return {
    x: samples.reduce((total, s) => total + s.x, 0) / samples.length,
    y: samples.reduce((total, s) => total + s.y, 0) / samples.length
  };
}

/** How far the samples' centre of mass moves from their first half to their second. */
function trendOf(samples: Array<{ x: number; y: number }>): number {
  const half = Math.floor(samples.length / 2);
  const first = mean(samples.slice(0, half));
  const second = mean(samples.slice(half));
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function reject(drift: StickDrift, because: string): void {
  drift.phase = 'rejected';
  drift.rejectedBecause = because;
  drift.armed = false;
  drift.window = [];
  drift.recent = [];
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
  drift
}: {
  label: string;
  x: number;
  y: number;
  deadzonePercent: number;
  drift: StickDrift;
}) {
  const peak = driftEstimate(drift);
  const phase = drift.phase;
  const complete = driftIsComplete(drift);
  const disagrees = driftDisagreement(drift) > READING_DISAGREEMENT_LIMIT;
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
  // Only a finished measurement can turn the disc green. A partial one going green would say the
  // deadzone is big enough on the strength of evidence that is not all in yet.
  const covered = complete && !disagrees && deadzonePercent > 0 && peak * 100 <= deadzonePercent;

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
        <span className="tester-mono">
          {complete ? `drift ${(peak * 100).toFixed(1)}%` : `reading ${drift.readings.length} of ${REQUIRED_READINGS}`}
        </span>
        {/* Names the step, so an unfinished or discarded reading is never mistaken for a result.
            Disagreeing readings never read as done, however many of them there are. */}
        <span className={`dzscope-state is-${phase}${disagrees ? ' is-doubtful' : ''}`}>
          {phase === 'rejected' ? `discarded — ${drift.rejectedBecause}` : DRIFT_PHASE_LABEL[phase]}
        </span>
        {/* The readings themselves, so a bad one is visible rather than merely outvoted. */}
        {drift.readings.length > 0 ? (
          <span className={`dzscope-readings${disagrees ? ' is-disagreeing' : ''}`}>
            {drift.readings.map((reading) => `${(reading * 100).toFixed(1)}%`).join('  ')}
          </span>
        ) : null}
        {disagrees ? (
          <span className="dzscope-warning">
            readings disagree — a thumb still on the stick does this
          </span>
        ) : null}
        <span className="dzscope-view">view &plusmn;{Math.round(domain * 100)}%</span>
      </div>
    </div>
  );
}
