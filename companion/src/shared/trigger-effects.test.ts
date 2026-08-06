import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_MAJOR, PROTOCOL_MINOR } from './protocol';
import {
  TRIGGER_EFFECT_ID,
  TRIGGER_EFFECT_SIZE,
  defaultTriggerEffect,
  encodeTriggerEffect,
  TRIGGER_EFFECT_TYPES
} from './trigger-effects';
import { buildRawTriggerEffectReport, COMMAND_ID, REPORT_ID, parseControllerInputReport } from './protocol';
import { decodeDualSenseInputReport } from './dualsense-input';

describe('companion protocol version', () => {
  const firmwareSource = readFileSync(
    path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'src', 'companion.cpp'),
    'utf8'
  );

  function firmwareConstant(name: string): number {
    const match = new RegExp(`constexpr uint8_t ${name} = (\\d+);`).exec(firmwareSource);
    if (!match) {
      throw new Error(`Could not read ${name} from src/companion.cpp`);
    }
    return Number(match[1]);
  }

  it('matches the firmware exactly', () => {
    // parseStatusReport uses assertVersion, which requires an EXACT minor match. So a bump on
    // either side alone makes the app reject the other's status report, and the bridge shows as
    // not detected even with a controller happily connected -- which is what a bump to 18 did.
    //
    // Adding a report id or command id does NOT need a bump: the firmware accepts commands from
    // an older app (buffer[5] <= kProtocolMinor), an unknown report id fails its GET_REPORT and
    // the reader handles that, and an unknown command is refused with ERR_UNKNOWN_COMMAND.
    // Features are gated on status firmwareFlags capability bits instead -- see the *Supported
    // flags in App.tsx. The minor has not moved since the initial commit; adding to these tables
    // is not a reason to move it.
    expect(PROTOCOL_MAJOR).toBe(firmwareConstant('kProtocolMajor'));
    expect(PROTOCOL_MINOR).toBe(firmwareConstant('kProtocolMinor'));
  });
});

describe('trigger effect encoding', () => {
  it('encodes every effect type to exactly the effect size', () => {
    for (const type of TRIGGER_EFFECT_TYPES) {
      const bytes = encodeTriggerEffect(defaultTriggerEffect(type));
      expect(bytes, type).toHaveLength(TRIGGER_EFFECT_SIZE);
      expect(bytes.every((byte) => byte >= 0 && byte <= 255), type).toBe(true);
    }
  });

  it('uses 0x05 for off, not 0x00', () => {
    // 0x00 is a valid effect id on the controller, so "zero the bytes" does NOT mean "no
    // effect" -- getting this wrong leaves a real effect engaged that looks like it was cleared.
    expect(encodeTriggerEffect({ type: 'off' })[0]).toBe(TRIGGER_EFFECT_ID.OFF);
  });

  it('carries native ranges the percent path cannot express', () => {
    // Force 200 is not reachable through the percent API: it maps force onto a 3-bit field, so
    // only eight levels exist across the whole range. This is the reason the raw path exists.
    const bytes = encodeTriggerEffect({ type: 'resistance', start: 40, force: 200 });
    expect(bytes[0]).toBe(TRIGGER_EFFECT_ID.SIMPLE_RESISTANCE);
    expect(bytes[1]).toBe(40);
    expect(bytes[2]).toBe(200);
  });

  it('keeps a weapon effect releasable when end is dragged below start', () => {
    const bytes = encodeTriggerEffect({ type: 'weapon', start: 100, end: 20, force: 255 });
    expect(bytes[2]).toBeGreaterThan(bytes[1]);
  });

  it('clamps auto frequency to the field width', () => {
    const bytes = encodeTriggerEffect({ type: 'auto', start: 0, force: 255, frequency: 99 });
    expect(bytes[3]).toBe(15);
  });

  it('omits zero-force zones from the active mask', () => {
    // An active zone at zero force is a dead band, not an absent zone. Zones 0 and 1 are off
    // here, so only bits 2..9 may be set.
    const bytes = encodeTriggerEffect({
      type: 'zoned-feedback',
      zones: [0, 0, 7, 7, 7, 7, 7, 7, 7, 7]
    });
    const mask = bytes[1] | (bytes[2] << 8);
    expect(mask & 0b11).toBe(0);
    expect(mask).toBe(0b1111111100);
  });

  it('packs zone force levels three bits apart', () => {
    const bytes = encodeTriggerEffect({
      type: 'zoned-feedback',
      zones: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0]
    });
    const forceBits = bytes[3] | (bytes[4] << 8) | (bytes[5] << 16) | (bytes[6] << 24);
    expect(forceBits & 0b111).toBe(1);
    expect((forceBits >> 3) & 0b111).toBe(2);
  });
});

describe('raw trigger effect command', () => {
  it('targets the right trigger only when asked', () => {
    const report = buildRawTriggerEffectReport(
      7,
      'r2',
      { type: 'resistance', start: 10, force: 20 },
      { type: 'resistance', start: 30, force: 40 }
    );
    expect(report[7]).toBe(COMMAND_ID.SET_RAW_TRIGGER_EFFECT);
    expect(report[8]).toBe(7);
    // Flags live in the value's high byte: bit0 right, bit1 left.
    expect(report[10] & 0x01).toBe(0x01);
    expect(report[10] & 0x02).toBe(0);
  });

  it('marks an off effect inactive even when its trigger is targeted', () => {
    const report = buildRawTriggerEffectReport(0, 'both', { type: 'off' }, { type: 'off' });
    expect(report[10]).toBe(0);
  });

  it('places both effects where the firmware reads them', () => {
    const report = buildRawTriggerEffectReport(
      0,
      'both',
      { type: 'resistance', start: 11, force: 22 },
      { type: 'auto', start: 33, force: 44, frequency: 5 }
    );
    // Right at payload[11..], left immediately after it.
    expect(report[11]).toBe(TRIGGER_EFFECT_ID.SIMPLE_RESISTANCE);
    expect(report[12]).toBe(11);
    expect(report[13]).toBe(22);
    expect(report[11 + TRIGGER_EFFECT_SIZE]).toBe(TRIGGER_EFFECT_ID.SIMPLE_AUTO);
    expect(report[12 + TRIGGER_EFFECT_SIZE]).toBe(33);
  });
});

function controllerInputReport(
  inputBytes: number[],
  options: { connected?: boolean; declaredLength?: number } = {}
): number[] {
  const report = new Array<number>(64).fill(0);
  report[0] = REPORT_ID.CONTROLLER_INPUT;
  report[1] = 'D'.charCodeAt(0);
  report[2] = 'S'.charCodeAt(0);
  report[3] = '5'.charCodeAt(0);
  report[4] = 'B'.charCodeAt(0);
  report[5] = PROTOCOL_MAJOR;
  report[6] = PROTOCOL_MINOR;
  report[7] = options.connected === false ? 0 : 1;
  report[8] = options.declaredLength ?? inputBytes.length;
  for (let index = 0; index < inputBytes.length; index += 1) {
    report[9 + index] = inputBytes[index];
  }
  return report;
}

describe('controller input report', () => {
  it('returns no decoded state when no controller is connected', () => {
    // The firmware's cache holds a NEUTRAL report when nothing is attached. Decoding it would
    // render a centred, fully-released controller that looks live.
    const neutral = new Array<number>(54).fill(0);
    neutral[0] = 128;
    neutral[1] = 128;
    const snapshot = parseControllerInputReport(controllerInputReport(neutral, { connected: false }));
    expect(snapshot.controllerConnected).toBe(false);
    expect(snapshot.state).toBeNull();
  });

  it('ignores a declared length larger than the payload can hold', () => {
    // The length byte is firmware-supplied and can be anything; the report itself is always a
    // fixed 64 bytes (assertReport rejects anything else), so the payload caps at 55. Without
    // the clamp a bogus length walks off the end of the array and yields undefined entries.
    const bytes = new Array<number>(55).fill(0xab);
    const snapshot = parseControllerInputReport(
      controllerInputReport(bytes, { declaredLength: 200 })
    );
    expect(snapshot.raw).toHaveLength(55);
    expect(snapshot.raw.every((byte) => Number.isInteger(byte))).toBe(true);
  });

  it('decodes sticks, triggers and buttons at the firmware decoder offsets', () => {
    const bytes = new Array<number>(54).fill(0);
    bytes[0] = 0x10;
    bytes[1] = 0x20;
    bytes[2] = 0x30;
    bytes[3] = 0x40;
    bytes[4] = 0x7f;
    bytes[5] = 0xff;
    bytes[7] = 0x20 | 0x02; // cross pressed, dpad = right
    bytes[8] = 0x01; // L1
    bytes[9] = 0x01; // PS

    const state = decodeDualSenseInputReport(bytes);
    expect(state).not.toBeNull();
    expect(state?.leftStickX).toBe(0x10);
    expect(state?.rightStickY).toBe(0x40);
    expect(state?.leftTrigger).toBe(0x7f);
    expect(state?.rightTrigger).toBe(0xff);
    expect(state?.cross).toBe(true);
    expect(state?.dpadRight).toBe(true);
    expect(state?.dpadUp).toBe(false);
    expect(state?.l1).toBe(true);
    expect(state?.home).toBe(true);
  });

  it('treats touch bit 7 as NOT-active', () => {
    const bytes = new Array<number>(54).fill(0);
    bytes[32] = 0x80; // no contact
    bytes[36] = 0x01; // contact id 1, active
    const state = decodeDualSenseInputReport(bytes);
    expect(state?.touchPoints[0].active).toBe(false);
    expect(state?.touchPoints[1].active).toBe(true);
    expect(state?.touchPoints[1].contactId).toBe(1);
  });

  it('reads a large sensor timestamp without going negative', () => {
    const bytes = new Array<number>(54).fill(0);
    bytes[27] = 0xff;
    bytes[28] = 0xff;
    bytes[29] = 0xff;
    bytes[30] = 0xff;
    expect(decodeDualSenseInputReport(bytes)?.sensorTimestamp).toBe(0xffffffff);
  });

  it('decodes negative gyro values', () => {
    const bytes = new Array<number>(54).fill(0);
    bytes[15] = 0x00;
    bytes[16] = 0x80; // -32768
    expect(decodeDualSenseInputReport(bytes)?.gyroX).toBe(-32768);
  });
});
