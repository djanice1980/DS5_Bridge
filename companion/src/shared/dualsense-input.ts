/**
 * DualSense input report decoding, app-side.
 *
 * The firmware caches the raw report it forwards to the host and serves it verbatim on
 * REPORT_ID.CONTROLLER_INPUT; nothing is parsed down there. That split is deliberate: every
 * field this decoder gains would otherwise need a firmware change and a reflash to surface, and
 * the tester's raw hex view would have nothing to show.
 *
 * Offsets are ported from src/dualsense_input_decoder.cpp, which is the decoder the bridge
 * itself runs. They are not guessed from a spec -- if the two ever disagree, that file wins.
 */

export const DUALSENSE_TOUCH_POINT_COUNT = 2;
/** The touchpad's reported coordinate space. */
export const DUALSENSE_TOUCHPAD_WIDTH = 1920;
export const DUALSENSE_TOUCHPAD_HEIGHT = 1080;

export interface DualSenseTouchPoint {
  active: boolean;
  contactId: number;
  x: number;
  y: number;
}

export interface DualSenseInputState {
  leftStickX: number;
  leftStickY: number;
  rightStickX: number;
  rightStickY: number;
  leftTrigger: number;
  rightTrigger: number;

  dpadUp: boolean;
  dpadDown: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;

  square: boolean;
  cross: boolean;
  circle: boolean;
  triangle: boolean;
  l1: boolean;
  r1: boolean;
  l2Pressed: boolean;
  r2Pressed: boolean;
  create: boolean;
  options: boolean;
  l3: boolean;
  r3: boolean;
  home: boolean;
  touchpadButton: boolean;
  mute: boolean;

  /** DualSense Edge only; always false on a standard controller. */
  edgeLeftFunction: boolean;
  edgeRightFunction: boolean;
  edgeLeftPaddle: boolean;
  edgeRightPaddle: boolean;

  gyroX: number;
  gyroY: number;
  gyroZ: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  sensorTimestamp: number;

  touchPoints: DualSenseTouchPoint[];

  /** Null when the report's power state does not map to a percentage. */
  batteryPercent: number | null;
  rawPowerState: number;
  charging: boolean;
  headsetPlugged: boolean;
  microphonePlugged: boolean;
  microphoneMuted: boolean;
}

export interface ControllerInputSnapshot {
  controllerConnected: boolean;
  /** Raw bytes exactly as the bridge forwarded them, for the tester's hex view. */
  raw: number[];
  /** Null when no controller is attached, or the report was too short to decode. */
  state: DualSenseInputState | null;
}

const DPAD_UP = 0;
const DPAD_UP_RIGHT = 1;
const DPAD_RIGHT = 2;
const DPAD_DOWN_RIGHT = 3;
const DPAD_DOWN = 4;
const DPAD_DOWN_LEFT = 5;
const DPAD_LEFT = 6;
const DPAD_UP_LEFT = 7;

/** The report must reach byte 53 (audio status) for a full decode. */
const MINIMUM_DECODABLE_LENGTH = 54;

function readI16LE(report: ArrayLike<number>, offset: number): number {
  const value = (report[offset] & 0xff) | ((report[offset + 1] & 0xff) << 8);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function readU32LE(report: ArrayLike<number>, offset: number): number {
  return (
    (report[offset] & 0xff)
    + ((report[offset + 1] & 0xff) << 8)
    + ((report[offset + 2] & 0xff) << 16)
    // Shifting into bit 31 would go negative in JS; multiply instead.
    + (report[offset + 3] & 0xff) * 0x1000000
  );
}

function readTouchPoint(report: ArrayLike<number>, offset: number): DualSenseTouchPoint {
  const first = report[offset] & 0xff;
  return {
    // Bit 7 SET means no contact -- the flag is inverted from what its position suggests.
    active: (first & 0x80) === 0,
    contactId: first & 0x7f,
    x: (report[offset + 1] & 0xff) | ((report[offset + 2] & 0x0f) << 8),
    y: ((report[offset + 2] >> 4) & 0x0f) | ((report[offset + 3] & 0xff) << 4)
  };
}

export function decodeDualSenseInputReport(report: ArrayLike<number>): DualSenseInputState | null {
  if (report.length < MINIMUM_DECODABLE_LENGTH) {
    return null;
  }

  const dpad = report[7] & 0x0f;
  const battery = report[52] & 0x0f;
  const rawPowerState = (report[52] >> 4) & 0x0f;

  let batteryPercent: number | null = null;
  if (rawPowerState === 0x02) {
    batteryPercent = 100;
  } else if (battery <= 10) {
    batteryPercent = battery * 10;
  }

  const touchPoints: DualSenseTouchPoint[] = [];
  for (let index = 0; index < DUALSENSE_TOUCH_POINT_COUNT; index += 1) {
    touchPoints.push(readTouchPoint(report, 32 + index * 4));
  }

  return {
    leftStickX: report[0] & 0xff,
    leftStickY: report[1] & 0xff,
    rightStickX: report[2] & 0xff,
    rightStickY: report[3] & 0xff,
    leftTrigger: report[4] & 0xff,
    rightTrigger: report[5] & 0xff,

    dpadUp: dpad === DPAD_UP || dpad === DPAD_UP_RIGHT || dpad === DPAD_UP_LEFT,
    dpadRight: dpad === DPAD_RIGHT || dpad === DPAD_UP_RIGHT || dpad === DPAD_DOWN_RIGHT,
    dpadDown: dpad === DPAD_DOWN || dpad === DPAD_DOWN_RIGHT || dpad === DPAD_DOWN_LEFT,
    dpadLeft: dpad === DPAD_LEFT || dpad === DPAD_UP_LEFT || dpad === DPAD_DOWN_LEFT,

    square: (report[7] & 0x10) !== 0,
    cross: (report[7] & 0x20) !== 0,
    circle: (report[7] & 0x40) !== 0,
    triangle: (report[7] & 0x80) !== 0,

    l1: (report[8] & 0x01) !== 0,
    r1: (report[8] & 0x02) !== 0,
    l2Pressed: (report[8] & 0x04) !== 0,
    r2Pressed: (report[8] & 0x08) !== 0,
    create: (report[8] & 0x10) !== 0,
    options: (report[8] & 0x20) !== 0,
    l3: (report[8] & 0x40) !== 0,
    r3: (report[8] & 0x80) !== 0,

    home: (report[9] & 0x01) !== 0,
    touchpadButton: (report[9] & 0x02) !== 0,
    mute: (report[9] & 0x04) !== 0,
    edgeLeftFunction: (report[9] & 0x10) !== 0,
    edgeRightFunction: (report[9] & 0x20) !== 0,
    edgeLeftPaddle: (report[9] & 0x40) !== 0,
    edgeRightPaddle: (report[9] & 0x80) !== 0,

    gyroX: readI16LE(report, 15),
    gyroY: readI16LE(report, 17),
    gyroZ: readI16LE(report, 19),
    accelX: readI16LE(report, 21),
    accelY: readI16LE(report, 23),
    accelZ: readI16LE(report, 25),
    sensorTimestamp: readU32LE(report, 27),

    touchPoints,

    batteryPercent,
    rawPowerState,
    charging: rawPowerState === 0x01 || rawPowerState === 0x02,
    headsetPlugged: (report[53] & 0x01) !== 0,
    microphonePlugged: (report[53] & 0x02) !== 0,
    microphoneMuted: (report[53] & 0x04) !== 0
  };
}
