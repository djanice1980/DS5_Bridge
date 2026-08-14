import { describe, expect, it } from 'vitest';
import {
  DirectControllerSource,
  probeDirectController,
  readDirectControllerMac,
  type DirectHidDevice,
  type DirectHidOpen
} from './direct-controller-source';

// A controllable stand-in for node-hid: tests push reports and errors by hand.
class FakeHidDevice implements DirectHidDevice {
  dataListener: ((data: Buffer) => void) | null = null;
  errorListener: ((error: Error) => void) | null = null;
  closed = false;
  featureReport: number[] | null = null;

  on(event: 'data' | 'error', listener: ((data: Buffer) => void) | ((error: Error) => void)): void {
    if (event === 'data') {
      this.dataListener = listener as (data: Buffer) => void;
    } else {
      this.errorListener = listener as (error: Error) => void;
    }
  }

  sentFeatureReports: number[][] = [];

  getFeatureReport(reportId: number, _length: number): number[] {
    if (this.featureReport === null) {
      throw new Error('no feature report configured');
    }
    void reportId;
    return this.featureReport;
  }

  sendFeatureReport(data: number[]): number {
    this.sentFeatureReports.push([...data]);
    return data.length;
  }

  timedRead: number[] = [];

  readTimeout(_timeoutMs: number): number[] {
    return this.timedRead;
  }

  close(): void {
    this.closed = true;
  }
}

function fakeOpen(device: FakeHidDevice): DirectHidOpen {
  return () => device;
}

// A 64-byte USB input report: id 0x01, then the payload the shared decoder reads.
function usbInputReport(firstPayloadByte: number): Buffer {
  const report = Buffer.alloc(64);
  report[0] = 0x01;
  report[1] = firstPayloadByte;
  return report;
}

describe('DirectControllerSource', () => {
  it('serves the payload with the report id stripped', () => {
    const device = new FakeHidDevice();
    let clock = 1000;
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device), () => clock);
    source.open();

    device.dataListener?.(usbInputReport(0x7f));

    const latest = source.latestInput();
    expect(latest).not.toBeNull();
    expect(latest?.raw).toHaveLength(63);
    // The 0x01 id byte is gone; the payload starts with the stick byte.
    expect(latest?.raw[0]).toBe(0x7f);
    void clock;
  });

  it('reports nothing once input goes stale', () => {
    const device = new FakeHidDevice();
    let clock = 1000;
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device), () => clock);
    source.open();
    device.dataListener?.(usbInputReport(0x7f));

    expect(source.latestInput()).not.toBeNull();
    // The charging-while-bridged case: the controller stops producing USB frames.
    clock += 5000;
    expect(source.latestInput()).toBeNull();
  });

  it('ignores frames that are not USB input reports', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();

    const wrongId = Buffer.alloc(64);
    wrongId[0] = 0x31;
    device.dataListener?.(wrongId);

    expect(source.latestInput()).toBeNull();
  });

  it('goes quiet and closes the device after a transport error', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();
    device.dataListener?.(usbInputReport(0x7f));

    device.errorListener?.(new Error('device unplugged'));

    expect(source.latestInput()).toBeNull();
    expect(source.lastError()?.message).toContain('unplugged');
    expect(device.closed).toBe(true);
  });

  it('close() releases the device', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();
    source.close();
    expect(device.closed).toBe(true);
    expect(source.latestInput()).toBeNull();
  });
});

describe('calibration over USB', () => {
  it('sends the dualshock-tools command bytes', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();

    source.sendCalibrationCommand(1, 1);

    // 0x82, op, device id 1, target -- the firmware's BT payload minus its CRC.
    expect(device.sentFeatureReports).toEqual([[0x82, 1, 1, 1]]);
  });

  it('returns the raw 0x83 reply and rejects other ids', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();

    device.featureReport = [0x83, 0x00, 0x01, 0x02];
    expect(source.readCalibrationStatus()).toEqual([0x83, 0x00, 0x01, 0x02]);

    device.featureReport = [0x05, 1, 2, 3];
    expect(source.readCalibrationStatus()).toBeNull();
  });

  it('uses the agreed NVS magic for unlock and the plain lock otherwise', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();

    source.setNvsUnlocked(true);
    source.setNvsUnlocked(false);

    expect(device.sentFeatureReports).toEqual([
      [0x80, 3, 2, 101, 50, 64, 12],
      [0x80, 3, 1]
    ]);
  });

  it('throws for writes once the device is gone, so re-lock failures surface', () => {
    const device = new FakeHidDevice();
    const source = new DirectControllerSource('/dev/hidraw9', fakeOpen(device));
    source.open();
    device.errorListener?.(new Error('device unplugged'));

    expect(() => source.setNvsUnlocked(false)).toThrow('unplugged');
    expect(() => source.sendCalibrationCommand(1, 1)).toThrow('unplugged');
    expect(source.readCalibrationStatus()).toBeNull();
  });
});

describe('probeDirectController', () => {
  it('reads the battery from one input report alongside the MAC', () => {
    const device = new FakeHidDevice();
    device.featureReport = [0x09, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x08, 0x25, 0x00];
    // 63-byte payload with battery bits at payload[52] (report index 53): nibble 8, so the
    // shared decoder reports bucket * 10 = 80%.
    const input = new Array<number>(64).fill(0);
    input[0] = 0x01;
    input[53] = 0x08;
    device.timedRead = input;

    const probe = probeDirectController('/dev/hidraw9', fakeOpen(device));

    expect(probe.mac).toBe('aabbccddeeff');
    expect(probe.batteryPercent).toBe(80);
  });

  it('degrades to a MAC-only probe when no input arrives', () => {
    const device = new FakeHidDevice();
    device.featureReport = [0x09, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa];
    device.timedRead = [];

    const probe = probeDirectController('/dev/hidraw9', fakeOpen(device));

    expect(probe.mac).toBe('aabbccddeeff');
    expect(probe.batteryPercent).toBeNull();
  });
});

describe('readDirectControllerMac', () => {
  it('reverses the pairing-info bytes into display order', () => {
    const device = new FakeHidDevice();
    // Report 0x09 carries the address little-endian: aa:bb:cc:dd:ee:ff arrives reversed.
    device.featureReport = [0x09, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x08, 0x25, 0x00];

    expect(readDirectControllerMac('/dev/hidraw9', fakeOpen(device))).toBe('aabbccddeeff');
    expect(device.closed).toBe(true);
  });

  it('returns null for an all-zero address', () => {
    const device = new FakeHidDevice();
    device.featureReport = [0x09, 0, 0, 0, 0, 0, 0];
    expect(readDirectControllerMac('/dev/hidraw9', fakeOpen(device))).toBeNull();
  });

  it('returns null when the report id is wrong or the read fails', () => {
    const wrongId = new FakeHidDevice();
    wrongId.featureReport = [0x05, 1, 2, 3, 4, 5, 6];
    expect(readDirectControllerMac('/dev/hidraw9', fakeOpen(wrongId))).toBeNull();

    const failing = new FakeHidDevice(); // no featureReport -> getFeatureReport throws
    expect(readDirectControllerMac('/dev/hidraw9', fakeOpen(failing))).toBeNull();
    expect(failing.closed).toBe(true);
  });
});
