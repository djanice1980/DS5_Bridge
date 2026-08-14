import { describe, expect, it } from 'vitest';
import {
  DUALSENSE_OUTPUT_PAYLOAD_SIZE,
  PLAYER_LED_CENTRE_INSTANT,
  buildDualSenseOutputPayload,
  buildDualSenseUsbOutputReport
} from './dualsense-output-report';

// Offsets under test are the ones ported from src/dualsense_output.h; each expectation names
// the firmware constant it mirrors.
describe('DualSense USB output report', () => {
  it('an empty update touches nothing', () => {
    const payload = buildDualSenseOutputPayload({});
    expect(payload).toHaveLength(DUALSENSE_OUTPUT_PAYLOAD_SIZE);
    expect(payload.every((byte) => byte === 0)).toBe(true);
  });

  it('rumble sets the compatible-vibration flags and motor bytes', () => {
    const payload = buildDualSenseOutputPayload({ rumble: { right: 200, left: 120 } });
    expect(payload[0]).toBe(0x01 | 0x02); // kFlag0CompatibleVibration | kFlag0HapticsSelect
    expect(payload[2]).toBe(200); // kMotorRightOffset
    expect(payload[3]).toBe(120); // kMotorLeftOffset
  });

  it('lightbar sets its control flag and RGB at 44-46', () => {
    const payload = buildDualSenseOutputPayload({ lightbar: { red: 10, green: 20, blue: 30 } });
    expect(payload[1]).toBe(0x04); // kFlag1LightbarControlEnable
    expect(payload.slice(44, 47)).toEqual([10, 20, 30]); // kLightbar{Red,Green,Blue}Offset
  });

  it('player LEDs set the indicator flag and byte 43', () => {
    const payload = buildDualSenseOutputPayload({ playerLeds: PLAYER_LED_CENTRE_INSTANT });
    expect(payload[1]).toBe(0x10); // kFlag1PlayerIndicatorControlEnable
    expect(payload[43]).toBe(0x24); // kPlayerLedsOffset, kPlayerLed1Instant
  });

  it('trigger effects land at the firmware offsets with their flags', () => {
    const right = new Array(11).fill(0).map((_, index) => index + 1);
    const left = new Array(11).fill(0).map((_, index) => 100 + index);
    const payload = buildDualSenseOutputPayload({ rightTrigger: right, leftTrigger: left });
    expect(payload[0]).toBe(0x04 | 0x08); // kFlag0{Right,Left}TriggerEffect
    expect(payload.slice(10, 21)).toEqual(right); // kTriggerEffectRightOffset
    expect(payload.slice(21, 32)).toEqual(left); // kTriggerEffectLeftOffset
  });

  it('fields compose without clobbering each other', () => {
    const payload = buildDualSenseOutputPayload({
      rumble: { right: 1, left: 2 },
      lightbar: { red: 3, green: 4, blue: 5 },
      playerLeds: 0x20,
      muteLedOn: true
    });
    expect(payload[0]).toBe(0x03);
    expect(payload[1]).toBe(0x01 | 0x04 | 0x10);
    expect(payload[8]).toBe(1); // kMuteLedOffset
    expect(payload[43]).toBe(0x20);
    expect(payload.slice(44, 47)).toEqual([3, 4, 5]);
  });

  it('the USB report is 0x02 plus the payload', () => {
    const report = buildDualSenseUsbOutputReport({ rumble: { right: 9, left: 9 } });
    expect(report).toHaveLength(48);
    expect(report[0]).toBe(0x02); // kUsbOutputReportId
    expect(report[3]).toBe(9);
  });
});
