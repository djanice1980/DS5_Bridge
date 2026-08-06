/**
 * Adaptive trigger effects, composed here rather than in firmware.
 *
 * The percent-based PREVIEW/APPLY commands take start/wall/force as 0-100 and the firmware maps
 * them onto the zone-packed effect family, where a position is one of ten zones and force is
 * three bits -- eight steps across the whole range. That is why those presets felt steppy, and
 * it is why the native ranges below cannot be expressed through them at all.
 *
 * These encoders write the effect exactly as the controller reads it, and the firmware forwards
 * the bytes without interpreting them (COMMAND_ID.SET_RAW_TRIGGER_EFFECT). Adding an effect type
 * here does not need a firmware change.
 */

export const TRIGGER_EFFECT_SIZE = 11;

/** Effect ids as the controller defines them. OFF is 0x05, not 0x00 -- 0x00 is not "no effect". */
export const TRIGGER_EFFECT_ID = {
  OFF: 0x05,
  SIMPLE_RESISTANCE: 0x01,
  SIMPLE_WEAPON: 0x02,
  SIMPLE_AUTO: 0x06,
  ZONED_FEEDBACK: 0x21,
  ZONED_WEAPON: 0x25,
  ZONED_VIBRATION: 0x26
} as const;

export const TRIGGER_ZONE_COUNT = 10;
/** Zone force is a 3-bit field, so a zone carries one of eight levels. */
export const TRIGGER_ZONE_FORCE_MAX = 7;
/** The SIMPLE auto effect frequency field is small; the controller ignores values above this. */
export const TRIGGER_FREQUENCY_MAX = 15;
/**
 * The zone-packed vibration effect carries frequency in a whole byte (index 9), so it is not
 * bound by the simple family limit above. Applying that limit here silently altered any effect
 * built with a higher frequency.
 */
export const TRIGGER_ZONE_FREQUENCY_MAX = 255;

/**
 * One entry per zone. null means the zone is NOT in the active mask; a number means it is
 * active at that force level, INCLUDING zero.
 *
 * Those are different effects on the controller and collapsing them loses one: a zone active
 * at level 0 is the weakest setting, not an absent one. Treating 0 as absent made every
 * lowest-force effect disappear instead of being faint.
 */
export type TriggerZones = Array<number | null>;

export type TriggerEffect =
  | { type: 'off' }
  /** Constant resistance from `start` to the end of travel. */
  | { type: 'resistance'; start: number; force: number }
  /** Resistance between `start` and `end`, then release -- a trigger pull with a break. */
  | { type: 'weapon'; start: number; end: number; force: number }
  /** Vibration from `start` onward at `frequency` Hz-ish. */
  | { type: 'auto'; start: number; force: number; frequency: number }
  /** Per-zone resistance. 10 entries: null for a zone that does not participate, else 0-7. */
  | { type: 'zoned-feedback'; zones: TriggerZones }
  /** Per-zone weapon: active zones from `start` to `end`, one force level. */
  | { type: 'zoned-weapon'; start: number; end: number; force: number }
  /** Per-zone vibration amplitude plus a frequency. */
  | { type: 'zoned-vibration'; zones: TriggerZones; frequency: number };

export type TriggerEffectType = TriggerEffect['type'];

export const TRIGGER_EFFECT_TYPES: TriggerEffectType[] = [
  'off',
  'resistance',
  'weapon',
  'auto',
  'zoned-feedback',
  'zoned-weapon',
  'zoned-vibration'
];

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampZone(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(TRIGGER_ZONE_COUNT - 1, Math.round(value)));
}

function clampZoneForce(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(TRIGGER_ZONE_FORCE_MAX, Math.round(value)));
}

/**
 * Pack ten zones into the active-zone mask and force words the zone-packed family uses: a
 * 16-bit mask of which zones participate, then 30 bits of per-zone level.
 *
 * null is the ONLY thing that leaves a zone out of the mask. A zone set to 0 is active at zero
 * force, which is the weakest real setting -- excluding it made the faintest effects vanish
 * entirely, and made the firmware's own percent-mapped effects impossible to reproduce.
 */
function packZones(zones: TriggerZones, out: number[], offset: number): void {
  let activeMask = 0;
  let forceBits = 0n;
  for (let zone = 0; zone < TRIGGER_ZONE_COUNT; zone += 1) {
    const entry = zones[zone];
    if (entry === null || entry === undefined) {
      continue;
    }
    const level = clampZoneForce(entry);
    activeMask |= 1 << zone;
    forceBits |= BigInt(level) << BigInt(3 * zone);
  }
  out[offset] = activeMask & 0xff;
  out[offset + 1] = (activeMask >> 8) & 0xff;
  for (let index = 0; index < 4; index += 1) {
    out[offset + 2 + index] = Number((forceBits >> BigInt(8 * index)) & 0xffn);
  }
}

/** Encode one effect into its 11 bytes. Always returns exactly TRIGGER_EFFECT_SIZE bytes. */
export function encodeTriggerEffect(effect: TriggerEffect): number[] {
  const bytes = new Array<number>(TRIGGER_EFFECT_SIZE).fill(0);

  switch (effect.type) {
    case 'off':
      bytes[0] = TRIGGER_EFFECT_ID.OFF;
      return bytes;

    case 'resistance':
      bytes[0] = TRIGGER_EFFECT_ID.SIMPLE_RESISTANCE;
      bytes[1] = clampByte(effect.start);
      bytes[2] = clampByte(effect.force);
      return bytes;

    case 'weapon': {
      // The controller needs somewhere to release; an end at or before start is not a narrower
      // effect, it is an undefined one.
      const start = clampByte(effect.start);
      const end = Math.max(clampByte(effect.end), start + 1);
      bytes[0] = TRIGGER_EFFECT_ID.SIMPLE_WEAPON;
      bytes[1] = start;
      bytes[2] = Math.min(end, 255);
      bytes[3] = clampByte(effect.force);
      return bytes;
    }

    case 'auto':
      bytes[0] = TRIGGER_EFFECT_ID.SIMPLE_AUTO;
      bytes[1] = clampByte(effect.start);
      bytes[2] = clampByte(effect.force);
      bytes[3] = Math.max(0, Math.min(TRIGGER_FREQUENCY_MAX, Math.round(effect.frequency)));
      return bytes;

    case 'zoned-feedback':
      bytes[0] = TRIGGER_EFFECT_ID.ZONED_FEEDBACK;
      packZones(effect.zones, bytes, 1);
      return bytes;

    case 'zoned-weapon': {
      const start = clampZone(effect.start);
      const end = Math.max(clampZone(effect.end), start + 1);
      bytes[0] = TRIGGER_EFFECT_ID.ZONED_WEAPON;
      // Weapon takes a start/stop zone PAIR as a mask, not a filled range.
      const mask = (1 << start) | (1 << Math.min(end, TRIGGER_ZONE_COUNT - 1));
      bytes[1] = mask & 0xff;
      bytes[2] = (mask >> 8) & 0xff;
      bytes[3] = clampZoneForce(effect.force);
      return bytes;
    }

    case 'zoned-vibration':
      bytes[0] = TRIGGER_EFFECT_ID.ZONED_VIBRATION;
      packZones(effect.zones, bytes, 1);
      bytes[9] = Math.max(0, Math.min(TRIGGER_ZONE_FREQUENCY_MAX, Math.round(effect.frequency)));
      return bytes;

    default: {
      // Exhaustiveness: a new effect type must be encoded, not silently sent as off.
      const unreachable: never = effect;
      throw new Error(`Unhandled trigger effect: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function defaultTriggerEffect(type: TriggerEffectType): TriggerEffect {
  switch (type) {
    case 'off':
      return { type: 'off' };
    case 'resistance':
      return { type: 'resistance', start: 40, force: 180 };
    case 'weapon':
      return { type: 'weapon', start: 15, end: 100, force: 255 };
    case 'auto':
      return { type: 'auto', start: 20, force: 200, frequency: 10 };
    case 'zoned-feedback':
      return { type: 'zoned-feedback', zones: [null, null, 3, 4, 5, 5, 5, 5, 5, 5] };
    case 'zoned-weapon':
      return { type: 'zoned-weapon', start: 3, end: 7, force: 6 };
    case 'zoned-vibration':
      return { type: 'zoned-vibration', zones: [null, null, 4, 4, 4, 4, 4, 4, 4, 4], frequency: 8 };
    default: {
      const unreachable: never = type;
      throw new Error(`Unknown trigger effect type: ${String(unreachable)}`);
    }
  }
}

export function formatTriggerEffectBytes(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (byte) => (byte & 0xff).toString(16).padStart(2, '0')).join(' ');
}
