import HID from 'node-hid';

/**
 * Input source for a DualSense plugged straight into the PC over USB.
 *
 * The bridge path and this one meet at the same bytes: the firmware's CONTROLLER_INPUT report
 * serves its cached copy of the controller's USB-format input report, and a hidraw read of a
 * direct controller yields that identical 63-byte payload behind a 0x01 report-id byte. So this
 * class only captures frames; decoding stays in shared/dualsense-input.ts for both paths.
 *
 * Reports are pushed by the device (~4 ms cadence on USB), so "connected" is defined by
 * freshness: a controller that is unplugged, asleep, or -- the case that motivated all of this
 * -- charging over USB while its data link lives on a bridge, simply stops producing frames.
 */

const DUALSENSE_USB_INPUT_REPORT_ID = 0x01;
const INPUT_STALE_MS = 1000;
const PAIRING_INFO_FEATURE_REPORT = 0x09;

// Stick calibration, per dualshock-tools/ds4-tools -- the identical bytes the firmware relays
// over Bluetooth (bt_send_stick_calibration / bt_set_nvs_unlocked in bt.cpp), minus the CRC32
// the BT transport requires and USB does not.
const CALIBRATION_COMMAND_FEATURE_REPORT = 0x82;
const CALIBRATION_STATUS_FEATURE_REPORT = 0x83;
const CALIBRATION_DEVICE_ID = 1;
const NVS_LOCK_FEATURE_REPORT = 0x80;
// Fixed magic sequence, agreed on by dualshock-tools/ds4-tools and sense-calibrator.
const NVS_UNLOCK_PAYLOAD = [3, 2, 101, 50, 64, 12];
const NVS_LOCK_PAYLOAD = [3, 1];

export interface DirectHidDevice {
  on(event: 'data', listener: (data: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  getFeatureReport(reportId: number, length: number): number[];
  sendFeatureReport(data: number[]): number;
  close(): void;
}

export type DirectHidOpen = (path: string) => DirectHidDevice;

const defaultOpen: DirectHidOpen = (path) => new HID.HID(path) as unknown as DirectHidDevice;

/**
 * Read the controller's Bluetooth MAC without keeping the device open. Returns bare lowercase
 * hex (aabbccddeeff) in display order -- the same format the bridge reports for its connected
 * controller and the same key controller profiles are bound to.
 *
 * The 0x09 pairing-info report carries the address in reversed (little-endian) byte order;
 * the kernel's hid-playstation driver reverses it the same way (dualsense_get_mac_address).
 */
export function readDirectControllerMac(path: string, openHid: DirectHidOpen = defaultOpen): string | null {
  let device: DirectHidDevice | null = null;
  try {
    device = openHid(path);
    const report = device.getFeatureReport(PAIRING_INFO_FEATURE_REPORT, 20);
    if (!report || report.length < 7 || report[0] !== PAIRING_INFO_FEATURE_REPORT) {
      return null;
    }
    let mac = '';
    for (let index = 6; index >= 1; index -= 1) {
      mac += (report[index] & 0xff).toString(16).padStart(2, '0');
    }
    return /^0+$/.test(mac) ? null : mac;
  } catch {
    return null;
  } finally {
    try {
      device?.close();
    } catch {
      // Ignore close failures on a device that may already be gone.
    }
  }
}

export class DirectControllerSource {
  private device: DirectHidDevice | null = null;
  private latestPayload: number[] | null = null;
  private latestAt = 0;
  private failed: Error | null = null;

  constructor(
    public readonly path: string,
    private readonly openHid: DirectHidOpen = defaultOpen,
    private readonly now: () => number = () => Date.now()
  ) {}

  open(): void {
    const device = this.openHid(this.path);
    this.device = device;
    device.on('data', (data: Buffer) => {
      // USB input report: id 0x01 followed by the 63-byte payload the shared decoder expects
      // (sticks first -- the same layout the firmware caches). Anything else (a BT-format 0x31
      // report cannot appear on this transport, but be strict anyway) is ignored.
      if (data.length >= 10 && data[0] === DUALSENSE_USB_INPUT_REPORT_ID) {
        this.latestPayload = Array.from(data.subarray(1));
        this.latestAt = this.now();
      }
    });
    device.on('error', (error: Error) => {
      // Unplugged mid-session. Keep the source; reads report disconnected from here on.
      this.failed = error;
      this.closeDevice();
    });
  }

  /** Latest payload in CONTROLLER_INPUT shape: null when nothing fresh has arrived. */
  latestInput(): { raw: number[] } | null {
    if (this.failed || this.latestPayload === null) {
      return null;
    }
    if (this.now() - this.latestAt > INPUT_STALE_MS) {
      // A DualSense with an active USB data link streams continuously; silence means the data
      // link is elsewhere (bridged and charging) or the controller went away.
      return null;
    }
    return { raw: this.latestPayload };
  }

  lastError(): Error | null {
    return this.failed;
  }

  /** Begin/sample/store a calibration step. Throws when the device is gone. */
  sendCalibrationCommand(op: number, target: number): void {
    this.requireDevice().sendFeatureReport([
      CALIBRATION_COMMAND_FEATURE_REPORT,
      op & 0xff,
      CALIBRATION_DEVICE_ID,
      target & 0xff
    ]);
  }

  /**
   * The controller's own 0x83 reply, report id included -- the same byte shape the bridge
   * caches from the BT reply, so both transports feed one acceptance check.
   */
  readCalibrationStatus(): number[] | null {
    try {
      const report = this.requireDevice().getFeatureReport(CALIBRATION_STATUS_FEATURE_REPORT, 64);
      if (!report || report.length < 1 || report[0] !== CALIBRATION_STATUS_FEATURE_REPORT) {
        return null;
      }
      return report.map((byte) => byte & 0xff);
    } catch {
      return null;
    }
  }

  /** Unlock or re-lock the controller's permanent storage. Throws when the device is gone. */
  setNvsUnlocked(unlocked: boolean): void {
    this.requireDevice().sendFeatureReport([
      NVS_LOCK_FEATURE_REPORT,
      ...(unlocked ? NVS_UNLOCK_PAYLOAD : NVS_LOCK_PAYLOAD)
    ]);
  }

  private requireDevice(): DirectHidDevice {
    if (this.device === null) {
      throw this.failed ?? new Error('USB controller is not open');
    }
    return this.device;
  }

  close(): void {
    this.closeDevice();
    this.latestPayload = null;
  }

  private closeDevice(): void {
    const device = this.device;
    this.device = null;
    if (device) {
      try {
        device.close();
      } catch {
        // Already gone.
      }
    }
  }
}
