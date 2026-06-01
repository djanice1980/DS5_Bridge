import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { HostAudioEngine, type HostAudioFramePayload } from './host-audio-engine';

const FRAME_LENGTH = 264;

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
