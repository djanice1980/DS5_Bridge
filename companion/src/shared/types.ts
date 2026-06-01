import type {
  BridgeAckPayload,
  AudioDebugStatsPayload,
  BridgeStatusPayload,
  ButtonRemapMap,
  ButtonRemapProfile,
  ControllerProfile,
  HostAudioStatusPayload,
  BridgePresetId,
  MuteButtonMode,
  MuteKeyboardBehavior,
  PollingRateMode,
  TriggerTestMode
} from './protocol';

export type UiScalePercent = 75 | 100 | 125 | 150;

export interface CompanionSettings {
  selectedPresetId: BridgePresetId;
  uiScalePercent: UiScalePercent;
  launchAtStartupEnabled: boolean;
  hapticsEnabled: boolean;
  hapticsGainPercent: number;
  feedbackBoostEnabled: boolean;
  hapticsBufferLength: number;
  classicRumbleEnabled: boolean;
  classicRumbleGainPercent: number;
  adaptiveTriggersEnabled: boolean;
  triggerEffectIntensityPercent: number;
  triggerTestMode: TriggerTestMode;
  speakerEnabled: boolean;
  speakerVolumePercent: number;
  micVolumePercent: number;
  micMuted: boolean;
  lightbarEnabled: boolean;
  lightbarColor: string;
  lightbarBrightnessPercent: number;
  lightbarOverrideEnabled: boolean;
  muteButtonMode: MuteButtonMode;
  muteKeyboardUsage: number;
  muteKeyboardModifiers: number;
  muteKeyboardBehavior: MuteKeyboardBehavior;
  ledEnabled: boolean;
  idleDisconnectEnabled: boolean;
  idleDisconnectTimeoutMinutes: number;
  usbSuspendDisconnectEnabled: boolean;
  sleepKeybindEnabled: boolean;
  speakerVolumeShortcutEnabled: boolean;
  pollingRateMode: PollingRateMode;
  notifyControllerConnection: boolean;
  notifyLowBattery: boolean;
  hostEncodedAudioEnabled: boolean;
  duplexMicEnabled: boolean;
  controllerPowerSavingEnabled: boolean;
  selectedControllerProfileId: string;
  controllerProfiles: ControllerProfile[];
  selectedButtonRemappingProfileId: string;
  buttonRemappingProfiles: ButtonRemapProfile[];
  buttonRemappingDraft: ButtonRemapMap;
}

export interface HidDeviceSummary {
  path?: string;
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
  product?: string;
  manufacturer?: string;
  interface?: number;
}

export type BridgeStateKind =
  | 'no-bridge'
  | 'normal-firmware'
  | 'connected'
  | 'incompatible'
  | 'error';

export interface BridgeDiagnostics {
  hidPath: string | null;
  protocolVersion: string | null;
  uptimeSeconds: number | null;
  settingsRevision: number | null;
  lastAck: BridgeAckPayload | null;
  lastError: string | null;
  lastPollAt: number | null;
  rawDevices: HidDeviceSummary[];
  hostAudioCaptureIssue: HostAudioCaptureIssue | null;
  hostAudioCaptureRetry: HostAudioCaptureRetry | null;
  audioDebugLogPath: string | null;
  audioDebugLogLines: string[];
  audioDebugDroppedCount: number;
  audioDebugStats: AudioDebugStatsPayload | null;
  triggerTraceLines: string[];
  triggerTraceDroppedCount: number;
  feedbackTraceLines: string[];
  feedbackTraceDroppedCount: number;
  hostAudioStatus: HostAudioStatusPayload | null;
}

export interface HostAudioCaptureIssue {
  reason: 'device-in-use' | 'device-invalidated' | 'unsupported-format' | 'bulk-pcm-unavailable' | 'start-timeout' | 'helper-exit';
  message: string;
  retryAt: number;
}

export interface HostAudioCaptureRetry {
  reason: 'device-in-use' | 'device-invalidated' | 'unsupported-format' | 'bulk-pcm-unavailable' | 'start-timeout' | 'helper-exit';
  message: string;
  retryAt: number;
}

export interface BridgeSnapshot {
  state: BridgeStateKind;
  message: string;
  status: BridgeStatusPayload | null;
  settings: CompanionSettings;
  diagnostics: BridgeDiagnostics;
}

export interface WindowsDeviceCleanupResult {
  scriptPath: string;
  logPath: string;
  includedBluetooth: boolean;
  message: string;
}
