import { createHmac, randomBytes } from 'node:crypto';
import {
  ACK_RESULT,
  BOOTLOADER_AUTHORIZATION_PROTOCOL_MINOR,
  BOOTLOADER_AUTHORIZATION_UPSTREAM_MINOR,
  COMMAND_ID,
  PROTOCOL_MAJOR,
  REPORT_ID,
  REPORT_LENGTH,
  parseBootloaderAuthorizationReport,
  parseDeviceIdentityReport
} from '../shared/protocol';
import type {
  BootloaderAuthorizationPayload,
  BridgeAckPayload
} from '../shared/protocol';
import type { BootloaderConfirmationPresentation } from '../shared/types';
import type {
  BootloaderAuthorizationKeyRecord,
  BootloaderAuthorizationStorePort
} from './bootloader-authorization-store';

// Ported from upstream 2.0 (Kitsune Input lineage). Entering BOOTSEL from the app
// needs this computer's enrolled key (an HMAC over a fresh single-use bridge
// challenge) and a random eight-button sequence entered on the connected
// controller, so no other program on the PC can put the bridge into flash mode
// on its own. The wire format is identical in both lineages; only the minor at
// which a firmware supports it differs (fork 20, upstream 24).

// Must match kAuthDomain in src/bootloader_maintenance.cpp.
const AUTH_DOMAIN = Buffer.from('DS5BRIDGE-BOOT1\0', 'ascii');
const CONFIRMATION_POLL_MS = 200;

export interface PicoBootloaderAuthorizationCommandOptions {
  throwOnCommandError?: boolean;
  extraPayload?: ArrayLike<number>;
  allowAckTransportLoss?: boolean;
}

export interface PicoBootloaderAuthorizationPorts {
  store?: BootloaderAuthorizationStorePort;
  /** The bridge's companion protocol, read even from incompatible firmware. */
  firmwareProtocolVersion(): Promise<{ major: number; minor: number }>;
  /**
   * True when the connected firmware is this fork's lineage (it answered the
   * fork-info report). Decides which minor first carries authenticated entry:
   * 20 on the fork, 24 upstream (upstream 21-23 do not have it). Absent means
   * not fork, i.e. the upstream threshold applies.
   */
  firmwareIsFork?(): Promise<boolean>;
  readFeatureReport(reportId: number, length: number): Promise<number[]>;
  sendCommand(
    commandId: number,
    value: number,
    options?: PicoBootloaderAuthorizationCommandOptions
  ): Promise<BridgeAckPayload>;
  showConfirmation(presentation: BootloaderConfirmationPresentation): void;
  hideConfirmation(): void;
  confirmationCancelled(): boolean;
  delay(milliseconds: number): Promise<void>;
  now(): number;
}

export class PicoBootloaderAuthorizationCoordinator {
  constructor(private readonly ports: PicoBootloaderAuthorizationPorts) {}

  async enter(): Promise<void> {
    const version = this.ports.store ? await this.ports.firmwareProtocolVersion() : null;
    const fork = version && this.ports.firmwareIsFork ? await this.ports.firmwareIsFork() : false;
    const requiredMinor = fork
      ? BOOTLOADER_AUTHORIZATION_PROTOCOL_MINOR
      : BOOTLOADER_AUTHORIZATION_UPSTREAM_MINOR;
    if (!version || version.major !== PROTOCOL_MAJOR || version.minor < requiredMinor) {
      // Older firmware only knows the plain command; it must stay reachable
      // so those bridges can be updated to the authenticated firmware.
      await this.ports.sendCommand(COMMAND_ID.ENTER_BOOTLOADER, 0, { allowAckTransportLoss: true });
      return;
    }
    await this.enterAuthenticated(fork);
  }

  private async enterAuthenticated(fork: boolean): Promise<void> {
    // The board id's place in the identity report predates the protocol
    // convergence and differs by lineage: the fork carries an id length at [7]
    // and the bytes at [8..], upstream a schema at [7] and the id at [56..63].
    // The id is MAC'd into every challenge, so reading the wrong bytes would
    // fail authorization even with a good key.
    const identityReport = await this.ports.readFeatureReport(REPORT_ID.DEVICE_IDENTITY, REPORT_LENGTH);
    const bridgeUniqueId = fork
      ? parseDeviceIdentityReport(identityReport).uniqueId
      : upstreamBridgeUniqueId(identityReport);
    if (!bridgeUniqueId) throw new Error('The Pico did not provide its unique hardware ID.');
    let authorization = await this.readAuthorizationReport();
    let key = this.ports.store!.get(bridgeUniqueId);
    if (!key || !authorization.authorized || !keyIdsEqual(key.keyId, authorization.keyId)) {
      key = await this.enroll(bridgeUniqueId);
      authorization = await this.readAuthorizationReport();
      if (!authorization.authorized || !keyIdsEqual(key.keyId, authorization.keyId)) {
        throw new Error('The Pico did not retain the new bootloader authorization.');
      }
    }

    if (!authorization.bootloaderEntryPhysicallyConfirmed) {
      await this.confirmPhysicalBootloaderEntry(bridgeUniqueId, key);
    }
    const ack = await this.sendAuthenticatedCommand(bridgeUniqueId, key, COMMAND_ID.ENTER_BOOTLOADER, {
      allowAckTransportLoss: true,
      throwOnCommandError: false
    });
    if (ack.resultCode !== ACK_RESULT.OK) {
      throw new Error('The Pico refused UF2 mode. Start again and enter the displayed sequence on the controller.');
    }
  }

  private async sendAuthenticatedCommand(
    bridgeUniqueId: string,
    key: BootloaderAuthorizationKeyRecord,
    commandId: number,
    options: PicoBootloaderAuthorizationCommandOptions = {}
  ): Promise<BridgeAckPayload> {
    const challengeAck = await this.ports.sendCommand(COMMAND_ID.BOOTLOADER_AUTH_CHALLENGE, 0, {
      throwOnCommandError: false
    });
    if (challengeAck.resultCode === ACK_RESULT.ERR_BUSY) {
      throw new Error('The Pico paused bootloader authorization after repeated failures. Wait 30 seconds, then try again.');
    }
    const challenge = await this.readAuthorizationReport();
    if (!challenge.challengeActive || challenge.challengeRemainingMs === 0
      || !keyIdsEqual(key.keyId, challenge.keyId)) {
      throw new Error('The Pico did not issue a usable bootloader authorization challenge.');
    }
    // domain(16) | board id(8) | nonce(16) | challenge id(4) | command(1) | key id(4)
    const message = Buffer.alloc(49);
    AUTH_DOMAIN.copy(message);
    Buffer.from(bridgeUniqueId, 'hex').copy(message, 16);
    Buffer.from(challenge.nonce).copy(message, 24);
    message.writeUInt32LE(challenge.challengeId >>> 0, 40);
    message[44] = commandId;
    Buffer.from(key.keyId).copy(message, 45);
    const payload = Buffer.alloc(40);
    Buffer.from(key.keyId).copy(payload);
    payload.writeUInt32LE(challenge.challengeId >>> 0, 4);
    createHmac('sha256', key.secret).update(message).digest().copy(payload, 8);
    return this.ports.sendCommand(commandId, 0, { ...options, extraPayload: payload });
  }

  private async confirmPhysicalBootloaderEntry(
    bridgeUniqueId: string,
    key: BootloaderAuthorizationKeyRecord
  ): Promise<void> {
    const beginAck = await this.sendAuthenticatedCommand(
      bridgeUniqueId,
      key,
      COMMAND_ID.BOOTLOADER_AUTH_PHYSICAL_BEGIN,
      { throwOnCommandError: false }
    );
    this.assertPhysicalConfirmationStarted(beginAck);
    await this.awaitConfirmation('bootloader-entry', (report) => ({
      pending: report.bootloaderEntryConfirmationPending,
      confirmed: report.bootloaderEntryPhysicallyConfirmed
    }));
  }

  private async enroll(bridgeUniqueId: string): Promise<BootloaderAuthorizationKeyRecord> {
    const key = { keyId: Array.from(randomBytes(4)), secret: randomBytes(32) };
    const beginAck = await this.ports.sendCommand(COMMAND_ID.BOOTLOADER_AUTH_ENROLL_BEGIN, 0, {
      extraPayload: Buffer.concat([Buffer.from(key.keyId), key.secret]),
      throwOnCommandError: false
    });
    this.assertPhysicalConfirmationStarted(beginAck);
    await this.awaitConfirmation('enrollment', (report) => ({
      pending: report.enrollmentPending,
      confirmed: report.enrollmentPhysicallyConfirmed
    }));
    const ack = await this.ports.sendCommand(COMMAND_ID.BOOTLOADER_AUTH_ENROLL_COMMIT, 0, {
      throwOnCommandError: false
    });
    if (ack.resultCode !== ACK_RESULT.OK) {
      await this.cancelPhysicalConfirmation();
      const reason = ack.resultCode === ACK_RESULT.ERR_UNAUTHORIZED
        ? 'the confirmation window expired'
        : 'the Pico could not save it';
      throw new Error(`Pico bootloader authorization failed: ${reason}.`);
    }
    try {
      this.ports.store!.set(bridgeUniqueId, key);
    } catch (error) {
      // The bridge already holds the new key; without it here, the next
      // attempt finds no usable key and enrolls again.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The Pico accepted the new authorization, but this computer could not save it (${reason}). Try again to enroll this computer.`);
    }
    return key;
  }

  // Shows the sequence and waits for the controller to enter it. Cancels the
  // firmware's confirmation if anything but success ends the wait.
  private async awaitConfirmation(
    purpose: BootloaderConfirmationPresentation['purpose'],
    state: (report: BootloaderAuthorizationPayload) => { pending: boolean; confirmed: boolean }
  ): Promise<void> {
    let confirmed = false;
    try {
      let report = await this.readAuthorizationReport();
      if (!state(report).pending || report.confirmationRemainingMs === 0) {
        throw new Error('The Pico did not start the controller confirmation.');
      }
      const expiresAtUnixMs = this.ports.now() + report.confirmationRemainingMs;
      this.ports.showConfirmation(presentation(purpose, report, expiresAtUnixMs));
      while (this.ports.now() < expiresAtUnixMs) {
        if (this.ports.confirmationCancelled()) {
          throw new Error('Pico UF2 mode was cancelled.');
        }
        if (state(report).confirmed) {
          confirmed = true;
          return;
        }
        await this.ports.delay(CONFIRMATION_POLL_MS);
        report = await this.readAuthorizationReport();
        const current = state(report);
        if (!current.pending && !current.confirmed) {
          throw new Error('The confirmation stopped because the controller disconnected or the time ran out.');
        }
        this.ports.showConfirmation(presentation(purpose, report, expiresAtUnixMs));
      }
      throw new Error('The confirmation timed out. Start again and enter the displayed eight-button sequence on the controller.');
    } finally {
      this.ports.hideConfirmation();
      if (!confirmed) await this.cancelPhysicalConfirmation();
    }
  }

  private async readAuthorizationReport(): Promise<BootloaderAuthorizationPayload> {
    return parseBootloaderAuthorizationReport(
      await this.ports.readFeatureReport(REPORT_ID.BOOTLOADER_AUTHORIZATION, REPORT_LENGTH)
    );
  }

  private async cancelPhysicalConfirmation(): Promise<void> {
    try {
      await this.ports.sendCommand(COMMAND_ID.BOOTLOADER_AUTH_CONFIRMATION_CANCEL, 0, {
        throwOnCommandError: false
      });
    } catch {
      // A controller or USB disconnect also clears the confirmation in firmware.
    }
  }

  private assertPhysicalConfirmationStarted(ack: BridgeAckPayload): void {
    if (ack.resultCode === ACK_RESULT.OK) return;
    if (ack.resultCode === ACK_RESULT.ERR_NOT_CONNECTED || ack.resultCode === ACK_RESULT.ERR_INVALID_VALUE) {
      throw new Error('Connect a controller to this Pico to confirm UF2 mode, or hold BOOTSEL while plugging the Pico in.');
    }
    if (ack.resultCode === ACK_RESULT.ERR_BUSY) {
      throw new Error('Pico bootloader authorization is busy. Try again in a moment.');
    }
    throw new Error('The Pico refused to start the controller confirmation.');
  }
}

function presentation(
  purpose: BootloaderConfirmationPresentation['purpose'],
  report: BootloaderAuthorizationPayload,
  expiresAtUnixMs: number
): BootloaderConfirmationPresentation {
  return {
    purpose,
    sequence: [...report.confirmationSequence],
    progress: report.confirmationProgress,
    mistakes: report.confirmationMistakes,
    expiresAtUnixMs
  };
}

// Upstream identity schema 2+: eight board-id bytes at report[56..63].
function upstreamBridgeUniqueId(report: ArrayLike<number>): string | null {
  if ((report[7] ?? 0) < 2) {
    return null;
  }
  const hex = Array.from({ length: 8 }, (_, index) => ((report[56 + index] ?? 0) & 0xff).toString(16).padStart(2, '0')).join('');
  return /^0+$/.test(hex) ? null : hex;
}

function keyIdsEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== 4 || right.length !== 4) return false;
  let difference = 0;
  for (let index = 0; index < 4; index += 1) {
    difference |= (left[index] & 0xff) ^ (right[index] & 0xff);
  }
  return difference === 0;
}
