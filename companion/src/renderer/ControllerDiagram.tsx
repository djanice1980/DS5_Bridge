import { createElement } from 'react';
import type { DualSenseInputState } from '../shared/dualsense-input';
import { DUALSENSE_TOUCHPAD_HEIGHT, DUALSENSE_TOUCHPAD_WIDTH } from '../shared/dualsense-input';
import { DUALSENSE_ART, DUALSENSE_VIEWBOX, type DualSenseArtRole } from './dualsense-art';

/**
 * DualSense driven by live input, over artwork from daidr/dualsense-tester (MIT, see
 * dualsense-art.ts and NOTICE.txt).
 *
 * Two deliberately different visual languages, because conflating them hides what the hardware
 * actually reports:
 *
 *   - DIGITAL controls snap. No transition at all -- a button is pressed or it is not, and any
 *     easing would invent intermediate states the controller never sent.
 *   - ANALOGUE controls fade in proportion to their value. A trigger at 40 and a trigger at 250
 *     must not look alike, and the fade is what makes a sticky or drifting axis visible.
 */

/** Touchpad bounds in artwork units, taken from the touchpad path, for placing live contacts. */
const TOUCHPAD = { x: 292, y: 143, width: 534, height: 254 };
/** Stick centres and cap radius in artwork units, from l3/r3. */
const LEFT_STICK = { cx: 351.764, cy: 528.548 };
const RIGHT_STICK = { cx: 763.456, cy: 528.548 };
/** How far a cap travels from centre at full deflection. The well is 87 and the cap 57, so this
 *  keeps the cap inside its well rather than sliding out of the drawing. */
const STICK_TRAVEL = 26;

function axis(value: number): number {
  return (value - 128) / 127;
}

/** 0..1 -> a fill opacity visible early without saturating immediately. */
function analogueOpacity(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return clamped === 0 ? 0 : 0.2 + clamped * 0.8;
}

export function ControllerDiagram({ state }: { state: DualSenseInputState | null }) {
  const s = state;

  const pressed: Partial<Record<DualSenseArtRole, boolean>> = {
    l1: s?.l1 === true,
    r1: s?.r1 === true,
    touchpad: s?.touchpadButton === true,
    create: s?.create === true,
    options: s?.options === true,
    dpadUp: s?.dpadUp === true,
    dpadDown: s?.dpadDown === true,
    dpadLeft: s?.dpadLeft === true,
    dpadRight: s?.dpadRight === true,
    triangle: s?.triangle === true,
    circle: s?.circle === true,
    cross: s?.cross === true,
    square: s?.square === true,
    l3: s?.l3 === true,
    r3: s?.r3 === true,
    ps: s?.home === true,
    mute: s?.mute === true
  };

  // The triggers are analogue, so they tint by travel instead of snapping. Their digital press
  // bit is deliberately NOT used to fill them -- it would jump to full at the actuation point
  // and hide the travel either side of it.
  const analogue: Partial<Record<DualSenseArtRole, number>> = {
    l2: (s?.leftTrigger ?? 0) / 255,
    r2: (s?.rightTrigger ?? 0) / 255
  };

  const leftAxis = { x: axis(s?.leftStickX ?? 128), y: axis(s?.leftStickY ?? 128) };
  const rightAxis = { x: axis(s?.rightStickX ?? 128), y: axis(s?.rightStickY ?? 128) };

  return (
    <svg
      viewBox={DUALSENSE_VIEWBOX}
      className="tester-controller"
      role="img"
      aria-label="Controller input"
    >
      {DUALSENSE_ART.map((element, index) => {
        // The artwork's own touch dots are placeholders at fixed positions; live contacts are
        // drawn below instead. Rendering both would show two sets of fingers.
        if (element.role === 'touchDot') {
          return null;
        }

        const analogueFraction = analogue[element.role];
        const isPressed = pressed[element.role] === true;

        // Stick caps translate with their axes; the wells stay put, so deflection reads as the
        // stick moving rather than the whole assembly sliding.
        let transform: string | undefined;
        if (element.role === 'l3') {
          transform = `translate(${leftAxis.x * STICK_TRAVEL} ${leftAxis.y * STICK_TRAVEL})`;
        } else if (element.role === 'r3') {
          transform = `translate(${rightAxis.x * STICK_TRAVEL} ${rightAxis.y * STICK_TRAVEL})`;
        }

        const className = [
          'ds-part',
          `ds-${element.role}`,
          isPressed ? 'is-on' : ''
        ].filter(Boolean).join(' ');

        const shape = createElement(element.tag, {
          ...element.attrs,
          className,
          key: 'base'
        });

        // The analogue overlay is the same shape drawn again, tinted by travel.
        const overlay = analogueFraction !== undefined && analogueFraction > 0
          ? createElement(element.tag, {
            ...element.attrs,
            className: 'ds-analogue',
            fillOpacity: analogueOpacity(analogueFraction),
            key: 'analogue'
          })
          : null;

        return <g key={index} transform={transform}>{shape}{overlay}</g>;
      })}

      {/* Live touch contacts, replacing the artwork's placeholders. */}
      {s?.touchPoints.map((point, index) => (
        point.active
          ? (
            <circle
              key={index}
              className={`ds-touch ds-touch-${index}`}
              cx={TOUCHPAD.x + (point.x / DUALSENSE_TOUCHPAD_WIDTH) * TOUCHPAD.width}
              cy={TOUCHPAD.y + (point.y / DUALSENSE_TOUCHPAD_HEIGHT) * TOUCHPAD.height}
              r={19}
            />
          )
          : null
      ))}

      {/* Deflection dots, so small stick movement is readable rather than merely implied. */}
      <circle
        className="ds-stick-dot"
        cx={LEFT_STICK.cx + leftAxis.x * STICK_TRAVEL}
        cy={LEFT_STICK.cy + leftAxis.y * STICK_TRAVEL}
        r={7}
      />
      <circle
        className="ds-stick-dot"
        cx={RIGHT_STICK.cx + rightAxis.x * STICK_TRAVEL}
        cy={RIGHT_STICK.cy + rightAxis.y * STICK_TRAVEL}
        r={7}
      />
    </svg>
  );
}

/**
 * Gyro as three dials: one per axis, each an arc sweeping from neutral in the direction of
 * rotation, length proportional to rate. A dial that never returns to neutral at rest is drift,
 * which a numeric readout alone makes very easy to miss.
 */
export function GyroDial({ label, value }: { label: string; value: number }) {
  // Full scale chosen so ordinary hand movement uses most of the dial rather than pinning it.
  const FULL_SCALE = 8000;
  const fraction = Math.max(-1, Math.min(1, value / FULL_SCALE));
  const radius = 26;
  const sweep = fraction * Math.PI * 0.9;
  const endX = 32 + Math.sin(sweep) * radius;
  const endY = 32 - Math.cos(sweep) * radius;
  const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;

  return (
    <div className="tester-dial">
      <svg viewBox="0 0 64 64" aria-label={`${label} rate`}>
        <circle cx={32} cy={32} r={radius} className="tester-dial-track" />
        <line x1={32} y1={32} x2={32} y2={32 - radius} className="tester-dial-neutral" />
        {fraction !== 0 && (
          <path
            d={`M 32 ${32 - radius} A ${radius} ${radius} 0 ${largeArc} ${fraction > 0 ? 1 : 0} ${endX} ${endY}`}
            className="tester-dial-arc"
          />
        )}
        <circle cx={endX} cy={endY} r={4} className="tester-dial-head" />
      </svg>
      <span className="tester-dial-label">{label}</span>
      <span className="tester-mono tester-dial-value">{value}</span>
    </div>
  );
}

/**
 * Acceleration as a vector.
 *
 * The needle plots X and Z -- the plane PARALLEL to a desk -- and the vertical axis goes on the
 * bar. Plotting X/Y instead pinned the needle at full deflection just from the controller sitting
 * still, which says nothing. The bar is centre-zero for the same reason: measured absolute it
 * parked at ~96% and never moved.
 *
 * A DualSense resting on a desk is NOT level. Measured on hardware it reads X=1, Y=7998, Z=1390 --
 * an X of 1 says the sensor zero is excellent, so that Z is a real ~9.9 degree nose-up tilt from
 * the controller sitting on its grips, not drift. The needle showing an offset there is correct.
 *
 * Hence `zero`: an EXPLICIT capture of the current reading as the origin, so the resting pose can
 * be made the centre when that is what you want to watch movement against. It is never applied
 * automatically and never persists across sessions -- a tester that zeroed itself on open would
 * define away the fault it exists to find, since a genuinely offset sensor would read perfect
 * every time. While a capture is active the panel says so.
 */

/**
 * Magnitude at 1g, from the measured resting vector (~8118, not the 8192 the scale implies).
 * Only sets the needle full-scale and the bar centre, so it does not need to be exact.
 */
const ACCEL_REST = 8118;

export interface AccelZero {
  x: number;
  y: number;
  z: number;
}

/** The origin used when nothing has been captured: an ideally level controller. */
export const ACCEL_ZERO_LEVEL: AccelZero = { x: 0, y: ACCEL_REST, z: 0 };

export function AccelVector({
  x,
  y,
  z,
  zero,
  onZero,
  onClearZero
}: {
  x: number;
  y: number;
  z: number;
  zero: AccelZero | null;
  onZero: () => void;
  onClearZero: () => void;
}) {
  const origin = zero ?? ACCEL_ZERO_LEVEL;
  const nx = Math.max(-1, Math.min(1, (x - origin.x) / ACCEL_REST));
  const nz = Math.max(-1, Math.min(1, (z - origin.z) / ACCEL_REST));
  const radius = 30;
  const tilted = Math.hypot(nx, nz) > 0.02;
  // Both axes are negated: the sensor positive X and Z point opposite to the direction the
  // controller is tilted as seen on screen. Confirmed against hardware.
  const needleX = 40 - nx * radius;
  const needleY = 40 - nz * radius;

  const lift = Math.max(-1, Math.min(1, (y - origin.y) / ACCEL_REST));
  const fillWidth = Math.abs(lift) * 50;
  const fillLeft = lift < 0 ? 50 - fillWidth : 50;

  return (
    <div className="tester-accel-panel">
      <div className="tester-accel">
        <svg viewBox="0 0 80 80" aria-label="Acceleration vector">
          <circle cx={40} cy={40} r={radius} className="tester-dial-track" />
          <circle cx={40} cy={40} r={radius / 2} className="tester-dial-track" />
          {/* Centre mark, so "level" is a visible target rather than an inferred one. */}
          <line x1={34} y1={40} x2={46} y2={40} className="tester-dial-neutral" />
          <line x1={40} y1={34} x2={40} y2={46} className="tester-dial-neutral" />
          {tilted && (
            <line x1={40} y1={40} x2={needleX} y2={needleY} className="tester-accel-needle" />
          )}
          <circle cx={needleX} cy={needleY} r={4} className="tester-dial-head" />
        </svg>
        <div className="tester-accel-z">
          <span className="tester-field-label">Lift</span>
          <div className="tester-bar tester-bar-centred">
            <div
              className="tester-bar-fill"
              style={{ width: `${fillWidth}%`, marginLeft: `${fillLeft}%` }}
            />
          </div>
          {/*
            Per-axis numbers, because the needle is driven by X and Z and without them an
            off-centre dot cannot be told apart from a sensor offset. These stay RAW even when a
            zero is captured, so the underlying reading is always visible.
          */}
          <dl className="tester-axis-readout">
            <div><dt>X</dt><dd className="tester-mono">{x}</dd></div>
            <div><dt>Y</dt><dd className="tester-mono">{y}</dd></div>
            <div><dt>Z</dt><dd className="tester-mono">{z}</dd></div>
          </dl>
        </div>
      </div>
      <div className="tester-accel-actions">
        <button type="button" onClick={zero ? onClearZero : onZero}>
          {zero ? 'Clear zero' : 'Zero here'}
        </button>
        <span className="tester-subtle">
          {zero
            ? 'Centred on a captured pose, not on level. Numbers above are still raw.'
            : 'Centred on level. A DualSense rests nose-up, so flat on a desk reads slightly off.'}
        </span>
      </div>
    </div>
  );
}
