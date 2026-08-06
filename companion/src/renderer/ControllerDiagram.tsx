import type { DualSenseInputState } from '../shared/dualsense-input';
import { DUALSENSE_TOUCHPAD_HEIGHT, DUALSENSE_TOUCHPAD_WIDTH } from '../shared/dualsense-input';

/**
 * Line-drawing DualSense driven by live input.
 *
 * Two deliberately different visual languages, because conflating them hides what the hardware
 * actually reports:
 *
 *   - DIGITAL controls snap. No transition at all -- a button is pressed or it is not, and any
 *     easing would invent intermediate states the controller never sent.
 *   - ANALOGUE controls fade in proportion to their value. A trigger at 40 and a trigger at 250
 *     must not look alike, and the fade is what makes a sticky or drifting axis visible.
 *
 * The stick wells show BOTH: the thumb moves with the axes (analogue) while the well itself
 * snaps when L3/R3 is clicked (digital).
 *
 * Geometry is a front view in a 1000x800 space, laid out to match the real controller's
 * proportions: L2/R2 are the domes at the very top, L1/R1 the bars beneath them, and left-hand
 * controls sit on the left. That sounds obvious, and it is exactly the thing worth stating,
 * because a mirrored trigger makes every reading taken from this diagram wrong.
 */

const DIGITAL = 'tester-digital';

function digitalProps(on: boolean | undefined) {
  return { className: `${DIGITAL}${on === true ? ' is-on' : ''}` };
}

/** 0..1 -> a fill opacity visible early without saturating immediately. */
function analogueOpacity(fraction: number): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  return clamped === 0 ? 0 : 0.15 + clamped * 0.85;
}

/** Stick bytes are 0-255 around a nominal 128 centre. */
function axis(value: number): number {
  return (value - 128) / 127;
}

/**
 * A trigger dome. The analogue fill rises from the bottom of the dome as the trigger travels,
 * and the outline snaps separately on the digital press bit.
 */
function Trigger({
  id,
  path,
  bounds,
  value,
  pressed
}: {
  id: string;
  path: string;
  bounds: { y: number; height: number };
  value: number;
  pressed: boolean | undefined;
}) {
  const fraction = Math.max(0, Math.min(1, value / 255));
  const fillHeight = bounds.height * fraction;
  return (
    <g>
      <clipPath id={`clip-${id}`}>
        <rect
          x={0}
          y={bounds.y + bounds.height - fillHeight}
          width={1000}
          height={fillHeight}
        />
      </clipPath>
      <path d={path} className="tester-outline" />
      <path
        d={path}
        className="tester-analogue-fill"
        fillOpacity={analogueOpacity(fraction)}
        clipPath={`url(#clip-${id})`}
      />
      <path d={path} fill="none" {...digitalProps(pressed)} />
    </g>
  );
}

function Stick({
  cx,
  cy,
  xValue,
  yValue,
  clicked
}: {
  cx: number;
  cy: number;
  xValue: number;
  yValue: number;
  clicked: boolean | undefined;
}) {
  const nx = axis(xValue);
  const ny = axis(yValue);
  const travel = Math.min(1, Math.hypot(nx, ny));
  const outer = 62;
  const thumb = 43;
  return (
    <g>
      {/* Deflection glow: analogue, fades with how far the stick is pushed. */}
      <circle
        cx={cx}
        cy={cy}
        r={outer}
        className="tester-analogue-fill"
        fillOpacity={analogueOpacity(travel) * 0.45}
      />
      <circle cx={cx} cy={cy} r={outer} className="tester-outline" fill="none" />
      {/* Thumb cap: position is analogue, its outline snaps on the L3/R3 click. */}
      <circle
        cx={cx + nx * (outer - thumb)}
        cy={cy + ny * (outer - thumb)}
        r={thumb}
        {...digitalProps(clicked)}
      />
    </g>
  );
}

export function ControllerDiagram({ state }: { state: DualSenseInputState | null }) {
  const s = state;

  // Trigger domes, seated directly on top of the bumpers. Left trigger on the left.
  const L2_PATH = 'M 165 170 v -60 a 52 52 0 0 1 105 0 v 60 z';
  const R2_PATH = 'M 730 170 v -60 a 52 52 0 0 1 105 0 v 60 z';

  return (
    <svg viewBox="0 0 1000 840" className="tester-controller" role="img" aria-label="Controller input">
      <Trigger
        id="l2"
        path={L2_PATH}
        bounds={{ y: 58, height: 112 }}
        value={s?.leftTrigger ?? 0}
        pressed={s?.l2Pressed}
      />
      <Trigger
        id="r2"
        path={R2_PATH}
        bounds={{ y: 58, height: 112 }}
        value={s?.rightTrigger ?? 0}
        pressed={s?.r2Pressed}
      />

      {/* L1 / R1: bumpers sitting ON the shell's top edge, not floating past its corners. */}
      <path d="M 145 200 a 72 30 0 0 1 145 0 z" {...digitalProps(s?.l1)} />
      <path d="M 710 200 a 72 30 0 0 1 145 0 z" {...digitalProps(s?.r1)} />

      {/*
        Shell. The top edge runs nearly the full width, the widest point is around mid-height,
        and the grips TAPER to a rounded tip rather than staying full width to the bottom --
        which is what made the first attempts read as two balloons.
      */}
      <path
        className="tester-shell"
        d="M 150 200
           C 100 202, 62 240, 46 300
           C 32 355, 30 400, 34 445
           C 40 520, 58 600, 84 670
           C 106 730, 140 780, 186 792
           C 232 804, 268 770, 296 710
           C 324 650, 350 614, 400 604
           L 600 604
           C 650 614, 676 650, 704 710
           C 732 770, 768 804, 814 792
           C 860 780, 894 730, 916 670
           C 942 600, 960 520, 966 445
           C 970 400, 968 355, 954 300
           C 938 240, 900 202, 850 200
           Z"
      />

      {/* Touchpad, with live contacts. The pad itself is the digital click. */}
      <rect x={300} y={225} width={400} height={200} rx={26} {...digitalProps(s?.touchpadButton)} />
      {s?.touchPoints.map((point, index) => (
        point.active
          ? (
            <circle
              key={index}
              cx={300 + (point.x / DUALSENSE_TOUCHPAD_WIDTH) * 400}
              cy={225 + (point.y / DUALSENSE_TOUCHPAD_HEIGHT) * 200}
              r={15}
              className={`tester-touch-contact tester-touch-contact-${index}`}
            />
          )
          : null
      ))}

      {/* Create / Options: slim pills flanking the touchpad. */}
      <rect x={272} y={235} width={16} height={50} rx={8} {...digitalProps(s?.create)} />
      <rect x={712} y={235} width={16} height={50} rx={8} {...digitalProps(s?.options)} />

      {/*
        D-pad: four keys with a visible gap between them. They previously ran through the centre
        and intersected, so the cross read as one interlocking blob rather than four buttons.
      */}
      <path d="M 173 348 v -30 l 22 -22 l 22 22 v 30 z" {...digitalProps(s?.dpadUp)} />
      <path d="M 173 402 v 30 l 22 22 l 22 -22 v -30 z" {...digitalProps(s?.dpadDown)} />
      <path d="M 168 353 h -30 l -22 22 l 22 22 h 30 z" {...digitalProps(s?.dpadLeft)} />
      <path d="M 222 353 h 30 l 22 22 l -22 22 h -30 z" {...digitalProps(s?.dpadRight)} />

      {/* Face buttons, mirroring the d-pad across the centreline. */}
      <circle cx={805} cy={309} r={34} {...digitalProps(s?.triangle)} />
      <text x={805} y={318} className="tester-svg-glyph">&#9651;</text>
      <circle cx={871} cy={375} r={34} {...digitalProps(s?.circle)} />
      <text x={871} y={384} className="tester-svg-glyph">&#9711;</text>
      <circle cx={805} cy={441} r={34} {...digitalProps(s?.cross)} />
      <text x={805} y={450} className="tester-svg-glyph">&#10005;</text>
      <circle cx={739} cy={375} r={34} {...digitalProps(s?.square)} />
      <text x={739} y={384} className="tester-svg-glyph">&#9723;</text>

      <Stick
        cx={305}
        cy={520}
        xValue={s?.leftStickX ?? 128}
        yValue={s?.leftStickY ?? 128}
        clicked={s?.l3}
      />
      <Stick
        cx={695}
        cy={520}
        xValue={s?.rightStickX ?? 128}
        yValue={s?.rightStickY ?? 128}
        clicked={s?.r3}
      />

      {/* PS button and the mute bar beneath it. */}
      <circle cx={500} cy={490} r={22} {...digitalProps(s?.home)} />
      <text x={500} y={496} className="tester-svg-glyph-small">PS</text>
      <rect x={473} y={552} width={54} height={18} rx={9} {...digitalProps(s?.mute)} />
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
