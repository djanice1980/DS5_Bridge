import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CompanionDebugConfig, DEBUG_ENV } from './debug-config';
import type {
  AudioReactiveHapticsSource,
  AudioReactiveHapticsAttack,
  AudioReactiveHapticsBassFocus,
  AudioReactiveHapticsRelease,
  AudioReactiveHapticsResponse
} from '../shared/protocol';
import type { AudioHapticsSession } from '../shared/types';

export type HostAudioFramePayload = {
  frame: number[];
  sequence: number;
  encodedBytes: number;
};

export type SystemAudioHapticsConfig = {
  source: AudioReactiveHapticsSource;
  gainPercent: number;
  bassFocus: AudioReactiveHapticsBassFocus;
  response: AudioReactiveHapticsResponse;
  attack: AudioReactiveHapticsAttack;
  release: AudioReactiveHapticsRelease;
};

export type HostAudioStartFailureReason =
  | 'device-in-use'
  | 'device-invalidated'
  | 'unsupported-format'
  | 'bulk-pcm-unavailable'
  | 'app-session-unavailable'
  | 'start-timeout'
  | 'start-cancelled'
  | 'helper-exit';

export class HostAudioStartError extends Error {
  constructor(
    message: string,
    readonly reason: HostAudioStartFailureReason
  ) {
    super(message);
    this.name = 'HostAudioStartError';
  }
}

const FRAME_RECORD_PREFIX_BYTES = 2;
const HOST_AUDIO_FRAME_BYTES = 264;
const HELPER_RECORDING_STARTED_MESSAGE = 'status: recording-started';
const HELPER_CAPTURE_UNAVAILABLE_PREFIX = 'status: capture-unavailable';
const HELPER_START_TIMEOUT_MS = 8000;
const HELPER_TEST_TONE_TIMEOUT_MS = 10000;
const HELPER_SESSION_LIST_TIMEOUT_MS = 3000;
const HELPER_STDERR_MAX_CHARS = 8192;
const HELPER_RELATIVE_PATH = path.join('native', 'HostAudioHelper', 'HostAudioHelper.exe');
const HELPER_TEST_AUDIO_FILE = 'test-speaker-tone-silence-tail.mp3';
type HostAudioSource = 'usb-pcm' | 'usb-bulk-pcm' | 'raw-pcm-capture' | 'render-loopback';

const HOST_AUDIO_SOURCE = normalizeHostAudioSource(CompanionDebugConfig.hostAudioSource);
const BRIDGE_AUDIO_DEVICE_NAME = 'DS5 Bridge';
const BRIDGE_RAW_PCM_DEVICE_NAME = 'DS5 Bridge Raw PCM';
const HOST_AUDIO_AUTO_CAPTURE_ENABLED = CompanionDebugConfig.hostAudioAutoCaptureEnabled;
const HOST_AUDIO_DIAGNOSTIC_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const HOST_AUDIO_DIAGNOSTIC_DIR = path.join(homedir(), 'Desktop');
const DEV_HELPER_RELATIVE_PATH = path.join(
  'native',
  'HostAudioHelper',
  'bin',
  'publish',
  'win-x64',
  'HostAudioHelper.exe'
);

export class HostAudioEngine extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private readonly stoppingHelpers = new WeakSet<ChildProcessWithoutNullStreams>();
  private stdoutBuffer = Buffer.alloc(0);
  private sequence = 0;
  private activeHidPath: string | null = null;
  private activeSpeakerVolumePercent = 100;

  async start(hidPath: string | null, speakerVolumePercent = 100): Promise<void> {
    const nextSpeakerVolumePercent = normalizeSpeakerVolumePercent(speakerVolumePercent);
    if (this.process) {
      if (this.activeHidPath !== hidPath) {
        await this.stop();
      } else {
        this.setSpeakerVolumePercent(nextSpeakerVolumePercent);
        return;
      }
    }
    if (this.process) {
      return;
    }
    if (this.starting) {
      await this.starting;
      if (this.process && this.activeHidPath === hidPath) {
        this.setSpeakerVolumePercent(nextSpeakerVolumePercent);
        return;
      }
      return this.start(hidPath, nextSpeakerVolumePercent);
    }

    this.starting = this.startInternal(hidPath, nextSpeakerVolumePercent).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  setSpeakerVolumePercent(percent: number): void {
    const nextSpeakerVolumePercent = normalizeSpeakerVolumePercent(percent);
    this.activeSpeakerVolumePercent = nextSpeakerVolumePercent;
    this.writeControlLine(`speaker-volume ${nextSpeakerVolumePercent}`);
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
    this.activeHidPath = null;
    this.activeSpeakerVolumePercent = 100;
    this.stdoutBuffer = Buffer.alloc(0);
    this.sequence = 0;
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
      }, 500);

      helper.once('exit', () => {
        clearTimeout(timeout);
        this.stoppingHelpers.delete(helper);
        resolve();
      });

      helper.stdin?.end();
      helper.kill();
    });
  }

  isActive(): boolean {
    return this.process !== null;
  }

  private async startInternal(hidPath: string | null, speakerVolumePercent: number): Promise<void> {
    const helperPath = resolveHelperPath();
    const deviceName = HOST_AUDIO_SOURCE === 'raw-pcm-capture' ? BRIDGE_RAW_PCM_DEVICE_NAME : BRIDGE_AUDIO_DEVICE_NAME;
    const args = [
      '--device-name',
      deviceName,
      '--source',
      HOST_AUDIO_SOURCE,
      '--speaker-volume',
      `${speakerVolumePercent}`
    ];
    if (hidPath) {
      args.push('--hid-path', hidPath);
    }
    const helper = spawn(helperPath, args, {
      env: buildHostAudioHelperEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process = helper;
    this.activeHidPath = hidPath;
    this.activeSpeakerVolumePercent = speakerVolumePercent;
    helper.stdin.on('error', (error) => {
      if (!isExpectedHelperPipeError(error)) {
        this.emit('error', error);
      }
    });
    helper.stdout.on('data', (chunk: Buffer) => this.processStdout(chunk));
    helper.on('error', (error) => this.emit('error', error));
    helper.on('exit', (code, signal) => {
      if (this.process === helper) {
        this.process = null;
        this.activeHidPath = null;
        this.activeSpeakerVolumePercent = 100;
        this.stdoutBuffer = Buffer.alloc(0);
        this.emit('status', `host audio helper exited (${signal ?? code ?? 'unknown'})`);
      }
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
          if (!helper.killed) {
            helper.kill();
          }
          reject(error);
        } else {
          resolve();
        }
      };
      const timeout = setTimeout(() => {
        finish(new HostAudioStartError(
          `Host audio helper did not start recording within ${HELPER_START_TIMEOUT_MS}ms.`,
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
          this.emit('status', text);
          if (text.includes(HELPER_RECORDING_STARTED_MESSAGE)) {
            finish();
            continue;
          }
          const reason = parseCaptureUnavailableReason(text);
          if (reason) {
            finish(new HostAudioStartError(
              hostAudioStartFailureMessage(reason),
              reason
            ));
          }
        }
      });
      helper.once('exit', (code, signal) => {
        const wasStoppedByCompanion = this.stoppingHelpers.has(helper);
        this.stoppingHelpers.delete(helper);
        finish(new HostAudioStartError(
          wasStoppedByCompanion
            ? 'Host audio helper startup was cancelled.'
            : `Host audio helper exited before recording started: helper exited (${signal ?? code ?? 'unknown'}).`,
          wasStoppedByCompanion ? 'start-cancelled' : 'helper-exit'
        ));
      });
    });
  }

  private processStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (this.stdoutBuffer.length >= FRAME_RECORD_PREFIX_BYTES) {
      const frameLength = this.stdoutBuffer.readUInt16LE(0);
      if (frameLength !== HOST_AUDIO_FRAME_BYTES) {
        this.stdoutBuffer = Buffer.alloc(0);
        this.emit('error', new Error(`Unexpected host audio frame length ${frameLength}`));
        return;
      }
      const recordLength = FRAME_RECORD_PREFIX_BYTES + frameLength;
      if (this.stdoutBuffer.length < recordLength) {
        return;
      }

      const frame = this.stdoutBuffer.subarray(FRAME_RECORD_PREFIX_BYTES, recordLength);
      this.stdoutBuffer = this.stdoutBuffer.subarray(recordLength);

      this.emit('frame', {
        frame: [...frame],
        sequence: this.sequence,
        encodedBytes: Math.max(0, frame.length - 64)
      } satisfies HostAudioFramePayload);
      this.sequence = (this.sequence + 1) & 0xffff;
    }
  }
}

export class SystemAudioHapticsEngine extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private activeConfig: SystemAudioHapticsConfig = {
    source: 'system-audio',
    gainPercent: 100,
    bassFocus: 'balanced',
    response: 'balanced',
    attack: 'balanced',
    release: 'balanced'
  };

  async start(config: SystemAudioHapticsConfig): Promise<void> {
    const nextConfig = normalizeSystemAudioHapticsConfig(config);
    if (this.process) {
      if (audioReactiveHapticsSourceKey(this.activeConfig.source) !== audioReactiveHapticsSourceKey(nextConfig.source)) {
        await this.stop();
        return this.start(nextConfig);
      }
      this.setConfig(nextConfig);
      return;
    }
    if (this.starting) {
      await this.starting;
      if (this.process) {
        this.setConfig(nextConfig);
        return;
      }
      return this.start(nextConfig);
    }

    this.starting = this.startInternal(nextConfig).finally(() => {
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

  private async startInternal(config: SystemAudioHapticsConfig): Promise<void> {
    const helperPath = resolveHelperPath();
    this.activeConfig = config;
    const args = [
      '--device-name',
      BRIDGE_AUDIO_DEVICE_NAME,
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

function normalizeSpeakerVolumePercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
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

function parseAudioHapticsSessions(raw: string): AudioHapticsSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
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

function parseCaptureUnavailableReason(line: string): HostAudioStartFailureReason | null {
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

function hostAudioStartFailureMessage(reason: HostAudioStartFailureReason): string {
  switch (reason) {
    case 'device-in-use':
      return 'DualSense audio endpoint is in exclusive use by another application.';
    case 'device-invalidated':
      return 'DualSense audio endpoint changed while host audio was starting.';
    case 'unsupported-format':
      return 'DualSense raw PCM capture endpoint format is not usable by Windows. Re-enumerate or clean stale DualSense audio devices.';
    case 'bulk-pcm-unavailable':
      return 'DS5 Bridge WinUSB PCM pipe is unavailable. Re-enumerate or clean stale DS5 Bridge devices, then Host Encoding will retry.';
    case 'app-session-unavailable':
      return 'Selected audio app is not available for haptics yet.';
    case 'start-timeout':
      return `Host audio helper did not start recording within ${HELPER_START_TIMEOUT_MS}ms.`;
    case 'start-cancelled':
      return 'Host audio helper startup was cancelled.';
    case 'helper-exit':
      return 'Host audio helper exited before recording started.';
  }
}

function buildHostAudioHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!isWinUsbPcmSource(HOST_AUDIO_SOURCE) || !HOST_AUDIO_AUTO_CAPTURE_ENABLED) {
    return env;
  }

  env[DEBUG_ENV.hostAudioHelperDiagnostics] ??= CompanionDebugConfig.hostAudioHelperDiagnosticsEnabled ? '1' : '0';
  if (CompanionDebugConfig.hostAudioDumpEnabled) {
    env[DEBUG_ENV.hostAudioRawCaptureDump] ??= path.join(
      HOST_AUDIO_DIAGNOSTIC_DIR,
      `ds5-bridge-winusb-pcm-${HOST_AUDIO_DIAGNOSTIC_STAMP}.wav`
    );
    env[DEBUG_ENV.hostAudioRawCaptureDumpSeconds] ??= '20';
    env[DEBUG_ENV.hostAudioFrameDump] ??= path.join(
      HOST_AUDIO_DIAGNOSTIC_DIR,
      `ds5-bridge-host-frames-${HOST_AUDIO_DIAGNOSTIC_STAMP}.bin`
    );
    env[DEBUG_ENV.hostAudioFrameDumpLimit] ??= '2500';
  }
  return env;
}

function buildSystemAudioHapticsHelperEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env[DEBUG_ENV.hostAudioHelperDiagnostics] ??= CompanionDebugConfig.hostAudioHelperDiagnosticsEnabled ? '1' : '0';
  return env;
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
      finish(new HostAudioStartError(
        `Host audio helper did not start recording within ${HELPER_START_TIMEOUT_MS}ms.`,
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
          finish(new HostAudioStartError(
            hostAudioStartFailureMessage(reason),
            reason
          ));
        }
      }
    });
    helper.once('exit', (code, signal) => {
      finish(new HostAudioStartError(
        `Host audio helper exited before recording started: helper exited (${signal ?? code ?? 'unknown'}).`,
        'helper-exit'
      ));
    });
  });
}

export async function playHostAudioTestTone(speakerVolumePercent = 100): Promise<void> {
  const helperPath = resolveHelperPath();
  const testAudioPath = resolveHelperTestAudioPath(helperPath);
  const helper = spawn(helperPath, [
    '--play-test-tone',
    '--device-name',
    'DS5 Bridge',
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

export async function listAudioHapticsSessions(source: AudioReactiveHapticsSource = 'system-audio'): Promise<AudioHapticsSession[]> {
  const helperPath = resolveHelperPath();
  const args = ['--list-audio-sessions'];
  const appSource = audioReactiveHapticsAppSource(normalizeAudioReactiveHapticsSource(source));
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
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const raw = await new Promise<string>((resolve, reject) => {
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
        resolve(stdout);
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Audio haptics session list timed out after ${HELPER_SESSION_LIST_TIMEOUT_MS}ms.`));
    }, HELPER_SESSION_LIST_TIMEOUT_MS);

    helper.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    helper.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-HELPER_STDERR_MAX_CHARS);
    });
    helper.once('error', finish);
    helper.once('exit', (code, signal) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`Audio haptics session list failed (${signal ?? code ?? 'unknown'}): ${stderr.trim()}`));
      }
    });
  });

  return parseAudioHapticsSessions(raw);
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

function normalizeHostAudioSource(value: string | undefined): HostAudioSource {
  if (value === 'render-loopback' || value === 'raw-pcm-capture') {
    return value;
  }
  if (value === 'usb-bulk-pcm' || value === 'usb-pcm') {
    return 'usb-pcm';
  }
  return 'usb-pcm';
}

function isWinUsbPcmSource(value: HostAudioSource): boolean {
  return value === 'usb-pcm' || value === 'usb-bulk-pcm';
}

export function hostAudioUsesRawPcmCapture(): boolean {
  return HOST_AUDIO_SOURCE === 'raw-pcm-capture';
}

export function resolveHostAudioHelperPath(): string {
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
    throw new Error(`Host audio helper is missing. Run npm run build:host-audio from companion/.`);
  }
  return helperPath;
}

function resolveHelperPath(): string {
  return resolveHostAudioHelperPath();
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
