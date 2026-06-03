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
  HostAudioEngine,
  HostAudioStartError,
  SystemAudioHapticsEngine,
  listAudioHapticsSessions,
  type HostAudioFramePayload
} from './host-audio-engine';

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

function pushStdout(engine: HostAudioEngine, chunk: Buffer): void {
  (engine as unknown as { processStdout(chunk: Buffer): void }).processStdout(chunk);
}

describe('HostAudioEngine startup lifecycle', () => {
  it('reports an intentional stop during startup as cancellation instead of helper exit', async () => {
    const engine = new HostAudioEngine();
    const statuses: string[] = [];
    engine.on('status', (line) => statuses.push(line));

    const startPromise = engine.start('hid-path', 80);
    const startResult = expect(startPromise).rejects.toMatchObject({
      reason: 'start-cancelled'
    } satisfies Partial<HostAudioStartError>);

    await engine.stop();
    await startResult;

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(statuses).not.toContain('host audio helper exited (SIGTERM)');
    expect(engine.isActive()).toBe(false);
  });
});

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

    await engine.stop();
  });
});

describe('audio haptics session listing', () => {
  it('parses helper session JSON defensively', async () => {
    const sessionsPromise = listAudioHapticsSessions('system-audio');
    const helper = childProcessMock.processes[0]!;
    helper.stdout.emit('data', Buffer.from(JSON.stringify([{
      processId: 2345,
      displayName: 'Battlefront II',
      executableName: 'starwarsbattlefrontii.exe',
      processPath: 'C:\\Games\\Battlefront\\starwarsbattlefrontii.exe',
      iconPath: '',
      sessionIdentifier: 'session',
      sessionInstanceIdentifier: 'instance',
      state: 'active',
      endpointName: 'Speakers',
      isSelected: true
    }, {
      processId: 0,
      displayName: 'bad'
    }])));
    helper.emit('exit', 0, null);

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
      isSelected: true
    }]);
  });
});

describe('HostAudioEngine stdout frame parser', () => {
  it('buffers partial records and emits complete frames in sequence order', () => {
    const engine = new HostAudioEngine();
    const frames: HostAudioFramePayload[] = [];
    engine.on('frame', (frame) => frames.push(frame));
    const first = frameRecord(10);
    const second = frameRecord(90);
    const combined = Buffer.concat([first, second]);

    pushStdout(engine, combined.subarray(0, 7));
    expect(frames).toEqual([]);

    pushStdout(engine, combined.subarray(7, first.length + 12));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      sequence: 0,
      encodedBytes: 200
    });
    expect(frames[0]!.frame.slice(0, 4)).toEqual([10, 11, 12, 13]);

    pushStdout(engine, combined.subarray(first.length + 12));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({
      sequence: 1,
      encodedBytes: 200
    });
    expect(frames[1]!.frame.slice(0, 4)).toEqual([90, 91, 92, 93]);
  });

  it('emits an error and discards buffered data when a helper record has the wrong length', () => {
    const engine = new HostAudioEngine();
    const errors: Error[] = [];
    const frames: HostAudioFramePayload[] = [];
    engine.on('error', (error) => errors.push(error));
    engine.on('frame', (frame) => frames.push(frame));

    const bad = Buffer.alloc(2);
    bad.writeUInt16LE(123, 0);
    pushStdout(engine, Buffer.concat([bad, frameRecord(1)]));

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Unexpected host audio frame length 123');
    expect(frames).toEqual([]);

    pushStdout(engine, frameRecord(2));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.sequence).toBe(0);
    expect(frames[0]!.frame[0]).toBe(2);
  });
});
