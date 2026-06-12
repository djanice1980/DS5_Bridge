import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class MockWritable extends EventEmitter {
    destroyed = false;
    writable = true;
    end = vi.fn(() => {
      this.writable = false;
    });
    write = vi.fn((_line: string, callback?: (error?: Error | null) => void) => {
      callback?.();
      return true;
    });
  }

  class MockChildProcess extends EventEmitter {
    stdout = Object.assign(new EventEmitter(), { resume: vi.fn() });
    stderr = new EventEmitter();
    stdin = new MockWritable();
    killed = false;
    kill = vi.fn((signal?: string) => {
      this.killed = true;
      this.emit('exit', null, signal ?? 'SIGTERM');
      return true;
    });
  }

  const processes: MockChildProcess[] = [];

  return {
    processes,
    spawn: vi.fn(() => {
      const process = new MockChildProcess();
      processes.push(process);
      return process;
    })
  };
});

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true)
}));

vi.mock('node:child_process', () => ({
  spawn: childProcessMock.spawn
}));

vi.mock('node:fs', () => ({
  existsSync: fsMock.existsSync
}));

import {
  AudioHapticsSessionMonitor,
  SystemAudioHapticsEngine,
  type AudioHapticsFramePayload
} from './audio-helper';

const FRAME_LENGTH = 264;

beforeEach(() => {
  childProcessMock.processes.length = 0;
  childProcessMock.spawn.mockClear();
  fsMock.existsSync.mockClear();
  fsMock.existsSync.mockReturnValue(true);
});

function frameRecord(seed: number): Buffer {
  const record = Buffer.alloc(2 + FRAME_LENGTH);
  record.writeUInt16LE(FRAME_LENGTH, 0);
  for (let index = 0; index < FRAME_LENGTH; index += 1) {
    record[2 + index] = (seed + index) & 0xff;
  }
  return record;
}

describe('SystemAudioHapticsEngine app source', () => {
  it('passes selected app session identity to the helper', async () => {
    const engine = new SystemAudioHapticsEngine();
    const start = engine.start({
      source: {
        kind: 'app-session',
        processId: 1234,
        displayName: 'Game',
        executableName: 'Game.exe',
        processPath: 'C:\\Games\\Game.exe'
      },
      gainPercent: 125,
      bassFocus: 'punchy',
      response: 'strong',
      attack: 'fast',
      release: 'smooth'
    });

    const helper = childProcessMock.processes[0]!;
    helper.stderr.emit('data', Buffer.from('status: recording-started\n'));
    await start;

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    const args = childProcessMock.spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--haptics-app-process-id');
    expect(args).toContain('1234');
    expect(args).toContain('--haptics-app-process-path');
    expect(args).toContain('C:\\Games\\Game.exe');
    expect(args).toContain('--haptics-app-executable');
    expect(args).toContain('Game.exe');
    expect(args).not.toContain('--stdout-only');

    await engine.stop();
  });

  it('parses direct haptics frames from stdout', async () => {
    const engine = new SystemAudioHapticsEngine();
    const frames: AudioHapticsFramePayload[] = [];
    engine.on('frame', (frame) => frames.push(frame));

    const start = engine.start({
      source: 'system-audio',
      gainPercent: 100,
      bassFocus: 'balanced',
      response: 'balanced',
      attack: 'balanced',
      release: 'balanced',
      directFrames: true
    });
    const helper = childProcessMock.processes[0]!;
    helper.stderr.emit('data', Buffer.from('status: recording-started\n'));
    await start;

    helper.stdout.emit('data', frameRecord(42));

    const args = childProcessMock.spawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--stdout-only');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.sequence).toBe(0);
    expect(frames[0]!.frame.slice(0, 4)).toEqual([42, 43, 44, 45]);

    await engine.stop();
  });
});

describe('audio haptics session listing', () => {
  it('keeps one monitor helper alive and returns cached snapshots', async () => {
    const monitor = new AudioHapticsSessionMonitor();
    const sessionsPromise = monitor.listSessions();
    const helper = childProcessMock.processes[0]!;
    const snapshot = {
      type: 'snapshot',
      sessions: [{
        processId: 2345,
        displayName: 'Battlefront II',
        executableName: 'starwarsbattlefrontii.exe',
        processPath: 'C:\\Games\\Battlefront\\starwarsbattlefrontii.exe',
        iconPath: '',
        sessionIdentifier: 'session',
        sessionInstanceIdentifier: 'instance',
        state: 'active',
        endpointName: 'Speakers',
        isSelected: false
      }]
    };

    helper.stdout.emit('data', Buffer.from(`${JSON.stringify(snapshot)}\n`));

    await expect(sessionsPromise).resolves.toEqual([{
      processId: 2345,
      displayName: 'Battlefront II',
      executableName: 'starwarsbattlefrontii.exe',
      processPath: 'C:\\Games\\Battlefront\\starwarsbattlefrontii.exe',
      iconPath: null,
      iconDataUrl: null,
      sessionIdentifier: 'session',
      sessionInstanceIdentifier: 'instance',
      state: 'active',
      endpointName: 'Speakers',
      isSelected: false
    }]);
    await expect(monitor.listSessions()).resolves.toHaveLength(1);

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn.mock.calls[0]![1]).toEqual(['--monitor-audio-sessions']);

    await monitor.stop();
  });
});
