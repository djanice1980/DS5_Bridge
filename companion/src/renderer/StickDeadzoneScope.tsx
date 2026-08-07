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

/** Samples measured after a release before the reading freezes, at the 40ms poll -- about 2s. */
const MEASURE_SAMPLES = 50;

export type DriftPhase = 'idle' | 'returning' | 'measuring' | 'done';

export const DRIFT_PHASE_LABEL: Record<DriftPhase, string> = {
  idle: 'push it out and let go',
  returning: 'waiting for it to settle',
  measuring: 'measuring',
  done: 'done'
};

export interface StickDrift {
  /** Furthest from centre the stick rested during the LAST measurement, 0..1 of full travel. */
  peak: number;
  phase: DriftPhase;
  /** Set by pushing the stick out; cleared when a measurement finishes. */
  armed: boolean;
  measured: number;
  recent: Array<{ x: number; y: number }>;
}

export function createDrift(): StickDrift {
  return { peak: 0, phase: 'idle', armed: false, measured: 0, recent: [] };
}

export function resetDrift(drift: StickDrift): void {
  drift.peak = 0;
  drift.phase = 'idle';
  drift.armed = false;
  drift.measured = 0;
  drift.recent = [];
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
export function recordDrift(drift: StickDrift, xByte: number, yByte: number, domain: number): void {
  const x = (xByte - 128) / 127;
  const y = (yByte - 128) / 127;
  const magnitude = Math.hypot(x, y);

  // A deliberate push throws away whatever was measured before and starts a fresh attempt.
  if (magnitude > ARM_TRAVEL) {
    drift.peak = 0;
    drift.phase = 'returning';
    drift.armed = true;
    drift.measured = 0;
    drift.recent = [];
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

  // Still waiting out the bounce as it snaps back, or a thumb is still resting on it out past
  // the view. Either way it is not yet sitting where it will end up.
  if (spread > STILL_SPREAD || trend > STILL_TREND || magnitude > domain) {
    drift.phase = 'returning';
    return;
  }

  drift.phase = 'measuring';
  if (magnitude > drift.peak) {
    drift.peak = magnitude;
  }
  drift.measured += 1;
  if (drift.measured >= MEASURE_SAMPLES) {
    drift.phase = 'done';
    drift.armed = false;
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
  phase
}: {
  label: string;
  x: number;
  y: number;
  deadzonePercent: number;
  peak: number;
  phase: DriftPhase;
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
        <span className="tester-mono">
          {phase === 'idle' ? 'peak --' : `peak ${(peak * 100).toFixed(1)}%`}
        </span>
        {/* Names the step, so a reading that is not moving is never mistaken for a finished one. */}
        <span className={`dzscope-state is-${phase}`}>{DRIFT_PHASE_LABEL[phase]}</span>
        <span className="dzscope-view">view &plusmn;{Math.round(domain * 100)}%</span>
      </div>
    </div>
  );
}
