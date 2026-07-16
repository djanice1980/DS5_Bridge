import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CompanionDebugConfig, DEBUG_ENV } from './debug-config';
import type {
  AudioReactiveHapticsSource,
  AudioReactiveHapticsAttack,
  AudioReactiveHapticsBassFocus,
  AudioReactiveHapticsRelease,
  AudioReactiveHapticsResponse,
  HostPersonaMode
} from '../shared/protocol';
import type { AudioHapticsSession } from '../shared/types';

export type SystemAudioHapticsConfig = {
  source: AudioReactiveHapticsSource;
  gainPercent: number;
  bassFocus: AudioReactiveHapticsBassFocus;
  response: AudioReactiveHapticsResponse;
  attack: AudioReactiveHapticsAttack;
  release: AudioReactiveHapticsRelease;
};

export type DefaultRenderEndpointStatus = {
  deviceName: string;
  isBridgeEndpoint: boolean;
};

type AudioHelperStartFailureReason =
  | 'device-in-use'
  | 'device-invalidated'
  | 'unsupported-format'
  | 'bulk-pcm-unavailable'
  | 'app-session-unavailable'
  | 'start-timeout'
  | 'start-cancelled'
  | 'helper-exit';

class AudioHelperStartError extends Error {
  constructor(
    message: string,
    readonly reason: AudioHelperStartFailureReason
  ) {
    super(message);
    this.name = 'AudioHelperStartError';
  }
}

const HELPER_RECORDING_STARTED_MESSAGE = 'status: recording-started';
const HELPER_CAPTURE_UNAVAILABLE_PREFIX = 'status: capture-unavailable';
const HELPER_START_TIMEOUT_MS = 8000;
const HELPER_TEST_TONE_TIMEOUT_MS = 10000;
const HELPER_COMMAND_TIMEOUT_MS = 2500;
const HELPER_SESSION_MONITOR_START_TIMEOUT_MS = 3000;
const HELPER_SESSION_MONITOR_STOP_TIMEOUT_MS = 500;
const HELPER_STDERR_MAX_CHARS = 8192;
const HELPER_EXECUTABLE_NAME = process.platform === 'win32' ? 'AudioHelper.exe' : 'AudioHelper';
const HELPER_PUBLISH_RID = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
const HELPER_RELATIVE_PATH = path.join('native', 'AudioHelper', HELPER_EXECUTABLE_NAME);
const HELPER_TEST_AUDIO_FILE = 'test-speaker-tone-silence-tail.mp3';

const DEV_HELPER_RELATIVE_PATH = path.join(
  'native',
  'AudioHelper',
  'bin',
  'publish',
  HELPER_PUBLISH_RID,
  HELPER_EXECUTABLE_NAME
);

export type AudioHelperCommand = {
  command: string;
  args: string[];
  label: string;
};

function normalizeBridgePersonaMode(mode: HostPersonaMode): HostPersonaMode {
  if (mode === 'xbox' || mode === 'ds4') {
    return mode;
  }
  return 'dualsense';
}

function bridgePersonaArgs(mode: HostPersonaMode): string[] {
  return ['--bridge-persona', normalizeBridgePersonaMode(mode)];
}

export class SystemAudioHapticsEngine extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private activeHostPersonaMode: HostPersonaMode = 'dualsense';
  private activeConfig: SystemAudioHapticsConfig = {
    source: 'system-audio',
    gainPercent: 100,
    bassFocus: 'balanced',
    response: 'balanced',
    attack: 'balanced',
    release: 'balanced'
  };

  async start(config: SystemAudioHapticsConfig, hostPersonaMode: HostPersonaMode = 'dualsense'): Promise<void> {
    const nextConfig = normalizeSystemAudioHapticsConfig(config);
    const nextHostPersonaMode = normalizeBridgePersonaMode(hostPersonaMode);
    if (this.process) {
      if (
        audioReactiveHapticsSourceKey(this.activeConfig.source) !== audioReactiveHapticsSourceKey(nextConfig.source)
        || this.activeHostPersonaMode !== nextHostPersonaMode
      ) {
        await this.stop();
        return this.start(nextConfig, nextHostPersonaMode);
      }
      this.setConfig(nextConfig);
      return;
    }
    if (this.starting) {
      await this.starting;
      if (this.process) {
        if (
          audioReactiveHapticsSourceKey(this.activeConfig.source) === audioReactiveHapticsSourceKey(nextConfig.source)
          && this.activeHostPersonaMode === nextHostPersonaMode
        ) {
          this.setConfig(nextConfig);
          return;
        }
        await this.stop();
      }
      return this.start(nextConfig, nextHostPersonaMode);
    }

    this.starting = this.startInternal(nextConfig, nextHostPersonaMode).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  setConfig(config: SystemAudioHapticsConfig): void {
    this.activeConfig = normalizeSystemAudioHapticsConfig(config);
    this.writeControlLine(
      `haptics-config ${this.activeConfig.gainPercent} ${this.activeConfig.bassFocus} ${this.activeConfig.response} ${this.activeConfig.attack} ${this.activeConfig.release}`
    );
  }

  private writeControlLine(line: string): void {
    const helper = this.process;
    if (!helper || helper.stdin.destroyed || !helper.stdin.writable) {
      return;
    }
    try {
      helper.stdin.write(`${line}\n`, (error) => {
        if (error && !isExpectedHelperPipeError(error)) {
          this.emit('error', error);
        }
      });
    } catch (error) {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    }
  }

  async stop(): Promise<void> {
    const helper = this.process;
    this.process = null;
    if (!helper) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!helper.killed) {
          helper.kill('SIGKILL');
        }
        resolve();
      }, 500);

      helper.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      helper.stdin?.end();
      helper.kill();
    });
  }

  isActive(): boolean {
    return this.process !== null;
  }

  private async startInternal(config: SystemAudioHapticsConfig, hostPersonaMode: HostPersonaMode): Promise<void> {
    const helperPath = resolveHelperPath();
    this.activeConfig = config;
    this.activeHostPersonaMode = hostPersonaMode;
    const args = [
      ...bridgePersonaArgs(hostPersonaMode),
      '--source',
      'render-loopback',
      '--haptics-only',
      '--haptics-gain',
      `${config.gainPercent}`,
      '--haptics-bass-focus',
      config.bassFocus,
      '--haptics-response',
      config.response,
      '--haptics-attack',
      config.attack,
      '--haptics-release',
      config.release
    ];
    const appSource = audioReactiveHapticsAppSource(config.source);
    if (appSource) {
      if (Number.isFinite(appSource.processId) && appSource.processId > 0) {
        args.push('--haptics-app-process-id', `${Math.round(appSource.processId)}`);
      }
      if (appSource.processPath) {
        args.push('--haptics-app-process-path', appSource.processPath);
      }
      if (appSource.executableName) {
        args.push('--haptics-app-executable', appSource.executableName);
      }
    }

    const helper = spawn(helperPath, args, {
      env: buildSystemAudioHapticsHelperEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process = helper;
    helper.stdin.on('error', (error) => {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    });
    helper.stdout.resume();
    helper.on('error', (error) => this.emit('error', error));
    helper.on('exit', (code, signal) => {
      if (this.process === helper) {
        this.process = null;
        this.emit('status', `system audio haptics helper exited (${signal ?? code ?? 'unknown'})`);
      }
    });

    await waitForHelperRecordingStarted(helper, (line) => this.emit('status', line));
  }
}

export type HapticsFrameWriter = (fragment: number[]) => void;

// Compact-frame + fragment constants, mirroring AudioConstants /
// LegacyFramePacketizer in the native helper.
const COMPACT_FRAME_BYTES = 264;
const FAST_PAYLOAD_BYTES = 57;
const HID_REPORT_BYTES = 64;
const LEGACY_AUDIO_STREAM_REPORT_ID = 0x07;
const FAST_FRAME_FRAGMENT_TYPE = 0x08;
const MAX_FRAME_BYTES = 4096;

// Linux path for Audio Haptics. The native helper (--haptics-only --stdout-only)
// captures audio, runs the DSP, and writes 264-byte haptic frames to stdout.
// This engine reassembles those frames, splits each into the firmware's 64-byte
// fragments, and forwards them over the vendor USB interface the main transport
// already holds — because libusb interface claims are exclusive, a standalone
// helper cannot open a second handle the way the Windows WinUSB helper does.
export class LinuxUsbHapticsEngine extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private activeHostPersonaMode: HostPersonaMode = 'dualsense';
  private activeConfig: SystemAudioHapticsConfig = {
    source: 'system-audio',
    gainPercent: 100,
    bassFocus: 'balanced',
    response: 'balanced',
    attack: 'balanced',
    release: 'balanced'
  };
  private frameBuffer: Buffer = Buffer.alloc(0);
  private frameSequence = 0;

  constructor(private readonly getFrameWriter: () => HapticsFrameWriter | null) {
    super();
  }

  async start(config: SystemAudioHapticsConfig, hostPersonaMode: HostPersonaMode = 'dualsense'): Promise<void> {
    const nextConfig = normalizeSystemAudioHapticsConfig(config);
    const nextHostPersonaMode = normalizeBridgePersonaMode(hostPersonaMode);
    if (this.process) {
      if (
        audioReactiveHapticsSourceKey(this.activeConfig.source) !== audioReactiveHapticsSourceKey(nextConfig.source)
        || this.activeHostPersonaMode !== nextHostPersonaMode
      ) {
        await this.stop();
        return this.start(nextConfig, nextHostPersonaMode);
      }
      this.setConfig(nextConfig);
      return;
    }
    if (this.starting) {
      await this.starting;
      return this.start(nextConfig, nextHostPersonaMode);
    }

    this.starting = this.startInternal(nextConfig, nextHostPersonaMode).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  setConfig(config: SystemAudioHapticsConfig): void {
    this.activeConfig = normalizeSystemAudioHapticsConfig(config);
    const helper = this.process;
    if (!helper || helper.stdin.destroyed || !helper.stdin.writable) {
      return;
    }
    const line = `haptics-config ${this.activeConfig.gainPercent} ${this.activeConfig.bassFocus} ${this.activeConfig.response} ${this.activeConfig.attack} ${this.activeConfig.release}`;
    try {
      helper.stdin.write(`${line}\n`, (error) => {
        if (error && !isExpectedHelperPipeError(error)) {
          this.emit('error', error);
        }
      });
    } catch (error) {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    }
  }

  async stop(): Promise<void> {
    const helper = this.process;
    this.process = null;
    this.frameBuffer = Buffer.alloc(0);
    if (!helper) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!helper.killed) {
          helper.kill('SIGKILL');
        }
        resolve();
      }, 500);
      helper.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      helper.stdin?.end();
      helper.kill();
    });
  }

  isActive(): boolean {
    return this.process !== null;
  }

  private async startInternal(config: SystemAudioHapticsConfig, hostPersonaMode: HostPersonaMode): Promise<void> {
    const helperPath = resolveHelperPath();
    this.activeConfig = config;
    this.activeHostPersonaMode = hostPersonaMode;
    this.frameBuffer = Buffer.alloc(0);
    const args = [
      ...bridgePersonaArgs(hostPersonaMode),
      '--source',
      'render-loopback',
      '--haptics-only',
      '--stdout-only',
      '--haptics-gain',
      `${config.gainPercent}`,
      '--haptics-bass-focus',
      config.bassFocus,
      '--haptics-response',
      config.response,
      '--haptics-attack',
      config.attack,
      '--haptics-release',
      config.release
    ];
    const appSource = audioReactiveHapticsAppSource(config.source);
    if (appSource) {
      if (Number.isFinite(appSource.processId) && appSource.processId > 0) {
        args.push('--haptics-app-process-id', `${Math.round(appSource.processId)}`);
      }
      if (appSource.processPath) {
        args.push('--haptics-app-process-path', appSource.processPath);
      }
      if (appSource.executableName) {
        args.push('--haptics-app-executable', appSource.executableName);
      }
    }

    const helper = spawn(helperPath, args, {
      env: buildSystemAudioHapticsHelperEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process = helper;
    helper.stdin.on('error', (error) => {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    });
    helper.stdout.on('data', (chunk: Buffer) => this.handleFrameData(chunk));
    helper.on('error', (error) => this.emit('error', error));
    helper.on('exit', (code, signal) => {
      if (this.process === helper) {
        this.process = null;
        this.emit('status', `usb haptics helper exited (${signal ?? code ?? 'unknown'})`);
      }
    });

    await waitForHelperRecordingStarted(helper, (line) => this.emit('status', line));
  }

  private handleFrameData(chunk: Buffer): void {
    this.frameBuffer = this.frameBuffer.length ? Buffer.concat([this.frameBuffer, chunk]) : chunk;
    while (this.frameBuffer.length >= 2) {
      const length = this.frameBuffer.readUInt16LE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        // Stream desync — drop the buffer rather than emit garbage frames.
        this.frameBuffer = Buffer.alloc(0);
        return;
      }
      if (this.frameBuffer.length < 2 + length) {
        return;
      }
      const frame = this.frameBuffer.subarray(2, 2 + length);
      this.frameBuffer = Buffer.from(this.frameBuffer.subarray(2 + length));
      if (length === COMPACT_FRAME_BYTES) {
        this.emitFrame(frame);
      }
    }
  }

  private emitFrame(frame: Buffer): void {
    const writer = this.getFrameWriter();
    if (!writer) {
      return;
    }
    const sequence = this.frameSequence & 0xffff;
    this.frameSequence = (this.frameSequence + 1) & 0xffff;
    for (const fragment of buildHapticFrameFragments(frame, sequence)) {
      writer(fragment);
    }
  }
}

// Split a 264-byte compact frame into the firmware's 64-byte fragment reports.
// Byte-for-byte equivalent of LegacyFramePacketizer.WriteFastHidFragments in
// the native helper; exported so the layout can be unit-tested without hardware.
export function buildHapticFrameFragments(frame: ArrayLike<number>, sequence: number): number[][] {
  const seq = sequence & 0xffff;
  const fragmentCount = Math.ceil(frame.length / FAST_PAYLOAD_BYTES);
  const fragments: number[][] = [];
  let fragmentIndex = 0;
  for (let offset = 0; offset < frame.length; offset += FAST_PAYLOAD_BYTES) {
    const payloadLength = Math.min(FAST_PAYLOAD_BYTES, frame.length - offset);
    const report = new Array<number>(HID_REPORT_BYTES).fill(0);
    report[0] = LEGACY_AUDIO_STREAM_REPORT_ID;
    report[1] = FAST_FRAME_FRAGMENT_TYPE;
    report[2] = seq & 0xff;
    report[3] = (seq >> 8) & 0xff;
    report[4] = fragmentIndex;
    report[5] = fragmentCount;
    report[6] = payloadLength;
    for (let i = 0; i < payloadLength; i += 1) {
      report[7 + i] = frame[offset + i] & 0xff;
    }
    fragments.push(report);
    fragmentIndex += 1;
  }
  return fragments;
}

export class AudioHapticsSessionMonitor extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private readonly stoppingHelpers = new WeakSet<ChildProcessWithoutNullStreams>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private sessions: AudioHapticsSession[] = [];
  private haveSnapshot = false;

  async start(): Promise<void> {
    if (this.process && this.haveSnapshot) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async listSessions(): Promise<AudioHapticsSession[]> {
    await this.start();
    return cloneAudioHapticsSessions(this.sessions);
  }

  async refresh(): Promise<AudioHapticsSession[]> {
    await this.start();
    this.writeControlLine('refresh');
    return cloneAudioHapticsSessions(this.sessions);
  }

  async stop(): Promise<void> {
    const helper = this.process;
    this.process = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.haveSnapshot = false;
    if (!helper) {
      return;
    }

    this.stoppingHelpers.add(helper);
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!helper.killed) {
          helper.kill('SIGKILL');
        }
        resolve();
      }, HELPER_SESSION_MONITOR_STOP_TIMEOUT_MS);

      helper.once('exit', () => {
        clearTimeout(timeout);
        this.stoppingHelpers.delete(helper);
        resolve();
      });

      this.writeControlLine('stop', helper);
      helper.stdin?.end();
      helper.kill();
    });
  }

  isActive(): boolean {
    return this.process !== null;
  }

  private async startInternal(): Promise<void> {
    const helperPath = resolveHelperPath();
    const helper = spawn(helperPath, ['--monitor-audio-sessions'], {
      env: buildSystemAudioHapticsHelperEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process = helper;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.haveSnapshot = false;
    helper.stdin.on('error', (error) => {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    });
    helper.on('error', (error) => this.emit('error', error));
    helper.on('exit', (code, signal) => {
      const wasStoppedByCompanion = this.stoppingHelpers.has(helper);
      this.stoppingHelpers.delete(helper);
      if (this.process === helper) {
        this.process = null;
        this.stdoutBuffer = '';
        this.stderrBuffer = '';
        this.haveSnapshot = false;
      }
      if (!wasStoppedByCompanion) {
        this.emit('status', `audio session monitor exited (${signal ?? code ?? 'unknown'})`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error) {
          if (this.process === helper) {
            this.process = null;
          }
          if (!helper.killed) {
            helper.kill();
          }
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        finish(new Error(`Audio haptics session monitor did not produce a snapshot within ${HELPER_SESSION_MONITOR_START_TIMEOUT_MS}ms.`));
      }, HELPER_SESSION_MONITOR_START_TIMEOUT_MS);

      helper.stdout.on('data', (chunk: Buffer) => {
        this.processMonitorStdout(chunk, () => finish());
      });
      helper.stderr.on('data', (chunk: Buffer) => {
        this.processMonitorStderr(chunk);
      });
      helper.once('error', finish);
      helper.once('exit', (code, signal) => {
        const detail = this.stderrBuffer.trim() || `helper exited (${signal ?? code ?? 'unknown'})`;
        finish(new Error(`Audio haptics session monitor failed to start: ${detail}`));
      });
    });
  }

  private writeControlLine(line: string, helper = this.process): void {
    if (!helper || helper.stdin.destroyed || !helper.stdin.writable) {
      return;
    }
    try {
      helper.stdin.write(`${line}\n`, (error) => {
        if (error && !isExpectedHelperPipeError(error)) {
          this.emit('error', error);
        }
      });
    } catch (error) {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    }
  }

  private processMonitorStdout(chunk: Buffer, onSnapshot?: () => void): void {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const sessions = parseAudioHapticsSessionMonitorLine(line);
      if (!sessions) {
        continue;
      }
      this.sessions = sessions;
      this.haveSnapshot = true;
      this.emit('sessions', cloneAudioHapticsSessions(sessions));
      onSnapshot?.();
    }
  }

  private processMonitorStderr(chunk: Buffer): void {
    this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-HELPER_STDERR_MAX_CHARS);
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const text = line.trim();
      if (text) {
        this.emit('status', text);
      }
    }
  }
}

function normalizeSpeakerVolumePercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeTestHapticsGainPercent(percent: number): number {
  return Math.max(0, Math.min(200, Math.round(percent)));
}

function normalizeSystemAudioHapticsConfig(config: SystemAudioHapticsConfig): SystemAudioHapticsConfig {
  return {
    source: normalizeAudioReactiveHapticsSource(config.source),
    gainPercent: Math.max(0, Math.min(200, Math.round(config.gainPercent))),
    bassFocus: config.bassFocus === 'deep' || config.bassFocus === 'punchy' || config.bassFocus === 'wide'
      ? config.bassFocus
      : 'balanced',
    response: config.response === 'subtle' || config.response === 'strong'
      ? config.response
      : 'balanced',
    attack: config.attack === 'soft' || config.attack === 'fast' || config.attack === 'sharp'
      ? config.attack
      : 'balanced',
    release: config.release === 'tight' || config.release === 'smooth' || config.release === 'long'
      ? config.release
      : 'balanced'
  };
}

function parseAudioHapticsSessionMonitorLine(raw: string): AudioHapticsSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const message = parsed as { type?: unknown; sessions?: unknown };
  if (message.type !== 'snapshot') {
    return null;
  }
  return normalizeAudioHapticsSessionArray(message.sessions);
}

function normalizeAudioHapticsSessionArray(parsed: unknown): AudioHapticsSession[] {
  if (!Array.isArray(parsed)) {
    return [];
  }
  const sessions: AudioHapticsSession[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const candidate = value as Partial<AudioHapticsSession>;
    const processId = Number.isFinite(candidate.processId)
      ? Math.max(0, Math.round(candidate.processId!))
      : 0;
    const displayName = normalizeOptionalText(candidate.displayName);
    if (processId <= 0 || !displayName) {
      continue;
    }
    sessions.push({
      processId,
      displayName,
      executableName: normalizeOptionalText(candidate.executableName) ?? null,
      processPath: normalizeOptionalText(candidate.processPath) ?? null,
      iconPath: normalizeOptionalText(candidate.iconPath) ?? null,
      iconDataUrl: normalizeOptionalText(candidate.iconDataUrl) ?? null,
      sessionIdentifier: normalizeOptionalText(candidate.sessionIdentifier) ?? null,
      sessionInstanceIdentifier: normalizeOptionalText(candidate.sessionInstanceIdentifier) ?? null,
      state: normalizeOptionalText(candidate.state) ?? 'inactive',
      endpointName: normalizeOptionalText(candidate.endpointName) ?? '',
      isSelected: Boolean(candidate.isSelected)
    });
  }
  return sessions;
}

function cloneAudioHapticsSessions(sessions: AudioHapticsSession[]): AudioHapticsSession[] {
  return sessions.map((session) => ({ ...session }));
}

function normalizeAudioReactiveHapticsSource(source: AudioReactiveHapticsSource | undefined): AudioReactiveHapticsSource {
  if (source === 'controller-audio' || source === 'system-audio') {
    return source;
  }
  const appSource = audioReactiveHapticsAppSource(source);
  if (!appSource) {
    return 'system-audio';
  }
  const processId = Number.isFinite(appSource.processId) ? Math.max(0, Math.round(appSource.processId)) : 0;
  return {
    kind: 'app-session',
    processId,
    displayName: normalizeOptionalText(appSource.displayName),
    executableName: normalizeOptionalText(appSource.executableName),
    processPath: normalizeOptionalText(appSource.processPath),
    sessionIdentifier: normalizeOptionalText(appSource.sessionIdentifier),
    sessionInstanceIdentifier: normalizeOptionalText(appSource.sessionInstanceIdentifier)
  };
}

function audioReactiveHapticsAppSource(source: AudioReactiveHapticsSource | undefined) {
  return source && typeof source === 'object' && source.kind === 'app-session'
    ? source
    : null;
}

function audioReactiveHapticsSourceKey(source: AudioReactiveHapticsSource): string {
  const appSource = audioReactiveHapticsAppSource(source);
  if (!appSource) {
    return source === 'controller-audio' ? 'controller-audio' : 'system-audio';
  }
  if (appSource.processPath) {
    return `app-path:${appSource.processPath.toLowerCase()}`;
  }
  if (appSource.executableName) {
    return `app-exe:${appSource.executableName.toLowerCase()}`;
  }
  return `app-pid:${Math.max(0, Math.round(appSource.processId))}`;
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isExpectedHelperPipeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPIPE'
    || code === 'ERR_STREAM_DESTROYED'
    || error.message.includes('write EPIPE');
}

function parseCaptureUnavailableReason(line: string): AudioHelperStartFailureReason | null {
  if (!line.startsWith(HELPER_CAPTURE_UNAVAILABLE_PREFIX)) {
    return null;
  }
  if (line.includes('reason=device-in-use')) {
    return 'device-in-use';
  }
  if (line.includes('reason=device-invalidated')) {
    return 'device-invalidated';
  }
  if (line.includes('reason=unsupported-format')) {
    return 'unsupported-format';
  }
  if (line.includes('reason=bulk-pcm-unavailable')) {
    return 'bulk-pcm-unavailable';
  }
  if (
    line.includes('reason=app-session-unavailable')
    || line.includes('reason=app-loopback-unavailable')
    || line.includes('reason=app-loopback-timeout')
  ) {
    return 'app-session-unavailable';
  }
  return 'helper-exit';
}

function audioHelperStartFailureMessage(reason: AudioHelperStartFailureReason): string {
  switch (reason) {
    case 'device-in-use':
      return 'DualSense audio endpoint is in exclusive use by another application.';
    case 'device-invalidated':
      return 'DualSense audio endpoint changed while audio helper capture was starting.';
    case 'unsupported-format':
      return 'DualSense raw PCM capture endpoint format is not usable by Windows. Re-enumerate or clean stale DualSense audio devices.';
    case 'bulk-pcm-unavailable':
      return 'DS5 Bridge WinUSB PCM pipe is unavailable. Re-enumerate or clean stale DS5 Bridge devices.';
    case 'app-session-unavailable':
      return 'Selected audio app is not available for haptics yet.';
    case 'start-timeout':
      return `Audio helper did not start recording within ${HELPER_START_TIMEOUT_MS}ms.`;
    case 'start-cancelled':
      return 'Audio helper startup was cancelled.';
    case 'helper-exit':
      return 'Audio helper exited before recording started.';
  }
}

function buildSystemAudioHapticsHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env[DEBUG_ENV.audioHelperDiagnostics] ??= CompanionDebugConfig.audioHelperDiagnosticsEnabled ? '1' : '0';
  return env;
}

async function runAudioHelperCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const commands = resolveAudioHelperCommands(args);
  let lastError: Error | null = null;
  for (const command of commands) {
    try {
      return await runAudioHelperCommandOnce(command.command, command.args);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('Audio helper command failed.');
}

function runAudioHelperCommandOnce(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const helper = spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        if (!helper.killed) {
          helper.kill();
        }
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Audio helper command timed out after ${HELPER_COMMAND_TIMEOUT_MS}ms.`));
    }, HELPER_COMMAND_TIMEOUT_MS);

    helper.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-HELPER_STDERR_MAX_CHARS);
    });
    helper.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-HELPER_STDERR_MAX_CHARS);
    });
    helper.on('error', (error) => finish(error));
    helper.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || `helper exited (${signal ?? code ?? 'unknown'})`;
      finish(new Error(detail));
    });
  });
}

function parseDefaultRenderEndpointStatus(stdout: string): DefaultRenderEndpointStatus {
  const text = stdout.trim();
  if (!text) {
    throw new Error('Audio helper did not report the default render endpoint.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Audio helper reported invalid default render endpoint status.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Audio helper reported invalid default render endpoint status.');
  }
  const value = parsed as Partial<DefaultRenderEndpointStatus>;
  return {
    deviceName: typeof value.deviceName === 'string' ? value.deviceName : '',
    isBridgeEndpoint: Boolean(value.isBridgeEndpoint)
  };
}

async function waitForHelperRecordingStarted(
  helper: ChildProcessWithoutNullStreams,
  onStatus: (line: string) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        if (!helper.killed) {
          helper.kill();
        }
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      finish(new AudioHelperStartError(
        `Audio helper did not start recording within ${HELPER_START_TIMEOUT_MS}ms.`,
        'start-timeout'
      ));
    }, HELPER_START_TIMEOUT_MS);

    helper.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const lines = stderr.split(/\r?\n/);
      stderr = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) {
          continue;
        }
        onStatus(text);
        if (text.includes(HELPER_RECORDING_STARTED_MESSAGE)) {
          finish();
          continue;
        }
        const reason = parseCaptureUnavailableReason(text);
        if (reason) {
          finish(new AudioHelperStartError(
            audioHelperStartFailureMessage(reason),
            reason
          ));
        }
      }
    });
    helper.once('exit', (code, signal) => {
      finish(new AudioHelperStartError(
        `Audio helper exited before recording started: helper exited (${signal ?? code ?? 'unknown'}).`,
        'helper-exit'
      ));
    });
  });
}

export async function playBridgeSpeakerTestTone(
  speakerVolumePercent = 100,
  hostPersonaMode: HostPersonaMode = 'dualsense'
): Promise<void> {
  const helperPath = resolveHelperPath();
  const testAudioPath = resolveHelperTestAudioPath(helperPath);
  const helper = spawn(helperPath, [
    '--play-test-tone',
    ...bridgePersonaArgs(hostPersonaMode),
    '--test-audio-path',
    testAudioPath,
    '--speaker-volume',
    `${normalizeSpeakerVolumePercent(speakerVolumePercent)}`
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      if (!helper.killed) {
        helper.kill('SIGKILL');
      }
      finish(new Error('Speaker test helper timed out.'));
    }, HELPER_TEST_TONE_TIMEOUT_MS);

    helper.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > HELPER_STDERR_MAX_CHARS) {
        stderr = stderr.slice(-HELPER_STDERR_MAX_CHARS);
      }
    });
    helper.on('error', (error) => finish(error));
    helper.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || `helper exited (${signal ?? code ?? 'unknown'})`;
      finish(new Error(detail));
    });
  });
}

export async function playBridgeHapticsTestPattern(
  hapticsGainPercent = 100,
  hostPersonaMode: HostPersonaMode = 'dualsense'
): Promise<void> {
  const helperPath = resolveHelperPath();
  const helper = spawn(helperPath, [
    '--play-test-haptics',
    ...bridgePersonaArgs(hostPersonaMode),
    '--haptics-gain',
    `${normalizeTestHapticsGainPercent(hapticsGainPercent)}`
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = setTimeout(() => {
      if (!helper.killed) {
        helper.kill('SIGKILL');
      }
      finish(new Error('Haptics test helper timed out.'));
    }, HELPER_TEST_TONE_TIMEOUT_MS);

    helper.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > HELPER_STDERR_MAX_CHARS) {
        stderr = stderr.slice(-HELPER_STDERR_MAX_CHARS);
      }
    });
    helper.on('error', (error) => finish(error));
    helper.on('exit', (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = stderr.trim() || `helper exited (${signal ?? code ?? 'unknown'})`;
      finish(new Error(detail));
    });
  });
}

export async function getDefaultRenderEndpointStatus(): Promise<DefaultRenderEndpointStatus> {
  const result = await runAudioHelperCommand(['--default-render-status']);
  return parseDefaultRenderEndpointStatus(result.stdout);
}

export async function setDefaultRenderBridgeEndpoint(mode: HostPersonaMode): Promise<void> {
  await runAudioHelperCommand([
    '--set-default-render-bridge',
    '--bridge-persona',
    mode
  ]);
}

// Linux only: boost the controller sink's software volume to make up the
// ~6 dB the PipeWire USB-audio path loses, so a firmware gain level sounds the
// same as on Windows. The helper no-ops on a sink the user has already
// adjusted; safe to call again (it re-checks before applying).
export async function applyLinuxSpeakerCompensation(): Promise<void> {
  await runAudioHelperCommand(['--apply-speaker-compensation']);
}

export class MicKeepaliveEngine extends EventEmitter {
  private process: ChildProcess | null = null;
  private starting: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const helper = this.process;
    this.process = null;
    if (!helper) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!helper.killed) {
          helper.kill('SIGKILL');
        }
        resolve();
      }, 500);

      helper.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      helper.stdin?.end();
      helper.kill();
    });
  }

  isActive(): boolean {
    return this.process !== null;
  }

  private async startInternal(): Promise<void> {
    const helperPath = resolveHelperPath();
    const helper = spawn(helperPath, ['--mic-keepalive-only', '--mic-device-name', 'DS5 Bridge'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });

    this.process = helper;
    helper.stderr.on('data', (chunk: Buffer) => {
      this.emit('status', chunk.toString('utf8').trim());
    });
    helper.on('error', (error) => this.emit('error', error));
    helper.on('exit', (code, signal) => {
      if (this.process === helper) {
        this.process = null;
        this.emit('status', `mic keepalive helper exited (${signal ?? code ?? 'unknown'})`);
      }
    });
  }
}

/**
 * Linux only: holds an EVIOCGRAB on the DualSense touchpad's evdev node so it stops
 * acting as a mouse. The helper self-locates the touchpad and re-grabs across controller
 * reconnects; killing this process (stop()) releases the grab and restores the touchpad.
 */
export class TouchpadInhibitEngine extends EventEmitter {
  private process: ChildProcess | null = null;
  private starting: Promise<void> | null = null;

  async start(): Promise<void> {
    if (this.process) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const helper = this.process;
    this.process = null;
    if (!helper) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!helper.killed) {
          helper.kill('SIGKILL');
        }
        resolve();
      }, 500);

      helper.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      helper.stdin?.end();
      helper.kill();
    });
  }

  isActive(): boolean {
    return this.process !== null;
  }

  private async startInternal(): Promise<void> {
    const helperPath = resolveHelperPath();
    const helper = spawn(helperPath, ['--inhibit-touchpad'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });

    this.process = helper;
    helper.stderr.on('data', (chunk: Buffer) => {
      this.emit('status', chunk.toString('utf8').trim());
    });
    helper.on('error', (error) => this.emit('error', error));
    helper.on('exit', (code, signal) => {
      if (this.process === helper) {
        this.process = null;
        this.emit('status', `touchpad inhibitor exited (${signal ?? code ?? 'unknown'})`);
      }
    });
  }
}

const UINPUT_READY_MESSAGE = 'status: uinput-ready';
const UINPUT_UNAVAILABLE_PREFIX = 'status: uinput-unavailable';
const UINPUT_START_TIMEOUT_MS = 5000;

// Persistent helper-hosted /dev/uinput keyboard for chord key injection on
// Linux. The device stays open between chords: compositors ignore events from
// a uinput device for a short window after it appears, so a device-per-press
// approach drops keystrokes.
export class VirtualKeyboardEngine extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pendingResponse: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private stdoutBuffer = '';

  async sendKeySequence(codes: number[]): Promise<void> {
    const task = this.queue.then(() => this.sendKeySequenceInternal(codes));
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async stop(): Promise<void> {
    const helper = this.process;
    this.process = null;
    this.failPendingResponse(new Error('Virtual keyboard helper stopped.'));
    if (!helper) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!helper.killed) {
          helper.kill('SIGKILL');
        }
        resolve();
      }, 500);

      helper.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      helper.stdin?.end();
      helper.kill();
    });
  }

  private async sendKeySequenceInternal(codes: number[]): Promise<void> {
    await this.ensureStarted();
    const helper = this.process;
    if (!helper?.stdin?.writable) {
      throw new Error('Virtual keyboard helper is not running.');
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error('Timed out waiting for the virtual keyboard helper.'));
      }, HELPER_COMMAND_TIMEOUT_MS);
      this.pendingResponse = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };
      helper.stdin.write(`keys ${codes.join(',')}\n`, (error) => {
        if (error) {
          this.pendingResponse = null;
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.process) {
      return;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private startInternal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const helperPath = resolveHelperPath();
      const helper = spawn(helperPath, ['--uinput-keyboard'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams;

      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          helper.kill();
          reject(new Error('Timed out starting the virtual keyboard helper.'));
        }
      }, UINPUT_START_TIMEOUT_MS);

      helper.stderr.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          this.emit('status', trimmed);
          if (!settled && trimmed.startsWith(UINPUT_READY_MESSAGE)) {
            settled = true;
            clearTimeout(timeout);
            this.process = helper;
            resolve();
          } else if (!settled && trimmed.startsWith(UINPUT_UNAVAILABLE_PREFIX)) {
            settled = true;
            clearTimeout(timeout);
            helper.kill();
            reject(new Error(`Virtual keyboard unavailable: ${trimmed}`));
          }
        }
      });

      helper.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString('utf8');
        let newlineIndex = this.stdoutBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
          newlineIndex = this.stdoutBuffer.indexOf('\n');
          if (!line) {
            continue;
          }
          const pending = this.pendingResponse;
          this.pendingResponse = null;
          if (!pending) {
            continue;
          }
          if (line === 'ok') {
            pending.resolve();
          } else {
            pending.reject(new Error(`Shortcut key injection failed: ${line}`));
          }
        }
      });

      helper.on('error', (error) => {
        this.emit('error', error);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        }
        this.failPendingResponse(error);
      });

      helper.on('exit', (code, signal) => {
        if (this.process === helper) {
          this.process = null;
        }
        this.emit('status', `virtual keyboard helper exited (${signal ?? code ?? 'unknown'})`);
        const exitError = new Error('Virtual keyboard helper exited.');
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(exitError);
        }
        this.failPendingResponse(exitError);
      });
    });
  }

  private failPendingResponse(error: Error): void {
    const pending = this.pendingResponse;
    this.pendingResponse = null;
    pending?.reject(error);
  }
}

let sharedVirtualKeyboardEngine: VirtualKeyboardEngine | null = null;

export function virtualKeyboardEngine(): VirtualKeyboardEngine {
  if (!sharedVirtualKeyboardEngine) {
    sharedVirtualKeyboardEngine = new VirtualKeyboardEngine();
  }
  return sharedVirtualKeyboardEngine;
}

export async function stopVirtualKeyboardEngine(): Promise<void> {
  const engine = sharedVirtualKeyboardEngine;
  sharedVirtualKeyboardEngine = null;
  if (engine) {
    await engine.stop();
  }
}

export function resolveAudioHelperPath(): string {
  const packagedCandidate = process.resourcesPath ? path.join(process.resourcesPath, HELPER_RELATIVE_PATH) : null;
  const devCandidates = [
    path.resolve(process.cwd(), DEV_HELPER_RELATIVE_PATH),
    path.resolve(__dirname, '..', '..', '..', DEV_HELPER_RELATIVE_PATH)
  ];
  const candidates = [
    packagedCandidate,
    ...(isDevelopmentRuntime() ? devCandidates : [])
  ].filter((candidate): candidate is string => Boolean(candidate));

  const helperPath = candidates.find((candidate) => existsSync(candidate));
  if (!helperPath) {
    throw new Error('Audio helper is missing. Run npm run build:audio-helper from companion/.');
  }
  return helperPath;
}

export function resolveAudioHelperCommands(args: string[]): AudioHelperCommand[] {
  const helperPath = resolveAudioHelperPath();
  const commands: AudioHelperCommand[] = [{
    command: helperPath,
    args,
    label: helperPath
  }];
  for (const dllPath of audioHelperDllFallbackCandidates(helperPath)) {
    commands.push({
      command: 'dotnet',
      args: [dllPath, ...args],
      label: `dotnet ${dllPath}`
    });
  }
  return commands;
}

function resolveHelperPath(): string {
  return resolveAudioHelperPath();
}

function audioHelperDllFallbackCandidates(helperPath: string): string[] {
  const seen = new Set<string>();
  const candidates = [
    path.join(path.dirname(helperPath), 'AudioHelper.dll'),
    ...audioHelperBuildDllFallbackCandidates(helperPath)
  ];
  return candidates.filter((candidate) => {
    const normalized = path.normalize(candidate).toLowerCase();
    if (seen.has(normalized) || !existsSync(candidate)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function audioHelperBuildDllFallbackCandidates(helperPath: string): string[] {
  const binDirectory = path.resolve(path.dirname(helperPath), '..', '..');
  const candidates: string[] = [];
  for (const configuration of ['Release', 'Debug']) {
    const configurationDirectory = path.join(binDirectory, configuration);
    for (const targetFramework of safeReadDirectory(configurationDirectory)) {
      if (!targetFramework.startsWith('net')) {
        continue;
      }
      candidates.push(
        path.join(configurationDirectory, targetFramework, HELPER_PUBLISH_RID, 'AudioHelper.dll'),
        path.join(configurationDirectory, targetFramework, 'AudioHelper.dll')
      );
    }
  }
  return candidates;
}

function safeReadDirectory(directoryPath: string): string[] {
  try {
    return readdirSync(directoryPath);
  } catch {
    return [];
  }
}

function resolveHelperTestAudioPath(helperPath: string): string {
  const candidates = [
    path.join(path.dirname(helperPath), HELPER_TEST_AUDIO_FILE),
    ...(isDevelopmentRuntime()
      ? [
          path.resolve(process.cwd(), 'src', 'renderer', 'assets', HELPER_TEST_AUDIO_FILE),
          path.resolve(__dirname, '..', '..', '..', 'src', 'renderer', 'assets', HELPER_TEST_AUDIO_FILE)
        ]
      : [])
  ];

  const audioPath = candidates.find((candidate) => existsSync(candidate));
  if (!audioPath) {
    throw new Error(`Speaker test audio is missing: ${HELPER_TEST_AUDIO_FILE}`);
  }
  return audioPath;
}

function isDevelopmentRuntime(): boolean {
  const processWithElectronFlags = process as NodeJS.Process & { defaultApp?: boolean };
  return Boolean(processWithElectronFlags.defaultApp)
    || process.env.NODE_ENV === 'development'
    || process.env.VITEST === 'true';
}
