import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LucideIcon,
  Activity,
  Bell,
  Check,
  ChevronDown,
  Keyboard,
  Mic,
  Minus,
  Moon,
  MoreHorizontal,
  Palette,
  Play,
  RefreshCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Vibrate,
  Volume2,
  VolumeX,
  X,
  Zap
} from 'lucide-react';
import bridgeMarkUrl from '../../../assets/controllers/ds5-bridge_mark.svg';
import controllerImage from '../../../assets/controllers/dualsense-edge-front.svg';
import testSpeakerToneUrl from './assets/test-speaker-tone-silence-tail.mp3';
import { ackResultName } from '../shared/protocol';
import type { BridgePresetId, MuteButtonMode, MuteKeyboardBehavior, PollingRateMode, TriggerTestMode, TriggerTestTarget } from '../shared/protocol';
import type { BridgeSnapshot } from '../shared/types';

type ControlTab = 'haptics' | 'audio' | 'triggers' | 'lighting' | 'system';
type LightbarPaletteCell = {
  color: string;
  name: string;
};

const HAPTICS_STEP = 20;
const SPEAKER_VOLUME_STEP = 10;
const MIC_VOLUME_STEP = 10;
const LIGHTBAR_BRIGHTNESS_STEP = 10;
const TRIGGER_EFFECT_STEP = 10;
const TEST_HAPTICS_LOCK_MS = 1100;
const TEST_SPEAKER_LOCK_MS = 900;
const TEST_MIC_LISTEN_MS = 5000;
const TEST_SPEAKER_VOLUME_SETTLE_MS = 90;
const HOST_AUDIO_INITIAL_START_GRACE_MS = 2500;
const TEST_SPEAKER_ENDPOINT_ATTEMPTS = 12;
const TEST_SPEAKER_ENDPOINT_RETRY_MS = 150;
const TEST_SPEAKER_ENDPOINT_REFRESH_MS = 1500;
const TEST_SPEAKER_ENDPOINT_VERIFY_MS = 100;
const TEST_SPEAKER_PREROLL_MS = 220;
const TEST_TRIGGER_LOCK_MS = 2800;
const SLEEP_CONFIRM_MS = 2400;
const LIGHTBAR_SWATCHES = ['#ffff00', '#0000ff', '#00ff00', '#ff0000', '#8000ff', '#ffffff'];
const LIGHTBAR_SWATCH_NAMES: Record<string, string> = {
  '#ffff00': 'Yellow',
  '#0000ff': 'Blue',
  '#00ff00': 'Green',
  '#ff0000': 'Red',
  '#8000ff': 'Violet',
  '#ffffff': 'White'
};
const LIGHTBAR_DEFAULT_CUSTOM_COLOR = '#7b61ff';
const LIGHTBAR_CUSTOM_PALETTE = makeLightbarCustomPalette();
const LIGHTBAR_COLOR_NAMES = makeLightbarColorNames();
const LIGHTBAR_PRESETS: Array<[string, number]> = [
  ['Low', 30],
  ['Medium', 50],
  ['High', 100]
];
const HAPTICS_PRESETS: Array<[string, number]> = [
  ['Low', 50],
  ['Medium', 100],
  ['High', 150]
];
const SPEAKER_VOLUME_PRESETS: Array<[string, number]> = [
  ['Low', 30],
  ['Medium', 70],
  ['High', 100]
];
const MIC_VOLUME_PRESETS: Array<[string, number]> = [
  ['Low', 30],
  ['Medium', 70],
  ['High', 100]
];
const TRIGGER_EFFECT_PRESETS: Array<[string, number]> = [
  ['Low', 30],
  ['Medium', 70],
  ['High', 100]
];
const PERCENT_SLIDER_TICKS = Array.from({ length: 11 }, (_, index) => index * 10);
const HAPTICS_SLIDER_TICKS = Array.from({ length: 11 }, (_, index) => index * 20);
const BRIDGE_AUDIO_OUTPUT_RE = /ds5|dualsense|dual sense|wireless controller|bridge/i;
const BRIDGE_AUDIO_INPUT_RE = /ds5|dualsense|dual sense|wireless controller|bridge/i;
const BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE = 'DualSense audio endpoint unavailable';
const BRIDGE_MIC_ENDPOINT_UNAVAILABLE = 'DualSense microphone unavailable';
const MUTE_KEY_OPTIONS: Array<[string, number]> = [
  ['F1', 0x3A], ['F2', 0x3B], ['F3', 0x3C], ['F4', 0x3D], ['F5', 0x3E], ['F6', 0x3F],
  ['F7', 0x40], ['F8', 0x41], ['F9', 0x42], ['F10', 0x43], ['F11', 0x44], ['F12', 0x45],
  ['F13', 0x68], ['F14', 0x69], ['F15', 0x6A], ['F16', 0x6B], ['F17', 0x6C], ['F18', 0x6D],
  ['F19', 0x6E], ['F20', 0x6F], ['F21', 0x70], ['F22', 0x71], ['F23', 0x72], ['F24', 0x73],
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter, index) => [letter, 0x04 + index] as [string, number]),
  ['1', 0x1E], ['2', 0x1F], ['3', 0x20], ['4', 0x21], ['5', 0x22],
  ['6', 0x23], ['7', 0x24], ['8', 0x25], ['9', 0x26], ['0', 0x27],
  ['Enter', 0x28], ['Escape', 0x29], ['Backspace', 0x2A], ['Tab', 0x2B], ['Space', 0x2C],
  ['-', 0x2D], ['=', 0x2E], ['[', 0x2F], [']', 0x30], ['\\', 0x31],
  [';', 0x33], ["'", 0x34], ['`', 0x35], [',', 0x36], ['.', 0x37], ['/', 0x38],
  ['Insert', 0x49], ['Home', 0x4A], ['Page Up', 0x4B], ['Delete', 0x4C], ['End', 0x4D], ['Page Down', 0x4E],
  ['Right Arrow', 0x4F], ['Left Arrow', 0x50], ['Down Arrow', 0x51], ['Up Arrow', 0x52]
];
const MUTE_MODIFIER_OPTIONS: Array<[string, number]> = [
  ['Ctrl', 0x01],
  ['Shift', 0x02],
  ['Alt', 0x04],
  ['Win', 0x08]
];
const TRIGGER_TEST_MODE_OPTIONS: Array<[string, TriggerTestMode]> = [
  ['Feedback', 'feedback'],
  ['Weapon', 'weapon'],
  ['Vibration', 'vibration']
];
const BRIDGE_PRESET_OPTIONS: Array<[string, BridgePresetId]> = [
  ['Custom', 'custom'],
  ['Balanced', 'balanced'],
  ['Quiet', 'quiet'],
  ['No Speaker', 'no-speaker'],
  ['No Haptics', 'no-haptics'],
  ['No Triggers', 'no-triggers'],
  ['Lights Off', 'lights-off']
];
const MUTE_BUTTON_MODE_OPTIONS: Array<[string, MuteButtonMode]> = [
  ['Normal', 'normal'],
  ['Keyboard Key', 'keyboard'],
  ['Quiet Toggle', 'quiet']
];
const MUTE_KEYBOARD_BEHAVIOR_OPTIONS: Array<[string, MuteKeyboardBehavior]> = [
  ['Tap Once', 'tap'],
  ['Hold While Pressed', 'hold']
];
const POLLING_RATE_OPTIONS: Array<[string, PollingRateMode]> = [
  ['1000 Hz / Real-time', '1000'],
  ['500 Hz', '500'],
  ['250 Hz', '250']
];
const TRIGGER_TARGET_OPTIONS: Array<[string, TriggerTestTarget]> = [
  ['L2', 'l2'],
  ['R2', 'r2'],
  ['Both Triggers', 'both']
];
const CONTROL_TABS: Array<{ id: ControlTab; label: string; Icon: LucideIcon }> = [
  { id: 'haptics', label: 'Haptics', Icon: Sparkles },
  { id: 'audio', label: 'Audio', Icon: Volume2 },
  { id: 'triggers', label: 'Triggers', Icon: Zap },
  { id: 'lighting', label: 'Lighting', Icon: Palette },
  { id: 'system', label: 'System', Icon: Settings2 }
];

type SelectValue = string | number;
type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
  sinkId?: string;
};
type CustomSelectProps<T extends SelectValue> = {
  value: T;
  options: Array<[string, T]>;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: T) => void;
};

function snapHapticsValue(value: number): number {
  return Math.max(0, Math.min(200, Math.round(value / HAPTICS_STEP) * HAPTICS_STEP));
}

function snapSpeakerVolume(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / SPEAKER_VOLUME_STEP) * SPEAKER_VOLUME_STEP));
}

function snapMicVolume(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / MIC_VOLUME_STEP) * MIC_VOLUME_STEP));
}

function snapLightbarBrightness(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / LIGHTBAR_BRIGHTNESS_STEP) * LIGHTBAR_BRIGHTNESS_STEP));
}

function snapTriggerEffectIntensity(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value / TRIGGER_EFFECT_STEP) * TRIGGER_EFFECT_STEP));
}

function sliderTickClass(value: number, max: number): string | undefined {
  if (value === 0 || value === max) {
    return 'milestone endpoint';
  }
  if (value === max / 2) {
    return 'milestone';
  }
  return undefined;
}

function normalizeHexColor(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : '#ffff00';
}

function normalizeLightbarPresetColor(value: string): string {
  return normalizeHexColor(value);
}

function isLightbarPresetColor(value: string): boolean {
  return LIGHTBAR_SWATCHES.includes(normalizeLightbarPresetColor(value));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const normalizedHue = (((hue % 360) + 360) % 360) / 360;
  const normalizedSaturation = Math.max(0, Math.min(100, saturation)) / 100;
  const normalizedLightness = Math.max(0, Math.min(100, lightness)) / 100;

  if (normalizedSaturation === 0) {
    const channel = clampByte(normalizedLightness * 255);
    return rgbToHex(channel, channel, channel);
  }

  const q = normalizedLightness < 0.5
    ? normalizedLightness * (1 + normalizedSaturation)
    : normalizedLightness + normalizedSaturation - normalizedLightness * normalizedSaturation;
  const p = 2 * normalizedLightness - q;
  const hueToRgb = (offset: number) => {
    let t = normalizedHue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  return rgbToHex(hueToRgb(1 / 3) * 255, hueToRgb(0) * 255, hueToRgb(-1 / 3) * 255);
}

function makeLightbarCustomPalette(): LightbarPaletteCell[][] {
  const hues = [
    { hue: 0, name: 'Red' },
    { hue: 30, name: 'Orange' },
    { hue: 60, name: 'Yellow' },
    { hue: 90, name: 'Lime' },
    { hue: 120, name: 'Green' },
    { hue: 150, name: 'Mint' },
    { hue: 180, name: 'Cyan' },
    { hue: 210, name: 'Sky' },
    { hue: 240, name: 'Blue' },
    { hue: 270, name: 'Violet' },
    { hue: 300, name: 'Magenta' },
    { hue: 330, name: 'Rose' }
  ];
  const rows = [
    { saturation: 28, lightness: 88, tone: 'Pale', gray: '#ffffff', grayName: 'White' },
    { saturation: 58, lightness: 78, tone: 'Soft', gray: '#d9d9d9', grayName: 'Light Gray' },
    { saturation: 82, lightness: 66, tone: 'Light', gray: '#b3b3b3', grayName: 'Silver' },
    { saturation: 100, lightness: 58, tone: 'Bright', gray: '#8a8a8a', grayName: 'Gray' },
    { saturation: 100, lightness: 50, tone: 'Pure', gray: '#666666', grayName: 'Dim Gray' },
    { saturation: 100, lightness: 40, tone: 'Deep', gray: '#4a4a4a', grayName: 'Charcoal' },
    { saturation: 100, lightness: 30, tone: 'Dark', gray: '#333333', grayName: 'Dark Gray' },
    { saturation: 100, lightness: 20, tone: 'Midnight', gray: '#1a1a1a', grayName: 'Near Black' },
    { saturation: 100, lightness: 10, tone: 'Blackened', gray: '#000000', grayName: 'Black' }
  ];
  return rows.map((row) => [
    ...hues.map((hue) => ({
      color: hslToHex(hue.hue, row.saturation, row.lightness),
      name: `${row.tone} ${hue.name}`
    })),
    {
      color: row.gray,
      name: row.grayName
    }
  ]);
}

function makeLightbarColorNames(): Record<string, string> {
  const names = { ...LIGHTBAR_SWATCH_NAMES };
  for (const row of LIGHTBAR_CUSTOM_PALETTE) {
    for (const cell of row) {
      names[cell.color] ??= cell.name;
    }
  }
  names[LIGHTBAR_DEFAULT_CUSTOM_COLOR] = 'Custom';
  return names;
}

function lightbarColorFromSnapshot(snapshot: BridgeSnapshot): string {
  if (snapshot.status?.firmwareFlags.lightbarControl) {
    const color = snapshot.status.lightbarColor;
    return normalizeLightbarPresetColor(rgbToHex(color.red, color.green, color.blue));
  }
  return normalizeLightbarPresetColor(snapshot.settings.lightbarColor);
}

function lightbarBrightnessFromSnapshot(snapshot: BridgeSnapshot): number {
  if (snapshot.status?.firmwareFlags.lightbarControl) {
    return snapshot.status.lightbarColor.brightnessPercent;
  }
  return snapshot.settings.lightbarBrightnessPercent;
}

function batteryLabel(snapshot: BridgeSnapshot | null | undefined): string {
  const battery = snapshot?.status?.batteryPercent;
  return battery === null || battery === undefined ? '--' : `${battery}%`;
}

function batteryTone(percent: number | null | undefined): 'healthy' | 'warning' | 'low' | 'unknown' {
  if (percent === null || percent === undefined) return 'unknown';
  if (percent <= 20) return 'low';
  if (percent <= 45) return 'warning';
  return 'healthy';
}

function isChargingPowerState(rawPowerState: number | undefined): boolean {
  return rawPowerState === 0x01 || rawPowerState === 0x02;
}

function controllerName(type: string | undefined): string {
  if (type === 'dualsense-edge') return 'DualSense Edge';
  if (type === 'dualsense') return 'DualSense';
  return 'Controller';
}

function healthLabel(snapshot: BridgeSnapshot | null | undefined): string {
  if (!snapshot) return 'Unavailable';
  if (snapshot.state !== 'connected') return snapshot.message;
  if (snapshot.diagnostics.lastError) return snapshot.diagnostics.lastError;
  return 'All systems normal';
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase();
}

function bridgeAudioOutputScore(device: MediaDeviceInfo): number {
  const label = device.label.toLowerCase();
  let score = 1;
  if (label.includes('dualsense') || label.includes('dual sense')) score += 4;
  if (label.includes('wireless controller')) score += 3;
  if (label.includes('speaker')) score += 2;
  if (label.includes('ds5') || label.includes('bridge')) score += 1;
  return score;
}

function bridgeAudioInputScore(device: MediaDeviceInfo): number {
  const label = device.label.toLowerCase();
  let score = 1;
  if (label.includes('dualsense') || label.includes('dual sense')) score += 4;
  if (label.includes('wireless controller')) score += 3;
  if (label.includes('microphone') || label.includes('mic')) score += 2;
  if (label.includes('ds5') || label.includes('bridge')) score += 1;
  return score;
}

async function findBridgeAudioOutputIdOnce(): Promise<string | null> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return null;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((device) => (
      device.kind === 'audiooutput'
      && BRIDGE_AUDIO_OUTPUT_RE.test(device.label)
      && device.deviceId
      && device.deviceId !== 'default'
      && device.deviceId !== 'communications'
    ));
    outputs.sort((left, right) => bridgeAudioOutputScore(right) - bridgeAudioOutputScore(left));
    const output = outputs[0];
    return output?.deviceId ?? null;
  } catch {
    return null;
  }
}

async function findBridgeAudioInputIdOnce(): Promise<string | null> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return null;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => (
      device.kind === 'audioinput'
      && BRIDGE_AUDIO_INPUT_RE.test(device.label)
      && device.deviceId
      && device.deviceId !== 'default'
      && device.deviceId !== 'communications'
    ));
    inputs.sort((left, right) => bridgeAudioInputScore(right) - bridgeAudioInputScore(left));
    const input = inputs[0];
    return input?.deviceId ?? null;
  } catch {
    return null;
  }
}

async function findBridgeAudioInputId(): Promise<string | null> {
  let inputId = await findBridgeAudioInputIdOnce();
  if (inputId || !navigator.mediaDevices?.getUserMedia) {
    return inputId;
  }

  let permissionStream: MediaStream | null = null;
  try {
    permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    return null;
  } finally {
    permissionStream?.getTracks().forEach((track) => track.stop());
  }

  inputId = await findBridgeAudioInputIdOnce();
  return inputId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

let speakerPrerollSilenceUrl: string | null = null;

function getSpeakerPrerollSilenceUrl(): string {
  if (speakerPrerollSilenceUrl) {
    return speakerPrerollSilenceUrl;
  }

  const sampleRate = 48000;
  const channels = 2;
  const bytesPerSample = 2;
  const frames = Math.round((sampleRate * TEST_SPEAKER_PREROLL_MS) / 1000);
  const dataSize = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  speakerPrerollSilenceUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return speakerPrerollSilenceUrl;
}

async function findBridgeAudioOutputId(attempts = 1): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sinkId = await findBridgeAudioOutputIdOnce();
    if (sinkId) {
      return sinkId;
    }
    if (attempt + 1 < attempts) {
      await delay(TEST_SPEAKER_ENDPOINT_RETRY_MS);
    }
  }
  return null;
}

let speakerToneAudio: SinkSelectableAudio | null = null;
let speakerToneSinkId: string | null = null;

function resetSpeakerToneAudio(): void {
  if (speakerToneAudio) {
    try {
      speakerToneAudio.pause();
      speakerToneAudio.removeAttribute('src');
      speakerToneAudio.load();
    } catch {
      // Ignore teardown races while Windows is removing the audio endpoint.
    }
  }
  speakerToneAudio = null;
  speakerToneSinkId = null;
}

async function playSpeakerAudioSource(sourceUrl: string): Promise<void> {
  const sinkId = await findBridgeAudioOutputId(TEST_SPEAKER_ENDPOINT_ATTEMPTS);
  if (!sinkId) {
    throw new Error(BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE);
  }

  // Reuse the persistent Audio element if the endpoint hasn't changed.
  // This keeps the WASAPI session alive so the firmware audio pipeline stays warm.
  if (!speakerToneAudio || speakerToneSinkId !== sinkId) {
    const audio = new Audio() as SinkSelectableAudio;
    audio.volume = 1;
    if (!audio.setSinkId) {
      throw new Error(BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE);
    }
    try {
      await audio.setSinkId(sinkId);
    } catch {
      throw new Error(BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE);
    }
    if (audio.sinkId !== undefined && audio.sinkId !== sinkId) {
      throw new Error(BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE);
    }
    speakerToneAudio = audio;
    speakerToneSinkId = sinkId;
  }

  const audio = speakerToneAudio;
  audio.src = sourceUrl;
  audio.currentTime = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const mediaDevices = navigator.mediaDevices;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const verifySink = () => {
      void (async () => {
        const currentSinkId = await findBridgeAudioOutputIdOnce();
        if (
          currentSinkId !== sinkId
          || (audio.sinkId !== undefined && audio.sinkId !== sinkId)
        ) {
          resetSpeakerToneAudio();
          fail(new Error(BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE));
        }
      })();
    };
    const verifyTimer = window.setInterval(verifySink, TEST_SPEAKER_ENDPOINT_VERIFY_MS);
    function cleanup() {
      window.clearInterval(verifyTimer);
      audio.removeEventListener('ended', finish);
      audio.removeEventListener('error', onAudioError);
      mediaDevices?.removeEventListener?.('devicechange', verifySink);
    }
    function onAudioError() {
      fail(new Error('Speaker test audio playback failed.'));
    }

    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', onAudioError, { once: true });
    mediaDevices?.addEventListener?.('devicechange', verifySink);
    audio.play().then(verifySink).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error('Speaker test audio playback failed.'));
    });
  });
}

async function playSpeakerToneFile(): Promise<void> {
  await playSpeakerAudioSource(getSpeakerPrerollSilenceUrl());
  await delay(25);
  await playSpeakerAudioSource(testSpeakerToneUrl);
}

let micListenAudio: HTMLAudioElement | null = null;
let micListenStream: MediaStream | null = null;
let micListenTimer: number | null = null;
let micListenResolve: (() => void) | null = null;

function stopMicLiveListen(): void {
  if (micListenTimer !== null) {
    window.clearTimeout(micListenTimer);
  }
  micListenTimer = null;
  if (micListenAudio) {
    try {
      micListenAudio.pause();
      micListenAudio.srcObject = null;
    } catch {
      // Ignore teardown races while the mic endpoint is closing.
    }
  }
  micListenAudio = null;
  micListenStream?.getTracks().forEach((track) => track.stop());
  micListenStream = null;
  const resolve = micListenResolve;
  micListenResolve = null;
  resolve?.();
}

async function openBridgeMicStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(BRIDGE_MIC_ENDPOINT_UNAVAILABLE);
  }

  const inputId = await findBridgeAudioInputId();
  if (!inputId) {
    throw new Error(BRIDGE_MIC_ENDPOINT_UNAVAILABLE);
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: inputId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  });
}

async function playMicLiveListen(durationMs: number): Promise<void> {
  stopMicLiveListen();
  const stream = await openBridgeMicStream();
  const audio = new Audio();
  audio.srcObject = stream;
  audio.volume = 1;
  micListenAudio = audio;
  micListenStream = stream;

  try {
    await audio.play();
  } catch (error) {
    stopMicLiveListen();
    throw error;
  }

  await new Promise<void>((resolve) => {
    micListenResolve = resolve;
    micListenTimer = window.setTimeout(stopMicLiveListen, durationMs);
  });
}

function CustomSelect<T extends SelectValue>({
  value,
  options,
  disabled = false,
  ariaLabel,
  onChange
}: CustomSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find(([, optionValue]) => optionValue === value);
  const longList = options.length > 18;
  const defaultMenuMaxHeight = longList ? 360 : 232;
  const [menuMaxHeight, setMenuMaxHeight] = useState(defaultMenuMaxHeight);

  function updateMenuMaxHeight() {
    const root = rootRef.current;
    if (!root) {
      setMenuMaxHeight(defaultMenuMaxHeight);
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const boundary = root.closest('.system-card, .feature-card, .settings-menu, .control-page') as HTMLElement | null;
    const boundaryRect = boundary?.getBoundingClientRect();
    const menuGap = 6;
    const lowerLimit = Math.min(window.innerHeight, boundaryRect?.bottom ?? window.innerHeight);
    const spaceBelow = Math.max(1, Math.floor(lowerLimit - rootRect.bottom - menuGap));
    const nextMaxHeight = longList ? spaceBelow : Math.min(defaultMenuMaxHeight, spaceBelow);

    setMenuMaxHeight(Math.max(1, nextMaxHeight));
  }

  useEffect(() => {
    if (!open) return undefined;
    function closeIfOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', closeIfOutside);
    return () => document.removeEventListener('mousedown', closeIfOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    updateMenuMaxHeight();
    window.addEventListener('resize', updateMenuMaxHeight);
    window.addEventListener('scroll', updateMenuMaxHeight, true);
    return () => {
      window.removeEventListener('resize', updateMenuMaxHeight);
      window.removeEventListener('scroll', updateMenuMaxHeight, true);
    };
  }, [open, defaultMenuMaxHeight, longList]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      const menu = menuRef.current;
      const selectedElement = menu?.querySelector('[data-selected="true"]') as HTMLElement | null;
      if (!menu || !selectedElement) {
        return;
      }
      const selectedCenter = selectedElement.offsetTop + selectedElement.offsetHeight / 2;
      menu.scrollTop = Math.max(0, selectedCenter - menu.clientHeight / 2);
    });
  }, [open]);

  function choose(nextValue: T) {
    setOpen(false);
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }

  function toggleOpen() {
    if (!open) {
      updateMenuMaxHeight();
    }
    setOpen((nextOpen) => !nextOpen);
  }

  function openMenu() {
    updateMenuMaxHeight();
    setOpen(true);
  }

  return (
    <div
      ref={rootRef}
      className={`custom-select ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
      style={{ '--custom-select-menu-max-height': `${menuMaxHeight}px` } as CSSProperties}
    >
      <button
        type="button"
        className="custom-select-button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openMenu();
          }
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
      >
        <span>{selected?.[0] ?? String(value)}</span>
        <ChevronDown size={18} />
      </button>
      {open && (
        <div ref={menuRef} className="custom-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map(([label, optionValue]) => {
            const selectedOption = optionValue === value;
            return (
              <button
                key={String(optionValue)}
                type="button"
                role="option"
                aria-selected={selectedOption}
                data-selected={selectedOption ? 'true' : undefined}
                className={selectedOption ? 'selected' : ''}
                onClick={() => choose(optionValue)}
              >
                <span>{label}</span>
                {selectedOption && <Check size={15} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UptimeValue({
  active,
  lastPollAt,
  uptimeSeconds
}: {
  active: boolean;
  lastPollAt: number | null;
  uptimeSeconds: number | null;
}) {
  const [displayUptime, setDisplayUptime] = useState<number | null>(uptimeSeconds);

  useEffect(() => {
    if (!active || !lastPollAt || uptimeSeconds === null) {
      setDisplayUptime(uptimeSeconds);
      return;
    }

    const updateUptime = () => {
      const elapsedSeconds = Math.floor((Date.now() - lastPollAt) / 1000);
      setDisplayUptime(uptimeSeconds + Math.max(0, elapsedSeconds));
    };

    updateUptime();
    const handle = window.setInterval(updateUptime, 1000);
    return () => window.clearInterval(handle);
  }, [active, lastPollAt, uptimeSeconds]);

  return <span className="uptime-value">{displayUptime ?? '--'}s</span>;
}

export function App() {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [activeControlTab, setActiveControlTab] = useState<ControlTab>('haptics');
  const [hapticsValue, setHapticsValue] = useState(100);
  const [classicRumbleValue, setClassicRumbleValue] = useState(100);
  const [speakerVolumeValue, setSpeakerVolumeValue] = useState(100);
  const [micVolumeValue, setMicVolumeValue] = useState(100);
  const [lightbarColor, setLightbarColor] = useState('#ffff00');
  const [customLightbarColor, setCustomLightbarColor] = useState<string | null>(() => {
    const saved = window.localStorage.getItem('ds5bridge.customLightbarColor');
    if (!saved || !/^#[0-9a-fA-F]{6}$/.test(saved)) return null;
    const color = normalizeLightbarPresetColor(saved);
    return LIGHTBAR_SWATCHES.includes(color) ? null : color;
  });
  const [customColorDraft, setCustomColorDraft] = useState(LIGHTBAR_DEFAULT_CUSTOM_COLOR);
  const [showCustomColorPicker, setShowCustomColorPicker] = useState(false);
  const [customSwatchPrimed, setCustomSwatchPrimed] = useState(false);
  const [lightbarBrightnessValue, setLightbarBrightnessValue] = useState(100);
  const [triggerEffectIntensityValue, setTriggerEffectIntensityValue] = useState(100);
  const [triggerTarget, setTriggerTarget] = useState<TriggerTestTarget>('both');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [showBridgeSettings, setShowBridgeSettings] = useState(false);
  const [showNotificationsMenu, setShowNotificationsMenu] = useState(false);
  const [showClassicRumbleControl, setShowClassicRumbleControl] = useState(false);
  const [showMicrophoneControl, setShowMicrophoneControl] = useState(false);
  const [testLocked, setTestLocked] = useState(false);
  const [speakerTestLocked, setSpeakerTestLocked] = useState(false);
  const [speakerOutputAvailable, setSpeakerOutputAvailable] = useState<boolean | null>(null);
  const [speakerTestError, setSpeakerTestError] = useState<string | null>(null);
  const [micTestLocked, setMicTestLocked] = useState(false);
  const [micTestError, setMicTestError] = useState<string | null>(null);
  const [triggerTestLocked, setTriggerTestLocked] = useState(false);
  const [hapticsCommitPending, setHapticsCommitPending] = useState(false);
  const [classicRumbleCommitPending, setClassicRumbleCommitPending] = useState(false);
  const [speakerVolumeCommitPending, setSpeakerVolumeCommitPending] = useState(false);
  const [micVolumeCommitPending, setMicVolumeCommitPending] = useState(false);
  const [lightbarCommitPending, setLightbarCommitPending] = useState(false);
  const [sleepConfirmVisible, setSleepConfirmVisible] = useState(false);
  const hapticsEditingRef = useRef(false);
  const classicRumbleEditingRef = useRef(false);
  const speakerVolumeEditingRef = useRef(false);
  const micVolumeEditingRef = useRef(false);
  const lightbarBrightnessEditingRef = useRef(false);
  const triggerEffectEditingRef = useRef(false);
  const bridgeSettingsRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);
  const customColorPickerRef = useRef<HTMLDivElement>(null);
  const customSwatchPrimeTimerRef = useRef<number | null>(null);
  const sleepConfirmTimerRef = useRef<number | null>(null);
  const sleepConfirmArmedRef = useRef(false);
  const sleepTogglePromiseRef = useRef<Promise<void> | null>(null);
  const appOpenedAtRef = useRef(Date.now());
  const connected = snapshot?.state === 'connected';

  useEffect(() => {
    let cancelled = false;
    window.bridge.getStatus().then((next) => {
      if (!cancelled) {
        setSnapshot(next);
        setHapticsValue(snapHapticsValue(next.settings.hapticsGainPercent));
        setClassicRumbleValue(snapHapticsValue(next.settings.classicRumbleGainPercent));
        setSpeakerVolumeValue(snapSpeakerVolume(next.settings.speakerVolumePercent));
        setMicVolumeValue(snapMicVolume(next.settings.micVolumePercent));
        const nextLightbarColor = lightbarColorFromSnapshot(next);
        setLightbarColor(nextLightbarColor);
        if (!isLightbarPresetColor(nextLightbarColor)) {
          setCustomLightbarColor(nextLightbarColor);
          setCustomColorDraft(nextLightbarColor);
          window.localStorage.setItem('ds5bridge.customLightbarColor', nextLightbarColor);
        }
        setLightbarBrightnessValue(snapLightbarBrightness(lightbarBrightnessFromSnapshot(next)));
        setTriggerEffectIntensityValue(snapTriggerEffectIntensity(next.settings.triggerEffectIntensityPercent));
      }
    });
    const unsubscribe = window.bridge.onSnapshot((next) => {
      setSnapshot(next);
      if (!hapticsEditingRef.current) {
        setHapticsValue(snapHapticsValue(next.settings.hapticsGainPercent));
      }
      if (!classicRumbleEditingRef.current) {
        setClassicRumbleValue(snapHapticsValue(next.settings.classicRumbleGainPercent));
      }
      if (!speakerVolumeEditingRef.current) {
        setSpeakerVolumeValue(snapSpeakerVolume(next.settings.speakerVolumePercent));
      }
      if (!micVolumeEditingRef.current) {
        setMicVolumeValue(snapMicVolume(next.settings.micVolumePercent));
      }
      const nextLightbarColor = lightbarColorFromSnapshot(next);
      setLightbarColor(nextLightbarColor);
      if (!isLightbarPresetColor(nextLightbarColor)) {
        setCustomLightbarColor(nextLightbarColor);
        setCustomColorDraft(nextLightbarColor);
        window.localStorage.setItem('ds5bridge.customLightbarColor', nextLightbarColor);
      }
      if (!lightbarBrightnessEditingRef.current) {
        setLightbarBrightnessValue(snapLightbarBrightness(lightbarBrightnessFromSnapshot(next)));
      }
      if (!triggerEffectEditingRef.current) {
        setTriggerEffectIntensityValue(snapTriggerEffectIntensity(next.settings.triggerEffectIntensityPercent));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (customSwatchPrimeTimerRef.current !== null) {
        window.clearTimeout(customSwatchPrimeTimerRef.current);
      }
      if (sleepConfirmTimerRef.current !== null) {
        window.clearTimeout(sleepConfirmTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showBridgeSettings && !showNotificationsMenu) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (showBridgeSettings && !bridgeSettingsRef.current?.contains(event.target as Node)) {
        setShowBridgeSettings(false);
      }
      if (showNotificationsMenu && !notificationsRef.current?.contains(event.target as Node)) {
        setShowNotificationsMenu(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowBridgeSettings(false);
        setShowNotificationsMenu(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showBridgeSettings, showNotificationsMenu]);

  useEffect(() => {
    let cancelled = false;
    const mediaDevices = navigator.mediaDevices;

    async function refreshSpeakerOutput() {
      const available = Boolean(await findBridgeAudioOutputId(2));
      if (cancelled) {
        return;
      }
      setSpeakerOutputAvailable(available);
      if (available) {
        setSpeakerTestError(null);
      }
    }

    function handleDeviceChange() {
      resetSpeakerToneAudio();
      void refreshSpeakerOutput();
    }

    void refreshSpeakerOutput();
    mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);

    return () => {
      cancelled = true;
      mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
    };
  }, []);

  useEffect(() => {
    if (!connected) {
      resetSpeakerToneAudio();
    }
  }, [connected]);

  useEffect(() => {
    if (!showCustomColorPicker) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!customColorPickerRef.current?.contains(event.target as Node)) {
        setShowCustomColorPicker(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowCustomColorPicker(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showCustomColorPicker]);

  const batteryPercent = Math.max(0, Math.min(100, snapshot?.status?.batteryPercent ?? 0));
  const batteryPercentLabel = batteryLabel(snapshot);
  const batteryLevelTone = batteryTone(snapshot?.status?.batteryPercent);
  const batteryCharging = isChargingPowerState(snapshot?.status?.rawPowerState);
  const batterySegmentCount = connected
    ? batteryPercent >= 67
      ? 3
      : batteryPercent >= 34
        ? 2
        : batteryPercent > 0
          ? 1
          : 0
    : 0;
  const batteryChargingSegment = connected && batteryCharging && batteryPercent < 100
    ? Math.min(2, batterySegmentCount)
    : -1;
  const batteryCritical = connected && !batteryCharging && batteryPercent > 0 && batteryPercent <= 20;
  const statusTone = connected ? 'good' : snapshot?.state === 'error' || snapshot?.state === 'incompatible' ? 'bad' : 'idle';
  const lastAck = snapshot?.diagnostics.lastAck;
  const speakerVolumeSupported = Boolean(snapshot?.status?.firmwareFlags.speakerVolumeControl);
  const lightbarSupported = Boolean(snapshot?.status?.firmwareFlags.lightbarControl);
  const lightbarOverrideSupported = Boolean(snapshot?.status?.firmwareFlags.lightbarOverrideControl);
  const muteButtonActionsSupported = Boolean(snapshot?.status?.firmwareFlags.muteButtonActions);
  const adaptiveTriggersSupported = Boolean(snapshot?.status?.firmwareFlags.adaptiveTriggersControl);
  const usbSuspendDisconnectSupported = Boolean(snapshot?.status?.firmwareFlags.usbSuspendDisconnectControl);
  const sleepControllerSupported = Boolean(snapshot?.status?.firmwareFlags.sleepControllerControl);
  const pollingRateControlSupported = Boolean(snapshot?.status?.firmwareFlags.pollingRateControl);
  const hapticsEnabled = Boolean(snapshot?.settings.hapticsEnabled);
  const classicRumbleEnabled = Boolean(snapshot?.settings.classicRumbleEnabled);
  const activeHapticsFeatureEnabled = showClassicRumbleControl ? classicRumbleEnabled : hapticsEnabled;
  const speakerEnabled = Boolean(snapshot?.settings.speakerEnabled);
  const adaptiveTriggersEnabled = Boolean(snapshot?.settings.adaptiveTriggersEnabled);
  const lightbarEnabled = Boolean(snapshot?.settings.lightbarEnabled);
  const sleepKeybindEnabled = Boolean(snapshot?.settings.sleepKeybindEnabled);
  const controllerToastEnabled = Boolean(snapshot?.settings.notifyControllerConnection);
  const lowBatteryToastEnabled = Boolean(snapshot?.settings.notifyLowBattery);
  const notificationsEnabled = controllerToastEnabled || lowBatteryToastEnabled;
  const controllerConnected = Boolean(snapshot?.status?.controllerConnected);
  const sleepButtonBusy = pendingAction !== null && pendingAction !== 'sleep-keybind';
  const gameStreamActive = Boolean(snapshot?.status?.hostOutputRecent);
  const audioStreamActive = Boolean(snapshot?.status?.audioRecent && pendingAction !== 'speaker' && !speakerTestLocked);
  const hostAudioStatus = snapshot?.diagnostics.hostAudioStatus;
  const hostAudioEnabled = Boolean(snapshot?.settings.hostEncodedAudioEnabled);
  const duplexMicEnabled = Boolean(snapshot?.settings.duplexMicEnabled);
  const audioEnabled = speakerEnabled || duplexMicEnabled;
  const hostAudioActive = hostAudioStatus?.mode === 'host-encoded-active';
  const initialHostAudioStartGrace = Date.now() - appOpenedAtRef.current < HOST_AUDIO_INITIAL_START_GRACE_MS;
  const hostAudioStarting = hostAudioEnabled
    && !hostAudioActive
    && (
      !hostAudioStatus
      || hostAudioStatus.fallbackReason === 'none'
      || hostAudioStatus.fallbackReason === 'host-disabled'
      || (initialHostAudioStartGrace && hostAudioStatus.fallbackReason === 'heartbeat-timeout')
    );
  const hostAudioLabel = !connected
    ? 'Unavailable'
    : hostAudioActive
      ? 'Host Encoded Active'
      : hostAudioStarting
        ? 'Starting Host Encoding'
      : hostAudioEnabled
        ? `Fallback: ${hostAudioStatus?.fallbackReason?.replaceAll('-', ' ') ?? 'pending'}`
        : 'Pico Local';
  const hostAudioTone = hostAudioActive
    ? 'good'
    : connected && hostAudioEnabled && !hostAudioStarting
      ? 'warn'
      : 'idle';
  const duplexMicLabel = hostAudioStatus?.duplexActive
    ? 'Duplex Active'
    : duplexMicEnabled
      ? 'Disabled in Fallback'
      : 'Off';
  const speakerOutputMissing = speakerOutputAvailable === false;
  const testHapticsUnavailable = !connected
    || !hapticsEnabled
    || pendingAction !== null
    || speakerVolumeCommitPending
    || lightbarCommitPending
    || testLocked
    || gameStreamActive
    || audioStreamActive
    || Boolean(snapshot?.status?.testHapticsBusy)
    || Boolean(snapshot?.status?.testHapticsCooldown);
  const testRumbleUnavailable = !connected
    || !classicRumbleEnabled
    || pendingAction !== null
    || speakerVolumeCommitPending
    || lightbarCommitPending
    || testLocked
    || gameStreamActive
    || audioStreamActive
    || Boolean(snapshot?.status?.testHapticsBusy);
  const hapticsTestReady = !testHapticsUnavailable;
  const rumbleTestReady = !testRumbleUnavailable;
  const hapticsStatusLabel = testLocked || snapshot?.status?.testHapticsBusy
    ? 'Testing'
    : snapshot?.status?.testHapticsCooldown
      ? 'Cooling Down'
      : hapticsTestReady
        ? 'Ready'
        : connected && gameStreamActive
          ? 'Game Active'
          : connected && audioStreamActive
            ? 'Audio Active'
            : connected && pendingAction !== null
              ? 'Command Pending'
              : 'Unavailable';
  const rumbleStatusLabel = testLocked
    ? 'Testing'
    : rumbleTestReady
      ? 'Ready'
      : connected && gameStreamActive
        ? 'Game Active'
        : connected && audioStreamActive
          ? 'Audio Active'
          : connected && pendingAction !== null
            ? 'Command Pending'
            : 'Unavailable';
  const hapticsStatusTone = testLocked || snapshot?.status?.testHapticsBusy || hapticsTestReady
    ? 'good'
    : connected && (snapshot?.status?.testHapticsCooldown || gameStreamActive || audioStreamActive || pendingAction !== null)
      ? 'warn'
      : 'idle';
  const rumbleStatusTone = testLocked || rumbleTestReady
    ? 'good'
    : connected && (gameStreamActive || audioStreamActive || pendingAction !== null)
      ? 'warn'
      : 'idle';
  const activeFeedbackTestUnavailable = showClassicRumbleControl ? testRumbleUnavailable : testHapticsUnavailable;
  const activeFeedbackStatusLabel = showClassicRumbleControl ? rumbleStatusLabel : hapticsStatusLabel;
  const activeFeedbackStatusTone = showClassicRumbleControl ? rumbleStatusTone : hapticsStatusTone;
  const testSpeakerUnavailable = !connected
    || !speakerVolumeSupported
    || !speakerEnabled
    || pendingAction !== null
    || speakerVolumeCommitPending
    || lightbarCommitPending
    || speakerTestLocked
    || gameStreamActive
    || Boolean(snapshot?.status?.testHapticsBusy);
  const speakerTestReady = !testSpeakerUnavailable && !speakerOutputMissing;
  const testMicUnavailable = !connected
    || !hostAudioEnabled
    || !hostAudioActive
    || !duplexMicEnabled
    || pendingAction !== null
    || micVolumeCommitPending
    || lightbarCommitPending
    || micTestLocked
    || gameStreamActive;
  const micTestReady = !testMicUnavailable;
  const speakerStatusLabel = speakerTestLocked
    ? 'Playing'
    : connected && speakerTestError
      ? speakerTestError
    : connected && speakerOutputMissing
        ? BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE
        : speakerTestReady
          ? 'Ready'
          : connected && gameStreamActive
            ? 'Game Audio Active'
            : connected && pendingAction !== null
              ? 'Command Pending'
              : 'Unavailable';
  const speakerStatusTone = speakerTestLocked || speakerTestReady
    ? 'good'
    : connected && (speakerTestError || speakerOutputMissing)
        ? 'bad'
      : connected && (gameStreamActive || pendingAction !== null)
        ? 'warn'
        : 'idle';
  const micTestStatusLabel = micTestLocked
    ? 'Listening'
    : connected && micTestError
      ? micTestError
      : micTestReady
        ? 'Ready'
        : connected && !hostAudioEnabled
          ? 'Host Encoding Off'
          : connected && !hostAudioActive
            ? 'Host Encoding Starting'
            : connected && pendingAction !== null
              ? 'Command Pending'
              : 'Unavailable';
  const micTestStatusTone = micTestLocked || micTestReady
    ? 'good'
    : connected && micTestError
      ? 'bad'
      : connected && (hostAudioEnabled || pendingAction !== null)
        ? 'warn'
        : 'idle';
  const activeAudioTestUnavailable = showMicrophoneControl ? testMicUnavailable : testSpeakerUnavailable;
  const activeAudioTestLocked = showMicrophoneControl ? micTestLocked : speakerTestLocked;
  const activeAudioTestStatusLabel = showMicrophoneControl ? micTestStatusLabel : speakerStatusLabel;
  const activeAudioTestStatusTone = showMicrophoneControl ? micTestStatusTone : speakerStatusTone;
  const heroBridgeLabel = 'DS5 Bridge';
  const heroReadinessLabel = connected && !snapshot.diagnostics.lastError ? 'Ready' : 'DS5 Bridge not detected';
  const testTriggersUnavailable = !connected
    || !adaptiveTriggersSupported
    || !adaptiveTriggersEnabled
    || pendingAction !== null
    || triggerTestLocked
    || gameStreamActive
    || Boolean(snapshot?.status?.testAdaptiveTriggersBusy);
  const triggerTestReady = !testTriggersUnavailable;
  const triggerStatusLabel = triggerTestLocked || snapshot?.status?.testAdaptiveTriggersBusy
    ? 'Testing'
    : triggerTestReady
      ? 'Ready'
      : connected && gameStreamActive
        ? 'Game Active'
        : connected && pendingAction !== null
          ? 'Command Pending'
          : 'Unavailable';
  const triggerStatusTone = triggerTestLocked || snapshot?.status?.testAdaptiveTriggersBusy || triggerTestReady
    ? 'good'
    : connected && (gameStreamActive || pendingAction !== null)
      ? 'warn'
      : 'idle';
  const lightbarStateActive = connected && lightbarSupported && lightbarEnabled;
  const lightbarStateLabel = lightbarStateActive
    ? 'Active'
    : connected && lightbarSupported
      ? 'Off'
      : 'Unavailable';

  useEffect(() => {
    if (!connected || speakerOutputAvailable !== false || speakerTestLocked) {
      return undefined;
    }

    const refresh = () => {
      void findBridgeAudioOutputId(2).then((sinkId) => {
        if (!sinkId) {
          return;
        }
        setSpeakerOutputAvailable(true);
        setSpeakerTestError(null);
      });
    };

    const handle = window.setInterval(refresh, TEST_SPEAKER_ENDPOINT_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [connected, speakerOutputAvailable, speakerTestLocked]);

  useEffect(() => () => {
    stopMicLiveListen();
  }, []);

  useEffect(() => {
    if ((!connected || !showMicrophoneControl) && micTestLocked) {
      stopMicLiveListen();
    }
  }, [connected, showMicrophoneControl, micTestLocked]);

  const normalizedLightbarColor = normalizeHexColor(lightbarColor);
  const customSwatchColor = customLightbarColor ?? LIGHTBAR_DEFAULT_CUSTOM_COLOR;
  const customSwatchSelected = Boolean(customLightbarColor && normalizedLightbarColor === customLightbarColor);
  const customColorPickerDisabled = !connected || !lightbarSupported || !lightbarEnabled;
  const diagnosticsVisible = activeControlTab === 'system' && showDiagnostics;
  const ackText = useMemo(() => {
    if (!diagnosticsVisible) return '';
    if (!lastAck) return 'No commands yet';
    return `${ackResultName(lastAck.resultCode)} - seq ${lastAck.commandSequence}`;
  }, [diagnosticsVisible, lastAck]);
  const audioDebugText = useMemo(() => {
    if (!diagnosticsVisible) {
      return '';
    }
    if (!snapshot) {
      return 'state=starting';
    }
    if (!snapshot.status) {
      return `state=${snapshot.state}\nmessage=${snapshot.message}`;
    }

    const debug = snapshot.status.audioDebug;
    const stats = snapshot.diagnostics.audioDebugStats;
    const host = snapshot.diagnostics.hostAudioStatus;
    const lines = [
      `state=${snapshot.state}`,
      `firmware=${snapshot.status.firmwareVersion}`,
      `triggerEffectIntensity=${snapshot.settings.triggerEffectIntensityPercent}%`,
      `classicRumble=${snapshot.settings.classicRumbleEnabled ? snapshot.settings.classicRumbleGainPercent : 0}%`,
      `appSpeakerSlider=${snapshot.settings.speakerVolumePercent}%`,
      `firmwareSpeakerGate=${snapshot.status.speakerVolumePercent}%`,
      `audioRecent=${snapshot.status.audioRecent ? 'true' : 'false'}`,
      `hostOutputRecent=${snapshot.status.hostOutputRecent ? 'true' : 'false'}`,
      `usbHostSpeakerVolume=${debug.usbHostSpeakerVolumePercent}%`,
      `usbHostSpeakerMute=${debug.usbHostSpeakerMute ? 'true' : 'false'}`,
      `usbHostMicVolume=${debug.usbHostMicVolumePercent}%`,
      `usbHostMicMute=${debug.usbHostMicMute ? 'true' : 'false'}`,
      `audioRepairCount=${debug.lastHostOutputCount}`,
      `lastAudioRepairReportId=0x${hexByte(debug.lastHostOutputReportId)}`,
      `lastAudioRepairLength=${debug.lastHostOutputLength}`,
      `lastAudioRepairFirst16=${debug.lastHostOutputFirst16.map(hexByte).join(' ')}`
    ];
    if (host) {
      lines.push(
        `hostAudioMode=${host.mode}`,
        `hostFallbackReason=${host.fallbackReason}`,
        `hostRequested=${host.hostRequested ? 'true' : 'false'}`,
        `hostHeartbeatHealthy=${host.heartbeatHealthy ? 'true' : 'false'}`,
        `hostStreamHealthy=${host.streamHealthy ? 'true' : 'false'}`,
        `hostGeneration=${host.streamGeneration}`,
        `hostFramesReceived=${host.hostFramesReceived}`,
        `hostFramesDropped=${host.hostFramesDropped}`,
        `duplexRequested=${host.duplexRequested ? 'true' : 'false'}`,
        `duplexActive=${host.duplexActive ? 'true' : 'false'}`,
        `micPacketsReceived=${host.micPacketsReceived}`,
        `micPacketsDropped=${host.micPacketsDropped}`,
        `micDecodeSuccess=${host.micDecodeSuccess}`,
        `micDecodeFail=${host.micDecodeFail}`,
        `micUsbWriteSuccess=${host.micUsbWriteSuccess}`,
        `micUsbWriteShort=${host.micUsbWriteShort}`,
        `micLastDecodedSamples=${host.micLastDecodedSamples}`,
        `micLastWrittenBytes=${host.micLastWrittenBytes}`,
        `micPeakPermille=${host.micPeakPermille}`,
        `micUsbStreaming=${host.micUsbStreaming ? 'true' : 'false'}`
      );
    }
    if (stats) {
      lines.push(
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
      );
    }
    return lines.join('\n');
  }, [diagnosticsVisible, snapshot]);
  const audioEventLogText = useMemo(() => {
    if (!diagnosticsVisible) {
      return '';
    }
    const lines = snapshot?.diagnostics.audioDebugLogLines ?? [];
    return lines.length > 0 ? lines.join('\n') : 'No audio debug events captured yet.';
  }, [diagnosticsVisible, snapshot?.diagnostics.audioDebugLogLines]);

  async function runAction(label: string, action: () => Promise<BridgeSnapshot>) {
    if (!snapshot || pendingAction) {
      return;
    }
    setPendingAction(label);
    try {
      const next = await action();
      setSnapshot(next);
    } catch {
      const next = await window.bridge.getStatus();
      setSnapshot(next);
    } finally {
      setPendingAction(null);
    }
  }

  async function commitHapticsValue(value = hapticsValue) {
    const snappedValue = snapHapticsValue(value);
    if (
      !snapshot
      || snapshot.state !== 'connected'
      || !snapshot.settings.hapticsEnabled
      || snappedValue === snapshot.settings.hapticsGainPercent
      || hapticsCommitPending
    ) {
      hapticsEditingRef.current = false;
      return;
    }

    setHapticsCommitPending(true);
    hapticsEditingRef.current = true;
    try {
      const next = await window.bridge.setHapticsGain(snappedValue);
      setSnapshot(next);
      setHapticsValue(snapHapticsValue(next.settings.hapticsGainPercent));
    } catch {
      const next = await window.bridge.getStatus();
      setSnapshot(next);
      setHapticsValue(snapHapticsValue(next.settings.hapticsGainPercent));
    } finally {
      setHapticsCommitPending(false);
      hapticsEditingRef.current = false;
    }
  }

  async function commitClassicRumbleValue(value = classicRumbleValue) {
    const snappedValue = snapHapticsValue(value);
    if (
      !snapshot
      || snapshot.state !== 'connected'
      || !snapshot.settings.classicRumbleEnabled
      || snappedValue === snapshot.settings.classicRumbleGainPercent
      || classicRumbleCommitPending
    ) {
      classicRumbleEditingRef.current = false;
      return;
    }

    setClassicRumbleCommitPending(true);
    classicRumbleEditingRef.current = true;
    try {
      const next = await window.bridge.setClassicRumbleGain(snappedValue);
      setSnapshot(next);
      setClassicRumbleValue(snapHapticsValue(next.settings.classicRumbleGainPercent));
    } catch {
      const next = await window.bridge.getStatus();
      setSnapshot(next);
      setClassicRumbleValue(snapHapticsValue(next.settings.classicRumbleGainPercent));
    } finally {
      setClassicRumbleCommitPending(false);
      classicRumbleEditingRef.current = false;
    }
  }

  async function commitSpeakerVolume(value = speakerVolumeValue) {
    if (
      !snapshot
      || snapshot.state !== 'connected'
      || !speakerVolumeSupported
      || !snapshot.settings.speakerEnabled
      || value === snapshot.settings.speakerVolumePercent
      || speakerVolumeCommitPending
    ) {
      speakerVolumeEditingRef.current = false;
      return;
    }

    setSpeakerVolumeCommitPending(true);
    speakerVolumeEditingRef.current = true;
    try {
      const next = await window.bridge.setSpeakerVolume(value);
      setSnapshot(next);
      setSpeakerVolumeValue(snapSpeakerVolume(next.settings.speakerVolumePercent));
      await delay(TEST_SPEAKER_VOLUME_SETTLE_MS);
    } catch {
      const next = await window.bridge.getStatus();
      setSnapshot(next);
      setSpeakerVolumeValue(snapSpeakerVolume(next.settings.speakerVolumePercent));
    } finally {
      setSpeakerVolumeCommitPending(false);
      speakerVolumeEditingRef.current = false;
    }
  }

  async function commitLightbar(nextColor = lightbarColor, brightness = lightbarBrightnessValue) {
    const color = normalizeHexColor(nextColor);
    const snappedBrightness = snapLightbarBrightness(brightness);
    if (
      !snapshot
      || snapshot.state !== 'connected'
      || !lightbarSupported
      || !snapshot.settings.lightbarEnabled
      || lightbarCommitPending
      || (
        color === normalizeHexColor(snapshot.settings.lightbarColor)
        && snappedBrightness === snapshot.settings.lightbarBrightnessPercent
      )
    ) {
      lightbarBrightnessEditingRef.current = false;
      return;
    }

    setLightbarCommitPending(true);
    try {
      setSnapshot(await window.bridge.setLightbarColor(color, snappedBrightness));
    } catch {
      setSnapshot(await window.bridge.getStatus());
    } finally {
      setLightbarCommitPending(false);
      lightbarBrightnessEditingRef.current = false;
    }
  }

  async function commitTriggerEffectIntensity(value = triggerEffectIntensityValue) {
    const snappedValue = snapTriggerEffectIntensity(value);
    if (
      !snapshot
      || snapshot.state !== 'connected'
      || !adaptiveTriggersSupported
      || !snapshot.settings.adaptiveTriggersEnabled
      || snappedValue === snapshot.settings.triggerEffectIntensityPercent
    ) {
      triggerEffectEditingRef.current = false;
      return;
    }

    try {
      setSnapshot(await window.bridge.setTriggerEffectIntensity(snappedValue));
    } catch {
      setSnapshot(await window.bridge.getStatus());
    } finally {
      triggerEffectEditingRef.current = false;
    }
  }

  function selectLightbarColor(nextColor: string) {
    const color = normalizeHexColor(nextColor);
    setLightbarColor(color);
    void commitLightbar(color, lightbarBrightnessValue);
  }

  function saveCustomLightbarColor(nextColor: string) {
    const color = normalizeHexColor(nextColor);
    setCustomLightbarColor(color);
    setCustomColorDraft(color);
    setLightbarColor(color);
    setShowCustomColorPicker(false);
    setCustomSwatchPrimed(false);
    window.localStorage.setItem('ds5bridge.customLightbarColor', color);
    void commitLightbar(color, lightbarBrightnessValue);
  }

  function previewCustomLightbarColor(nextColor: string) {
    const color = normalizeHexColor(nextColor);
    setCustomColorDraft(color);
    setLightbarColor(color);
    void commitLightbar(color, lightbarBrightnessValue);
  }

  function selectCustomLightbarColor() {
    if (!customLightbarColor) {
      setCustomSwatchPrimed(true);
      if (customSwatchPrimeTimerRef.current !== null) {
        window.clearTimeout(customSwatchPrimeTimerRef.current);
      }
      customSwatchPrimeTimerRef.current = window.setTimeout(() => {
        setCustomSwatchPrimed(false);
        customSwatchPrimeTimerRef.current = null;
      }, 1600);
      return;
    }
    selectLightbarColor(customLightbarColor);
  }

  function openCustomLightbarPicker() {
    const color = customLightbarColor ?? LIGHTBAR_DEFAULT_CUSTOM_COLOR;
    setCustomColorDraft(color);
    setCustomSwatchPrimed(false);
    setShowCustomColorPicker(true);
  }

  function setLightbarPreset(value: number) {
    const brightness = snapLightbarBrightness(value);
    setLightbarBrightnessValue(brightness);
    void commitLightbar(lightbarColor, brightness);
  }

  function setHapticsPreset(value: number) {
    const snappedValue = snapHapticsValue(value);
    hapticsEditingRef.current = true;
    setHapticsValue(snappedValue);
    void commitHapticsValue(snappedValue);
  }

  function setClassicRumblePreset(value: number) {
    const snappedValue = snapHapticsValue(value);
    classicRumbleEditingRef.current = true;
    setClassicRumbleValue(snappedValue);
    void commitClassicRumbleValue(snappedValue);
  }

  function setSpeakerPreset(value: number) {
    const snappedValue = snapSpeakerVolume(value);
    speakerVolumeEditingRef.current = true;
    setSpeakerVolumeValue(snappedValue);
    void commitSpeakerVolume(snappedValue);
  }

  async function commitMicVolume(value = micVolumeValue) {
    if (
      !snapshot
      || snapshot.state !== 'connected'
      || !hostAudioEnabled
      || value === snapshot.settings.micVolumePercent
      || micVolumeCommitPending
    ) {
      micVolumeEditingRef.current = false;
      return;
    }

    setMicVolumeCommitPending(true);
    micVolumeEditingRef.current = true;
    try {
      const next = await window.bridge.setMicVolume(value);
      setSnapshot(next);
      setMicVolumeValue(snapMicVolume(next.settings.micVolumePercent));
    } catch {
      const next = await window.bridge.getStatus();
      setSnapshot(next);
      setMicVolumeValue(snapMicVolume(next.settings.micVolumePercent));
    } finally {
      setMicVolumeCommitPending(false);
      micVolumeEditingRef.current = false;
    }
  }

  function setMicPreset(value: number) {
    const snappedValue = snapMicVolume(value);
    micVolumeEditingRef.current = true;
    setMicVolumeValue(snappedValue);
    void commitMicVolume(snappedValue);
  }

  function setTriggerIntensityPreset(value: number) {
    const snappedValue = snapTriggerEffectIntensity(value);
    setTriggerEffectIntensityValue(snappedValue);
    void commitTriggerEffectIntensity(snappedValue);
  }

  function lightbarColorName(color: string) {
    const normalized = normalizeHexColor(color);
    return LIGHTBAR_COLOR_NAMES[normalized] ?? 'Custom';
  }

  function runFeedbackTest() {
    setTestLocked(true);
    void runAction(showClassicRumbleControl ? 'test-rumble' : 'test', async () => {
      if (snapshot && showClassicRumbleControl) {
        if (classicRumbleValue !== snapshot.settings.classicRumbleGainPercent) {
          await window.bridge.setClassicRumbleGain(classicRumbleValue);
        }
        return window.bridge.testClassicRumble();
      }
      if (snapshot && hapticsValue !== snapshot.settings.hapticsGainPercent) {
        await window.bridge.setHapticsGain(hapticsValue);
      }
      return window.bridge.testHaptics();
    }).finally(() => {
      window.setTimeout(() => setTestLocked(false), TEST_HAPTICS_LOCK_MS);
    });
  }

  function runTestSpeaker() {
    setSpeakerTestLocked(true);
    setPendingAction('speaker');
    setSpeakerTestError(null);
    void (async () => {
      try {
        const speakerEndpointAvailable = Boolean(await findBridgeAudioOutputId());
        setSpeakerOutputAvailable(speakerEndpointAvailable);
        if (!speakerEndpointAvailable) {
          throw new Error(BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE);
        }

        let volumeChanged = false;
        if (snapshot && speakerVolumeSupported && speakerVolumeValue !== snapshot.settings.speakerVolumePercent) {
          speakerVolumeEditingRef.current = true;
          const next = await window.bridge.setSpeakerVolume(speakerVolumeValue);
          setSnapshot(next);
          setSpeakerVolumeValue(snapSpeakerVolume(next.settings.speakerVolumePercent));
          speakerVolumeEditingRef.current = false;
          volumeChanged = true;
        }
        if (volumeChanged) {
          await delay(TEST_SPEAKER_VOLUME_SETTLE_MS);
        }
        await playSpeakerToneFile();
        setSpeakerOutputAvailable(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE;
        setSpeakerTestError(message);
        if (message === BRIDGE_AUDIO_ENDPOINT_UNAVAILABLE) {
          setSpeakerOutputAvailable(false);
        }
        const next = await window.bridge.getStatus();
        setSnapshot(next);
        setSpeakerVolumeValue(snapSpeakerVolume(next.settings.speakerVolumePercent));
        speakerVolumeEditingRef.current = false;
      } finally {
        speakerVolumeEditingRef.current = false;
        setPendingAction(null);
        window.setTimeout(() => setSpeakerTestLocked(false), TEST_SPEAKER_LOCK_MS);
      }
    })();
  }

  function runTestMic() {
    setMicTestLocked(true);
    setPendingAction('mic-test');
    setMicTestError(null);
    void (async () => {
      try {
        if (snapshot && micVolumeValue !== snapshot.settings.micVolumePercent) {
          micVolumeEditingRef.current = true;
          const next = await window.bridge.setMicVolume(micVolumeValue);
          setSnapshot(next);
          setMicVolumeValue(snapMicVolume(next.settings.micVolumePercent));
          micVolumeEditingRef.current = false;
        }
        await playMicLiveListen(TEST_MIC_LISTEN_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : BRIDGE_MIC_ENDPOINT_UNAVAILABLE;
        setMicTestError(message);
        const next = await window.bridge.getStatus();
        setSnapshot(next);
        setMicVolumeValue(snapMicVolume(next.settings.micVolumePercent));
      } finally {
        micVolumeEditingRef.current = false;
        setPendingAction(null);
        setMicTestLocked(false);
      }
    })();
  }

  function runTestAdaptiveTriggers() {
    setTriggerTestLocked(true);
    void runAction('triggers', async () => {
      if (snapshot && triggerEffectIntensityValue !== snapshot.settings.triggerEffectIntensityPercent) {
        await window.bridge.setTriggerEffectIntensity(triggerEffectIntensityValue);
      }
      return window.bridge.testAdaptiveTriggers(snapshot?.settings.triggerTestMode ?? 'feedback', triggerTarget);
    }).finally(() => {
      window.setTimeout(() => setTriggerTestLocked(false), TEST_TRIGGER_LOCK_MS);
    });
  }

  function setTriggerTestMode(mode: TriggerTestMode) {
    void runAction('trigger-mode', () => window.bridge.setTriggerTestMode(mode));
  }

  function resetAdaptiveTriggers() {
    void runAction('triggers-reset', () => window.bridge.resetAdaptiveTriggers());
  }

  function applyPreset(presetId: BridgePresetId) {
    void runAction('preset', () => window.bridge.applyPreset(presetId));
  }

  function toggleHapticsEnabled() {
    if (!snapshot) return;
    void runAction('haptics-enabled', () => window.bridge.setHapticsEnabled(!snapshot.settings.hapticsEnabled));
  }

  function toggleClassicRumbleEnabled() {
    if (!snapshot) return;
    void runAction('classic-rumble-enabled', () => (
      window.bridge.setClassicRumbleEnabled(!snapshot.settings.classicRumbleEnabled)
    ));
  }

  function toggleSpeakerEnabled() {
    if (!snapshot) return;
    void runAction('speaker-enabled', () => window.bridge.setSpeakerEnabled(!snapshot.settings.speakerEnabled));
  }

  function toggleHostEncodedAudioEnabled() {
    if (!snapshot) return;
    void runAction('host-audio-enabled', () => (
      window.bridge.setHostEncodedAudioEnabled(!snapshot.settings.hostEncodedAudioEnabled)
    ));
  }

  function toggleAudioEnabled() {
    if (!snapshot) return;
    const enabled = !(snapshot.settings.speakerEnabled || snapshot.settings.duplexMicEnabled);
    void runAction('audio-enabled', async () => {
      let next = snapshot;
      if (next.settings.speakerEnabled !== enabled) {
        next = await window.bridge.setSpeakerEnabled(enabled);
      }
      const micEnabled = enabled && next.settings.hostEncodedAudioEnabled;
      if (next.settings.duplexMicEnabled !== micEnabled) {
        next = await window.bridge.setDuplexMicEnabled(micEnabled);
      }
      return next;
    });
  }

  function toggleDuplexMicEnabled() {
    if (!snapshot) return;
    void runAction('duplex-mic-enabled', () => (
      window.bridge.setDuplexMicEnabled(!snapshot.settings.duplexMicEnabled)
    ));
  }

  function toggleMicMute() {
    if (!snapshot) return;
    void runAction('mic-mute', () => window.bridge.setMicMute(!snapshot.settings.micMuted));
  }

  function toggleAdaptiveTriggersEnabled() {
    if (!snapshot) return;
    void runAction('triggers-enabled', () => (
      window.bridge.setAdaptiveTriggersEnabled(!snapshot.settings.adaptiveTriggersEnabled)
    ));
  }

  function toggleLightbarEnabled() {
    if (!snapshot) return;
    void runAction('lightbar-enabled', () => window.bridge.setLightbarEnabled(!snapshot.settings.lightbarEnabled));
  }

  function setMuteButtonAction(
    mode: MuteButtonMode,
    usage?: number,
    modifiers?: number,
    behavior?: MuteKeyboardBehavior
  ) {
    if (!snapshot) {
      return;
    }
    const keyUsage = usage ?? snapshot.settings.muteKeyboardUsage;
    const keyModifiers = modifiers ?? snapshot.settings.muteKeyboardModifiers;
    const keyBehavior = behavior ?? snapshot.settings.muteKeyboardBehavior;
    void runAction('mute-button', () => window.bridge.setMuteButtonAction(mode, keyUsage, keyModifiers, keyBehavior));
  }

  function setMuteModifier(bit: number, enabled: boolean) {
    if (!snapshot) {
      return;
    }
    const nextModifiers = enabled
      ? snapshot.settings.muteKeyboardModifiers | bit
      : snapshot.settings.muteKeyboardModifiers & ~bit;
    setMuteButtonAction(
      snapshot.settings.muteButtonMode,
      snapshot.settings.muteKeyboardUsage,
      nextModifiers,
      snapshot.settings.muteKeyboardBehavior
    );
  }

  function clearSleepConfirmation() {
    sleepConfirmArmedRef.current = false;
    setSleepConfirmVisible(false);
    if (sleepConfirmTimerRef.current !== null) {
      window.clearTimeout(sleepConfirmTimerRef.current);
      sleepConfirmTimerRef.current = null;
    }
  }

  function armSleepConfirmation() {
    sleepConfirmArmedRef.current = true;
    setSleepConfirmVisible(true);
    if (sleepConfirmTimerRef.current !== null) {
      window.clearTimeout(sleepConfirmTimerRef.current);
    }
    sleepConfirmTimerRef.current = window.setTimeout(() => {
      sleepConfirmArmedRef.current = false;
      setSleepConfirmVisible(false);
      sleepConfirmTimerRef.current = null;
    }, SLEEP_CONFIRM_MS);
  }

  function handleSleepButtonClick(detail: number) {
    if (!snapshot || detail > 1 || sleepButtonBusy || !connected || !sleepControllerSupported) {
      return;
    }

    armSleepConfirmation();
    const togglePromise = runAction('sleep-keybind', () => (
      window.bridge.setSleepKeybindEnabled(!snapshot.settings.sleepKeybindEnabled)
    ));
    const trackedPromise = togglePromise.finally(() => {
      if (sleepTogglePromiseRef.current === trackedPromise) {
        sleepTogglePromiseRef.current = null;
      }
    });
    sleepTogglePromiseRef.current = trackedPromise;
  }

  function handleSleepButtonDoubleClick() {
    if (!snapshot || sleepButtonBusy || !connected || !sleepControllerSupported || !controllerConnected) {
      return;
    }
    if (!sleepConfirmArmedRef.current) {
      armSleepConfirmation();
      return;
    }

    clearSleepConfirmation();
    const waitForToggle = sleepTogglePromiseRef.current ?? Promise.resolve();
    void waitForToggle.then(async () => {
      setPendingAction('sleep-controller');
      try {
        setSnapshot(await window.bridge.sleepController());
      } catch {
        setSnapshot(await window.bridge.getStatus());
      } finally {
        setPendingAction(null);
      }
    });
  }

  function toggleControllerNotifications() {
    if (!snapshot) return;
    void runAction('notify-controller', () => (
      window.bridge.setNotifyControllerConnection(!snapshot.settings.notifyControllerConnection)
    ));
  }

  function toggleLowBatteryNotifications() {
    if (!snapshot) return;
    void runAction('notify-battery', () => (
      window.bridge.setNotifyLowBattery(!snapshot.settings.notifyLowBattery)
    ));
  }

  function setPollingRateMode(mode: PollingRateMode) {
    void runAction('polling-rate', () => window.bridge.setPollingRateMode(mode));
  }

  function testNotifications() {
    void runAction('notify-test', () => window.bridge.testNotification());
  }

  function selectControlTab(tab: ControlTab) {
    if (tab === activeControlTab) {
      return;
    }
    setShowCustomColorPicker(false);
    setActiveControlTab(tab);
  }

  if (!snapshot) {
    return <div className="shell loading">Starting bridge companion</div>;
  }

  return (
    <div className="shell">
      <div
        className="window-bar"
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('.bridge-tools') || target.closest('.window-actions')) {
            return;
          }
          setShowBridgeSettings(false);
          setShowNotificationsMenu(false);
        }}
      >
        <span className="bridge-wordmark" aria-label="DS5 Bridge">
          <img className="bridge-mark" src={bridgeMarkUrl} alt="" aria-hidden="true" />
          <span className="bridge-wordmark-ds">DS5</span>
          <span className="bridge-wordmark-name">Bridge</span>
        </span>
        <div className="topbar-right">
          <div className="bridge-tools">
            <div className="sleep-control">
              <button
                className={`topbar-sleep-button ${sleepKeybindEnabled ? 'active' : ''} ${sleepConfirmVisible ? 'confirm' : ''}`}
                type="button"
                aria-label="Sleep controller"
                aria-pressed={sleepKeybindEnabled}
                disabled={!connected || !sleepControllerSupported || sleepButtonBusy}
                onClick={(event) => handleSleepButtonClick(event.detail)}
                onDoubleClick={handleSleepButtonDoubleClick}
              >
                <Moon size={16} />
                <span>Sleep</span>
              </button>
              <div className="sleep-keybind-tooltip" role="tooltip">
                Press PlayStation Home + Triangle to sleep
              </div>
              {sleepConfirmVisible && (
                <div className="sleep-confirm" role="status">
                  Double-click to sleep now
                </div>
              )}
            </div>
            <span className="bridge-tool-divider" aria-hidden="true" />
            <div className="notifications-control" ref={notificationsRef}>
              <button
                className={`topbar-tool notification-tool ${showNotificationsMenu ? 'active' : ''} ${notificationsEnabled ? 'armed' : ''}`}
                type="button"
                aria-label="Notifications"
                aria-haspopup="menu"
                aria-expanded={showNotificationsMenu}
                onClick={() => setShowNotificationsMenu((value) => !value)}
              >
                <Bell size={18} />
              </button>
              {showNotificationsMenu && (
                <div className="settings-menu notifications-menu" role="menu" aria-label="Notifications">
                  <div className="settings-menu-heading">
                    <Bell size={16} />
                    <span>Notifications</span>
                  </div>
                  <div className="settings-menu-row">
                    <div>
                      <strong>Controller Status</strong>
                      <span>Toast when the controller connects or disconnects</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={controllerToastEnabled}
                      className={`switch ${controllerToastEnabled ? 'on' : ''}`}
                      disabled={pendingAction !== null}
                      onClick={toggleControllerNotifications}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-menu-row">
                    <div>
                      <strong>Low Battery</strong>
                      <span>Toast when battery reaches 20% or below</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={lowBatteryToastEnabled}
                      className={`switch ${lowBatteryToastEnabled ? 'on' : ''}`}
                      disabled={pendingAction !== null}
                      onClick={toggleLowBatteryNotifications}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-menu-action">
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={pendingAction !== null}
                      onClick={testNotifications}
                    >
                      Test Toast
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="window-actions">
            <button type="button" title="Minimize" onClick={() => void window.bridge.minimizeWindow()}>
              <Minus size={16} />
            </button>
            <button type="button" title="Hide to tray" onClick={() => void window.bridge.hideWindow()}>
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      <main className="app-content">
        <section className={`hero-card status-${statusTone}`}>
          <div className="hero-actions">
            <div className="header-settings" ref={bridgeSettingsRef}>
              <button
                className={`icon-button ${showBridgeSettings ? 'active' : ''}`}
                type="button"
                title="Bridge settings"
                aria-haspopup="menu"
                aria-expanded={showBridgeSettings}
                onClick={() => setShowBridgeSettings((value) => !value)}
              >
                <MoreHorizontal size={22} />
              </button>
              {showBridgeSettings && (
                <div className="settings-menu" role="menu" aria-label="Bridge settings">
                  <div className="settings-menu-heading">
                    <Settings2 size={16} />
                    <span>Bridge Settings</span>
                  </div>
                  <div className="settings-menu-row">
                    <div>
                      <strong>Pico LED</strong>
                      <span>Board status LED while connected</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={snapshot.settings.ledEnabled}
                      className={`switch ${snapshot.settings.ledEnabled ? 'on' : ''}`}
                      disabled={!connected}
                      onClick={() => void runAction('led', () => window.bridge.setLedEnabled(!snapshot.settings.ledEnabled))}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-menu-row">
                    <div>
                      <strong>Idle Disconnect</strong>
                      <span>Disconnect controller after 30 minutes idle</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={snapshot.settings.idleDisconnectEnabled}
                      className={`switch ${snapshot.settings.idleDisconnectEnabled ? 'on' : ''}`}
                      disabled={!connected}
                      onClick={() => void runAction('idle', () => (
                        window.bridge.setIdleDisconnectEnabled(!snapshot.settings.idleDisconnectEnabled)
                      ))}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="settings-menu-row">
                    <div>
                      <strong>PC Sleep Disconnect</strong>
                      <span>Disconnect controller when USB host suspends</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={snapshot.settings.usbSuspendDisconnectEnabled}
                      className={`switch ${snapshot.settings.usbSuspendDisconnectEnabled ? 'on' : ''}`}
                      disabled={!connected || !usbSuspendDisconnectSupported}
                      onClick={() => void runAction('usb-suspend', () => (
                        window.bridge.setUsbSuspendDisconnectEnabled(!snapshot.settings.usbSuspendDisconnectEnabled)
                      ))}
                    >
                      <span />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="hero-main">
            <img className="controller-art" src={controllerImage} alt="" />
            <div className="status-copy">
              <div className="connection-row">
                <strong>{connected ? (controllerConnected ? controllerName(snapshot.status?.controllerType) : 'No Controller') : 'Controller'}</strong>
              </div>
              <div className="bridge-state">
                <span>{heroBridgeLabel}</span>
              </div>
              <div className="battery-row">
                <span
                  className={`battery-icon ${batteryLevelTone} ${batteryCharging ? 'charging' : ''}`}
                  aria-hidden="true"
                >
                  {[0, 1, 2].map((segment) => (
                    <span
                      key={segment}
                      className={[
                        segment < batterySegmentCount ? 'active' : '',
                        segment === batteryChargingSegment ? 'charging-segment' : '',
                        segment === 0 && batteryCritical ? 'critical-segment' : ''
                      ].filter(Boolean).join(' ')}
                    />
                  ))}
                </span>
                <strong>{connected ? batteryPercentLabel : '--'}</strong>
                <span>{heroReadinessLabel}</span>
              </div>
              <div
                className={`battery-track ${batteryLevelTone} ${batteryCharging ? 'charging' : ''}`}
                style={{ '--battery-scale': connected ? batteryPercent / 100 : 0 } as CSSProperties}
              >
                <div />
              </div>
            </div>
          </div>
          <div className="control-tabs" role="tablist" aria-label="Controls">
            {CONTROL_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                id={`control-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={activeControlTab === id}
                aria-controls={`control-panel-${id}`}
                className={activeControlTab === id ? 'active' : ''}
                onClick={() => selectControlTab(id)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </section>

      <section className="control-panel flat-control-panel">
        <div className="control-pages">
          <div
            className="control-page haptics-page"
            role="tabpanel"
            id="control-panel-haptics"
            aria-labelledby="control-tab-haptics"
            hidden={activeControlTab !== 'haptics'}
          >
              <div className="feature-heading">
                <div>
                  <h2>Haptics</h2>
                  <p>Adjust controller haptic feedback and run a quick test.</p>
                </div>
                <div className="inline-switch">
                  <span>Enabled</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={activeHapticsFeatureEnabled}
                    className={`switch ${activeHapticsFeatureEnabled ? 'on' : ''}`}
                    disabled={!connected || pendingAction !== null}
                    onClick={showClassicRumbleControl ? toggleClassicRumbleEnabled : toggleHapticsEnabled}
                  >
                    <span />
                  </button>
                </div>
              </div>
              <div className="feature-card-grid">
                <section className="feature-card">
                  <div className="feature-card-title">
                    <button
                      type="button"
                      className={`feature-icon haptics-enable-button ${activeHapticsFeatureEnabled ? 'active' : ''}`}
                      aria-pressed={activeHapticsFeatureEnabled}
                      aria-label={showClassicRumbleControl ? 'Enable rumble' : 'Enable haptics'}
                      title={showClassicRumbleControl ? 'Enable rumble' : 'Enable haptics'}
                      disabled={!connected || pendingAction !== null}
                      onClick={showClassicRumbleControl ? toggleClassicRumbleEnabled : toggleHapticsEnabled}
                    >
                      {showClassicRumbleControl ? <Vibrate size={20} /> : <Sparkles size={20} />}
                    </button>
                    <div className="title-copy">
                      <h3>{showClassicRumbleControl ? 'Rumble' : 'Intensity'}</h3>
                      <p>{showClassicRumbleControl ? 'Game Rumble Strength' : 'Haptic Feedback Strength'}</p>
                    </div>
                    <div className="dual-selector haptics-mode-selector" role="tablist" aria-label="Haptics control mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={!showClassicRumbleControl}
                        className={!showClassicRumbleControl ? 'active' : ''}
                        onClick={() => setShowClassicRumbleControl(false)}
                      >
                        <Sparkles size={17} />
                        Haptics
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={showClassicRumbleControl}
                        className={showClassicRumbleControl ? 'active' : ''}
                        onClick={() => setShowClassicRumbleControl(true)}
                      >
                        <Vibrate size={17} />
                        Rumble
                      </button>
                    </div>
                  </div>
                  <div className="framed-slider">
                    <label className="slider-row">
                      <span>0%</span>
                      <div className="range-control">
                        {showClassicRumbleControl ? (
                          <input
                            type="range"
                            min="0"
                            max="200"
                            step={HAPTICS_STEP}
                            value={classicRumbleValue}
                            disabled={!connected || !snapshot.settings.classicRumbleEnabled}
                            style={{ '--range-fill': `${classicRumbleValue / 2}%` } as CSSProperties}
                            onPointerDown={() => {
                              classicRumbleEditingRef.current = true;
                            }}
                            onChange={(event) => setClassicRumbleValue(snapHapticsValue(Number(event.currentTarget.value)))}
                            onPointerUp={() => void commitClassicRumbleValue()}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                classicRumbleEditingRef.current = true;
                              }
                            }}
                            onKeyUp={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                void commitClassicRumbleValue();
                              }
                            }}
                            onBlur={() => void commitClassicRumbleValue()}
                          />
                        ) : (
                          <input
                            type="range"
                            min="0"
                            max="200"
                            step={HAPTICS_STEP}
                            value={hapticsValue}
                            disabled={!connected || !snapshot.settings.hapticsEnabled}
                            style={{ '--range-fill': `${hapticsValue / 2}%` } as CSSProperties}
                            onPointerDown={() => {
                              hapticsEditingRef.current = true;
                            }}
                            onChange={(event) => setHapticsValue(snapHapticsValue(Number(event.currentTarget.value)))}
                            onPointerUp={() => void commitHapticsValue()}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                hapticsEditingRef.current = true;
                              }
                            }}
                            onKeyUp={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                void commitHapticsValue();
                              }
                            }}
                            onBlur={() => void commitHapticsValue()}
                          />
                        )}
                        <div className="range-ticks" aria-hidden="true">
                          {HAPTICS_SLIDER_TICKS.map((value) => (
                            <span key={value} className={sliderTickClass(value, 200)} />
                          ))}
                        </div>
                      </div>
                      <strong>{showClassicRumbleControl ? classicRumbleValue : hapticsValue}%</strong>
                    </label>
                  </div>
                  <p>{showClassicRumbleControl ? 'Applies to game rumble output.' : 'Balanced feedback across both motors.'}</p>
                  <div className="segmented-row">
                    {HAPTICS_PRESETS.map(([label, value]) => {
                      const presetValue = snapHapticsValue(Number(value));
                      const currentValue = showClassicRumbleControl ? classicRumbleValue : hapticsValue;
                      return (
                        <button
                          key={label}
                          type="button"
                          className={currentValue === presetValue ? 'active' : ''}
                          disabled={
                            !connected
                            || (showClassicRumbleControl ? !snapshot.settings.classicRumbleEnabled : !snapshot.settings.hapticsEnabled)
                          }
                          onClick={() => (
                            showClassicRumbleControl
                              ? setClassicRumblePreset(presetValue)
                              : setHapticsPreset(presetValue)
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </section>
                <section className="feature-card test-card">
                  <div className="feature-card-title">
                    <span className="feature-icon"><Activity size={20} /></span>
                    <div className="title-copy">
                      <h3>Testing</h3>
                      <p>Run a short test to feel the current settings.</p>
                    </div>
                  </div>
                  <button className="primary-action" type="button" disabled={activeFeedbackTestUnavailable} onClick={runFeedbackTest}>
                    <Play size={15} />
                    {showClassicRumbleControl
                      ? connected && gameStreamActive
                        ? 'Game Active'
                        : connected && audioStreamActive
                          ? 'Audio Active'
                        : connected && testLocked
                          ? 'Testing'
                          : 'Test Rumble'
                    : connected && gameStreamActive
                      ? 'Game Active'
                      : connected && audioStreamActive
                        ? 'Audio Active'
                      : connected && (testLocked || snapshot.status?.testHapticsCooldown)
                        ? 'Cooling Down'
                        : 'Test Haptics'}
                  </button>
                  <button className="secondary-action" type="button" disabled={!testLocked} onClick={() => setTestLocked(false)}>
                    <span className="stop-glyph" aria-hidden="true" />
                    Stop Test
                  </button>
                  <div className={`feature-status test-status ${activeFeedbackStatusTone}`}>
                    <span className="status-badge">
                      <span className={`dot ${activeFeedbackStatusTone}`} />
                      <strong>{activeFeedbackStatusLabel}</strong>
                    </span>
                  </div>
                </section>
              </div>
          </div>

          <div
            className="control-page audio-page"
            role="tabpanel"
            id="control-panel-audio"
            aria-labelledby="control-tab-audio"
            hidden={activeControlTab !== 'audio'}
          >
              <div className="feature-heading">
                <div>
                  <h2>Audio</h2>
                  <p>Adjust controller speaker and microphone levels.</p>
                </div>
                <div className="audio-heading-controls">
                  <div className="inline-switch">
                    <span>Host Encoded</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={hostAudioEnabled}
                      aria-label="Enable host encoded audio"
                      className={`switch ${hostAudioEnabled ? 'on' : ''}`}
                      disabled={!connected || pendingAction !== null}
                      onClick={toggleHostEncodedAudioEnabled}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="inline-switch">
                    <span>Enabled</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={audioEnabled}
                      aria-label="Enable audio"
                      className={`switch ${audioEnabled ? 'on' : ''}`}
                      disabled={!connected || pendingAction !== null}
                      onClick={toggleAudioEnabled}
                    >
                      <span />
                    </button>
                  </div>
                </div>
              </div>
              <div className="feature-card-grid">
                <section className="feature-card">
                  <div className="feature-card-title">
                    <button
                      type="button"
                      className={`feature-icon audio-enable-button ${
                        showMicrophoneControl
                          ? duplexMicEnabled
                            ? 'active'
                            : ''
                          : snapshot.settings.speakerEnabled
                            ? 'active'
                            : ''
                      }`}
                      aria-pressed={showMicrophoneControl ? duplexMicEnabled : snapshot.settings.speakerEnabled}
                      aria-label={showMicrophoneControl ? duplexMicLabel : 'Enable controller speaker'}
                      title={showMicrophoneControl ? duplexMicLabel : 'Enable controller speaker'}
                      disabled={
                        showMicrophoneControl
                          ? !connected || !hostAudioEnabled || pendingAction !== null
                          : !connected || !speakerVolumeSupported || pendingAction !== null
                      }
                      onClick={showMicrophoneControl ? toggleDuplexMicEnabled : toggleSpeakerEnabled}
                    >
                      {showMicrophoneControl ? <Mic size={20} /> : <Volume2 size={20} />}
                    </button>
                    <div className="title-copy">
                      <h3>{showMicrophoneControl ? 'Microphone' : 'Speaker'}</h3>
                      <p>
                        {showMicrophoneControl
                          ? 'Microphone input level.'
                          : 'Speaker output level.'}
                      </p>
                    </div>
                    <div className="dual-selector audio-mode-selector" role="tablist" aria-label="Audio control mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={!showMicrophoneControl}
                        className={!showMicrophoneControl ? 'active' : ''}
                        onClick={() => setShowMicrophoneControl(false)}
                      >
                        <Volume2 size={17} />
                        Speaker
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={showMicrophoneControl}
                        className={showMicrophoneControl ? 'active' : ''}
                        onClick={() => setShowMicrophoneControl(true)}
                      >
                        <Mic size={17} />
                        Mic
                      </button>
                    </div>
                  </div>
                  <div className="framed-slider">
                    <label className="slider-row">
                      <span>0%</span>
                      <div className="range-control">
                        {showMicrophoneControl ? (
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step={MIC_VOLUME_STEP}
                            value={micVolumeValue}
                            disabled={!connected || !hostAudioEnabled || !duplexMicEnabled || micVolumeCommitPending}
                            style={{ '--range-fill': `${micVolumeValue}%` } as CSSProperties}
                            aria-label="Microphone level"
                            onPointerDown={() => {
                              micVolumeEditingRef.current = true;
                            }}
                            onChange={(event) => setMicVolumeValue(snapMicVolume(Number(event.currentTarget.value)))}
                            onPointerUp={() => void commitMicVolume()}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                micVolumeEditingRef.current = true;
                              }
                            }}
                            onKeyUp={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                void commitMicVolume();
                              }
                            }}
                            onBlur={() => void commitMicVolume()}
                          />
                        ) : (
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step={SPEAKER_VOLUME_STEP}
                            value={speakerVolumeValue}
                            disabled={!connected || !speakerVolumeSupported || !snapshot.settings.speakerEnabled}
                            style={{ '--range-fill': `${speakerVolumeValue}%` } as CSSProperties}
                            onPointerDown={() => {
                              speakerVolumeEditingRef.current = true;
                            }}
                            onChange={(event) => setSpeakerVolumeValue(snapSpeakerVolume(Number(event.currentTarget.value)))}
                            onPointerUp={() => void commitSpeakerVolume()}
                            onKeyDown={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                speakerVolumeEditingRef.current = true;
                              }
                            }}
                            onKeyUp={(event) => {
                              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                                void commitSpeakerVolume();
                              }
                            }}
                            onBlur={() => void commitSpeakerVolume()}
                          />
                        )}
                        <div className="range-ticks" aria-hidden="true">
                          {PERCENT_SLIDER_TICKS.map((value) => (
                            <span key={value} className={sliderTickClass(value, 100)} />
                          ))}
                        </div>
                      </div>
                      <strong>{showMicrophoneControl ? micVolumeValue : speakerVolumeValue}%</strong>
                    </label>
                  </div>
                  {showMicrophoneControl ? (
                    <>
                      <p>Use presets for quick microphone levels.</p>
                      <div className="segmented-row">
                        {MIC_VOLUME_PRESETS.map(([label, value]) => (
                          <button
                            key={label}
                            type="button"
                            className={micVolumeValue === value ? 'active' : ''}
                            disabled={!connected || !hostAudioEnabled || !duplexMicEnabled || micVolumeCommitPending}
                            onClick={() => setMicPreset(Number(value))}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="mic-option-grid">
                        <button
                          type="button"
                          className={snapshot.settings.micMuted ? 'active danger' : ''}
                          aria-pressed={snapshot.settings.micMuted}
                          disabled={!connected || !duplexMicEnabled || pendingAction !== null}
                          onClick={toggleMicMute}
                        >
                          <VolumeX size={15} />
                          Mute
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p>Use presets for quick speaker levels.</p>
                      <div className="segmented-row">
                        {SPEAKER_VOLUME_PRESETS.map(([label, value]) => (
                          <button
                            key={label}
                            type="button"
                            className={speakerVolumeValue === value ? 'active' : ''}
                            disabled={!connected || !speakerVolumeSupported || !snapshot.settings.speakerEnabled || speakerVolumeCommitPending}
                            onClick={() => setSpeakerPreset(Number(value))}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>
                <section className="feature-card test-card">
                  <div className="feature-card-title">
                    <span className="feature-icon"><Activity size={20} /></span>
                    <div className="title-copy">
                      <h3>Testing</h3>
                      <p>{showMicrophoneControl ? 'Listen to the controller microphone for five seconds.' : 'Play a short sample through the controller speaker.'}</p>
                    </div>
                  </div>
                  <button
                    className="primary-action"
                    type="button"
                    disabled={activeAudioTestUnavailable}
                    onClick={showMicrophoneControl ? runTestMic : runTestSpeaker}
                  >
                    {showMicrophoneControl ? <Mic size={15} /> : <Play size={15} />}
                    {showMicrophoneControl
                      ? connected && micTestLocked
                        ? 'Live Listening'
                        : connected && micTestError
                          ? 'Retry Mic'
                          : 'Test Mic'
                      : connected && speakerTestLocked
                        ? 'Playing Tone'
                        : connected && gameStreamActive
                          ? 'Game Active'
                          : connected && speakerOutputMissing
                            ? 'Retry Speaker'
                          : 'Test Speaker'}
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    disabled={!activeAudioTestLocked}
                    onClick={showMicrophoneControl ? stopMicLiveListen : () => setSpeakerTestLocked(false)}
                  >
                    <span className="stop-glyph" aria-hidden="true" />
                    Stop Test
                  </button>
                  <div className="feature-status test-status audio-test-status">
                    <span className={`status-badge ${activeAudioTestStatusTone}`} title={activeAudioTestStatusLabel}>
                      <span className={`dot ${activeAudioTestStatusTone}`} />
                      <strong>{activeAudioTestStatusLabel}</strong>
                    </span>
                    <span className={`status-badge ${hostAudioTone}`} title={hostAudioLabel}>
                      <span className={`dot ${hostAudioTone}`} />
                      <strong>{hostAudioLabel}</strong>
                    </span>
                  </div>
                </section>
              </div>
          </div>

          <div
            className="control-page triggers-page"
            role="tabpanel"
            id="control-panel-triggers"
            aria-labelledby="control-tab-triggers"
            hidden={activeControlTab !== 'triggers'}
          >
              <div className="feature-heading">
                <div>
                  <h2>Adaptive Triggers</h2>
                  <p>Set trigger effect intensity and test mode.</p>
                </div>
                <div className="inline-switch">
                  <span>Enabled</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={snapshot.settings.adaptiveTriggersEnabled}
                    className={`switch ${snapshot.settings.adaptiveTriggersEnabled ? 'on' : ''}`}
                    disabled={!connected || !adaptiveTriggersSupported || pendingAction !== null}
                    onClick={toggleAdaptiveTriggersEnabled}
                  >
                    <span />
                  </button>
                </div>
              </div>
              <div className="feature-card-grid">
                <section className="feature-card">
                  <div className="feature-card-title">
                    <button
                      type="button"
                      className={`feature-icon triggers-enable-button ${snapshot.settings.adaptiveTriggersEnabled ? 'active' : ''}`}
                      aria-pressed={snapshot.settings.adaptiveTriggersEnabled}
                      aria-label="Enable adaptive triggers"
                      title="Enable adaptive triggers"
                      disabled={!connected || !adaptiveTriggersSupported || pendingAction !== null}
                      onClick={toggleAdaptiveTriggersEnabled}
                    >
                      <Zap size={20} />
                    </button>
                    <div className="title-copy">
                      <h3>Intensity</h3>
                      <p>Set the overall strength of adaptive trigger effects.</p>
                    </div>
                  </div>
                  <div className="framed-slider">
                    <label className="slider-row">
                      <span>0%</span>
                      <div className="range-control">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step={TRIGGER_EFFECT_STEP}
                          value={triggerEffectIntensityValue}
                          disabled={!connected || !adaptiveTriggersSupported || !snapshot.settings.adaptiveTriggersEnabled}
                          style={{ '--range-fill': `${triggerEffectIntensityValue}%` } as CSSProperties}
                          onPointerDown={() => {
                            triggerEffectEditingRef.current = true;
                          }}
                          onChange={(event) => (
                            setTriggerEffectIntensityValue(snapTriggerEffectIntensity(Number(event.currentTarget.value)))
                          )}
                          onPointerUp={() => void commitTriggerEffectIntensity()}
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                              triggerEffectEditingRef.current = true;
                            }
                          }}
                          onKeyUp={(event) => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                              void commitTriggerEffectIntensity();
                            }
                          }}
                          onBlur={() => void commitTriggerEffectIntensity()}
                        />
                        <div className="range-ticks" aria-hidden="true">
                          {PERCENT_SLIDER_TICKS.map((value) => (
                            <span key={value} className={sliderTickClass(value, 100)} />
                          ))}
                        </div>
                      </div>
                      <strong>{triggerEffectIntensityValue}%</strong>
                    </label>
                  </div>
                  <p>Use presets for quick trigger levels.</p>
                  <div className="segmented-row">
                    {TRIGGER_EFFECT_PRESETS.map(([label, value]) => (
                      <button
                        key={label}
                        type="button"
                        className={triggerEffectIntensityValue === value ? 'active' : ''}
                        disabled={!connected || !adaptiveTriggersSupported || !snapshot.settings.adaptiveTriggersEnabled || pendingAction !== null}
                        onClick={() => setTriggerIntensityPreset(Number(value))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="feature-card test-card">
                  <div className="feature-card-title">
                    <span className="feature-icon"><Activity size={20} /></span>
                    <div className="title-copy">
                      <h3>Testing</h3>
                      <p>Choose a trigger effect and run a short test.</p>
                    </div>
                  </div>
                  <div className="test-options">
                    <div className="select-row wide-select trigger-test-mode-control">
                      <CustomSelect
                        value={snapshot.settings.triggerTestMode}
                        disabled={!connected || !adaptiveTriggersSupported || !snapshot.settings.adaptiveTriggersEnabled || pendingAction !== null}
                        options={TRIGGER_TEST_MODE_OPTIONS}
                        ariaLabel="Trigger test type"
                        onChange={setTriggerTestMode}
                      />
                    </div>
                    <div className="target-row">
                      <div className="segmented-row compact">
                        {TRIGGER_TARGET_OPTIONS.map(([label, value]) => (
                          <button
                            key={value}
                            type="button"
                            className={triggerTarget === value ? 'active' : ''}
                            disabled={!connected || !adaptiveTriggersSupported}
                            onClick={() => setTriggerTarget(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="trigger-action-row">
                    <button className="primary-action" type="button" disabled={testTriggersUnavailable} onClick={runTestAdaptiveTriggers}>
                      <Play size={15} />
                      {connected && gameStreamActive
                        ? 'Game Active'
                        : connected && (triggerTestLocked || snapshot.status?.testAdaptiveTriggersBusy)
                          ? 'Testing'
                          : 'Test Triggers'}
                    </button>
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={!connected || !adaptiveTriggersSupported || pendingAction !== null}
                      onClick={resetAdaptiveTriggers}
                    >
                      <RefreshCcw size={14} />
                      Reset Triggers
                    </button>
                  </div>
                  <div className={`feature-status test-status ${triggerStatusTone}`}>
                    <span className="status-badge">
                      <span className={`dot ${triggerStatusTone}`} />
                      <strong>{triggerStatusLabel}</strong>
                    </span>
                  </div>
                </section>
              </div>
          </div>

          <div
            className="control-page lighting-page"
            role="tabpanel"
            id="control-panel-lighting"
            aria-labelledby="control-tab-lighting"
            hidden={activeControlTab !== 'lighting'}
          >
              <div className="feature-heading">
                <div>
                  <h2>Lighting</h2>
                  <p>Customize the controller light bar and override behavior.</p>
                </div>
                <div className="inline-switch">
                  <span>Enabled</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={snapshot.settings.lightbarEnabled}
                    className={`switch ${snapshot.settings.lightbarEnabled ? 'on' : ''}`}
                    disabled={!connected || !lightbarSupported || pendingAction !== null}
                    onClick={toggleLightbarEnabled}
                  >
                    <span />
                  </button>
                </div>
              </div>
              <div className="feature-card-grid lighting-grid">
                <section className="feature-card">
                  <div className="feature-card-title">
                    <button
                      type="button"
                      className={`feature-icon lighting-enable-button ${snapshot.settings.lightbarEnabled ? 'active' : ''}`}
                      aria-pressed={snapshot.settings.lightbarEnabled}
                      aria-label="Enable lighting"
                      title="Enable lighting"
                      disabled={!connected || !lightbarSupported || pendingAction !== null}
                      onClick={toggleLightbarEnabled}
                    >
                      <Palette size={20} />
                    </button>
                    <div className="title-copy">
                      <h3>Brightness</h3>
                      <p>Set the controller light bar brightness.</p>
                    </div>
                  </div>
                  <div className="framed-slider">
                    <label className="slider-row">
                      <span>0%</span>
                      <div className="range-control">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step={LIGHTBAR_BRIGHTNESS_STEP}
                          value={lightbarBrightnessValue}
                          disabled={!connected || !lightbarSupported || !snapshot.settings.lightbarEnabled}
                          style={{ '--range-fill': `${lightbarBrightnessValue}%` } as CSSProperties}
                          onPointerDown={() => {
                            lightbarBrightnessEditingRef.current = true;
                          }}
                          onChange={(event) => setLightbarBrightnessValue(snapLightbarBrightness(Number(event.currentTarget.value)))}
                          onPointerUp={() => void commitLightbar()}
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                              lightbarBrightnessEditingRef.current = true;
                            }
                          }}
                          onKeyUp={(event) => {
                            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                              void commitLightbar();
                            }
                          }}
                          onBlur={() => void commitLightbar()}
                        />
                        <div className="range-ticks" aria-hidden="true">
                          {PERCENT_SLIDER_TICKS.map((value) => (
                            <span key={value} className={sliderTickClass(value, 100)} />
                          ))}
                        </div>
                      </div>
                      <strong>{lightbarBrightnessValue}%</strong>
                    </label>
                  </div>
                  <p>Use presets for quick light bar levels.</p>
                  <div className="segmented-row">
                    {LIGHTBAR_PRESETS.map(([label, value]) => (
                      <button
                        key={label}
                        type="button"
                        className={lightbarBrightnessValue === value ? 'active' : ''}
                        disabled={!connected || !lightbarSupported || !snapshot.settings.lightbarEnabled}
                        onClick={() => setLightbarPreset(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </section>
                <section className="feature-card behavior-card">
                  <div className="feature-card-title">
                    <span className="feature-icon"><Zap size={20} /></span>
                    <div className="title-copy">
                      <h3>Behavior</h3>
                      <p>Set light bar behavior.</p>
                    </div>
                  </div>
                  <div className="behavior-toggle-row">
                    <div>
                      <strong>Light Bar Override</strong>
                      <p>Use app-controlled lighting instead of the default controller behavior.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={snapshot.settings.lightbarOverrideEnabled}
                      className={`switch ${snapshot.settings.lightbarOverrideEnabled ? 'on' : ''}`}
                      disabled={!connected || !lightbarOverrideSupported || !snapshot.settings.lightbarEnabled}
                      onClick={() => void runAction('lightbar-override', () => (
                        window.bridge.setLightbarOverrideEnabled(!snapshot.settings.lightbarOverrideEnabled)
                      ))}
                    >
                      <span />
                    </button>
                  </div>
                  <div className="light-color-panel">
                    <strong>Light Color</strong>
                    <div className="behavior-swatches" aria-label="Light bar color">
                      {LIGHTBAR_SWATCHES.map((color) => (
                        <button
                          key={color}
                          type="button"
                          title={`${lightbarColorName(color)} ${color.toUpperCase()}`}
                          className={normalizedLightbarColor === color ? 'active' : ''}
                          style={{ '--swatch-color': color } as CSSProperties}
                          disabled={!connected || !lightbarSupported || !snapshot.settings.lightbarEnabled}
                          onClick={() => selectLightbarColor(color)}
                        />
                      ))}
                      <div className="custom-color-anchor" ref={customColorPickerRef}>
                        <button
                          type="button"
                          className={`custom-color-swatch ${customSwatchSelected ? 'active' : ''} ${showCustomColorPicker ? 'picker-open' : ''} ${customSwatchPrimed && !customLightbarColor ? 'primed' : ''}`}
                          title={customLightbarColor ? `Custom ${customLightbarColor.toUpperCase()}` : 'Double-click to create a custom color'}
                          style={{ '--picker-color': customSwatchColor } as CSSProperties}
                          disabled={customColorPickerDisabled}
                          aria-pressed={customSwatchSelected}
                          onClick={selectCustomLightbarColor}
                          onDoubleClick={openCustomLightbarPicker}
                        >
                          <span className="custom-color-fill" aria-hidden="true" />
                          <Palette size={15} aria-hidden="true" />
                        </button>
                        {showCustomColorPicker && (
                          <div className="custom-color-popover" role="dialog" aria-label="Custom light bar color picker">
                            <div className="custom-color-popover-head">
                              <strong>Custom Color</strong>
                              <span>{customColorDraft.toUpperCase()}</span>
                            </div>
                            <div className="custom-color-palette" role="grid" aria-label="Custom color palette">
                              {LIGHTBAR_CUSTOM_PALETTE.map((row) => (
                                <div className="custom-color-palette-row" role="row" key={row[0].color}>
                                  {row.map((cell) => (
                                    <button
                                      key={cell.color}
                                      type="button"
                                      role="gridcell"
                                      className={normalizeHexColor(customColorDraft) === cell.color ? 'selected' : ''}
                                      style={{ '--picker-color': cell.color } as CSSProperties}
                                      title={`${cell.name} ${cell.color.toUpperCase()}`}
                                      aria-label={`${cell.name} ${cell.color.toUpperCase()}`}
                                      disabled={customColorPickerDisabled}
                                      onClick={() => previewCustomLightbarColor(cell.color)}
                                    />
                                  ))}
                                </div>
                              ))}
                            </div>
                            <div className="custom-color-picker-row">
                              <span
                                className="custom-color-preview"
                                style={{ '--picker-color': customColorDraft } as CSSProperties}
                                aria-hidden="true"
                              />
                              <code>{customColorDraft.toUpperCase()}</code>
                            </div>
                            <button
                              type="button"
                              className="custom-color-apply"
                              disabled={customColorPickerDisabled}
                              onClick={() => saveCustomLightbarColor(customColorDraft)}
                            >
                              Use Color
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="light-color-meta">
                      <strong>{lightbarColorName(lightbarColor)}</strong>
                      <span>{normalizedLightbarColor.toUpperCase()}</span>
                    </div>
                  </div>
                  <div className="feature-status lighting-status">
                    <span className={`status-badge ${lightbarStateActive ? 'good' : 'idle'}`}>
                      <span className={`dot ${lightbarStateActive ? 'good' : 'idle'}`} />
                      <strong>{lightbarStateLabel}</strong>
                    </span>
                  </div>
                </section>
              </div>
          </div>

          <div
            className="control-page system-page"
            role="tabpanel"
            id="control-panel-system"
            aria-labelledby="control-tab-system"
            hidden={activeControlTab !== 'system'}
          >
              <div className="feature-heading system-heading">
                <div>
                  <h2>System</h2>
                  <p>Configure bridge behavior and defaults.</p>
                </div>
                <div className="profile-controls">
                  <CustomSelect
                    value={snapshot.settings.selectedPresetId}
                    disabled={!connected || pendingAction !== null}
                    options={BRIDGE_PRESET_OPTIONS}
                    ariaLabel="Bridge profile"
                    onChange={applyPreset}
                  />
                  <button
                    className="heading-action"
                    type="button"
                    disabled={!connected || pendingAction !== null || hapticsCommitPending || speakerVolumeCommitPending || lightbarCommitPending}
                    onClick={() => void runAction('restore', () => window.bridge.restoreDefaults())}
                  >
                    <RefreshCcw size={18} />
                    Restore Defaults
                  </button>
                </div>
              </div>

              <div className="feature-card-grid">
                <section className="system-card mute-card">
                  <div className="feature-card-title system-card-heading">
                    <span className="feature-icon system-icon"><VolumeX size={20} /></span>
                    <div className="title-copy">
                      <h3>Mute Button</h3>
                      <p>Set controller mute behavior.</p>
                    </div>
                  </div>
                  <div className="system-fields">
                    <div className="select-row">
                      <span>Behavior</span>
                      <CustomSelect
                        value={snapshot.settings.muteButtonMode}
                        disabled={!connected || !muteButtonActionsSupported || pendingAction !== null}
                        options={MUTE_BUTTON_MODE_OPTIONS}
                        ariaLabel="Mute button behavior"
                        onChange={(mode) => setMuteButtonAction(mode)}
                      />
                    </div>
                    {snapshot.settings.muteButtonMode === 'keyboard' && (
                      <>
                        <div className="select-row">
                          <span>Key</span>
                          <CustomSelect
                            value={snapshot.settings.muteKeyboardUsage}
                            disabled={!connected || !muteButtonActionsSupported || pendingAction !== null}
                            options={MUTE_KEY_OPTIONS}
                            ariaLabel="Mute keyboard key"
                            onChange={(usage) => setMuteButtonAction('keyboard', usage)}
                          />
                        </div>
                        <div className="select-row">
                          <span>Press Mode</span>
                          <CustomSelect
                            value={snapshot.settings.muteKeyboardBehavior}
                            disabled={!connected || !muteButtonActionsSupported || pendingAction !== null}
                            options={MUTE_KEYBOARD_BEHAVIOR_OPTIONS}
                            ariaLabel="Mute keyboard press mode"
                            onChange={(behavior) => setMuteButtonAction('keyboard', undefined, undefined, behavior)}
                          />
                        </div>
                        <div className="modifier-block">
                          <div className="modifier-grid" aria-label="Keyboard modifiers">
                            {MUTE_MODIFIER_OPTIONS.map(([label, bit]) => {
                              const enabled = (snapshot.settings.muteKeyboardModifiers & bit) !== 0;
                              return (
                                <button
                                  key={bit}
                                  type="button"
                                  className={enabled ? 'active' : ''}
                                  disabled={!connected || !muteButtonActionsSupported || pendingAction !== null}
                                  onClick={() => setMuteModifier(bit, !enabled)}
                                >
                                  <Keyboard size={16} />
                                  {label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                    {snapshot.settings.muteButtonMode === 'quiet' && (
                      <div className={`quiet-state ${snapshot.status?.quietModeEnabled ? 'active' : ''}`}>
                        <VolumeX size={18} />
                        <span>{snapshot.status?.quietModeEnabled ? 'Controller Quiet On' : 'Controller Quiet Off'}</span>
                      </div>
                    )}
                  </div>
                </section>

                <section className={`system-card device-card ${showDiagnostics ? 'expanded' : ''}`}>
                  <div className="feature-card-title system-card-heading">
                    <span className="feature-icon system-icon">
                      {showDiagnostics ? <SlidersHorizontal size={20} /> : <Settings2 size={20} />}
                    </span>
                    <div className="title-copy">
                      <h3>{showDiagnostics ? 'Diagnostics' : 'Device'}</h3>
                        <p>
                          {showDiagnostics
                            ? 'Debug Data'
                            : 'Firmware'}
                        </p>
                    </div>
                    <div className="dual-selector system-mode-selector" role="tablist" aria-label="System control mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={!showDiagnostics}
                        className={!showDiagnostics ? 'active' : ''}
                        onClick={() => setShowDiagnostics(false)}
                      >
                        <Settings2 size={17} />
                        Device
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={showDiagnostics}
                        className={showDiagnostics ? 'active' : ''}
                        onClick={() => setShowDiagnostics(true)}
                      >
                        <SlidersHorizontal size={17} />
                        Diagnostics
                      </button>
                    </div>
                  </div>
                  {showDiagnostics ? (
                    <div className="device-diagnostics">
                      <dl>
                        <div><dt>Protocol</dt><dd>{snapshot.diagnostics.protocolVersion ?? '--'}</dd></div>
                        <div>
                          <dt>Uptime</dt>
                          <dd>
                            <UptimeValue
                              active={diagnosticsVisible}
                              lastPollAt={snapshot.diagnostics.lastPollAt}
                              uptimeSeconds={snapshot.diagnostics.uptimeSeconds}
                            />
                          </dd>
                        </div>
                        <div>
                          <dt>Revision</dt>
                          <dd><span className="diagnostic-number">{snapshot.diagnostics.settingsRevision ?? '--'}</span></dd>
                        </div>
                        <div><dt>Last ACK</dt><dd>{ackText}</dd></div>
                        <div><dt>HID Path</dt><dd>{snapshot.diagnostics.hidPath ?? '--'}</dd></div>
                        <div>
                          <dt>Audio Log</dt>
                          <dd title={snapshot.diagnostics.audioDebugLogPath ?? undefined}>
                            {snapshot.diagnostics.audioDebugLogPath ?? '--'}
                          </dd>
                        </div>
                        <div>
                          <dt>Dropped</dt>
                          <dd><span className="diagnostic-number">{snapshot.diagnostics.audioDebugDroppedCount}</span></dd>
                        </div>
                        <div className="debug-entry">
                          <dt>Audio Debug</dt>
                          <dd>
                            <textarea readOnly value={audioDebugText} aria-label="Audio debug copy text" />
                          </dd>
                        </div>
                        <div className="debug-entry">
                          <dt>Audio Events</dt>
                          <dd>
                            <textarea readOnly value={audioEventLogText} aria-label="Audio event log text" />
                          </dd>
                        </div>
                      </dl>
                    </div>
                  ) : (
                    <div className="device-list">
                      <div className="device-row">
                        <span>Firmware</span>
                        <strong>{snapshot.status?.firmwareVersion ?? '--'}</strong>
                      </div>
                      <div className="device-row">
                        <span>Controller</span>
                        <strong>{controllerConnected ? controllerName(snapshot.status?.controllerType) : '--'}</strong>
                      </div>
                      <div className="device-row device-control-row">
                        <span>Polling Rate</span>
                        <CustomSelect
                          value={snapshot.settings.pollingRateMode}
                          disabled={!connected || !pollingRateControlSupported || pendingAction !== null}
                          options={POLLING_RATE_OPTIONS}
                          ariaLabel="Polling rate"
                          onChange={setPollingRateMode}
                        />
                      </div>
                      <div className="device-row">
                        <span>Status</span>
                        <strong className={`health-label ${snapshot.diagnostics.lastError ? 'bad' : 'good'}`}>
                          <span className={`dot ${snapshot.diagnostics.lastError ? 'bad' : statusTone}`} />
                          {healthLabel(snapshot)}
                        </strong>
                      </div>
                    </div>
                  )}
                </section>
              </div>
          </div>
        </div>
      </section>
      </main>

    </div>
  );
}
