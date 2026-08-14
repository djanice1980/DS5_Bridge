/**
 * DualSense USB output report composition, app-side.
 *
 * Offsets and flags are ported from src/dualsense_output.h, which is what the bridge firmware
 * itself writes; if the two ever disagree, that header wins. The report is flag-driven and
 * partial by design: the controller only touches the fields whose valid-flag bits are set, so
 * an update can change the lightbar without disturbing rumble or triggers.
 *
 * Used for controllers plugged straight in over USB, where writes go to the hidraw device as
 * report 0x02 with no checksum (the CRC32 the firmware appends is a Bluetooth requirement).
 */

export const DUALSENSE_USB_OUTPUT_REPORT_ID = 0x02;
export const DUALSENSE_OUTPUT_PAYLOAD_SIZE = 47;

// valid_flag0 (byte 0)
const FLAG0_COMPATIBLE_VIBRATION = 0x01;
const FLAG0_HAPTICS_SELECT = 0x02;
const FLAG0_RIGHT_TRIGGER_EFFECT = 0x04;
const FLAG0_LEFT_TRIGGER_EFFECT = 0x08;

// valid_flag1 (byte 1)
const FLAG1_MIC_MUTE_LED_CONTROL = 0x01;
const FLAG1_LIGHTBAR_CONTROL = 0x04;
const FLAG1_PLAYER_INDICATOR_CONTROL = 0x10;

// Field offsets within the 47-byte payload.
const MOTOR_RIGHT_OFFSET = 2;
const MOTOR_LEFT_OFFSET = 3;
const MUTE_LED_OFFSET = 8;
const TRIGGER_RIGHT_OFFSET = 10;
const TRIGGER_LEFT_OFFSET = 21;
const PLAYER_LEDS_OFFSET = 43;
const LIGHTBAR_RED_OFFSET = 44;
const LIGHTBAR_GREEN_OFFSET = 45;
const LIGHTBAR_BLUE_OFFSET = 46;

export const TRIGGER_EFFECT_BYTES = 11;

/** Player-LED byte for the single centre LED, set instantly (no fade-in) -- the firmware's
 *  kPlayerLed1Instant. Bit 0x20 is the no-fade bit; low bits pick LEDs. */
export const PLAYER_LED_CENTRE_INSTANT = 0x24;
export const PLAYER_LED_NONE_INSTANT = 0x20;

export interface DualSenseOutputUpdate {
  /** Classic rumble, 0-255 per motor. Uses the compatible-vibration path. */
  rumble?: { right: number; left: number };
  muteLedOn?: boolean;
  /** Lightbar colour, 0-255 per channel. Brightness should already be folded into the
   *  channels, matching how the firmware scales before writing. */
  lightbar?: { red: number; green: number; blue: number };
  /** Raw player-LED byte (see PLAYER_LED_* constants). */
  playerLeds?: number;
  /** 11-byte encoded effects from shared/trigger-effects. */
  rightTrigger?: ArrayLike<number>;
  leftTrigger?: ArrayLike<number>;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** The 47-byte payload (no report id). */
export function buildDualSenseOutputPayload(update: DualSenseOutputUpdate): number[] {
  const payload = new Array<number>(DUALSENSE_OUTPUT_PAYLOAD_SIZE).fill(0);

  if (update.rumble) {
    payload[0] |= FLAG0_COMPATIBLE_VIBRATION | FLAG0_HAPTICS_SELECT;
    payload[MOTOR_RIGHT_OFFSET] = clampByte(update.rumble.right);
    payload[MOTOR_LEFT_OFFSET] = clampByte(update.rumble.left);
  }
  if (update.muteLedOn !== undefined) {
    payload[1] |= FLAG1_MIC_MUTE_LED_CONTROL;
    payload[MUTE_LED_OFFSET] = update.muteLedOn ? 1 : 0;
  }
  if (update.lightbar) {
    payload[1] |= FLAG1_LIGHTBAR_CONTROL;
    payload[LIGHTBAR_RED_OFFSET] = clampByte(update.lightbar.red);
    payload[LIGHTBAR_GREEN_OFFSET] = clampByte(update.lightbar.green);
    payload[LIGHTBAR_BLUE_OFFSET] = clampByte(update.lightbar.blue);
  }
  if (update.playerLeds !== undefined) {
    payload[1] |= FLAG1_PLAYER_INDICATOR_CONTROL;
    payload[PLAYER_LEDS_OFFSET] = clampByte(update.playerLeds);
  }
  if (update.rightTrigger) {
    payload[0] |= FLAG0_RIGHT_TRIGGER_EFFECT;
    for (let index = 0; index < TRIGGER_EFFECT_BYTES; index += 1) {
      payload[TRIGGER_RIGHT_OFFSET + index] = clampByte(update.rightTrigger[index] ?? 0);
    }
  }
  if (update.leftTrigger) {
    payload[0] |= FLAG0_LEFT_TRIGGER_EFFECT;
    for (let index = 0; index < TRIGGER_EFFECT_BYTES; index += 1) {
      payload[TRIGGER_LEFT_OFFSET + index] = clampByte(update.leftTrigger[index] ?? 0);
    }
  }

  return payload;
}

/** The full USB report for a hidraw write: 0x02 followed by the payload. */
export function buildDualSenseUsbOutputReport(update: DualSenseOutputUpdate): number[] {
  return [DUALSENSE_USB_OUTPUT_REPORT_ID, ...buildDualSenseOutputPayload(update)];
}
