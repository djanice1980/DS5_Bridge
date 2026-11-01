import { describe, expect, it } from 'vitest';
import {
  describeForkRestart,
  describeUpstreamRestart,
  formatRestartDuration,
  formatRestartReport
} from './bridge-restart';
import {
  MAGIC,
  PROTOCOL_MAJOR,
  REPORT_ID,
  REPORT_LENGTH,
  parseDeviceIdentityReport,
  parseForkResetRecordReport,
  parseUpstreamResetEvidenceReport,
  type ForkResetRecordPayload,
  type WatchdogTelemetryPayload
} from './protocol';

const NOW = 1_800_000_000_000;

function watchdog(overrides: Partial<WatchdogTelemetryPayload>): WatchdogTelemetryPayload {
  return {
    priorTimeout: true,
    priorValid: true,
    priorEnableTimeout: true,
    priorPhase: 13,
    priorSequence: 4242,
    priorPhaseEnteredAtMs: 7_000,
    worstPhase: 0,
    worstPhaseMs: 0,
    faultAddress: 0,
    phaseBeforeFault: 0,
    faultArg0High: 0,
    ...overrides
  };
}

const RECORD: ForkResetRecordPayload = {
  abnormalReset: true,
  breadcrumbValid: true,
  consecutiveAbnormalResets: 3,
  priorUptimeSeconds: 8040,
  uptimeSeconds: 300
};

function report(id: number, minor: number, fill: (bytes: number[]) => void): number[] {
  const bytes = new Array<number>(REPORT_LENGTH).fill(0);
  bytes[0] = id;
  for (let index = 0; index < 4; index += 1) bytes[1 + index] = MAGIC.charCodeAt(index);
  bytes[5] = PROTOCOL_MAJOR;
  bytes[6] = minor;
  fill(bytes);
  return bytes;
}

function writeU32(bytes: number[], offset: number, value: number): void {
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = (value >>> (index * 8)) & 0xff;
}

describe('describeForkRestart', () => {
  it('says nothing after a clean boot or on firmware without the record', () => {
    expect(describeForkRestart({ watchdog: null, record: null, technical: '', nowMs: NOW })).toBeNull();
    expect(describeForkRestart({
      watchdog: watchdog({ priorTimeout: false }),
      record: null,
      technical: '',
      nowMs: NOW
    })).toBeNull();
  });

  it('reads a CPU fault as a crash, placed by what the main loop was doing before it', () => {
    const restart = describeForkRestart({
      watchdog: watchdog({ priorPhase: 26, phaseBeforeFault: 20, faultAddress: 0x2000_0010 }),
      record: RECORD,
      technical: 'HANG in FAULT (bus) @ PC 0x10001234',
      nowMs: NOW
    });
    expect(restart).toMatchObject({
      kind: 'crash',
      area: 'sending controller input to the PC',
      consecutive: 3,
      uptimeBeforeSeconds: 8040,
      restartedAtUnixMs: NOW - 300_000,
      technical: 'HANG in FAULT (bus) @ PC 0x10001234'
    });
  });

  it('reads a panic the same way as a fault', () => {
    expect(describeForkRestart({
      watchdog: watchdog({ priorPhase: 23, phaseBeforeFault: 2 }),
      record: null,
      technical: '',
      nowMs: NOW
    })).toMatchObject({ kind: 'crash', area: 'handling USB' });
  });

  it('reads any other phase as a hang in that phase', () => {
    expect(describeForkRestart({
      watchdog: watchdog({ priorPhase: 13 }),
      record: null,
      technical: '',
      nowMs: NOW
    })).toMatchObject({
      kind: 'hang',
      area: 'talking to the DS5 Bridge app',
      consecutive: null,
      uptimeBeforeSeconds: null,
      restartedAtUnixMs: null
    });
  });

  it('names a stalled audio core separately', () => {
    expect(describeForkRestart({
      watchdog: watchdog({ priorPhase: 31 }),
      record: null,
      technical: '',
      nowMs: NOW
    })?.kind).toBe('audio-stall');
  });

  it('admits when the breadcrumb did not survive', () => {
    expect(describeForkRestart({
      watchdog: watchdog({ priorValid: false }),
      record: { ...RECORD, breadcrumbValid: false, consecutiveAbnormalResets: 1, priorUptimeSeconds: null },
      technical: '',
      nowMs: NOW
    })).toMatchObject({ kind: 'unknown', area: null, consecutive: 1 });
  });

  it('keys a restart by its record, so a different crash is announced again', () => {
    const first = describeForkRestart({ watchdog: watchdog({}), record: RECORD, technical: '', nowMs: NOW });
    const same = describeForkRestart({ watchdog: watchdog({}), record: RECORD, technical: 'x', nowMs: NOW + 60_000 });
    const next = describeForkRestart({
      watchdog: watchdog({}),
      record: { ...RECORD, priorUptimeSeconds: 12 },
      technical: '',
      nowMs: NOW
    });
    expect(same?.key).toBe(first?.key);
    expect(next?.key).not.toBe(first?.key);
  });
});

describe('describeUpstreamRestart', () => {
  it('maps upstream reasons onto crash and hang', () => {
    const base = {
      watchdogReset: true,
      evidenceValid: true,
      phase: 'cyw43',
      reason: 'panic',
      consecutiveAbnormalResets: 2,
      uptimeBeforeResetMs: 61_500,
      detail: 0,
      uptimeMs: 10_000
    };
    expect(describeUpstreamRestart(base, NOW)).toMatchObject({
      kind: 'crash',
      area: 'running the Bluetooth radio',
      consecutive: 2,
      uptimeBeforeSeconds: 61,
      restartedAtUnixMs: NOW - 10_000
    });
    expect(describeUpstreamRestart({ ...base, reason: 'watchdog-timeout' }, NOW)?.kind).toBe('hang');
    expect(describeUpstreamRestart({ ...base, watchdogReset: false }, NOW)).toBeNull();
  });
});

describe('restart report parsing', () => {
  it('parses the fork reset record (0x61)', () => {
    const bytes = report(REPORT_ID.RESET_RECORD, 20, (b) => {
      b[7] = 1;
      b[8] = 0x03;
      b[9] = 4;
      writeU32(b, 10, 3600);
      writeU32(b, 14, 42);
    });
    expect(parseForkResetRecordReport(bytes)).toEqual({
      abnormalReset: true,
      breadcrumbValid: true,
      consecutiveAbnormalResets: 4,
      priorUptimeSeconds: 3600,
      uptimeSeconds: 42
    });
  });

  it('parses upstream reset evidence (0x13)', () => {
    const bytes = report(REPORT_ID.UPSTREAM_RESET_EVIDENCE, 24, (b) => {
      b[7] = 1;
      b[8] = 0x03;
      b[9] = 18;
      b[10] = 2;
      b[11] = 1;
      writeU32(b, 12, 5000);
      writeU32(b, 16, 0xabcd);
      writeU32(b, 20, 900);
    });
    expect(parseUpstreamResetEvidenceReport(bytes)).toEqual({
      watchdogReset: true,
      evidenceValid: true,
      phase: 'wake-on-lan',
      reason: 'out-of-memory',
      consecutiveAbnormalResets: 1,
      uptimeBeforeResetMs: 5000,
      detail: 0xabcd,
      uptimeMs: 900
    });
  });

  it('reads an upstream identity report by its own layout, with no watchdog record', () => {
    const bytes = report(REPORT_ID.DEVICE_IDENTITY, 24, (b) => {
      b[7] = 2;
      b[8] = 0x01 | 0x04;
      const address = 'A0:B1:C2:D3:E4:F5';
      for (let index = 0; index < address.length; index += 1) b[10 + index] = address.charCodeAt(index);
      const name = 'DualSense Wireless Controller';
      for (let index = 0; index < 24; index += 1) b[28 + index] = name.charCodeAt(index);
      for (let index = 0; index < 8; index += 1) b[56 + index] = 0x10 + index;
    });
    expect(parseDeviceIdentityReport(bytes)).toEqual({
      uniqueId: '1011121314151617',
      controllerMac: 'a0b1c2d3e4f5',
      watchdog: null,
      pairingEvents: []
    });
  });

  it('still reads the fork identity layout', () => {
    const bytes = report(REPORT_ID.DEVICE_IDENTITY, 20, (b) => {
      b[7] = 8;
      for (let index = 0; index < 8; index += 1) b[8 + index] = 0xe6 + index;
      b[44] = 0x03;
      b[45] = 13;
    });
    const identity = parseDeviceIdentityReport(bytes);
    expect(identity.uniqueId).toBe('e6e7e8e9eaebeced');
    expect(identity.watchdog).toMatchObject({ priorTimeout: true, priorValid: true, priorPhase: 13 });
  });
});

describe('restart formatting', () => {
  it('keeps durations short', () => {
    expect(formatRestartDuration(45)).toBe('45 s');
    expect(formatRestartDuration(8040)).toBe('2 h 14 min');
    expect(formatRestartDuration(90_000)).toBe('1 d 1 h');
  });

  it('writes a report with nothing left to decode except the raw record', () => {
    const restart = describeForkRestart({
      watchdog: watchdog({ priorPhase: 26, phaseBeforeFault: 20 }),
      record: RECORD,
      technical: 'HANG in FAULT (bus)',
      nowMs: NOW
    })!;
    const text = formatRestartReport(restart, { firmwareVersion: '1.6.78', appVersion: '1.6.125' });
    expect(text).toContain("The bridge's firmware crashed");
    expect(text).toContain('It was sending controller input to the PC.');
    expect(text).toContain('It had been running for 2 h 14 min.');
    expect(text).toContain('This is 3 abnormal restarts in a row.');
    expect(text).toContain('Firmware 1.6.78, app 1.6.125.');
    expect(text).toContain('Record: HANG in FAULT (bus)');
  });
});
