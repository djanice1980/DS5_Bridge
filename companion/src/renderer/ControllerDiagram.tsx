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
 * The needle plots X and Z -- the plane PARALLEL to a desk -- and Y, the vertical axis, goes on
 * the bar. Laid flat, a DualSense puts gravity almost entirely on Y, so the needle sits centred
 * and the bar reads about 1g. Plotting X/Y instead pinned the needle at full deflection just
 * from the controller sitting still, which says nothing.
 *
 * Centred therefore means level, and the needle leans the way the controller is tilted.
 */
export function AccelVector({ x, y, z }: { x: number; y: number; z: number }) {
  // ~1g at rest on this sensor's scale.
  const ONE_G = 8192;
  const nx = Math.max(-1, Math.min(1, x / ONE_G));
  const ny = Math.max(-1, Math.min(1, y / ONE_G));
  const nz = Math.max(-1, Math.min(1, z / ONE_G));
  const radius = 30;
  const tilted = Math.hypot(nx, nz) > 0.04;

  return (
    <div className="tester-accel">
      <svg viewBox="0 0 80 80" aria-label="Acceleration vector">
        <circle cx={40} cy={40} r={radius} className="tester-dial-track" />
        <circle cx={40} cy={40} r={radius / 2} className="tester-dial-track" />
        {/* Centre mark, so "level" is a visible target rather than an inferred one. */}
        <line x1={34} y1={40} x2={46} y2={40} className="tester-dial-neutral" />
        <line x1={40} y1={34} x2={40} y2={46} className="tester-dial-neutral" />
        {tilted && (
          <line
            x1={40}
            y1={40}
            x2={40 + nx * radius}
            y2={40 + nz * radius}
            className="tester-accel-needle"
          />
        )}
        <circle cx={40 + nx * radius} cy={40 + nz * radius} r={4} className="tester-dial-head" />
      </svg>
      <div className="tester-accel-z">
        <span className="tester-field-label">Y (vertical)</span>
        <div className="tester-bar">
          <div
            className="tester-bar-fill"
            style={{ width: `${Math.abs(ny) * 100}%`, marginLeft: ny < 0 ? 'auto' : undefined }}
          />
        </div>
        <span className="tester-mono">{y}</span>
      </div>
    </div>
  );
}
