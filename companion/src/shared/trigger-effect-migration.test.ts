import { describe, expect, it } from 'vitest';
import {
  frequencyFromPercent,
  positionFromPercent,
  strengthFromPercent,
  triggerEffectFromLegacyPercents
} from './trigger-effect-migration';
import { TRIGGER_EFFECT_ID, encodeTriggerEffect } from './trigger-effects';

/**
 * Expectations here are hand-computed from the firmware's formulas rather than produced by
 * re-running the same code, because a test that mirrors the implementation proves only that it
 * is self-consistent. These assert the actual numbers a saved profile must land on.
 */
describe('legacy percent mapping', () => {
  it('matches the firmware strength curve', () => {
    // (percent * 8 + 99) / 100, floored, with 0 reserved for "off".
    expect(strengthFromPercent(0)).toBe(0);
    expect(strengthFromPercent(1)).toBe(1);   // (8+99)/100 = 1
    expect(strengthFromPercent(50)).toBe(4);  // (400+99)/100 = 4
    expect(strengthFromPercent(100)).toBe(8); // (800+99)/100 = 8
    expect(strengthFromPercent(150)).toBe(8); // clamped
  });

  it('matches the firmware position curve', () => {
    // min(9, (percent + 5) / 10), floored.
    expect(positionFromPercent(0)).toBe(0);
    expect(positionFromPercent(20)).toBe(2);
    expect(positionFromPercent(46)).toBe(5);
    expect(positionFromPercent(100)).toBe(9);
  });

  it('matches the firmware frequency curve, which exceeds the simple family limit', () => {
    // (percent * 28 + 50) / 100, floored, never 0.
    expect(frequencyFromPercent(0)).toBe(1);
    expect(frequencyFromPercent(50)).toBe(14);
    expect(frequencyFromPercent(100)).toBe(28);
  });
});

describe('migrating saved Trigger Lab profiles', () => {
  it('treats zero force as off, whatever the other fields say', () => {
    const effect = triggerEffectFromLegacyPercents({
      mode: 'feedback', startPercent: 50, wallPercent: 80, forcePercent: 0
    });
    expect(effect).toEqual({ type: 'off' });
  });

  it('fills feedback zones from the start position at strength minus one', () => {
    // start 20% -> zone 2; force 50% -> strength 4 -> level 3.
    const effect = triggerEffectFromLegacyPercents({
      mode: 'feedback', startPercent: 20, wallPercent: 0, forcePercent: 50
    });
    expect(effect).toEqual({
      type: 'zoned-feedback',
      zones: [null, null, 3, 3, 3, 3, 3, 3, 3, 3]
    });
  });

  it('keeps the weakest force as an ACTIVE zone at level zero', () => {
    // force 1% -> strength 1 -> level 0. Under the old encoder this became an empty mask and
    // the profile silently stopped doing anything at all.
    const effect = triggerEffectFromLegacyPercents({
      mode: 'feedback', startPercent: 0, wallPercent: 0, forcePercent: 1
    });
    expect(effect).toEqual({
      type: 'zoned-feedback',
      zones: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    });
    const bytes = encodeTriggerEffect(effect);
    expect(bytes[0]).toBe(TRIGGER_EFFECT_ID.ZONED_FEEDBACK);
    // Every zone participates, all at force zero.
    expect(bytes[1] | (bytes[2] << 8)).toBe(0b1111111111);
  });

  it('applies the weapon clamps the firmware applied', () => {
    // start 0% -> zone 0, pinned up to 2; wall 0% -> zone 0, pushed past start to 3.
    const effect = triggerEffectFromLegacyPercents({
      mode: 'weapon', startPercent: 0, wallPercent: 0, forcePercent: 100
    });
    expect(effect).toEqual({ type: 'zoned-weapon', start: 2, end: 3, force: 7 });
  });

  it('takes vibration frequency from the WALL percent, not a field of its own', () => {
    const effect = triggerEffectFromLegacyPercents({
      mode: 'vibration', startPercent: 30, wallPercent: 100, forcePercent: 100
    });
    expect(effect).toEqual({
      type: 'zoned-vibration',
      zones: [null, null, null, 7, 7, 7, 7, 7, 7, 7],
      frequency: 28
    });
    // 28 is above the SIMPLE family's 15 and must survive encoding intact.
    expect(encodeTriggerEffect(effect)[9]).toBe(28);
  });
});
