import { describe, expect, it } from 'vitest';
import { buildHapticFrameFragments } from './audio-helper';

const COMPACT_FRAME_BYTES = 264;
const FAST_PAYLOAD_BYTES = 57;
const HID_REPORT_BYTES = 64;

describe('buildHapticFrameFragments', () => {
  it('splits a 264-byte frame into five 64-byte fragment reports', () => {
    const frame = Array.from({ length: COMPACT_FRAME_BYTES }, (_, i) => i & 0xff);
    const fragments = buildHapticFrameFragments(frame, 0);

    expect(fragments).toHaveLength(5);
    for (const fragment of fragments) {
      expect(fragment).toHaveLength(HID_REPORT_BYTES);
    }

    // Payload lengths: 57, 57, 57, 57, then 264 - 228 = 36.
    expect(fragments.map((f) => f[6])).toEqual([57, 57, 57, 57, 36]);
  });

  it('writes the fragment header and payload in the firmware layout', () => {
    const frame = Array.from({ length: COMPACT_FRAME_BYTES }, (_, i) => (i * 3 + 1) & 0xff);
    const fragments = buildHapticFrameFragments(frame, 0x1234);

    fragments.forEach((fragment, index) => {
      expect(fragment[0]).toBe(0x07); // LegacyAudioStreamReportId
      expect(fragment[1]).toBe(0x08); // FastFrameFragmentType
      expect(fragment[2]).toBe(0x34); // sequence low byte
      expect(fragment[3]).toBe(0x12); // sequence high byte
      expect(fragment[4]).toBe(index); // fragment index
      expect(fragment[5]).toBe(5); // fragment count
    });

    // Reassembling the payloads must reproduce the original frame exactly.
    const reassembled: number[] = [];
    for (const fragment of fragments) {
      const payloadLength = fragment[6];
      reassembled.push(...fragment.slice(7, 7 + payloadLength));
    }
    expect(reassembled).toEqual(frame);
  });

  it('masks the sequence to 16 bits and pads unused report bytes with zero', () => {
    const frame = new Array<number>(COMPACT_FRAME_BYTES).fill(0xaa);
    const fragments = buildHapticFrameFragments(frame, 0x1_0001);

    // 0x10001 & 0xffff === 0x0001
    expect(fragments[0][2]).toBe(0x01);
    expect(fragments[0][3]).toBe(0x00);

    // The last fragment carries 36 payload bytes; bytes past 7 + 36 are zero.
    const last = fragments[4];
    for (let i = 7 + 36; i < HID_REPORT_BYTES; i += 1) {
      expect(last[i]).toBe(0);
    }
  });
});
