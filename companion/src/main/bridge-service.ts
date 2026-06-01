import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACK_RESULT,
  AUDIO_DEBUG_EVENT,
  COMMAND_ID,
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
  parseTriggerTraceReport,
  parseFeedbackTraceReport,
  parseStatusReport,
  HOST_AUDIO_PACKET_TYPE,
  SHORTCUT_EVENT,
  buildButtonRemapPayload,
  normalizeBridgePresetId,
  pollingRateModeValue
} from '../shared/protocol';
import type {
  AdaptiveTriggerPreviewEffect,
  AudioDebugEventPayload,
  AudioDebugStatsPayload,
  BridgePresetId,
  RemapButtonId,
  HostAudioStatusPayload,
  TriggerTraceEventPayload,
  FeedbackTraceEventPayload,
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
  HostAudioCaptureIssue,
  HostAudioCaptureRetry,
  HidDeviceSummary,
  UiScalePercent,
  WindowsDeviceCleanupResult
} from '../shared/types';
import {
  HostAudioEngine,
  HostAudioStartError,
  MicKeepaliveEngine,
  playHostAudioTestTone,
  type HostAudioStartFailureReason,
  type HostAudioFramePayload
} from './host-audio-engine';
import { CompanionDebugConfig } from './debug-config';
import { HidDiscoveryClient } from './hid-discovery-client';
import { SettingsStore, normalizeUiScalePercent } from './settings-store';
import { WinUsbCompanionTransport } from './winusb-companion-transport';

const POLL_INTERVAL_MS = 500;
const HOST_AUDIO_HEARTBEAT_MS = 250;
const HOST_AUDIO_ACTIVE_POLL_INTERVAL_MS = 5000;
const HOST_AUDIO_STATUS_READ_INTERVAL_MS = 500;
const HOST_AUDIO_HELPER_STATUS_READ_INTERVAL_MS = 5000;
const HOST_AUDIO_CAPTURE_RETRY_MS = 5000;
const AUDIO_DEBUG_READ_INTERVAL_MS = 500;
const TRIGGER_TRACE_READ_INTERVAL_MS = 250;
const FEEDBACK_TRACE_READ_INTERVAL_MS = 250;
const AUDIO_DEBUG_DIAGNOSTICS_ENABLED = CompanionDebugConfig.audioDebugDiagnosticsEnabled;
const TRIGGER_TRACE_DIAGNOSTICS_ENABLED = CompanionDebugConfig.triggerTraceDiagnosticsEnabled;
const FEEDBACK_TRACE_DIAGNOSTICS_ENABLED = CompanionDebugConfig.feedbackTraceDiagnosticsEnabled;
const MIC_KEEPALIVE_ENABLED = CompanionDebugConfig.micKeepaliveEnabled;
const HOST_AUDIO_MAX_QUEUED_FRAMES = 2;
const HOST_AUDIO_STOP_FADE_MS = 40;
const LOW_BATTERY_PERCENT = 20;
const MIN_SUPPORTED_FIRMWARE_VERSION = '1.5.0';
const FIRMWARE_UPDATE_REQUIRED_MESSAGE = `Firmware ${MIN_SUPPORTED_FIRMWARE_VERSION} update required`;
const AUDIO_DEBUG_LOG_LINE_LIMIT = 300;
const TRIGGER_TRACE_LOG_LINE_LIMIT = 300;
const TRIGGER_TRACE_MAX_READS_PER_POLL = 32;
const FEEDBACK_TRACE_LOG_LINE_LIMIT = 300;
const FEEDBACK_TRACE_MAX_READS_PER_POLL = 32;
const STARTUP_REAPPLY_MIN_SETTLE_MS = 0;
const STARTUP_REAPPLY_RETRY_DELAYS_MS = [250, 650, 1300] as const;
const MIN_IDLE_DISCONNECT_TIMEOUT_MINUTES = 1;
const MAX_IDLE_DISCONNECT_TIMEOUT_MINUTES = 120;
const CONTROLLER_POWER_SAVING_CAP_PERCENT = 60;
const STANDARD_FEEDBACK_GAIN_PERCENT = 200;
const BOOSTED_FEEDBACK_GAIN_PERCENT = 500;
const SONY_VENDOR_ID = 0x054c;
const DUALSENSE_PRODUCT_IDS = new Set([0x0ce6, 0x0df2]);
const WINDOWS_DEVICE_CLEANUP_RELATIVE_PATH = path.join('tools', 'windows', 'clean-ds5bridge-devices.ps1');
const POWERSHELL_ERROR_OUTPUT_MAX_CHARS = 8192;
const CLEANUP_LOG_EXCERPT_MAX_CHARS = 3000;
type BridgeDiagnosticsWithoutAudioLog = Omit<
  BridgeDiagnostics,
  | 'audioDebugLogPath'
  | 'audioDebugLogLines'
  | 'audioDebugDroppedCount'
  | 'audioDebugStats'
  | 'triggerTraceLines'
  | 'triggerTraceDroppedCount'
  | 'feedbackTraceLines'
  | 'feedbackTraceDroppedCount'
  | 'hostAudioCaptureIssue'
  | 'hostAudioCaptureRetry'
  | 'hostAudioStatus'
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
    feedbackBoostEnabled: false,
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
  return major > 1 || (major === 1 && (minor > 5 || (minor === 5 && patch >= 0)));
}

function hostAudioCaptureIssueMessage(
  reason: HostAudioStartFailureReason,
  retrySeconds: number,
  fallbackMessage: string
): string {
  switch (reason) {
    case 'device-in-use':
      return `DualSense audio endpoint is in exclusive use. Host Encoding will retry in ${retrySeconds}s; disable Host Encoding for games that require exclusive DualSense audio.`;
    case 'device-invalidated':
      return `DualSense audio endpoint changed while Host Encoding was starting. Host Encoding will retry in ${retrySeconds}s.`;
    case 'unsupported-format':
      return `DualSense raw PCM capture endpoint format is not usable by Windows. Re-enumerate or clean stale DualSense audio devices, then Host Encoding will retry in ${retrySeconds}s.`;
    case 'bulk-pcm-unavailable':
      return `DS5 Bridge WinUSB PCM pipe is unavailable. Re-enumerate or clean stale DS5 Bridge devices, then Host Encoding will retry in ${retrySeconds}s.`;
    case 'start-timeout':
    case 'helper-exit':
      return `${fallbackMessage} Host Encoding will retry in ${retrySeconds}s.`;
  }
}

function shouldSurfaceHostAudioCaptureIssue(reason: HostAudioStartFailureReason): boolean {
  return reason === 'device-in-use'
    || reason === 'device-invalidated'
    || reason === 'unsupported-format'
    || reason === 'bulk-pcm-unavailable';
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
    hostAudioCaptureIssue: null,
    hostAudioCaptureRetry: null,
    audioDebugLogPath: null,
    audioDebugLogLines: [],
    audioDebugDroppedCount: 0,
    audioDebugStats: null,
    triggerTraceLines: [],
    triggerTraceDroppedCount: 0,
    feedbackTraceLines: [],
    feedbackTraceDroppedCount: 0,
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

function normalizeTriggerTestMode(mode: unknown): TriggerTestMode {
  if (mode === 'weapon' || mode === 'vibration') {
    return mode;
  }
  return 'feedback';
}

function normalizeTriggerTestTarget(target: unknown): TriggerTestTarget {
  if (target === 'l2' || target === 'r2') {
    return target;
  }
  return 'both';
}

function normalizePercent(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue)
    ? Math.max(0, Math.min(100, Math.round(numericValue)))
    : 0;
}

function normalizeAdaptiveTriggerPreviewEffect(
  effect: Partial<AdaptiveTriggerPreviewEffect> | null | undefined
): AdaptiveTriggerPreviewEffect {
  const candidate = effect ?? {};
  return {
    mode: normalizeTriggerTestMode(candidate.mode),
    target: normalizeTriggerTestTarget(candidate.target),
    startPercent: normalizePercent(candidate.startPercent),
    wallPercent: normalizePercent(candidate.wallPercent),
    forcePercent: normalizePercent(candidate.forcePercent)
  };
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
    case 8:
      return `${prefix} [USB] BULK_PCM_PARTIAL headerWritten=${arg1} payloadWritten=${arg2} payloadBytes=${arg3}`;
    case 9:
      return `${prefix} [USB] BULK_PCM_DROP countLow=${arg1} available=${arg2} packetBytes=${arg3} sequenceLow=${arg4}`;
    case 10:
      return `${prefix} [USB] BULK_PCM_QUEUE_DROP countLow=${arg1} queue=${arg2}/${arg3} sequenceLow=${arg4}`;
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
      if (arg0 === 0xf0) {
        return `${prefix} [HostPico] JITTER drop-oldest queue=${arg1} target=${arg2} dropped=${arg3} started=${arg4 === 1 ? 'true' : 'false'}`;
      }
      if (arg0 === 0xf1) {
        return `${prefix} [HostPico] JITTER add-fail queue=${arg1} target=${arg2} dropped=${arg3}`;
      }
      if (arg0 === 0xf2) {
        return `${prefix} [HostPico] JITTER start queue=${arg1} target=${arg2} packet=${arg3} duplex=${arg4 === 1 ? 'true' : 'false'}`;
      }
      if (arg0 === 0xf3) {
        return `${prefix} [HostPico] JITTER underrun queue=${arg1} target=${arg2} dropped=${arg3} duplex=${arg4 === 1 ? 'true' : 'false'}`;
      }
      if (arg0 === 0xf4) {
        return `${prefix} [HostPico] JITTER duplex-prebuffer queue=${arg1} target=${arg2} packet=${arg3} reportSeq=${arg4}`;
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
    case AUDIO_DEBUG_EVENT.CPU_LOAD:
      return `${prefix} [CPU] core1Busy=${arg0}% core1Speaker=${arg1}% core1Mic=${arg2}% audioLoopMax=${scaled100Us(arg3)} audioLoopGapMax=${scaled100Us(arg4)}`;
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

function triggerTraceStageLabel(stage: number): string {
  switch (stage) {
    case 1:
      return 'HOST';
    case 2:
      return 'BRIDGE-IN';
    case 3:
      return 'BRIDGE-OUT';
    case 4:
      return 'BT';
    case 5:
      return 'DROP';
    default:
      return `stage-${stage}`;
  }
}

function outputDecisionLabel(decision: number): string {
  switch (decision) {
    case 0:
      return 'raw';
    case 1:
      return 'critical-direct';
    case 2:
      return 'audio';
    case 3:
      return 'state-only';
    case 4:
      return 'critical-flags';
    case 5:
      return 'critical-payload';
    case 6:
      return 'noop';
    default:
      return String(decision);
  }
}

function hexBytes(values: number[]): string {
  return values.map(hexByte).join(' ');
}

function formatTriggerTraceEvent(event: TriggerTraceEventPayload): string {
  return [
    `#${event.sequence}`,
    `t=${event.timeMs}ms`,
    triggerTraceStageLabel(event.stage),
    `report=${hexByte(event.reportId)}`,
    `len=${limitedByte(event.length)}`,
    `seq=${hexByte(event.sequenceTag)}`,
    `flags=${hexByte(event.flag0)}/${hexByte(event.flag1)}/${hexByte(event.flag2)}`,
    `power=${hexByte(event.motorPower)}`,
    `decision=${outputDecisionLabel(event.decision)}`,
    `R=[${hexBytes(event.rightTrigger)}]`,
    `L=[${hexBytes(event.leftTrigger)}]`
  ].join(' ');
}

function feedbackTraceStageLabel(stage: number): string {
  switch (stage) {
    case 1:
      return 'HOST';
    case 2:
      return 'BRIDGE-IN';
    case 3:
      return 'BRIDGE-OUT';
    case 4:
      return 'BT';
    case 5:
      return 'DROP';
    case 6:
      return 'HOST-AUDIO-RX';
    case 7:
      return 'HOST-AUDIO-SUBMIT';
    case 8:
      return 'AUDIO-ENQUEUE';
    case 9:
      return 'AUDIO-DROP';
    case 10:
      return 'LOCAL-AUDIO';
    default:
      return `stage-${stage}`;
  }
}

function outputTraceRouteLabels(flags: number): string {
  const labels: string[] = [];
  if ((flags & 0x01) !== 0) {
    labels.push('state-pending');
  }
  if ((flags & 0x02) !== 0) {
    labels.push('protected');
  }
  if ((flags & 0x04) !== 0) {
    labels.push('audio-recent');
  }
  if ((flags & 0x08) !== 0) {
    labels.push('host-audio');
  }
  if ((flags & 0x10) !== 0) {
    labels.push('usb-speaker');
  }
  if ((flags & 0x20) !== 0) {
    labels.push('classic-active');
  }
  if ((flags & 0x40) !== 0) {
    labels.push('send-audio');
  }
  if ((flags & 0x80) !== 0) {
    labels.push('send-output');
  }
  return labels.length === 0 ? '-' : labels.join(',');
}

function outputTraceTransformLabels(flags: number): string {
  const labels: string[] = [];
  if ((flags & 0x01) !== 0) {
    labels.push('strip-zero-rumble');
  }
  if ((flags & 0x02) !== 0) {
    labels.push('split-state');
  }
  if ((flags & 0x04) !== 0) {
    labels.push('protected');
  }
  if ((flags & 0x08) !== 0) {
    labels.push('classic-rumble');
  }
  if ((flags & 0x10) !== 0) {
    labels.push('feedback-state');
  }
  if ((flags & 0x20) !== 0) {
    labels.push('state');
  }
  return labels.length === 0 ? '-' : labels.join(',');
}

function feedbackTraceDetailFields(event: FeedbackTraceEventPayload): string[] {
  const fields = [`detail=${event.detail0}/${event.detail1}/${event.detail2}/${event.detail3}`];
  if (![2, 3, 4, 5, 8, 9].includes(event.stage)) {
    return fields;
  }

  fields.push(`q=C${event.detail0}/A${event.detail1}`);
  fields.push(`route=${outputTraceRouteLabels(event.detail2)}`);
  if (event.stage === 3 || event.stage === 5) {
    fields.push(`xf=${outputTraceTransformLabels(event.detail3)}`);
  } else if (event.stage === 4 || event.stage === 9) {
    fields.push(`age=${event.detail3}ms`);
  }
  return fields;
}

function formatFeedbackTraceEvent(event: FeedbackTraceEventPayload): string {
  return [
    `#${event.sequence}`,
    `t=${event.timeMs}ms`,
    feedbackTraceStageLabel(event.stage),
    `report=${hexByte(event.reportId)}`,
    `len=${limitedByte(event.length)}`,
    `seq=${hexByte(event.sequenceTag)}`,
    `flags=${hexByte(event.flag0)}/${hexByte(event.flag1)}/${hexByte(event.flag2)}`,
    `motors=R${hexByte(event.motorRight)} L${hexByte(event.motorLeft)}`,
    `haptic=peak${event.hapticPeak} mean${event.hapticMean} nz${event.hapticNonZero}`,
    `decision=${outputDecisionLabel(event.decision)}`,
    ...feedbackTraceDetailFields(event)
  ].join(' ');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteWindowsCommandArgument(value: string): string {
  if (!/[\s"]/.test(value)) {
    return value;
  }
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`;
}

function createWindowsDeviceCleanupLogPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(tmpdir(), `ds5-bridge-device-cleanup-${process.pid}-${stamp}.log`);
}

function createWindowsDeviceCleanupRunnerPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(tmpdir(), `ds5-bridge-device-cleanup-runner-${process.pid}-${stamp}.ps1`);
}

function readCleanupLogExcerpt(logPath: string): string {
  try {
    if (!existsSync(logPath)) {
      return '';
    }
    const text = readFileSync(logPath, 'utf8').trim();
    if (text.length <= CLEANUP_LOG_EXCERPT_MAX_CHARS) {
      return text;
    }
    return text.slice(-CLEANUP_LOG_EXCERPT_MAX_CHARS);
  } catch {
    return '';
  }
}

function buildWindowsDeviceCleanupRunnerScript(scriptPath: string, logPath: string): string {
  const quotedScriptPath = quotePowerShellString(scriptPath);
  const quotedLogPath = quotePowerShellString(logPath);
  return [
    "$ErrorActionPreference = 'Stop'",
    `$logPath = ${quotedLogPath}`,
    `$scriptPath = ${quotedScriptPath}`,
    'try {',
    "  \"DS5 Bridge emergency cleanup started: $(Get-Date -Format o)\" | Out-File -LiteralPath $logPath -Encoding UTF8",
    '  & $scriptPath -Apply -IncludeBluetooth -RepeatUntilClean -Force -Confirm:$false *>&1 | Tee-Object -FilePath $logPath -Append',
    '  $exitCode = if ($null -eq $global:LASTEXITCODE) { 0 } else { $global:LASTEXITCODE }',
    "  \"DS5 Bridge emergency cleanup exited: $exitCode\" | Out-File -LiteralPath $logPath -Encoding UTF8 -Append",
    '  exit $exitCode',
    '} catch {',
    '  $message = if ($_.Exception) { $_.Exception.Message } else { $_ | Out-String }',
    "  \"ERROR: $message\" | Out-File -LiteralPath $logPath -Encoding UTF8 -Append",
    '  $_ | Out-String | Out-File -LiteralPath $logPath -Encoding UTF8 -Append',
    '  exit 1',
    '}'
  ].join('\r\n');
}

function resolveWindowsDeviceCleanupScriptPath(): string {
  const packagedCandidate = process.resourcesPath
    ? path.join(process.resourcesPath, WINDOWS_DEVICE_CLEANUP_RELATIVE_PATH)
    : null;
  const candidates = [
    packagedCandidate,
    path.resolve(process.cwd(), WINDOWS_DEVICE_CLEANUP_RELATIVE_PATH),
    path.resolve(process.cwd(), '..', WINDOWS_DEVICE_CLEANUP_RELATIVE_PATH),
    path.resolve(__dirname, '..', '..', '..', WINDOWS_DEVICE_CLEANUP_RELATIVE_PATH),
    path.resolve(__dirname, '..', '..', '..', '..', WINDOWS_DEVICE_CLEANUP_RELATIVE_PATH)
  ].filter((candidate): candidate is string => Boolean(candidate));

  const scriptPath = candidates.find((candidate) => existsSync(candidate));
  if (!scriptPath) {
    throw new Error('Windows device cleanup script is missing.');
  }
  return scriptPath;
}

async function runElevatedWindowsDeviceCleanup(scriptPath: string, logPath: string): Promise<void> {
  const runnerPath = createWindowsDeviceCleanupRunnerPath();
  writeFileSync(runnerPath, buildWindowsDeviceCleanupRunnerScript(scriptPath, logPath), 'utf8');
  const cleanupArguments = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    runnerPath
  ].map(quoteWindowsCommandArgument).join(' ');
  const command = [
    "$ErrorActionPreference = 'Stop';",
    `$process = Start-Process -FilePath ${quotePowerShellString('powershell.exe')} -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${quotePowerShellString(cleanupArguments)};`,
    'exit $process.ExitCode'
  ].join(' ');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > POWERSHELL_ERROR_OUTPUT_MAX_CHARS) {
        output = output.slice(-POWERSHELL_ERROR_OUTPUT_MAX_CHARS);
      }
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const logExcerpt = readCleanupLogExcerpt(logPath);
      const details = logExcerpt || output.trim();
      const suffix = details ? `\n\n${details}` : ` See log: ${logPath}. Runner: ${runnerPath}`;
      reject(new Error(`Windows device cleanup failed.${suffix}`));
    });
  });
}

export class BridgeService extends EventEmitter {
  private device: WinUsbCompanionTransport | null = null;
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
  private triggerTraceLines: string[] = [];
  private triggerTraceDroppedCount = 0;
  private triggerTraceSupported: boolean | null = null;
  private feedbackTraceLines: string[] = [];
  private feedbackTraceDroppedCount = 0;
  private feedbackTraceSupported: boolean | null = null;
  private hostAudioStatus: HostAudioStatusPayload | null = null;
  private lastAudioStatsSignature: string | null = null;
  private hostAudioCommandActive = false;
  private commandQueue: Promise<unknown> = Promise.resolve();
  private hostAudioHeartbeatBusy = false;
  private hostAudioReportQueue: number[][] = [];
  private hostAudioWritePumpActive = false;
  private hostAudioFrameCount = 0;
  private hostAudioChunkWriteCount = 0;
  private hostAudioFrameDropCount = 0;
  private hostAudioCaptureRetryAt = 0;
  private hostAudioCaptureIssue: HostAudioCaptureIssue | null = null;
  private hostAudioCaptureRetry: HostAudioCaptureRetry | null = null;
  private lastHostAudioStageLogAt = 0;
  private lastHostAudioStatusReadAt = 0;
  private lastAudioDebugReadAt = 0;
  private lastTriggerTraceReadAt = 0;
  private lastFeedbackTraceReadAt = 0;
  private lastHostAudioActivePollAt = 0;
  private controllerPowerSavingActive: boolean | null = null;
  private previousControllerConnected: boolean | null = null;
  private lowBatteryToastActive = false;
  private shortcutFeaturePollingAvailable = true;
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

  private enqueueShortcutEvent(event: ShortcutEvent): void {
    this.volumeShortcutQueue = this.volumeShortcutQueue
      .catch(() => {
        // Keep later shortcut events alive after a failed command.
      })
      .then(() => this.dispatchShortcutAction(event));
  }

  private async pollShortcutEvent(): Promise<void> {
    const device = this.device;
    if (!device || !this.shortcutFeaturePollingAvailable) {
      return;
    }

    try {
      const event = parseShortcutEvent(await device.getFeatureReport(REPORT_ID.INPUT, REPORT_LENGTH));
      if (event !== null) {
        this.enqueueShortcutEvent(event);
      }
    } catch {
      // Shortcut polling is optional and should never make the bridge look
      // disconnected on its own.
      this.shortcutFeaturePollingAvailable = false;
    }
  }

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

  async repairWindowsDeviceCache(): Promise<WindowsDeviceCleanupResult> {
    if (this.snapshot.status?.controllerConnected) {
      throw new Error('Disconnect the controller from the bridge before running emergency device repair.');
    }
    if (process.platform !== 'win32') {
      throw new Error('Windows device repair is only available on Windows.');
    }

    const scriptPath = resolveWindowsDeviceCleanupScriptPath();
    const logPath = createWindowsDeviceCleanupLogPath();
    await runElevatedWindowsDeviceCleanup(scriptPath, logPath);
    return {
      scriptPath,
      logPath,
      includedBluetooth: true,
      message: 'Emergency device repair completed. Reconnect the bridge after Windows settles; pair DualSense controllers to Windows again if you use them directly over Bluetooth.'
    };
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
      triggerTraceLines: [...this.triggerTraceLines],
      triggerTraceDroppedCount: this.triggerTraceDroppedCount,
      feedbackTraceLines: [...this.feedbackTraceLines],
      feedbackTraceDroppedCount: this.feedbackTraceDroppedCount,
      hostAudioCaptureIssue: this.hostAudioCaptureIssue ? { ...this.hostAudioCaptureIssue } : null,
      hostAudioCaptureRetry: this.hostAudioCaptureRetry ? { ...this.hostAudioCaptureRetry } : null,
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

  private async readAudioDebugEvents(): Promise<void> {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (!this.device) {
      return;
    }

    try {
      const debug = parseAudioDebugReport(await this.device.getFeatureReport(REPORT_ID.AUDIO_DEBUG, REPORT_LENGTH));
      this.audioDebugDroppedCount = debug.droppedCount;
      this.appendAudioDebugLines(debug.events.map(formatAudioDebugEvent));
    } catch {
      // Keep diagnostics best-effort so normal status polling is not blocked.
    }
  }

  private async readAudioDebugStats(): Promise<void> {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (!this.device) {
      return;
    }

    try {
      const stats = parseAudioStatsReport(await this.device.getFeatureReport(REPORT_ID.AUDIO_STATS, REPORT_LENGTH));
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

  private async readAudioDebugThrottled(force = false): Promise<void> {
    if (!AUDIO_DEBUG_DIAGNOSTICS_ENABLED) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastAudioDebugReadAt < AUDIO_DEBUG_READ_INTERVAL_MS) {
      return;
    }
    this.lastAudioDebugReadAt = now;
    await this.readAudioDebugEvents();
    await this.readAudioDebugStats();
  }

  private appendTriggerTraceLines(lines: string[]): void {
    if (lines.length === 0) {
      return;
    }

    this.triggerTraceLines.push(...lines);
    if (this.triggerTraceLines.length > TRIGGER_TRACE_LOG_LINE_LIMIT) {
      this.triggerTraceLines = this.triggerTraceLines.slice(-TRIGGER_TRACE_LOG_LINE_LIMIT);
    }
    this.snapshot = {
      ...this.snapshot,
      diagnostics: this.withAudioDebugDiagnostics(this.snapshot.diagnostics)
    };
  }

  private async readTriggerTraceThrottled(force = false): Promise<void> {
    if (!TRIGGER_TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (!this.device) {
      return;
    }
    if (this.triggerTraceSupported === false) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastTriggerTraceReadAt < TRIGGER_TRACE_READ_INTERVAL_MS) {
      return;
    }
    this.lastTriggerTraceReadAt = now;

    try {
      const lines: string[] = [];
      for (let readIndex = 0; readIndex < TRIGGER_TRACE_MAX_READS_PER_POLL; readIndex += 1) {
        const trace = parseTriggerTraceReport(await this.device.getFeatureReport(REPORT_ID.TRIGGER_TRACE, REPORT_LENGTH));
        this.triggerTraceSupported = true;
        this.triggerTraceDroppedCount = trace.droppedCount;
        if (trace.events.length === 0) {
          break;
        }
        lines.push(...trace.events.map(formatTriggerTraceEvent));
      }
      this.appendTriggerTraceLines(lines);
    } catch {
      this.triggerTraceSupported = false;
    }
  }

  private appendFeedbackTraceLines(lines: string[]): void {
    if (lines.length === 0) {
      return;
    }

    this.feedbackTraceLines.push(...lines);
    if (this.feedbackTraceLines.length > FEEDBACK_TRACE_LOG_LINE_LIMIT) {
      this.feedbackTraceLines = this.feedbackTraceLines.slice(-FEEDBACK_TRACE_LOG_LINE_LIMIT);
    }
    this.snapshot = {
      ...this.snapshot,
      diagnostics: this.withAudioDebugDiagnostics(this.snapshot.diagnostics)
    };
  }

  private async readFeedbackTraceThrottled(force = false): Promise<void> {
    if (!FEEDBACK_TRACE_DIAGNOSTICS_ENABLED) {
      return;
    }
    if (!this.device) {
      return;
    }
    if (this.feedbackTraceSupported === false) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastFeedbackTraceReadAt < FEEDBACK_TRACE_READ_INTERVAL_MS) {
      return;
    }
    this.lastFeedbackTraceReadAt = now;

    try {
      const lines: string[] = [];
      for (let readIndex = 0; readIndex < FEEDBACK_TRACE_MAX_READS_PER_POLL; readIndex += 1) {
        const trace = parseFeedbackTraceReport(await this.device.getFeatureReport(REPORT_ID.FEEDBACK_TRACE, REPORT_LENGTH));
        this.feedbackTraceSupported = true;
        this.feedbackTraceDroppedCount = trace.droppedCount;
        if (trace.events.length === 0) {
          break;
        }
        lines.push(...trace.events.map(formatFeedbackTraceEvent));
      }
      this.appendFeedbackTraceLines(lines);
    } catch {
      this.feedbackTraceSupported = false;
    }
  }

  private async readHostAudioStatus(): Promise<void> {
    if (!this.device) {
      this.hostAudioStatus = null;
      return;
    }

    try {
      const status = parseHostAudioStatusReport(
        await this.device.getFeatureReport(REPORT_ID.HOST_AUDIO_STATUS, REPORT_LENGTH)
      );
      this.hostAudioStatus = status;
      this.lastHostAudioStatusReadAt = Date.now();
    } catch {
      this.hostAudioStatus = null;
    }
  }

  private async readHostAudioStatusThrottled(force = false, intervalMs = HOST_AUDIO_STATUS_READ_INTERVAL_MS): Promise<void> {
    if (!force && Date.now() - this.lastHostAudioStatusReadAt < intervalMs) {
      return;
    }
    await this.readHostAudioStatus();
  }

  private isControllerPowerSavingActive(settings: CompanionSettings): boolean {
    return settings.controllerPowerSavingEnabled && Boolean(this.hostAudioStatus?.headsetPlugged);
  }

  private capForControllerPowerSaving(value: number, settings: CompanionSettings): number {
    return this.isControllerPowerSavingActive(settings)
      ? Math.min(value, CONTROLLER_POWER_SAVING_CAP_PERCENT)
      : value;
  }

  private feedbackGainMax(settings: CompanionSettings): number {
    return settings.feedbackBoostEnabled ? BOOSTED_FEEDBACK_GAIN_PERCENT : STANDARD_FEEDBACK_GAIN_PERCENT;
  }

  private capForFeedbackBoost(value: number, settings: CompanionSettings): number {
    return Math.min(value, this.feedbackGainMax(settings));
  }

  private effectiveHapticsGain(settings: CompanionSettings): number {
    return settings.hapticsEnabled
      ? this.capForControllerPowerSaving(this.capForFeedbackBoost(settings.hapticsGainPercent, settings), settings)
      : 0;
  }

  private effectiveClassicRumbleGain(settings: CompanionSettings): number {
    return settings.classicRumbleEnabled
      ? this.capForControllerPowerSaving(this.capForFeedbackBoost(settings.classicRumbleGainPercent, settings), settings)
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
    const currentSettings = this.settingsStore.get();
    const value = Math.max(0, Math.min(this.feedbackGainMax(currentSettings), Math.round(percent)));
    const enableFromPositiveGain = value > 0 && !currentSettings.hapticsEnabled;
    const nextSettings = {
      ...currentSettings,
      hapticsGainPercent: value,
      hapticsEnabled: enableFromPositiveGain ? true : currentSettings.hapticsEnabled
    };
    const effectiveValue = this.effectiveHapticsGain(nextSettings);
    await this.sendSettingCommand(COMMAND_ID.SET_HAPTICS_GAIN, effectiveValue, customSettingUpdate({
      hapticsGainPercent: value,
      ...(enableFromPositiveGain ? { hapticsEnabled: true } : {})
    }));
    return this.getSnapshot();
  }

  async setHapticsEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const currentSettings = this.settingsStore.get();
    const settings = {
      ...currentSettings,
      hapticsEnabled: enabled
    };
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
    const currentSettings = this.settingsStore.get();
    const value = Math.max(0, Math.min(this.feedbackGainMax(currentSettings), Math.round(percent)));
    const nextSettings = { ...currentSettings, classicRumbleGainPercent: value };
    const effectiveValue = this.effectiveClassicRumbleGain(nextSettings);
    await this.sendSettingCommand(COMMAND_ID.SET_CLASSIC_RUMBLE_GAIN, effectiveValue, customSettingUpdate({
      classicRumbleGainPercent: value
    }));
    return this.getSnapshot();
  }

  async setFeedbackBoostEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const currentSettings = this.settingsStore.get();
    const update: Partial<CompanionSettings> = { feedbackBoostEnabled: enabled };
    if (!enabled) {
      update.hapticsGainPercent = Math.min(currentSettings.hapticsGainPercent, STANDARD_FEEDBACK_GAIN_PERCENT);
      update.classicRumbleGainPercent = Math.min(
        currentSettings.classicRumbleGainPercent,
        STANDARD_FEEDBACK_GAIN_PERCENT
      );
    }
    this.snapshot.settings = this.settingsStore.update(update);
    if (this.snapshot.state === 'connected') {
      await this.sendCommand(COMMAND_ID.SET_HAPTICS_GAIN, this.effectiveHapticsGain(this.snapshot.settings), {
        expectSettingsRevisionChange: true
      });
      await this.sendCommand(
        COMMAND_ID.SET_CLASSIC_RUMBLE_GAIN,
        this.effectiveClassicRumbleGain(this.snapshot.settings),
        { expectSettingsRevisionChange: true }
      );
    }
    this.emitSnapshot();
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
    await this.updateMicKeepaliveEngine(Boolean(this.snapshot.status?.controllerConnected));
    this.emitSnapshot();
    return this.getSnapshot();
  }

  async setHostEncodedAudioEnabled(enabled: boolean): Promise<BridgeSnapshot> {
    const settings = this.settingsStore.get();
    this.clearHostAudioCaptureBackoff();
    if (enabled) {
      if (settings.duplexMicEnabled) {
        await this.applyMicSettings(settings, false);
      } else {
        await this.sendCommand(COMMAND_ID.SET_MIC_MUTE, 1, { throwOnCommandError: false });
      }
      await this.startHostAudioSession(true);
    } else {
      await this.stopHostAudioSession(true);
    }
    this.snapshot.settings = this.settingsStore.update(customSettingUpdate({
      hostEncodedAudioEnabled: enabled,
      duplexMicEnabled: enabled ? this.snapshot.settings.duplexMicEnabled : false
    }));
    await this.readHostAudioStatus();
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
    await this.sendHostAudioStreamReport(
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
    await this.readHostAudioStatus();
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

  async previewAdaptiveTriggerEffect(effect: AdaptiveTriggerPreviewEffect): Promise<BridgeSnapshot> {
    const normalized = normalizeAdaptiveTriggerPreviewEffect(effect);
    const value = triggerTestModeValue(normalized.mode) | (triggerTestTargetValue(normalized.target) << 8);
    await this.sendCommand(COMMAND_ID.PREVIEW_ADAPTIVE_TRIGGER_EFFECT, value, {
      extraPayload: [normalized.startPercent, normalized.wallPercent, normalized.forcePercent],
      throwOnCommandError: false
    });
    return this.getSnapshot();
  }

  async applyAdaptiveTriggerEffect(effect: AdaptiveTriggerPreviewEffect): Promise<BridgeSnapshot> {
    const normalized = normalizeAdaptiveTriggerPreviewEffect(effect);
    const value = triggerTestModeValue(normalized.mode) | (triggerTestTargetValue(normalized.target) << 8);
    await this.sendCommand(COMMAND_ID.APPLY_ADAPTIVE_TRIGGER_EFFECT, value, {
      extraPayload: [normalized.startPercent, normalized.wallPercent, normalized.forcePercent],
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

  private enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commandQueue.then(operation, operation);
    this.commandQueue = run.catch(() => undefined);
    return run;
  }

  private async sendCommand(commandId: number, value: number, options: CommandOptions = {}) {
    return this.enqueueCommand(async () => {
      await this.ensureCompanionDevice();
      if (!this.device) {
        throw new Error('No companion bridge is connected.');
      }

      const sequence = this.nextSequence();
      const previousSettingsRevision = this.snapshot.diagnostics.settingsRevision;
      await this.device.sendFeatureReport(buildCommandReport(commandId, sequence, value, options.extraPayload));
      const ack = parseAckReport(await this.device.getFeatureReport(REPORT_ID.ACK, REPORT_LENGTH));
      this.snapshot.diagnostics.lastAck = ack;
      if (ack.commandId !== (commandId & 0xff) || ack.commandSequence !== sequence) {
        const message = `Stale companion ACK: expected command 0x${(commandId & 0xff).toString(16).padStart(2, '0')} sequence ${sequence}, received command 0x${ack.commandId.toString(16).padStart(2, '0')} sequence ${ack.commandSequence}.`;
        this.snapshot.diagnostics.lastError = message;
        this.emitSnapshot();
        throw new Error(message);
      }
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
    });
  }

  private async writeHostAudioStreamReport(report: number[]): Promise<boolean> {
    if (!this.device) {
      return false;
    }
    try {
      await this.device.write(report);
      return true;
    } catch {
      return false;
    }
  }

  private sendHostAudioStreamReport(packetType: number): Promise<boolean> {
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
    void this.pumpHostAudioReports();
  }

  private async pumpHostAudioReports(): Promise<void> {
    if (this.hostAudioWritePumpActive) {
      return;
    }
    this.hostAudioWritePumpActive = true;
    const pump = async () => {
      const report = this.hostAudioReportQueue.shift();
      if (!report) {
        this.hostAudioWritePumpActive = false;
        return;
      }
      if (!(await this.writeHostAudioStreamReport(report))) {
        this.hostAudioReportQueue = [];
        this.hostAudioWritePumpActive = false;
        this.hostAudioCommandActive = false;
        this.logHostAudioStage('write-failed');
        return;
      }
      this.hostAudioChunkWriteCount++;
      this.logHostAudioStage('write');
      setImmediate(() => {
        void pump();
      });
    };
    setImmediate(() => {
      void pump();
    });
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

  private async ensureHostAudioCapture(speakerVolumePercent: number): Promise<boolean> {
    if (this.isHostAudioCaptureRetryPending()) {
      await this.hostAudioEngine.stop();
      return false;
    }

    try {
      await this.hostAudioEngine.start(this.devicePath, speakerVolumePercent);
      this.clearHostAudioCaptureBackoff();
      return true;
    } catch (error) {
      if (!(error instanceof HostAudioStartError)) {
        throw error;
      }

      await this.handleHostAudioCaptureStartFailure(error);
      return false;
    }
  }

  private isHostAudioCaptureRetryPending(): boolean {
    return this.hostAudioCaptureRetryAt > Date.now();
  }

  private clearHostAudioCaptureBackoff(): void {
    this.hostAudioCaptureRetryAt = 0;
    this.hostAudioCaptureIssue = null;
    this.hostAudioCaptureRetry = null;
  }

  private async handleHostAudioCaptureStartFailure(error: HostAudioStartError): Promise<void> {
    const retryAt = Date.now() + HOST_AUDIO_CAPTURE_RETRY_MS;
    this.hostAudioCaptureRetryAt = retryAt;
    await this.deactivateHostAudioFirmwareAfterCaptureFailure();

    const retrySeconds = Math.round(HOST_AUDIO_CAPTURE_RETRY_MS / 1000);
    const message = hostAudioCaptureIssueMessage(error.reason, retrySeconds, error.message);
    const surfaceIssue = shouldSurfaceHostAudioCaptureIssue(error.reason);
    this.hostAudioCaptureRetry = {
      reason: error.reason,
      message,
      retryAt
    };
    this.hostAudioCaptureIssue = surfaceIssue
      ? {
          reason: error.reason,
          message,
          retryAt
        }
      : null;
    this.appendAudioDebugLines([
      `[HostBridge] host audio capture unavailable reason=${error.reason} retryInMs=${HOST_AUDIO_CAPTURE_RETRY_MS}`
    ]);
    this.snapshot = {
      ...this.snapshot,
      diagnostics: this.withAudioDebugDiagnostics({
        ...this.snapshot.diagnostics,
        lastError: surfaceIssue ? message : this.snapshot.diagnostics.lastError,
        lastPollAt: Date.now()
      })
    };
    this.emitSnapshot();
  }

  private async deactivateHostAudioFirmwareAfterCaptureFailure(): Promise<void> {
    const wasHostAudioActive = this.hostAudioCommandActive;
    this.clearHostAudioReportQueue();
    this.hostAudioCommandActive = false;
    await this.hostAudioEngine.stop();

    if (!this.device || !wasHostAudioActive) {
      return;
    }

    await this.sendCommand(COMMAND_ID.STOP_HOST_AUDIO, 0, { throwOnCommandError: false });
    await this.sendCommand(COMMAND_ID.SET_HOST_AUDIO_ENABLED, 0, { throwOnCommandError: false });
    await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, 0, { throwOnCommandError: false });
    await this.readHostAudioStatus();
  }

  private async updateHostAudioEngine(): Promise<void> {
    const settings = this.settingsStore.get();
    if (!settings.hostEncodedAudioEnabled || !this.device || !this.hostAudioCommandActive) {
      this.clearHostAudioReportQueue();
      await this.hostAudioEngine.stop();
      return;
    }
    await this.ensureHostAudioCapture(settings.speakerEnabled ? settings.speakerVolumePercent : 0);
  }

  private async startHostAudioSession(expectSettingsRevisionChange: boolean): Promise<void> {
    const settings = this.settingsStore.get();
    const speakerVolumePercent = settings.speakerEnabled ? settings.speakerVolumePercent : 0;
    const duplexEnabled = settings.duplexMicEnabled;
    const captureReady = await this.ensureHostAudioCapture(speakerVolumePercent);
    if (!captureReady) {
      await this.readHostAudioStatus();
      return;
    }
    if (this.hostAudioCommandActive) {
      await this.hostAudioEngine.start(this.devicePath, speakerVolumePercent);
      await this.readHostAudioStatus();
      return;
    }

    this.clearHostAudioReportQueue();
    await this.sendCommand(COMMAND_ID.SET_HOST_AUDIO_ENABLED, 1, { expectSettingsRevisionChange });
    this.hostAudioCommandActive = true;
    await this.sendCommand(COMMAND_ID.START_HOST_AUDIO, 0, { throwOnCommandError: false });
    await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, duplexEnabled ? 1 : 0, { throwOnCommandError: false });
    await this.sendCommand(COMMAND_ID.HOST_AUDIO_HEARTBEAT, 0, { throwOnCommandError: false });
    await this.sendHostAudioStreamReport(HOST_AUDIO_PACKET_TYPE.HELLO);
    await this.sendHostAudioStreamReport(
      duplexEnabled ? HOST_AUDIO_PACKET_TYPE.SET_DUPLEX_ENABLED : HOST_AUDIO_PACKET_TYPE.SET_DUPLEX_DISABLED
    );
    await this.sendHostAudioStreamReport(HOST_AUDIO_PACKET_TYPE.HEARTBEAT);
    await this.readHostAudioStatus();
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
    await this.readHostAudioStatus();
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
      if (
        !MIC_KEEPALIVE_ENABLED
        || !controllerConnected
        || !hostAudioActive
        || !settings.duplexMicEnabled
        || settings.micMuted
      ) {
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
      if (this.isHostAudioCaptureRetryPending()) {
        if (this.hostAudioCommandActive) {
          await this.deactivateHostAudioFirmwareAfterCaptureFailure();
        }
        await this.readHostAudioStatusThrottled(!this.hostAudioCommandActive);
        return;
      }
      const helperWasActive = this.hostAudioEngine.isActive();
      if (!helperWasActive) {
        await this.readHostAudioStatusThrottled(!this.hostAudioCommandActive);
      }
      if (!this.hostAudioCommandActive || (!helperWasActive && this.hostAudioStatus?.streamActive === false)) {
        const speakerVolumePercent = settings.speakerEnabled ? settings.speakerVolumePercent : 0;
        const captureReady = await this.ensureHostAudioCapture(speakerVolumePercent);
        if (!captureReady) {
          return;
        }
        await this.sendCommand(COMMAND_ID.SET_HOST_AUDIO_ENABLED, 1, { throwOnCommandError: false });
        this.hostAudioCommandActive = true;
        await this.sendCommand(COMMAND_ID.START_HOST_AUDIO, 0, { throwOnCommandError: false });
        await this.sendCommand(COMMAND_ID.SET_DUPLEX_ENABLED, settings.duplexMicEnabled ? 1 : 0, { throwOnCommandError: false });
        await this.readHostAudioStatus();
      } else {
        await this.updateHostAudioEngine();
      }
      const helperIsActive = this.hostAudioEngine.isActive();
      if (!helperIsActive) {
        await this.sendHostAudioStreamReport(HOST_AUDIO_PACKET_TYPE.HEARTBEAT);
      }
      if (this.hostAudioCommandActive) {
        await this.sendCommand(COMMAND_ID.HOST_AUDIO_HEARTBEAT, 0, { throwOnCommandError: false });
      }
      await this.readHostAudioStatusThrottled(
        false,
        helperIsActive ? HOST_AUDIO_HELPER_STATUS_READ_INTERVAL_MS : HOST_AUDIO_STATUS_READ_INTERVAL_MS
      );
      await this.pollShortcutEvent();
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
    let status: BridgeStatusPayload | null;
    try {
      status = await this.openAndReadStatus();
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        throw error;
      }
      this.noteControllerUnavailableForToasts();
      this.snapshot = {
        state: 'incompatible',
        message: FIRMWARE_UPDATE_REQUIRED_MESSAGE,
        status: null,
        settings: this.settingsStore.get(),
        diagnostics: this.withAudioDebugDiagnostics({
          ...emptyDiagnostics(rawDevices),
          hidPath: this.devicePath,
          lastError: error.message,
          lastPollAt: Date.now()
        })
      };
      this.emitSnapshot();
      return;
    }
    if (!status) {
      this.closeDevice();
      const normalFirmwarePresent = rawDevices.some(isDualSenseDevice);
      this.markBridgeUnavailableAfterDisconnect(rawDevices, normalFirmwarePresent);
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
          lastError: `Firmware ${status.firmwareVersion} is too old for this companion app. Update the bridge firmware to ${MIN_SUPPORTED_FIRMWARE_VERSION} or newer.`,
          lastPollAt: Date.now(),
          rawDevices
        })
      };
      this.emitSnapshot();
      return;
    }

    await this.readTriggerTraceThrottled();
    await this.readFeedbackTraceThrottled();
    if (hostAudioActive) {
      await this.readAudioDebugThrottled();
    }
    if (hostAudioActive && !this.hostAudioEngine.isActive()) {
      await this.readHostAudioStatusThrottled();
    } else if (!hostAudioActive) {
      await this.readAudioDebugThrottled(true);
      await this.readHostAudioStatus();
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
    if (!hostAudioActive) {
      await this.pollShortcutEvent();
    }
  }

  private async ensureCompanionDevice(): Promise<void> {
    if (this.device) {
      return;
    }
    await this.openAndReadStatus();
  }

  private async openAndReadStatus() {
    try {
      if (!this.device) {
        this.device = await WinUsbCompanionTransport.open();
        this.device.on('error', (error: Error) => this.publishError(error));
        this.device.on('close', () => {
          this.closeDevice();
          this.markBridgeUnavailableAfterDisconnect([]);
          this.emitSnapshot();
        });
        this.devicePath = this.device.path;
        this.shortcutFeaturePollingAvailable = true;
        this.lastUptimeSeconds = null;
        this.sessionKey = null;
        this.sessionPath = null;
        this.resetStartupReapplyState();
      }
      const status = parseStatusReport(await this.device.getFeatureReport(REPORT_ID.STATUS, REPORT_LENGTH));
      return status;
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw error;
      }
      this.closeDevice();
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
      if (!settings.hostEncodedAudioEnabled || this.hostAudioCommandActive) {
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
      if (settings.duplexMicEnabled) {
        await this.applyMicSettings(settings, expectSettingsRevisionChange);
      } else {
        await this.sendCommand(COMMAND_ID.SET_MIC_MUTE, 1, { throwOnCommandError: false });
      }
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
    const device = this.device;
    this.device = null;
    if (device) {
      try {
        device.removeAllListeners();
        device.close();
      } catch {
        // Ignore close races while Windows removes the WinUSB path.
      }
    }
    this.devicePath = null;
    this.hostAudioCommandActive = false;
    this.hostAudioStatus = null;
    this.triggerTraceSupported = null;
    this.feedbackTraceSupported = null;
    this.controllerPowerSavingActive = null;
    this.hostAudioReportQueue = [];
    this.hostAudioWritePumpActive = false;
    this.hostAudioFrameCount = 0;
    this.hostAudioChunkWriteCount = 0;
    this.hostAudioFrameDropCount = 0;
    this.clearHostAudioCaptureBackoff();
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
        triggerTraceLineCount: this.snapshot.diagnostics.triggerTraceLines.length,
        triggerTraceTail: this.snapshot.diagnostics.triggerTraceLines.at(-1) ?? null,
        triggerTraceDroppedCount: this.snapshot.diagnostics.triggerTraceDroppedCount,
        feedbackTraceLineCount: this.snapshot.diagnostics.feedbackTraceLines.length,
        feedbackTraceTail: this.snapshot.diagnostics.feedbackTraceLines.at(-1) ?? null,
        feedbackTraceDroppedCount: this.snapshot.diagnostics.feedbackTraceDroppedCount,
        hostAudioCaptureIssue: this.snapshot.diagnostics.hostAudioCaptureIssue,
        hostAudioCaptureRetry: this.snapshot.diagnostics.hostAudioCaptureRetry,
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
