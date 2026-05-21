import { EventEmitter } from 'node:events';
import HID from 'node-hid';
import {
  ACK_RESULT,
  AUDIO_DEBUG_EVENT,
  COMMAND_ID,
  COMPANION_USAGE,
  COMPANION_USAGE_PAGE,
  REPORT_ID,
  REPORT_LENGTH,
  MUTE_KEYBOARD_HOLD_FLAG,
  MUTE_KEYBOARD_MODIFIER_MASK,
  ProtocolError,
  ackUserMessage,
  buildCommandReport,
  buildHostAudioFastFrameReports,
  buildHostAudioStreamReport,
  parseAckReport,
  parseAudioDebugReport,
  parseAudioStatsReport,
  parseHostAudioStatusReport,
  parseStatusReport,
  HOST_AUDIO_PACKET_TYPE,
  SHORTCUT_EVENT,
  buildButtonRemapPayload,
  normalizeBridgePresetId,
  pollingRateModeValue
} from '../shared/protocol';
import type {
  AudioDebugEventPayload,
  AudioDebugStatsPayload,
  BridgePresetId,
  RemapButtonId,
  HostAudioStatusPayload,
  BridgeStatusPayload,
  MuteButtonMode,
  MuteKeyboardBehavior,
  PollingRateMode,
  ShortcutEvent,
  TriggerTestMode,
  TriggerTestTarget
} from '../shared/protocol';
import type {
  BridgeDiagnostics,
  BridgeSnapshot,
  CompanionSettings,
  HidDeviceSummary,
  UiScalePercent
} from '../shared/types';
import {
  HostAudioEngine,
  MicKeepaliveEngine,
  playHostAudioTestTone,
  type HostAudioFramePayload
} from './host-audio-engine';
import { HidDiscoveryClient } from './hid-discovery-client';
import { SettingsStore, normalizeUiScalePercent } from './settings-store';

const POLL_INTERVAL_MS = 500;
const HOST_AUDIO_HEARTBEAT_MS = 250;
const HOST_AUDIO_ACTIVE_POLL_INTERVAL_MS = 5000;
const HOST_AUDIO_STATUS_READ_INTERVAL_MS = 500;
const HOST_AUDIO_HELPER_STATUS_READ_INTERVAL_MS = 5000;
const AUDIO_DEBUG_READ_INTERVAL_MS = 500;
const AUDIO_DEBUG_DIAGNOSTICS_ENABLED = false;
const HOST_AUDIO_MAX_QUEUED_FRAMES = 2;
const HOST_AUDIO_STOP_FADE_MS = 40;
const LOW_BATTERY_PERCENT = 20;
const FIRMWARE_UPDATE_REQUIRED_MESSAGE = 'Firmware 1.0.1 update required';
const AUDIO_DEBUG_LOG_LINE_LIMIT = 300;
const STARTUP_REAPPLY_MIN_SETTLE_MS = 0;
const STARTUP_REAPPLY_RETRY_DELAYS_MS = [250, 650, 1300] as const;
const MIN_IDLE_DISCONNECT_TIMEOUT_MINUTES = 1;
const MAX_IDLE_DISCONNECT_TIMEOUT_MINUTES = 120;
const CONTROLLER_POWER_SAVING_CAP_PERCENT = 60;
const SONY_VENDOR_ID = 0x054c;
const DUALSENSE_PRODUCT_IDS = new Set([0x0ce6, 0x0df2]);
type DiscoveredHidDevice = HidDeviceSummary;
type BridgeDiagnosticsWithoutAudioLog = Omit<
  BridgeDiagnostics,
  'audioDebugLogPath' | 'audioDebugLogLines' | 'audioDebugDroppedCount' | 'audioDebugStats' | 'hostAudioStatus'
>;

type CommandOptions = {
  expectSettingsRevisionChange?: boolean;
  throwOnCommandError?: boolean;
  extraPayload?: ArrayLike<number>;
};

export type BridgeToast = {
  title: string;
  body: string;
};

const PRESET_SETTINGS: Record<Exclude<BridgePresetId, 'custom'>, Partial<CompanionSettings>> = {
  balanced: {
    selectedPresetId: 'balanced',
    hapticsEnabled: true,
    hapticsGainPercent: 100,
    classicRumbleEnabled: true,
    classicRumbleGainPercent: 100,
    speakerEnabled: true,
    speakerVolumePercent: 100,
    adaptiveTriggersEnabled: true,
    triggerEffectIntensityPercent: 100,
    lightbarEnabled: true,
    lightbarColor: '#0000ff',
    lightbarBrightnessPercent: 100,
    lightbarOverrideEnabled: false,
    muteButtonMode: 'normal',
    muteKeyboardBehavior: 'tap'
  },
  quiet: {
    selectedPresetId: 'quiet',
    hapticsEnabled: false,
    classicRumbleEnabled: false,
    speakerEnabled: false,
    adaptiveTriggersEnabled: false,
    lightbarEnabled: true,
    lightbarBrightnessPercent: 35,
    lightbarOverrideEnabled: true,
    muteButtonMode: 'quiet'
  },
  'no-speaker': {
    selectedPresetId: 'no-speaker',
    speakerEnabled: false
  },
  'no-haptics': {
    selectedPresetId: 'no-haptics',
    hapticsEnabled: false,
    classicRumbleEnabled: false
  },
  'no-triggers': {
    selectedPresetId: 'no-triggers',
    adaptiveTriggersEnabled: false,
    triggerEffectIntensityPercent: 0
  },
  'lights-off': {
    selectedPresetId: 'lights-off',
    lightbarEnabled: false,
    lightbarOverrideEnabled: true
  }
};

function isCompanionCandidate(device: HidDeviceSummary): boolean {
  return device.usagePage === COMPANION_USAGE_PAGE && device.usage === COMPANION_USAGE && Boolean(device.path);
}

function isDualSenseDevice(device: HidDeviceSummary): boolean {
  return device.vendorId === SONY_VENDOR_ID
    && DUALSENSE_PRODUCT_IDS.has(device.productId ?? 0)
    && /DualSense/i.test(device.product ?? '');
}

function isSupportedFirmwareVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every(Number.isFinite)) {
    return false;
  }
  return major >= 1;
}

function emptyDiagnostics(rawDevices: HidDeviceSummary[]): BridgeDiagnostics {
  return {
    hidPath: null,
    protocolVersion: null,
    uptimeSeconds: null,
    settingsRevision: null,
    lastAck: null,
    lastError: null,
    lastPollAt: null,
    rawDevices,
    audioDebugLogPath: null,
    audioDebugLogLines: [],
    audioDebugDroppedCount: 0,
    audioDebugStats: null,
    hostAudioStatus: null
  };
}

function parseHexColor(color: string): { hex: string; red: number; green: number; blue: number } {
  const hex = /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '#0000ff';
  return {
    hex,
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16)
  };
}

function muteButtonModeValue(mode: MuteButtonMode): number {
  if (mode === 'keyboard') return 1;
  if (mode === 'quiet') return 2;
  return 0;
}

function encodeMuteKeyboardOptions(modifiers: number, behavior: MuteKeyboardBehavior): number {
  const modifierBits = Math.max(0, Math.min(MUTE_KEYBOARD_MODIFIER_MASK, Math.round(modifiers)));
  return behavior === 'hold' ? modifierBits | MUTE_KEYBOARD_HOLD_FLAG : modifierBits;
}

function triggerTestModeValue(mode: TriggerTestMode): number {
  if (mode === 'weapon') return 1;
  if (mode === 'vibration') return 2;
  return 0;
}

function triggerTestTargetValue(target: TriggerTestTarget): number {
  if (target === 'l2') return 1;
  if (target === 'r2') return 2;
  return 0;
}

function normalizePollingRateMode(mode: PollingRateMode): PollingRateMode {
  if (mode === '250' || mode === '500') {
    return mode;
  }
  return '1000';
}

function normalizeIdleDisconnectTimeoutMinutes(minutes: number): number {
  return Math.max(
    MIN_IDLE_DISCONNECT_TIMEOUT_MINUTES,
    Math.min(MAX_IDLE_DISCONNECT_TIMEOUT_MINUTES, Math.round(minutes))
  );
}

function customSettingUpdate(update: Partial<CompanionSettings>): Partial<CompanionSettings> {
  return { ...update, selectedPresetId: 'custom' };
}

function limitedByte(value: number, suffix = '+'): string {
  return value === 255 ? `${value}${suffix}` : String(value);
}

function hexByte(value: number): string {
  return `0x${value.toString(16).padStart(2, '0')}`;
}

function scaled100Us(value: number): string {
  return value === 255 ? '25500+us' : `${value * 100}us`;
}

function formatMicDebugEvent(prefix: string, args: number[]): string {
  const [type, arg1, arg2, arg3, arg4] = args;
  switch (type) {
    case 0:
      return `${prefix} [HostPico] MIC decode-fail code=${arg1} dropped=${arg2}`;
    case 1:
      return `${prefix} [HostPico] MIC usb-short written=${arg1} target=${arg2} dropped=${arg3}`;
    case 2:
      return `${prefix} [HostPico] MIC packet rx=${arg1} raw_fifo=${arg2}`;
    case 3:
      return `${prefix} [HostPico] MIC playout-underrun usb_fifo=${arg1} decoded_fifo=${arg2} dropped=${arg3}`;
    case 4:
      return `${prefix} [HostPico] MIC raw-fifo-overflow raw_fifo=${arg1} dropped=${arg2}`;
    case 5:
      return `${prefix} [HostPico] MIC raw-fifo-add-fail raw_fifo=${arg1} dropped=${arg2}`;
    case 6:
      return `${prefix} [HostPico] MIC short-packet len=${arg1} dropped=${arg2}`;
    case 7:
      return `${prefix} [HostPico] MIC decoded-fifo-overflow decoded_fifo=${arg1} dropped=${arg2}`;
    case 8:
      return `${prefix} [HostPico] MIC decoded-fifo-add-fail decoded_fifo=${arg1} dropped=${arg2}`;
    case 9:
      return `${prefix} [HostPico] MIC plc-fail code=${arg1} dropped=${arg2}`;
    case 10:
      return `${prefix} [HostPico] MIC plc decoded_fifo=${arg1} samples=${arg2}`;
    default:
      return `${prefix} [HostPico] MIC type=${type} arg1=${arg1} arg2=${arg2} arg3=${arg3} arg4=${arg4}`;
  }
}

function isExpectedHidDisconnectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes('could not read from hid device')
    || message.includes('cannot read from hid device')
    || message.includes('hid device disconnected');
}

function parseShortcutEvent(data: Buffer | number[]): ShortcutEvent | null {
  const report = Array.from(data);
  const event = report[0] === REPORT_ID.INPUT ? report[1] : report[0];
  switch (event) {
    case SHORTCUT_EVENT.CONTROLLER_VOLUME_DOWN:
    case SHORTCUT_EVENT.CONTROLLER_VOLUME_UP:
    case SHORTCUT_EVENT.SLEEP_CONTROLLER:
      return event;
    default:
      return null;
  }
}

function formatUsbDebugEvent(prefix: string, args: number[]): string {
  const [type, arg1, arg2, arg3, arg4] = args;
  switch (type) {
    case 1:
      return `${prefix} [USB] AUDIO_SET_INTERFACE itf=${arg1} alt=${arg2} speakerStreaming=${arg3 === 1 ? 'true' : 'false'} micStreaming=${arg4 === 1 ? 'true' : 'false'}`;
    case 2:
      return `${prefix} [USB] AUDIO_GET entity=${hexByte(arg1)} control=${hexByte(arg2)} request=${hexByte(arg3)} len=${arg4}`;
    case 3:
      return `${prefix} [USB] AUDIO_SET entity=${hexByte(arg1)} control=${hexByte(arg2)} request=${hexByte(arg3)} len=${arg4}`;
    case 4:
      return `${prefix} [USB] AUDIO_DISCARD reads=${arg1} maxReads=${arg2} runtime=${arg3} stillAvailable=${arg4 === 1 ? 'true' : 'false'}`;
    default:
      return `${prefix} [USB] type=${type} arg1=${arg1} arg2=${arg2} arg3=${arg3} arg4=${arg4}`;
  }
}

function formatHidDebugEvent(prefix: string, args: number[]): string {
  const [type, reportId, reportType, len, firstByte] = args;
  switch (type) {
    case 1:
      return `${prefix} [HID] GET_REPORT report=${hexByte(reportId)} type=${reportType} len=${limitedByte(len)}`;
    case 2:
      return `${prefix} [HID] SET_REPORT report=${hexByte(reportId)} type=${reportType} len=${limitedByte(len)} first=${hexByte(firstByte)}`;
    case 3:
      return `${prefix} [HID] IN_REPORT report=${hexByte(reportId)} len=${limitedByte(len)} buttonByte=${hexByte(firstByte)}`;
    default:
      return `${prefix} [HID] type=${type} report=${hexByte(reportId)} reportType=${reportType} len=${limitedByte(len)} first=${hexByte(firstByte)}`;
  }
}

function formatBtDebugEvent(prefix: string, args: number[]): string {
  const [type, arg1, arg2, arg3, arg4] = args;
  switch (type) {
    case 1:
      return `${prefix} [BT] AUDIO_LATE age=${scaled100Us(arg1)} gap=${scaled100Us(arg2)} nonAudioBefore=${arg3} audioQueueAfter=${arg4}`;
    case 2:
      return `${prefix} [BT] NON_AUDIO_WITH_AUDIO_QUEUED reason=${arg1} queuedAudioAge=${scaled100Us(arg2)} criticalQ=${arg3} statePending=${arg4 === 1 ? 'true' : 'false'}`;
    case 3:
      return `${prefix} [BT] CONTROL_SEND op=${hexByte(arg1)} report=${hexByte(arg2)} age=${scaled100Us(arg3)} controlQ=${arg4}`;
    case 4:
      return `${prefix} [BT] CONTROL_SUPPRESSED op=${hexByte(arg1)} report=${hexByte(arg2)} cached=${arg3 === 1 ? 'true' : 'false'}`;
    default:
      return `${prefix} [BT] type=${type} arg1=${arg1} arg2=${arg2} arg3=${arg3} arg4=${arg4}`;
  }
}

function routeSourceLabel(source: number): string {
  switch (source) {
    case 0:
      return 'persistent';
    case 1:
      return 'headset-change';
    case 2:
      return 'host-primer';
    default:
      return String(source);
  }
}

function formatAudioDebugEvent(event: AudioDebugEventPayload): string {
  const [arg0, arg1, arg2, arg3, arg4] = event.args;
  const prefix = `#${event.sequence} t=${event.timeUs}us`;
  switch (event.eventCode) {
    case AUDIO_DEBUG_EVENT.AUDIO_START:
      return `${prefix} [Audio] START: host audio audio_fifo=${arg0} opus_ready=${arg1} frames=${arg2} packet=${arg3} reportSeq=${arg4}`;
    case AUDIO_DEBUG_EVENT.RESET_GAP:
      return `${prefix} [Audio] RESET: gap detected audio_fifo=${arg0} opus_ready=${arg1} gap_ms=${limitedByte(arg2)} packet=${arg3} skip=${arg4}`;
    case AUDIO_DEBUG_EVENT.CORE1_RESET:
      return `${prefix} [Audio] CORE1: reset encoder opus_fifo_before=${arg0} opus_fifo_after=${arg1} reset_ran=${arg2 === 1 ? 'true' : 'false'} audio_fifo=${arg3}`;
    case AUDIO_DEBUG_EVENT.SKIP_OPUS_PACKET:
      return `${prefix} [Audio] SKIP opus pkt skip_before=${arg0} skip_after=${arg1} opus_fifo=${arg2} packet=${arg3} reportSeq=${arg4}`;
    case AUDIO_DEBUG_EVENT.SEND_SPEAKER_PACKET:
      return `${prefix} [Audio] SEND: speaker opus included audio_fifo=${arg0} opus_ready=${arg1} packet=${arg2} reportSeq=${arg3} headset=${(arg4 & 0x01) !== 0 ? 'true' : 'false'} silence=${(arg4 & 0x02) !== 0 ? 'true' : 'false'}`;
    case AUDIO_DEBUG_EVENT.NO_OPUS_PACKET:
      return `${prefix} [Audio] SUPPRESS: no opus packet audio_fifo=${arg0} opus_ready=${arg1} packet=${arg2} reportSeq=${arg3}`;
    case AUDIO_DEBUG_EVENT.AUDIO_FIFO_DROP:
      return `${prefix} [Audio] DROP: audio_fifo full audio_fifo=${arg0} opus_ready=${arg1} packet=${arg2} reportSeq=${arg3}`;
    case AUDIO_DEBUG_EVENT.AUDIO_FIFO_ADD_FAIL:
      return `${prefix} [Audio] ERROR: audio_fifo add failed audio_fifo=${arg0} opus_ready=${arg1} packet=${arg2} reportSeq=${arg3}`;
    case AUDIO_DEBUG_EVENT.OPUS_FIFO_DROP:
      return `${prefix} [Audio] DROP: opus_fifo full audio_fifo=${arg0} opus_fifo=${arg1}`;
    case AUDIO_DEBUG_EVENT.OPUS_FIFO_ADD_FAIL:
      return `${prefix} [Audio] ERROR: opus_fifo add failed audio_fifo=${arg0} opus_fifo=${arg1}`;
    case AUDIO_DEBUG_EVENT.TEST_HAPTICS_START:
      return `${prefix} [Audio] TEST HAPTICS: start audio_fifo=${arg0} opus_ready=${arg1} haptics_gain=${arg2}%`;
    case AUDIO_DEBUG_EVENT.TEST_HAPTICS_STOP:
      return `${prefix} [Audio] TEST HAPTICS: stop reason=${arg0 === 1 ? 'complete' : 'disconnected'} audio_fifo=${arg1} opus_ready=${arg2}`;
    case AUDIO_DEBUG_EVENT.SPEAKER_ROUTE:
      return `${prefix} [Audio] ROUTE: speaker ${arg0 === 1 ? 'enabled' : 'disabled'} volume=${arg1}% quiet=${arg2 === 1 ? 'true' : 'false'} headset=${arg3 === 1 ? 'true' : 'false'} source=${routeSourceLabel(arg4)}`;
    case AUDIO_DEBUG_EVENT.QUIET_MODE:
      return `${prefix} [Audio] QUIET: ${arg0 === 1 ? 'enabled' : 'disabled'} audio_fifo=${arg1} opus_fifo=${arg2}`;
    case AUDIO_DEBUG_EVENT.SILENCE_PREROLL:
      return `${prefix} [Audio] PREROLL: encoded silence requested=${arg0} queued=${arg1} opus_fifo=${arg2} skip=${arg3}`;
    case AUDIO_DEBUG_EVENT.USB_SILENCE_TAIL:
      return `${prefix} [Audio] TAIL: forwarding USB silence frames=${arg0} audio_fifo=${arg1} opus_ready=${arg2} packet=${arg3} reportSeq=${arg4}`;
    case AUDIO_DEBUG_EVENT.HOST_MODE:
      return `${prefix} [HostPico] MODE runtime=${arg0} reason=${arg1} generation=${arg2}`;
    case AUDIO_DEBUG_EVENT.HOST_FRAME:
      if (arg0 === 0xfe || arg0 === 0xfd) {
        const transport = arg0 === 0xfe ? 'fast' : 'chunked';
        return `${prefix} [HostPico] FRAME incomplete-${transport} sequence=${arg1} mask=${hexByte(arg2)} chunks=${arg3} expected=${limitedByte(arg4)}`;
      }
      return `${prefix} [HostPico] FRAME submitted audio_fifo=${arg0} received=${arg1} generation=${arg2} packet=${arg3} reportSeq=${arg4}`;
    case AUDIO_DEBUG_EVENT.MIC_PACKET:
      return formatMicDebugEvent(prefix, event.args);
    case AUDIO_DEBUG_EVENT.USB_EVENT:
      return formatUsbDebugEvent(prefix, event.args);
    case AUDIO_DEBUG_EVENT.HID_EVENT:
      return formatHidDebugEvent(prefix, event.args);
    case AUDIO_DEBUG_EVENT.BT_EVENT:
      return formatBtDebugEvent(prefix, event.args);
    default:
      return `${prefix} [Audio] UNKNOWN code=${event.eventCode} args=${event.args.join(',')}`;
  }
}

function formatAudioStats(stats: AudioDebugStatsPayload): string {
  return [
    '[AudioStats]',
    `version=${stats.statsVersion}`,
    `usbAudioGapMaxUs=${stats.usbAudioGapMaxUs}`,
    `usbAudioGapOver1500Count=${stats.usbAudioGapOver1500Count}`,
    `opusEncodeMaxUs=${stats.opusEncodeMaxUs}`,
    `opusEncodeOverBudgetCount=${stats.opusEncodeOverBudgetCount}`,
    `audio0x36EnqueueToSendMaxUs=${stats.audio0x36EnqueueToSendMaxUs}`,
    `audio0x36SendGapMaxUs=${stats.audio0x36SendGapMaxUs}`,
    `audio0x36LateCountOver12000Us=${stats.audio0x36LateCountOver12000Us}`,
    `audio0x36DropOldestCount=${stats.audio0x36DropOldestCount}`,
    `audioGenerationDropCount=${stats.audioGenerationDropCount}`,
    `nonAudioReportsBetweenAudioMax=${stats.nonAudioReportsBetweenAudioMax}`,
    `btAudioQueueDepthMax=${stats.btAudioQueueDepthMax}`,
    `audio0x36EnqueuedCount=${stats.audio0x36EnqueuedCount}`,
    `audio0x36SentCount=${stats.audio0x36SentCount}`,
    `criticalStarvingAudioCount=${stats.criticalStarvingAudioCount}`
  ].join(' ');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class BridgeService extends EventEmitter {
  private device: HID.HID | null = null;
  private devicePath: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private hostAudioHeartbeatTimer: NodeJS.Timeout | null = null;
  private readonly hostAudioEngine = new HostAudioEngine();
  private readonly micKeepaliveEngine = new MicKeepaliveEngine();
  private readonly hidDiscovery = new HidDiscoveryClient();
  private snapshot: BridgeSnapshot;
  private lastEmittedSnapshotSignature: string | null = null;
  private commandSequence = 0;
  private lastUptimeSeconds: number | null = null;
  private sessionKey: string | null = null;
  private sessionPath: string | null = null;
  private reappliedSessionKey: string | null = null;
  private controllerConnectedSince = 0;
  private reapplyAttempt = 0;
  private nextReapplyAt = 0;
  private reapplyActive = false;
  private pollPausedUntil = 0;
  private readonly audioDebugLogPath: string | null = null;
  private audioDebugLogLines: string[] = [];
  private audioDebugDroppedCount = 0;
  private audioDebugStats: AudioDebugStatsPayload | null = null;
  private hostAudioStatus: HostAudioStatusPayload | null = null;
  private lastAudioStatsSignature: string | null = null;
  private hostAudioCommandActive = false;
  private hostAudioHeartbeatBusy = false;
  private hostAudioReportQueue: number[][] = [];
  private hostAudioWritePumpActive = false;
  private hostAudioFrameCount = 0;
  private hostAudioChunkWriteCount = 0;
  private hostAudioFrameDropCount = 0;
  private lastHostAudioStageLogAt = 0;
  private lastHostAudioStatusReadAt = 0;
  private lastAudioDebugReadAt = 0;
  private lastHostAudioActivePollAt = 0;
  private controllerPowerSavingActive: boolean | null = null;
  private previousControllerConnected: boolean | null = null;
  private lowBatteryToastActive = false;
  private volumeShortcutQueue: Promise<void> = Promise.resolve();
  private readonly shortcutActionHandlers: Record<ShortcutEvent, () => Promise<void>> = {
    [SHORTCUT_EVENT.CONTROLLER_VOLUME_DOWN]: () => this.applyControllerVolumeShortcut(-10),
    [SHORTCUT_EVENT.CONTROLLER_VOLUME_UP]: () => this.applyControllerVolumeShortcut(10),
    [SHORTCUT_EVENT.SLEEP_CONTROLLER]: () => this.applySleepShortcut()
  };

  constructor(private readonly settingsStore: SettingsStore) {
    super();
    this.snapshot = {
      state: 'no-bridge',
      message: 'No bridge detected',
      status: null,
      settings: this.settingsStore.get(),
      diagnostics: this.withAudioDebugDiagnostics(emptyDiagnostics([]))
    };
    this.hostAudioEngine.on('frame', (frame: HostAudioFramePayload) => this.sendHostAudioFrame(frame));
    this.hostAudioEngine.on('error', (error: Error) => this.publishError(error));
    this.hostAudioEngine.on('status', (line: string) => {
      if (line) {
        this.appendAudioDebugLines([`[HostHelper] ${line}`]);
      }
      this.emitSnapshot();
    });
    this.micKeepaliveEngine.on('error', (error: Error) => {
      this.appendAudioDebugLines([`[MicKeepalive] error: ${error.message}`]);
      this.emitSnapshot();
    });
    this.micKeepaliveEngine.on('status', (line: string) => {
      if (line) {
        this.appendAudioDebugLines([`[MicKeepalive] ${line}`]);
      }
      this.emitSnapshot();
    });
  }

  private readonly handleCompanionInputData = (data: Buffer | number[]): void => {
    const event = parseShortcutEvent(data);
    if (event === null) {
      return;
    }
    this.volumeShortcutQueue = this.volumeShortcutQueue
      .catch(() => {
        // Keep later shortcut events alive after a failed command.
      })
      .then(() => this.dispatchShortcutAction(event));
  };

  private readonly handleCompanionDeviceError = (error: Error): void => {
    if (!isExpectedHidDisconnectError(error)) {
      this.publishError(error);
      return;
    }

    this.closeDevice();
    this.markBridgeUnavailableAfterDisconnect([]);
    this.emitSnapshot();
  };

  start(): void {
    this.poll().catch((error) => this.publishError(error));
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => this.publishError(error));
    }, POLL_INTERVAL_MS);
    this.hostAudioHeartbeatTimer = setInterval(() => {
      this.pulseHostAudio().catch((error) => this.publishError(error));
    }, HOST_AUDIO_HEARTBEAT_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.hostAudioHeartbeatTimer) {
      clearInterval(this.hostAudioHeartbeatTimer);
      this.hostAudioHeartbeatTimer = null;
    }

    if (this.device) {
      try {
        await this.stopHostAudioSession(false);
      } catch (error) {
        this.publishError(error);
      }
    }
    await this.hostAudioEngine.stop();
    await this.micKeepaliveEngine.stop();
    this.hidDiscovery.stop();
    this.closeDevice();
  }

  getSnapshot(): BridgeSnapshot {
    return structuredClone(this.snapshot);
  }

  listDevices(): Promise<HidDeviceSummary[]> {
    return this.hidDiscovery.listDevices();
  }

  pausePollingFor(milliseconds: number): void {
    this.pollPausedUntil = Math.max(this.pollPausedUntil, Date.now() + milliseconds);
  }

  private withAudioDebugDiagnostics(diagnostics: BridgeDiagnosticsWithoutAudioLog): BridgeDiagnostics {
    return {
      ...diagnostics,
      audioDebugLogPath: this.audioDebugLogPath,
      audioDebugLogLines: [...this.audioDebugLogLines],
      audioDebugDroppedCount: this.audioDebugDroppedCount,
      audioDebugStats: this.audioDebugStats ? { ...this.audioDebugStats } : null,
      hostAudioStatus: this.hostAudioStatus ? { ...this.hostAudioStatus } : null
    };
  }

  private appendAudioDebugLines(lines: string[]): void {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (lines.length === 0) {
      return;
    }

    this.audioDebugLogLines.push(...lines);
    if (this.audioDebugLogLines.length > AUDIO_DEBUG_LOG_LINE_LIMIT) {
      this.audioDebugLogLines = this.audioDebugLogLines.slice(-AUDIO_DEBUG_LOG_LINE_LIMIT);
    }
    this.snapshot = {
      ...this.snapshot,
      diagnostics: this.withAudioDebugDiagnostics(this.snapshot.diagnostics)
    };
  }

  private readAudioDebugEvents(): void {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (!this.device) {
      return;
    }

    try {
      const debug = parseAudioDebugReport(this.device.getFeatureReport(REPORT_ID.AUDIO_DEBUG, REPORT_LENGTH));
      this.audioDebugDroppedCount = debug.droppedCount;
      this.appendAudioDebugLines(debug.events.map(formatAudioDebugEvent));
    } catch {
      // Keep diagnostics best-effort so normal status polling is not blocked.
    }
  }

  private readAudioDebugStats(): void {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (!this.device) {
      return;
    }

    try {
      const stats = parseAudioStatsReport(this.device.getFeatureReport(REPORT_ID.AUDIO_STATS, REPORT_LENGTH));
      this.audioDebugStats = stats;
      const signature = JSON.stringify(stats);
      if (signature !== this.lastAudioStatsSignature) {
        this.lastAudioStatsSignature = signature;
        this.appendAudioDebugLines([formatAudioStats(stats)]);
      }
    } catch {
      // Keep diagnostics best-effort so normal status polling is not blocked.
    }
  }

  private readAudioDebugThrottled(force = false): void {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastAudioDebugReadAt < AUDIO_DEBUG_READ_INTERVAL_MS) {
      return;
    }
    this.lastAudioDebugReadAt = now;
    this.readAudioDebugEvents();
    this.readAudioDebugStats();
  }

  private readHostAudioStatus(): void {
    if (!this.device) {
      this.hostAudioStatus = null;
      return;
    }

    try {
      this.hostAudioStatus = parseHostAudioStatusReport(
        this.device.getFeatureReport(REPORT_ID.HOST_AUDIO_STATUS, REPORT_LENGTH)
      );
      this.lastHostAudioStatusReadAt = Date.now();
    } catch {
      this.hostAudioStatus = null;
    }
  }

  private readHostAudioStatusThrottled(force = false, intervalMs = HOST_AUDIO_STATUS_READ_INTERVAL_MS): void {
    if (!force && Date.now() - this.lastHostAudioStatusReadAt < intervalMs) {
      return;
    }
    this.readHostAudioStatus();
  }

  private isControllerPowerSavingActive(settings: CompanionSettings): boolean {
    return settings.controllerPowerSavingEnabled && Boolean(this.hostAudioStatus?.headsetPlugged);
  }

  private capForControllerPowerSaving(value: number, settings: CompanionSettings): number {
    return this.isControllerPowerSavingActive(settings)
      ? Math.min(value, CONTROLLER_POWER_SAVING_CAP_PERCENT)
      : value;
  }

  private effectiveHapticsGain(settings: CompanionSettings): number {
    return settings.hapticsEnabled
      ? this.capForControllerPowerSaving(settings.hapticsGainPercent, settings)
      : 0;
  }

  private effectiveClassicRumbleGain(settings: CompanionSettings): number {
    return settings.classicRumbleEnabled
      ? this.capForControllerPowerSaving(settings.classicRumbleGainPercent, settings)
      : 0;
  }

  private effectiveTriggerEffectIntensity(settings: CompanionSettings): number {
    return settings.adaptiveTriggersEnabled
      ? this.capForControllerPowerSaving(settings.triggerEffectIntensityPercent, settings)
      : 0;
  }

  private effectiveLightbarBrightness(settings: CompanionSettings): number {
    return settings.lightbarEnabled
      ? this.capForControllerPowerSaving(settings.lightbarBrightnessPercent, settings)
      : 0;
  }

  private async applyControllerPowerSavingSensitiveSettings(
    settings: CompanionSettings,
    expectSettingsRevisionChange: boolean
  ): Promise<void> {
    await this.sendCommand(COMMAND_ID.SET_HAPTICS_GAIN, this.effectiveHapticsGain(settings), {
      expectSettingsRevisionChange
    });
    await this.sendCommand(COMMAND_ID.SET_CLASSIC_RUMBLE_GAIN, this.effectiveClassicRumbleGain(settings), {
      expectSettingsRevisionChange
    });
    await this.sendCommand(COMMAND_ID.SET_TRIGGER_EFFECT_INTENSITY, this.effectiveTriggerEffectIntensity(settings), {
      expectSettingsRevisionChange
    });
    await this.applyLightbarSettings(settings, expectSettingsRevisionChange);
  }

  private async syncControllerPowerSavingState(settings: CompanionSettings): Promise<void> {
    const active = this.isControllerPowerSavingActive(settings);
    if (this.controllerPowerSavingActive === active) {
      return;
    }
    const previousActive = this.controllerPowerSavingActive;
    this.controllerPowerSavingActive = active;
    if (previousActive === null || this.reapplyActive || this.snapshot.state !== 'connected') {
      return;
    }
    await this.applyControllerPowerSavingSensitiveSettings(settings, true);
    this.emitSnapshot();
  }

  async setHapticsGain(percent: number): Promise<BridgeSnapshot> {
    const value = Math.max(0, Math.min(200, Math.round(percent)));
    const nextSettings = { ...this.settingsStore.get(), hapticsGainPercent: value };
    const effectiveValue = this.effectiveHapticsGain(nextSettings);
    await this.sendSettingCommand(COMMAND_ID.SET_HAPTICS_GAIN, effectiveValue, customSettingUpdate({
      hapticsGainPercent: value
    }));
    return this.getSnapshot();
  }

  async setHapticsEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const settings = { ...this.settingsStore.get(), hapticsEnabled: enabled };
    await this.sendSettingCommand(COMMAND_ID.SET_HAPTICS_GAIN, this.effectiveHapticsGain(settings), customSettingUpdate({
      hapticsEnabled: enabled
    }));
    return this.getSnapshot();
  }

  async setHapticsBufferLength(length: number): Promise<BridgeSnapshot> {
    const value = Math.max(1, Math.min(255, Math.round(length)));
    await this.sendSettingCommand(COMMAND_ID.SET_HAPTICS_BUFFER_LENGTH, value, { hapticsBufferLength: value });
    return this.getSnapshot();
  }

  async setClassicRumbleGain(percent: number): Promise<BridgeSnapshot> {
    const value = Math.max(0, Math.min(200, Math.round(percent)));
    const nextSettings = { ...this.settingsStore.get(), classicRumbleGainPercent: value };
    const effectiveValue = this.effectiveClassicRumbleGain(nextSettings);
    await this.sendSettingCommand(COMMAND_ID.SET_CLASSIC_RUMBLE_GAIN, effectiveValue, customSettingUpdate({
      classicRumbleGainPercent: value
    }));
    return this.getSnapshot();
  }

  async setClassicRumbleEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const settings = { ...this.settingsStore.get(), classicRumbleEnabled: enabled };
    await this.sendSettingCommand(
      COMMAND_ID.SET_CLASSIC_RUMBLE_GAIN,
      this.effectiveClassicRumbleGain(settings),
      customSettingUpdate({ classicRumbleEnabled: enabled })
    );
    return this.getSnapshot();
  }

  async setTriggerEffectIntensity(percent: number): Promise<BridgeSnapshot> {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    const nextSettings = { ...this.settingsStore.get(), triggerEffectIntensityPercent: value };
    const effectiveValue = this.effectiveTriggerEffectIntensity(nextSettings);
    await this.sendSettingCommand(COMMAND_ID.SET_TRIGGER_EFFECT_INTENSITY, effectiveValue, customSettingUpdate({
      triggerEffectIntensityPercent: value
    }));
    return this.getSnapshot();
  }

  async setTriggerTestMode(mode: TriggerTestMode): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({ triggerTestMode: mode }));
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setAdaptiveTriggersEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const settings = { ...this.settingsStore.get(), adaptiveTriggersEnabled: enabled };
    await this.sendSettingCommand(
      COMMAND_ID.SET_TRIGGER_EFFECT_INTENSITY,
      this.effectiveTriggerEffectIntensity(settings),
      customSettingUpdate({ adaptiveTriggersEnabled: enabled })
    );
    if (!enabled && this.snapshot.state === 'connected') {
      await this.sendCommand(COMMAND_ID.RESET_ADAPTIVE_TRIGGERS, 0, { throwOnCommandError: false });
    }
    return this.getSnapshot();
  }

  async setSpeakerVolume(percent: number): Promise<BridgeSnapshot> {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    const settings = this.settingsStore.get();
    if (settings.speakerEnabled) {
      await this.setFirmwareSpeakerVolume(value, true);
    }
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      speakerVolumePercent: value
    }));
    if (this.snapshot.status) {
      this.snapshot.status.speakerVolumePercent = value;
    }
    await this.updateHostAudioEngine();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setSpeakerEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const settings = this.settingsStore.get();
    await this.setFirmwareSpeakerVolume(enabled ? settings.speakerVolumePercent : 0, true);
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      speakerEnabled: enabled
    }));
    await this.updateHostAudioEngine();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setMicVolume(percent: number): Promise<BridgeSnapshot> {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    await this.sendCommand(COMMAND_ID.SET_MIC_VOLUME, value, {
      expectSettingsRevisionChange: true
    });
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      micVolumePercent: value
    }));
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setMicMute(enabled: boolean): Promise<BridgeSnapshot> {
    await this.sendCommand(COMMAND_ID.SET_MIC_MUTE, enabled ? 1 : 0, {
      expectSettingsRevisionChange: true
    });
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      micMuted: enabled
    }));
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setHostEncodedAudioEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const settings = this.settingsStore.get();
    if (enabled) {
      await this.applyMicSettings(settings, false);
      await this.startHostAudioSession(true);
    } else {
      await this.stopHostAudioSession(true);
    }
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      hostEncodedAudioEnabled: enabled,
      duplexMicEnabled: enabled ? this.snapshot.settings.duplexMicEnabled : false
    }));
    this.readHostAudioStatus();
    await this.updateHostAudioEngine();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setDuplexMicEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const hostEncodedAudioEnabled = this.settingsStore.get().hostEncodedAudioEnabled;
    const nextEnabled = enabled && hostEncodedAudioEnabled;
    if (!nextEnabled) {
      await this.sendCommand(COMMAND_ID.SET_MIC_MUTE, 1, {
        expectSettingsRevisionChange: true
      });
    }
    await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, nextEnabled ? 1 : 0, {
      expectSettingsRevisionChange: true
    });
    if (nextEnabled) {
      await this.sendCommand(COMMAND_ID.SET_MIC_MUTE, 0, {
        expectSettingsRevisionChange: true
      });
    }
    this.sendHostAudioStreamReport(
      nextEnabled ? HOST_AUDIO_PACKET_TYPE.SET_DUPLEX_ENABLED : HOST_AUDIO_PACKET_TYPE.SET_DUPLEX_DISABLED
    );
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      duplexMicEnabled: nextEnabled,
      micMuted: !nextEnabled
    }));
    if (nextEnabled) {
      await this.updateMicKeepaliveEngine(Boolean(this.snapshot.status?.controllerConnected));
    } else {
      await this.micKeepaliveEngine.stop();
    }
    this.readHostAudioStatus();
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setLightbarColor(color: string, brightnessPercent: number): Promise<BridgeSnapshot> {
    const parsed = parseHexColor(color);
    const brightness = Math.max(0, Math.min(100, Math.round(brightnessPercent)));
    const nextSettings = {
      ...this.settingsStore.get(),
      lightbarColor: parsed.hex,
      lightbarBrightnessPercent: brightness
    };
    const effectiveBrightness = this.effectiveLightbarBrightness(nextSettings);
    const ack = await this.sendCommand(COMMAND_ID.SET_LIGHTBAR_COLOR, effectiveBrightness, {
      expectSettingsRevisionChange: true,
      extraPayload: [parsed.red, parsed.green, parsed.blue]
    });
    if (ack.resultCode === ACK_RESULT.OK) {
      this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
        lightbarColor: parsed.hex,
        lightbarBrightnessPercent: brightness
      }));
      if (this.snapshot.status) {
        this.snapshot.status.lightbarColor = {
          red: parsed.red,
          green: parsed.green,
          blue: parsed.blue,
          brightnessPercent: effectiveBrightness
        };
      }
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  async setLightbarOverrideEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const ack = await this.sendCommand(COMMAND_ID.SET_LIGHTBAR_OVERRIDE, enabled ? 1 : 0, {
      expectSettingsRevisionChange: true
    });
    if (ack.resultCode === ACK_RESULT.OK) {
      this.snapshot.settings = this.settingsStore.update(customSettingUpdate({ lightbarOverrideEnabled: enabled }));
      if (this.snapshot.status) {
        this.snapshot.status.lightbarOverrideEnabled = enabled;
      }
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  async setLightbarEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({ lightbarEnabled: enabled }));
    if (this.snapshot.state === 'connected') {
      await this.applyLightbarSettings(this.snapshot.settings, true);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setMuteButtonAction(
    mode: MuteButtonMode,
    usage: number,
    modifiers: number,
    behavior: MuteKeyboardBehavior
  ): Promise<BridgeSnapshot> {
    const keyUsage = Math.max(1, Math.min(0x73, Math.round(usage)));
    const keyModifiers = Math.max(0, Math.min(MUTE_KEYBOARD_MODIFIER_MASK, Math.round(modifiers)));
    const keyOptions = encodeMuteKeyboardOptions(keyModifiers, behavior);
    const ack = await this.sendCommand(COMMAND_ID.SET_MUTE_BUTTON_ACTION, muteButtonModeValue(mode), {
      expectSettingsRevisionChange: true,
      extraPayload: [keyUsage, keyOptions]
    });
    if (ack.resultCode === ACK_RESULT.OK) {
      this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
        muteButtonMode: mode,
        muteKeyboardUsage: keyUsage,
        muteKeyboardModifiers: keyModifiers,
        muteKeyboardBehavior: behavior
      }));
      if (this.snapshot.status) {
        this.snapshot.status.muteButtonMode = mode;
        this.snapshot.status.muteKeyboardUsage = keyUsage;
        this.snapshot.status.muteKeyboardModifiers = keyModifiers;
        this.snapshot.status.muteKeyboardBehavior = behavior;
      }
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  async setLedEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    await this.sendSettingCommand(COMMAND_ID.SET_LED_ENABLED, enabled ? 1 : 0, { ledEnabled: enabled });
    return this.getSnapshot();
  }

  async setIdleDisconnectEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    await this.sendSettingCommand(COMMAND_ID.SET_IDLE_DISCONNECT_ENABLED, enabled ? 1 : 0, {
      idleDisconnectEnabled: enabled
    });
    return this.getSnapshot();
  }

  private async dispatchShortcutAction(event: ShortcutEvent): Promise<void> {
    await this.shortcutActionHandlers[event]();
  }

  private async applyControllerVolumeShortcut(deltaPercent: number): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.speakerVolumeShortcutEnabled || !settings.speakerEnabled) {
      return;
    }

    const nextVolume = Math.max(0, Math.min(100, settings.speakerVolumePercent + deltaPercent));
    if (nextVolume === settings.speakerVolumePercent) {
      return;
    }

    await this.setSpeakerVolume(nextVolume);
  }

  private async applySleepShortcut(): Promise<void> {
    if (!this.settingsStore.get().sleepKeybindEnabled) {
      return;
    }
    await this.sleepController();
  }

  async setIdleDisconnectTimeoutMinutes(minutes: number): Promise<BridgeSnapshot> {
    const value = normalizeIdleDisconnectTimeoutMinutes(minutes);
    await this.sendSettingCommand(COMMAND_ID.SET_IDLE_DISCONNECT_TIMEOUT, value, {
      idleDisconnectTimeoutMinutes: value
    });
    return this.getSnapshot();
  }

  async setUsbSuspendDisconnectEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    await this.sendSettingCommand(COMMAND_ID.SET_USB_SUSPEND_DISCONNECT_ENABLED, enabled ? 1 : 0, {
      usbSuspendDisconnectEnabled: enabled
    });
    if (this.snapshot.status) {
      this.snapshot.status.usbSuspendDisconnectEnabled = enabled;
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  async setSleepKeybindEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    await this.sendSettingCommand(COMMAND_ID.SET_SLEEP_KEYBIND_ENABLED, enabled ? 1 : 0, {
      sleepKeybindEnabled: enabled
    });
    if (this.snapshot.status) {
      this.snapshot.status.sleepKeybindEnabled = enabled;
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  async setSpeakerVolumeShortcutEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    await this.sendSettingCommand(COMMAND_ID.SET_SPEAKER_VOLUME_SHORTCUT_ENABLED, enabled ? 1 : 0, {
      speakerVolumeShortcutEnabled: enabled
    });
    return this.getSnapshot();
  }

  async setControllerPowerSavingEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.update({ controllerPowerSavingEnabled: enabled });
    if (this.snapshot.state === 'connected') {
      const wasActive = this.controllerPowerSavingActive;
      this.controllerPowerSavingActive = this.isControllerPowerSavingActive(this.snapshot.settings);
      if (wasActive !== this.controllerPowerSavingActive) {
        await this.applyControllerPowerSavingSensitiveSettings(this.snapshot.settings, true);
      }
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  setUiScalePercent(value: UiScalePercent): BridgeSnapshot {
    this.snapshot.settings = this.settingsStore.update({
      uiScalePercent: normalizeUiScalePercent(value)
    });
    this.emitSnapshot();
    return this.getSnapshot();
  }

  setLaunchAtStartupEnabled(enabled: boolean): BridgeSnapshot {
    this.snapshot.settings = this.settingsStore.update({
      launchAtStartupEnabled: enabled
    });
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setPollingRateMode(mode: PollingRateMode): Promise<BridgeSnapshot> {
    const normalizedMode = normalizePollingRateMode(mode);
    await this.sendSettingCommand(
      COMMAND_ID.SET_POLLING_RATE_MODE,
      pollingRateModeValue(normalizedMode),
      { pollingRateMode: normalizedMode }
    );
    return this.getSnapshot();
  }

  async sleepController(): Promise<BridgeSnapshot> {
    await this.sendCommand(COMMAND_ID.SLEEP_CONTROLLER, 0, {
      throwOnCommandError: false
    });
    return this.getSnapshot();
  }

  async setNotifyControllerConnection(enabled: boolean): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.update({ notifyControllerConnection: enabled });
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setNotifyLowBattery(enabled: boolean): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.update({ notifyLowBattery: enabled });
    this.lowBatteryToastActive = false;
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async testNotification(): Promise<BridgeSnapshot> {
    this.emit('toast', {
      title: 'DS5 Bridge',
      body: 'Notifications are working.'
    } satisfies BridgeToast);
    return this.getSnapshot();
  }

  async testHaptics(): Promise<BridgeSnapshot> {
    await this.sendCommand(COMMAND_ID.TEST_HAPTICS, 0, { throwOnCommandError: false });
    return this.getSnapshot();
  }

  async testSpeaker(): Promise<BridgeSnapshot> {
    await playHostAudioTestTone(this.settingsStore.get().speakerVolumePercent);
    return this.getSnapshot();
  }

  async testClassicRumble(): Promise<BridgeSnapshot> {
    await this.sendCommand(COMMAND_ID.TEST_CLASSIC_RUMBLE, 0, { throwOnCommandError: false });
    return this.getSnapshot();
  }

  async testAdaptiveTriggers(
    mode = this.settingsStore.get().triggerTestMode,
    target: TriggerTestTarget = 'both'
  ): Promise<BridgeSnapshot> {
    const value = triggerTestModeValue(mode) | (triggerTestTargetValue(target) << 8);
    await this.sendCommand(COMMAND_ID.TEST_ADAPTIVE_TRIGGERS, value, {
      throwOnCommandError: false
    });
    return this.getSnapshot();
  }

  async resetAdaptiveTriggers(): Promise<BridgeSnapshot> {
    await this.sendCommand(COMMAND_ID.RESET_ADAPTIVE_TRIGGERS, 0, { throwOnCommandError: false });
    return this.getSnapshot();
  }

  async restoreDefaults(): Promise<BridgeSnapshot> {
    const ack = await this.sendCommand(COMMAND_ID.RESTORE_DEFAULTS, 0, { expectSettingsRevisionChange: true });
    if (ack.resultCode === ACK_RESULT.OK) {
      this.snapshot.settings = this.settingsStore.restoreDefaults();
      this.emitSnapshot();
    }
    return this.getSnapshot();
  }

  async applyPreset(presetId: BridgePresetId): Promise<BridgeSnapshot> {
    const normalizedPresetId = normalizeBridgePresetId(presetId);
    this.snapshot.settings = this.settingsStore.applyPreset(
      normalizedPresetId,
      normalizedPresetId === 'custom' ? undefined : PRESET_SETTINGS[normalizedPresetId]
    );
    if (this.snapshot.state === 'connected') {
      await this.applyCurrentSettings(this.snapshot.settings, false);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async selectControllerProfile(profileId: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.selectControllerProfile(profileId);
    if (this.snapshot.state === 'connected') {
      await this.applyCurrentSettings(this.snapshot.settings, false);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async saveControllerProfile(name?: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.saveControllerProfile(name);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async updateControllerProfile(profileId: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.updateControllerProfile(profileId);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async renameControllerProfile(profileId: string, name: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.renameControllerProfile(profileId, name);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async deleteControllerProfile(profileId: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.deleteControllerProfile(profileId);
    if (this.snapshot.state === 'connected') {
      await this.applyCurrentSettings(this.snapshot.settings, false);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setButtonRemap(buttonId: RemapButtonId, targetId: RemapButtonId): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.setButtonRemap(buttonId, targetId);
    if (this.snapshot.state === 'connected') {
      await this.applyButtonRemapping(this.snapshot.settings, true);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async selectButtonRemappingProfile(profileId: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.selectButtonRemappingProfile(profileId);
    if (this.snapshot.state === 'connected') {
      await this.applyButtonRemapping(this.snapshot.settings, true);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async saveButtonRemappingProfile(name?: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.saveButtonRemappingProfile(name);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async updateButtonRemappingProfile(profileId: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.updateButtonRemappingProfile(profileId);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async renameButtonRemappingProfile(profileId: string, name: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.renameButtonRemappingProfile(profileId, name);
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async deleteButtonRemappingProfile(profileId: string): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.deleteButtonRemappingProfile(profileId);
    if (this.snapshot.state === 'connected') {
      await this.applyButtonRemapping(this.snapshot.settings, true);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async restoreButtonRemappingDefaults(): Promise<BridgeSnapshot> {
    this.snapshot.settings = this.settingsStore.restoreButtonRemappingDefaults();
    if (this.snapshot.state === 'connected') {
      await this.applyButtonRemapping(this.snapshot.settings, true);
    }
    this.emitSnapshot();
    return this.getSnapshot();
  }

  private async applyButtonRemapping(
    settings: CompanionSettings,
    expectSettingsRevisionChange: boolean
  ): Promise<void> {
    await this.sendCommand(COMMAND_ID.SET_BUTTON_REMAP, 0, {
      expectSettingsRevisionChange,
      extraPayload: buildButtonRemapPayload(settings.buttonRemappingDraft)
    });
  }

  private async sendSettingCommand(
    commandId: number,
    value: number,
    settingUpdate: Partial<CompanionSettings>
  ): Promise<void> {
    const ack = await this.sendCommand(commandId, value, { expectSettingsRevisionChange: true });
    if (ack.resultCode === ACK_RESULT.OK) {
      this.snapshot.settings = this.settingsStore.update(settingUpdate);
      this.emitSnapshot();
    }
  }

  private async sendCommand(commandId: number, value: number, options: CommandOptions = {}) {
    await this.ensureCompanionDevice();
    if (!this.device) {
      throw new Error('No companion bridge is connected.');
    }

    const sequence = this.nextSequence();
    const previousSettingsRevision = this.snapshot.diagnostics.settingsRevision;
    this.device.sendFeatureReport(buildCommandReport(commandId, sequence, value, options.extraPayload));
    const ack = parseAckReport(this.device.getFeatureReport(REPORT_ID.ACK, REPORT_LENGTH));
    this.snapshot.diagnostics.lastAck = ack;
    this.snapshot.diagnostics.settingsRevision = ack.settingsRevision;
    this.snapshot.diagnostics.lastError = ack.resultCode === ACK_RESULT.OK ? null : ackUserMessage(ack.resultCode);
    this.emitSnapshot();

    if (ack.resultCode !== ACK_RESULT.OK) {
      if (options.throwOnCommandError === false) {
        return ack;
      }
      throw new Error(ackUserMessage(ack.resultCode));
    }
    if (
      options.expectSettingsRevisionChange
      && previousSettingsRevision !== null
      && ack.settingsRevision === previousSettingsRevision
    ) {
      const message = 'Firmware accepted the setting but did not advance settings_revision.';
      this.snapshot.diagnostics.lastError = message;
      this.emitSnapshot();
      throw new Error(message);
    }
    return ack;
  }

  private writeHostAudioStreamReport(report: number[]): boolean {
    if (!this.device) {
      return false;
    }
    try {
      this.device.write(report);
      return true;
    } catch {
      // Older firmware exposes only feature reports. The status path will show
      // fallback if the interrupt OUT stream is unavailable.
      return false;
    }
  }

  private sendHostAudioStreamReport(packetType: number): boolean {
    return this.writeHostAudioStreamReport(buildHostAudioStreamReport({ packetType }));
  }

  private sendHostAudioFrame(payload: HostAudioFramePayload): void {
    const settings = this.settingsStore.get();
    if (
      !settings.hostEncodedAudioEnabled
      || !this.device
      || !this.hostAudioCommandActive
    ) {
      return;
    }

    const reports = buildHostAudioFastFrameReports({
      frame: payload.frame,
      frameSequence: payload.sequence
    });

    this.hostAudioFrameCount++;
    if (this.hostAudioReportQueue.length >= reports.length * HOST_AUDIO_MAX_QUEUED_FRAMES) {
      this.hostAudioReportQueue.splice(0, reports.length);
      this.hostAudioFrameDropCount++;
    }
    this.hostAudioReportQueue.push(...reports);
    this.logHostAudioStage('enqueue');
    this.pumpHostAudioReports();
  }

  private pumpHostAudioReports(): void {
    if (this.hostAudioWritePumpActive) {
      return;
    }
    this.hostAudioWritePumpActive = true;
    const pump = () => {
      const report = this.hostAudioReportQueue.shift();
      if (!report) {
        this.hostAudioWritePumpActive = false;
        return;
      }
      if (!this.writeHostAudioStreamReport(report)) {
        this.hostAudioReportQueue = [];
        this.hostAudioWritePumpActive = false;
        this.hostAudioCommandActive = false;
        this.logHostAudioStage('write-failed');
        return;
      }
      this.hostAudioChunkWriteCount++;
      this.logHostAudioStage('write');
      setImmediate(pump);
    };
    setImmediate(pump);
  }

  private logHostAudioStage(stage: string): void {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    const now = Date.now();
    if (stage !== 'write-failed' && now - this.lastHostAudioStageLogAt < 1000) {
      return;
    }
    this.lastHostAudioStageLogAt = now;
    const picoReceived = this.hostAudioStatus?.hostFramesReceived ?? 0;
    const picoDropped = this.hostAudioStatus?.hostFramesDropped ?? 0;
    this.appendAudioDebugLines([
      `[HostBridge] stage=${stage} helperFrames=${this.hostAudioFrameCount} chunksWritten=${this.hostAudioChunkWriteCount} queuedChunks=${this.hostAudioReportQueue.length} appDroppedFrames=${this.hostAudioFrameDropCount} picoReceivedFrames=${picoReceived} picoDroppedFrames=${picoDropped} generation=${this.hostAudioStatus?.streamGeneration ?? 0}`
    ]);
  }

  private async updateHostAudioEngine(): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.hostEncodedAudioEnabled || !this.device || !this.hostAudioCommandActive) {
      this.clearHostAudioReportQueue();
      await this.hostAudioEngine.stop();
      return;
    }
    await this.hostAudioEngine.start(this.devicePath, settings.speakerEnabled ? settings.speakerVolumePercent : 0);
  }

  private async startHostAudioSession(expectSettingsRevisionChange: boolean): Promise<void> {
    const settings = this.settingsStore.get();
    const speakerVolumePercent = settings.speakerEnabled ? settings.speakerVolumePercent : 0;
    const duplexEnabled = settings.duplexMicEnabled;
    if (this.hostAudioCommandActive) {
      await this.hostAudioEngine.start(this.devicePath, speakerVolumePercent);
      this.readHostAudioStatus();
      return;
    }

    this.clearHostAudioReportQueue();
    await this.sendCommand(COMMAND_ID.SET_HOST_AUDIO_ENABLED, 1, { expectSettingsRevisionChange });
    this.hostAudioCommandActive = true;
    await this.sendCommand(COMMAND_ID.START_HOST_AUDIO, 0, { throwOnCommandError: false });
    await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, duplexEnabled ? 1 : 0, { throwOnCommandError: false });
    await this.sendCommand(COMMAND_ID.HOST_AUDIO_HEARTBEAT, 0, { throwOnCommandError: false });
    this.sendHostAudioStreamReport(HOST_AUDIO_PACKET_TYPE.HELLO);
    this.sendHostAudioStreamReport(
      duplexEnabled ? HOST_AUDIO_PACKET_TYPE.SET_DUPLEX_ENABLED : HOST_AUDIO_PACKET_TYPE.SET_DUPLEX_DISABLED
    );
    this.sendHostAudioStreamReport(HOST_AUDIO_PACKET_TYPE.HEARTBEAT);
    await this.hostAudioEngine.start(this.devicePath, speakerVolumePercent);
    this.readHostAudioStatus();
  }

  private async stopHostAudioSession(expectSettingsRevisionChange: boolean): Promise<void> {
    const wasHostAudioActive = this.hostAudioCommandActive;
    if (wasHostAudioActive) {
      await this.fadeOutHostAudioSpeaker();
    }
    this.clearHostAudioReportQueue();
    if (wasHostAudioActive) {
      await this.sendCommand(COMMAND_ID.STOP_HOST_AUDIO, 0, { throwOnCommandError: false });
    }
    await this.sendCommand(COMMAND_ID.SET_HOST_AUDIO_ENABLED, 0, { expectSettingsRevisionChange });
    await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, 0, { throwOnCommandError: false });
    this.hostAudioCommandActive = false;
    await this.hostAudioEngine.stop();
    await this.micKeepaliveEngine.stop();
    this.readHostAudioStatus();
  }

  private async fadeOutHostAudioSpeaker(): Promise<void> {
    if (!this.hostAudioEngine.isActive()) {
      return;
    }
    this.hostAudioEngine.setSpeakerVolumePercent(0);
    await delay(HOST_AUDIO_STOP_FADE_MS);
  }

  private clearHostAudioReportQueue(): void {
    this.hostAudioReportQueue = [];
  }

  private async updateMicKeepaliveEngine(controllerConnected: boolean): Promise<void> {
    try {
      const settings = this.settingsStore.get();
      const hostAudioActive = settings.hostEncodedAudioEnabled && this.hostAudioCommandActive;
      if (!controllerConnected || !hostAudioActive || !settings.duplexMicEnabled) {
        await this.micKeepaliveEngine.stop();
        return;
      }
      await this.micKeepaliveEngine.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendAudioDebugLines([`[MicKeepalive] error: ${message}`]);
    }
  }

  private async pulseHostAudio(): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.hostEncodedAudioEnabled || this.hostAudioHeartbeatBusy || this.reapplyActive) {
      return;
    }
    this.hostAudioHeartbeatBusy = true;
    try {
      await this.ensureCompanionDevice();
      if (!this.device) {
        this.hostAudioCommandActive = false;
        return;
      }
      const helperWasActive = this.hostAudioEngine.isActive();
      if (!helperWasActive) {
        this.readHostAudioStatusThrottled(!this.hostAudioCommandActive);
      }
      if (!this.hostAudioCommandActive || (!helperWasActive && this.hostAudioStatus?.streamActive === false)) {
        await this.sendCommand(COMMAND_ID.SET_HOST_AUDIO_ENABLED, 1, { throwOnCommandError: false });
        this.hostAudioCommandActive = true;
        await this.sendCommand(COMMAND_ID.START_HOST_AUDIO, 0, { throwOnCommandError: false });
        await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, settings.duplexMicEnabled ? 1 : 0, { throwOnCommandError: false });
        await this.updateHostAudioEngine();
        this.readHostAudioStatus();
      } else {
        await this.updateHostAudioEngine();
      }
      const helperIsActive = this.hostAudioEngine.isActive();
      if (!helperIsActive) {
        this.sendHostAudioStreamReport(HOST_AUDIO_PACKET_TYPE.HEARTBEAT);
      }
      if (this.hostAudioCommandActive) {
        await this.sendCommand(COMMAND_ID.HOST_AUDIO_HEARTBEAT, 0, { throwOnCommandError: false });
      }
      this.readHostAudioStatusThrottled(
        false,
        helperIsActive ? HOST_AUDIO_HELPER_STATUS_READ_INTERVAL_MS : HOST_AUDIO_STATUS_READ_INTERVAL_MS
      );
    } finally {
      this.hostAudioHeartbeatBusy = false;
    }
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    if (now < this.pollPausedUntil) {
      return;
    }
    const currentSettings = this.settingsStore.get();
    const hostAudioActive = currentSettings.hostEncodedAudioEnabled && this.hostAudioCommandActive;
    if (
      hostAudioActive
      && now - this.lastHostAudioActivePollAt < HOST_AUDIO_ACTIVE_POLL_INTERVAL_MS
    ) {
      return;
    }
    this.lastHostAudioActivePollAt = now;

    const rawDevices = await this.hidDiscovery.listDevices();
    const devices = rawDevices;
    const companionDevices = devices.filter(isCompanionCandidate);

    if (companionDevices.length === 0) {
      this.closeDevice();
      const normalFirmwarePresent = devices.some(isDualSenseDevice);
      this.markBridgeUnavailableAfterDisconnect(rawDevices, normalFirmwarePresent);
      this.emitSnapshot();
      return;
    }

    const status = await this.openAndReadStatus(companionDevices);
    if (!status) {
      this.noteControllerUnavailableForToasts();
      this.snapshot = {
        state: 'incompatible',
        message: FIRMWARE_UPDATE_REQUIRED_MESSAGE,
        status: null,
        settings: this.settingsStore.get(),
        diagnostics: this.withAudioDebugDiagnostics({
          ...emptyDiagnostics(rawDevices),
          hidPath: this.devicePath,
          lastError: 'No companion device returned a supported DS5B status report',
          lastPollAt: Date.now()
        })
      };
      this.emitSnapshot();
      return;
    }

    if (!isSupportedFirmwareVersion(status.firmwareVersion)) {
      this.noteControllerUnavailableForToasts();
      this.snapshot = {
        state: 'incompatible',
        message: FIRMWARE_UPDATE_REQUIRED_MESSAGE,
        status,
        settings: this.settingsStore.get(),
        diagnostics: this.withAudioDebugDiagnostics({
          hidPath: this.devicePath,
          protocolVersion: status.protocolVersion,
          uptimeSeconds: status.uptimeSeconds,
          settingsRevision: status.settingsRevision,
          lastAck: this.snapshot.diagnostics.lastAck,
          lastError: `Firmware ${status.firmwareVersion} is too old for this companion app. Update the bridge firmware to 1.0.1 or newer.`,
          lastPollAt: Date.now(),
          rawDevices
        })
      };
      this.emitSnapshot();
      return;
    }

    if (hostAudioActive) {
      this.readAudioDebugThrottled();
    }
    if (hostAudioActive && !this.hostAudioEngine.isActive()) {
      this.readHostAudioStatusThrottled();
    } else if (!hostAudioActive) {
      this.readAudioDebugThrottled(true);
      this.readHostAudioStatus();
    }
    this.maybeEmitStatusToasts(status);

    const previousUptime = this.lastUptimeSeconds;
    const isNewSession = this.sessionKey === null
      || this.sessionPath !== this.devicePath
      || (previousUptime !== null && status.uptimeSeconds < previousUptime)
      || previousUptime === null;

    if (isNewSession) {
      this.sessionKey = `${this.devicePath ?? 'unknown'}:${Date.now()}`;
      this.sessionPath = this.devicePath;
      this.resetStartupReapplyState();
    }
    this.lastUptimeSeconds = status.uptimeSeconds;

    const settings = this.settingsStore.get();

    this.snapshot = {
      state: 'connected',
      message: 'Companion firmware connected',
      status,
      settings: {
        ...settings,
        idleDisconnectTimeoutMinutes: status.idleDisconnectTimeoutMinutes
      },
      diagnostics: this.withAudioDebugDiagnostics({
        hidPath: this.devicePath,
        protocolVersion: status.protocolVersion,
        uptimeSeconds: status.uptimeSeconds,
        settingsRevision: status.settingsRevision,
        lastAck: this.snapshot.diagnostics.lastAck,
        lastError: null,
        lastPollAt: Date.now(),
        rawDevices
      })
    };
    this.emitSnapshot();
    await this.updateMicKeepaliveEngine(status.controllerConnected);
    await this.syncControllerPowerSavingState(settings);

    if (status.controllerConnected) {
      if (this.controllerConnectedSince === 0) {
        this.controllerConnectedSince = Date.now();
      }
      void this.reapplySettingsUntilSettled();
    } else {
      this.controllerConnectedSince = 0;
      this.reapplyAttempt = 0;
      this.nextReapplyAt = 0;
    }
  }

  private async ensureCompanionDevice(): Promise<void> {
    if (this.device) {
      return;
    }
    const devices = (await this.hidDiscovery.listDevices()).filter(isCompanionCandidate);
    await this.openAndReadStatus(devices);
  }

  private async openAndReadStatus(devices: DiscoveredHidDevice[]) {
    for (const candidate of devices) {
      if (!candidate.path) {
        continue;
      }
      try {
        if (this.devicePath !== candidate.path) {
          this.closeDevice();
          this.device = new HID.HID(candidate.path);
          this.device.on('data', this.handleCompanionInputData);
          this.device.on('error', this.handleCompanionDeviceError);
          this.devicePath = candidate.path;
          this.lastUptimeSeconds = null;
          this.sessionKey = null;
          this.sessionPath = null;
          this.resetStartupReapplyState();
        }
        const status = parseStatusReport(this.device!.getFeatureReport(REPORT_ID.STATUS, REPORT_LENGTH));
        return status;
      } catch (error) {
        if (error instanceof ProtocolError && error.code === 'bad-version') {
          throw error;
        }
        this.closeDevice();
      }
    }
    return null;
  }

  private maybeEmitStatusToasts(status: BridgeStatusPayload): void {
    const settings = this.settingsStore.get();
    const controllerConnected = status.controllerConnected;

    if (
      settings.notifyControllerConnection
      && this.previousControllerConnected !== null
      && this.previousControllerConnected !== controllerConnected
    ) {
      this.emit('toast', {
        title: 'DS5 Bridge',
        body: controllerConnected ? 'Controller connected' : 'Controller disconnected'
      } satisfies BridgeToast);
    }
    this.previousControllerConnected = controllerConnected;

    const lowBattery = controllerConnected
      && status.batteryPercent !== null
      && status.batteryPercent <= LOW_BATTERY_PERCENT;
    if (settings.notifyLowBattery && lowBattery && !this.lowBatteryToastActive) {
      this.emit('toast', {
        title: 'DS5 Bridge',
        body: `Controller battery low: ${status.batteryPercent}%`
      } satisfies BridgeToast);
    }
    this.lowBatteryToastActive = lowBattery;
  }

  private noteControllerUnavailableForToasts(): void {
    const settings = this.settingsStore.get();
    if (settings.notifyControllerConnection && this.previousControllerConnected === true) {
      this.emit('toast', {
        title: 'DS5 Bridge',
        body: 'Controller disconnected'
      } satisfies BridgeToast);
    }
    this.previousControllerConnected = false;
    this.lowBatteryToastActive = false;
  }

  private resetStartupReapplyState(): void {
    this.reappliedSessionKey = null;
    this.controllerConnectedSince = 0;
    this.reapplyAttempt = 0;
    this.nextReapplyAt = 0;
  }

  private async reapplySettingsUntilSettled(): Promise<void> {
    if (!this.sessionKey || this.reapplyActive || this.reappliedSessionKey === this.sessionKey) {
      return;
    }
    const now = Date.now();
    if (now < this.nextReapplyAt) {
      return;
    }
    if (this.controllerConnectedSince && now - this.controllerConnectedSince < STARTUP_REAPPLY_MIN_SETTLE_MS) {
      this.nextReapplyAt = this.controllerConnectedSince + STARTUP_REAPPLY_MIN_SETTLE_MS;
      return;
    }

    this.reapplyActive = true;
    try {
      const settings = this.settingsStore.get();
      await this.applyCurrentSettings(settings, this.reapplyAttempt === 0);
      if (settings.hostEncodedAudioEnabled && this.hostAudioCommandActive) {
        this.reappliedSessionKey = this.sessionKey;
      } else if (this.reapplyAttempt >= STARTUP_REAPPLY_RETRY_DELAYS_MS.length) {
        this.reappliedSessionKey = this.sessionKey;
      } else {
        this.nextReapplyAt = Date.now() + STARTUP_REAPPLY_RETRY_DELAYS_MS[this.reapplyAttempt];
        this.reapplyAttempt += 1;
      }
    } catch (error) {
      this.publishError(error);
    } finally {
      this.reapplyActive = false;
    }
  }

  private async applyCurrentSettings(settings: CompanionSettings, expectSettingsRevisionChange: boolean): Promise<void> {
    if (settings.hostEncodedAudioEnabled) {
      await this.startHostAudioSession(expectSettingsRevisionChange);
      await this.applySpeakerSettings(settings, expectSettingsRevisionChange);
      await this.applyMicSettings(settings, expectSettingsRevisionChange);
    }
    await this.applyLightbarSettings(settings, expectSettingsRevisionChange);
    await this.sendCommand(COMMAND_ID.SET_MUTE_BUTTON_ACTION, muteButtonModeValue(settings.muteButtonMode), {
      expectSettingsRevisionChange,
      extraPayload: [
        settings.muteKeyboardUsage,
        encodeMuteKeyboardOptions(settings.muteKeyboardModifiers, settings.muteKeyboardBehavior)
      ]
    });
    await this.sendCommand(COMMAND_ID.SET_HAPTICS_GAIN, this.effectiveHapticsGain(settings), {
      expectSettingsRevisionChange
    });
    await this.sendCommand(COMMAND_ID.SET_HAPTICS_BUFFER_LENGTH, settings.hapticsBufferLength, {
      expectSettingsRevisionChange
    });
    await this.sendCommand(
      COMMAND_ID.SET_CLASSIC_RUMBLE_GAIN,
      this.effectiveClassicRumbleGain(settings),
      { expectSettingsRevisionChange }
    );
    await this.sendCommand(
      COMMAND_ID.SET_TRIGGER_EFFECT_INTENSITY,
      this.effectiveTriggerEffectIntensity(settings),
      { expectSettingsRevisionChange }
    );
    if (!settings.adaptiveTriggersEnabled) {
      await this.sendCommand(COMMAND_ID.RESET_ADAPTIVE_TRIGGERS, 0, { throwOnCommandError: false });
    }
    if (!settings.hostEncodedAudioEnabled) {
      await this.applySpeakerSettings(settings, expectSettingsRevisionChange);
      await this.applyMicSettings(settings, expectSettingsRevisionChange);
      await this.stopHostAudioSession(expectSettingsRevisionChange);
    }
    await this.sendCommand(COMMAND_ID.SET_LED_ENABLED, settings.ledEnabled ? 1 : 0, {
      expectSettingsRevisionChange
    });
    await this.sendCommand(COMMAND_ID.SET_IDLE_DISCONNECT_ENABLED, settings.idleDisconnectEnabled ? 1 : 0, {
      expectSettingsRevisionChange
    });
    await this.sendCommand(COMMAND_ID.SET_IDLE_DISCONNECT_TIMEOUT, settings.idleDisconnectTimeoutMinutes, {
      expectSettingsRevisionChange
    });
    await this.sendCommand(
      COMMAND_ID.SET_USB_SUSPEND_DISCONNECT_ENABLED,
      settings.usbSuspendDisconnectEnabled ? 1 : 0,
      { expectSettingsRevisionChange }
    );
    await this.sendCommand(
      COMMAND_ID.SET_SLEEP_KEYBIND_ENABLED,
      settings.sleepKeybindEnabled ? 1 : 0,
      { expectSettingsRevisionChange }
    );
    await this.sendCommand(
      COMMAND_ID.SET_SPEAKER_VOLUME_SHORTCUT_ENABLED,
      settings.speakerVolumeShortcutEnabled ? 1 : 0,
      { expectSettingsRevisionChange }
    );
    await this.applyButtonRemapping(settings, expectSettingsRevisionChange);
    await this.sendCommand(
      COMMAND_ID.SET_POLLING_RATE_MODE,
      pollingRateModeValue(settings.pollingRateMode),
      { expectSettingsRevisionChange }
    );
  }

  private async applyLightbarSettings(settings: CompanionSettings, expectSettingsRevisionChange: boolean): Promise<void> {
    const color = settings.lightbarEnabled ? parseHexColor(settings.lightbarColor) : { red: 0, green: 0, blue: 0 };
    await this.sendCommand(
      COMMAND_ID.SET_LIGHTBAR_COLOR,
      this.effectiveLightbarBrightness(settings),
      {
        expectSettingsRevisionChange,
        extraPayload: [color.red, color.green, color.blue]
      }
    );
    await this.sendCommand(COMMAND_ID.SET_LIGHTBAR_OVERRIDE, (!settings.lightbarEnabled || settings.lightbarOverrideEnabled) ? 1 : 0, {
      expectSettingsRevisionChange
    });
  }

  private async applySpeakerSettings(settings: CompanionSettings, expectSettingsRevisionChange: boolean): Promise<void> {
    await this.setFirmwareSpeakerVolume(settings.speakerEnabled ? settings.speakerVolumePercent : 0, expectSettingsRevisionChange);
  }

  private async applyMicSettings(settings: CompanionSettings, expectSettingsRevisionChange: boolean): Promise<void> {
    await this.sendCommand(COMMAND_ID.SET_MIC_VOLUME, settings.micVolumePercent, {
      expectSettingsRevisionChange
    });
    await this.sendCommand(COMMAND_ID.SET_MIC_MUTE, settings.micMuted ? 1 : 0, {
      expectSettingsRevisionChange
    });
  }

  private async setFirmwareSpeakerVolume(percent: number, expectSettingsRevisionChange: boolean): Promise<void> {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    await this.sendCommand(COMMAND_ID.SET_SPEAKER_VOLUME, value, {
      expectSettingsRevisionChange
    });
    if (this.snapshot.status) {
      this.snapshot.status.speakerVolumePercent = value;
    }
  }

  private nextSequence(): number {
    this.commandSequence = (this.commandSequence + 1) & 0xff;
    return this.commandSequence;
  }

  private publishError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const isIncompatible = error instanceof ProtocolError && error.code === 'bad-version';
    this.snapshot = {
      ...this.snapshot,
      state: isIncompatible ? 'incompatible' : this.snapshot.state === 'no-bridge' ? 'no-bridge' : 'error',
      message: isIncompatible ? FIRMWARE_UPDATE_REQUIRED_MESSAGE : message,
      diagnostics: {
        ...this.snapshot.diagnostics,
        lastError: message,
        lastPollAt: Date.now()
      }
    };
    this.emitSnapshot();
  }

  private closeDevice(): void {
    if (this.device) {
      try {
        this.device.removeAllListeners('data');
        this.device.removeAllListeners('error');
        this.device.close();
      } catch {
        // Ignore close races while Windows removes the HID path.
      }
    }
    this.device = null;
    this.devicePath = null;
    this.hostAudioCommandActive = false;
    this.hostAudioStatus = null;
    this.controllerPowerSavingActive = null;
    this.hostAudioReportQueue = [];
    this.hostAudioWritePumpActive = false;
    this.hostAudioFrameCount = 0;
    this.hostAudioChunkWriteCount = 0;
    this.hostAudioFrameDropCount = 0;
    void this.hostAudioEngine.stop();
    void this.micKeepaliveEngine.stop();
  }

  private markBridgeUnavailableAfterDisconnect(rawDevices: HidDeviceSummary[], normalFirmwarePresent = false): void {
    this.lastUptimeSeconds = null;
    this.sessionKey = null;
    this.sessionPath = null;
    this.reapplyActive = false;
    this.hostAudioHeartbeatBusy = false;
    this.noteControllerUnavailableForToasts();
    this.lowBatteryToastActive = false;
    this.resetStartupReapplyState();
    this.snapshot = {
      state: normalFirmwarePresent ? 'normal-firmware' : 'no-bridge',
      message: normalFirmwarePresent
        ? 'Companion firmware required'
        : 'No bridge detected',
      status: null,
      settings: this.settingsStore.get(),
      diagnostics: this.withAudioDebugDiagnostics(emptyDiagnostics(rawDevices))
    };
  }

  private emitSnapshot(): void {
    const signature = JSON.stringify({
      state: this.snapshot.state,
      message: this.snapshot.message,
      status: this.snapshot.status
        ? {
            ...this.snapshot.status,
            uptimeSeconds: 0
          }
        : null,
      settings: this.snapshot.settings,
      diagnostics: {
        hidPath: this.snapshot.diagnostics.hidPath,
        protocolVersion: this.snapshot.diagnostics.protocolVersion,
        settingsRevision: this.snapshot.diagnostics.settingsRevision,
        lastAck: this.snapshot.diagnostics.lastAck,
        lastError: this.snapshot.diagnostics.lastError,
        audioDebugLogPath: this.snapshot.diagnostics.audioDebugLogPath,
        audioDebugLogLineCount: this.snapshot.diagnostics.audioDebugLogLines.length,
        audioDebugLogTail: this.snapshot.diagnostics.audioDebugLogLines.at(-1) ?? null,
        audioDebugDroppedCount: this.snapshot.diagnostics.audioDebugDroppedCount,
        hostAudioStatus: this.snapshot.diagnostics.hostAudioStatus
      }
    });
    if (signature === this.lastEmittedSnapshotSignature) {
      return;
    }
    this.lastEmittedSnapshotSignature = signature;
    this.emit('snapshot', this.getSnapshot());
  }
}
