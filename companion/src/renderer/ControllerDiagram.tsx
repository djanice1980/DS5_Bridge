import type { DualSenseInputState } from '../shared/dualsense-input';
import { DUALSENSE_TOUCHPAD_HEIGHT, DUALSENSE_TOUCHPAD_WIDTH } from '../shared/dualsense-input';
import {
  DUALSENSE_ART,
  DUALSENSE_TRANSFORM,
  DUALSENSE_VIEWBOX,
  type DualSenseArtRole
} from './dualsense-art';

/**
 * DualSense driven by live input, over traced artwork (see dualsense-art.ts).
 *
 * Two deliberately different visual languages, because conflating them hides what the hardware
 * actually reports:
 *
 *   - DIGITAL controls snap. No transition at all -- a button is pressed or it is not, and any
 *     easing would invent intermediate states the controller never sent.
 *   - ANALOGUE controls fade in proportion to their value. A trigger at 40 and a trigger at 250
 *     must not look alike, and the fade is what makes a sticky or drifting axis visible.
 *
 * The artwork carries no separate outline: the linework is the GAP between filled regions, so
 * the card behind showing through IS the outline. Fills therefore have to stay lighter than the
 * card, and the canvas path is never drawn.
 */

/** Touchpad geometry in artwork units, for placing live contacts. */
const TOUCHPAD = { x: 12606, y: 20101, width: 18247, height: 9321 };
/** The PS button is linework in the artwork rather than a fillable region, so it gets an overlay. */
const PS_BUTTON = { cx: 21749, cy: 14700, r: 620 };
/** Stick centres in artwork units. */
const LEFT_STICK = { cx: 14002, cy: 15109 };
const RIGHT_STICK = { cx: 29381, cy: 15115 };
/** How far a thumb cap travels from centre at full deflection, in artwork units. */
const STICK_TRAVEL = 900;

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
    leftStickInner: s?.l3 === true,
    rightStickInner: s?.r3 === true,
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
      <g transform={DUALSENSE_TRANSFORM}>
        {DUALSENSE_ART.map((path, index) => {
          // The canvas path is the traced background, not part of the controller.
          if (path.role === 'canvas') {
            return null;
          }

          const analogueFraction = analogue[path.role];
          const isPressed = pressed[path.role] === true;

          // Thumb caps translate with their axes; the wells stay put, so deflection reads as
          // the stick moving rather than the whole assembly sliding. Artwork Y is flipped by
          // the group transform, hence the negated Y.
          let transform: string | undefined;
          if (path.role === 'leftStickInner') {
            transform = `translate(${leftAxis.x * STICK_TRAVEL} ${-leftAxis.y * STICK_TRAVEL})`;
          } else if (path.role === 'rightStickInner') {
            transform = `translate(${rightAxis.x * STICK_TRAVEL} ${-rightAxis.y * STICK_TRAVEL})`;
          }

          const className = [
            'ds-part',
            path.role === 'shell' ? 'ds-shell' : 'ds-control',
            isPressed ? 'is-on' : ''
          ].filter(Boolean).join(' ');

          return (
            <g key={index} transform={transform}>
              <path className={className} d={path.d} />
              {analogueFraction !== undefined && analogueFraction > 0 && (
                <path
                  className="ds-analogue"
                  d={path.d}
                  fillOpacity={analogueOpacity(analogueFraction)}
                />
              )}
            </g>
          );
        })}

        {/* PS button: an overlay, because the logo is linework in the artwork, not a region. */}
        <circle
          className={`ds-part ds-control ds-ps${s?.home === true ? ' is-on' : ''}`}
          cx={PS_BUTTON.cx}
          cy={PS_BUTTON.cy}
          r={PS_BUTTON.r}
        />

        {/* Live touch contacts. The report's Y grows downward, the artwork's upward. */}
        {s?.touchPoints.map((point, index) => (
          point.active
            ? (
              <circle
                key={index}
                className={`ds-touch ds-touch-${index}`}
                cx={TOUCHPAD.x + (point.x / DUALSENSE_TOUCHPAD_WIDTH) * TOUCHPAD.width}
                cy={TOUCHPAD.y + TOUCHPAD.height
                  - (point.y / DUALSENSE_TOUCHPAD_HEIGHT) * TOUCHPAD.height}
                r={520}
              />
            )
            : null
        ))}

        {/* Deflection dots, so small stick movement is readable rather than merely implied. */}
        <circle
          className="ds-stick-dot"
          cx={LEFT_STICK.cx + leftAxis.x * STICK_TRAVEL}
          cy={LEFT_STICK.cy - leftAxis.y * STICK_TRAVEL}
          r={230}
        />
        <circle
          className="ds-stick-dot"
          cx={RIGHT_STICK.cx + rightAxis.x * STICK_TRAVEL}
          cy={RIGHT_STICK.cy - rightAxis.y * STICK_TRAVEL}
          r={230}
        />
      </g>
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
 * Acceleration as a vector: X/Y as a needle in the plane, Z as a bar. At rest the needle points
 * along gravity, so the controller's resting orientation is directly readable -- and a needle
 * that does not settle is a bad sensor.
 */
export function AccelVector({ x, y, z }: { x: number; y: number; z: number }) {
  // ~1g at rest on this sensor's scale.
  const ONE_G = 8192;
  const nx = Math.max(-1, Math.min(1, x / ONE_G));
  const ny = Math.max(-1, Math.min(1, y / ONE_G));
  const nz = Math.max(-1, Math.min(1, z / ONE_G));
  const radius = 30;

  return (
    <div className="tester-accel">
      <svg viewBox="0 0 80 80" aria-label="Acceleration vector">
        <circle cx={40} cy={40} r={radius} className="tester-dial-track" />
        <circle cx={40} cy={40} r={radius / 2} className="tester-dial-track" />
        <line
          x1={40}
          y1={40}
          x2={40 + nx * radius}
          y2={40 + ny * radius}
          className="tester-accel-needle"
        />
        <circle cx={40 + nx * radius} cy={40 + ny * radius} r={4} className="tester-dial-head" />
      </svg>
      <div className="tester-accel-z">
        <span className="tester-field-label">Z</span>
        <div className="tester-bar">
          <div
            className="tester-bar-fill"
            style={{ width: `${Math.abs(nz) * 100}%`, marginLeft: nz < 0 ? 'auto' : undefined }}
          />
        </div>
        <span className="tester-mono">{z}</span>
      </div>
    </div>
  );
}
