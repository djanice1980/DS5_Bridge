import {
  TRIGGER_ZONE_COUNT,
  TRIGGER_ZONE_FORCE_MAX,
  type TriggerEffect,
  type TriggerZones
} from './trigger-effects';

/**
 * Convert a Trigger Lab profile saved in the old percent form into the effect it produced.
 *
 * This is a one-way migration of stored user data, so it reproduces the firmware's OWN mapping
 * exactly rather than approximating it. Every helper below is a port of the corresponding
 * function in src/bt.cpp; the goal is that a migrated profile encodes to the same eleven bytes
 * the percent command used to send, so nobody's saved profile changes feel on upgrade.
 *
 * The percent path always targeted the ZONE-PACKED family -- that is precisely why it felt
 * steppy, and why the Lab is moving off it -- so these produce zoned effects, not the simple
 * ones. A profile can then be edited into the simple family afterwards if you want the smoother
 * response; the migration itself changes nothing.
 */

/** Port of trigger_strength_from_percent: 1..8, or 0 meaning the effect is off. */
export function strengthFromPercent(percent: number): number {
  if (percent <= 0) {
    return 0;
  }
  const clamped = Math.min(100, Math.round(percent));
  const strength = Math.floor((clamped * 8 + 99) / 100);
  return strength === 0 ? 1 : strength;
}

/** Port of trigger_position_from_percent: a zone index 0..9. */
export function positionFromPercent(percent: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return Math.min(9, Math.floor((clamped + 5) / 10));
}

/** Port of trigger_frequency_from_percent: 1..28. Note this exceeds the SIMPLE family's 15. */
export function frequencyFromPercent(percent: number): number {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const frequency = Math.floor((clamped * 28 + 50) / 100);
  return frequency === 0 ? 1 : frequency;
}

/**
 * Fill zones from `position` to the end at one level, leaving earlier zones out entirely.
 *
 * The level is `strength - 1`, so the weakest setting is level ZERO with the zone still active --
 * which is why zones carry null separately from 0. Collapsing those made every lowest-force
 * profile migrate to an empty effect.
 */
function filledZones(position: number, strength: number): TriggerZones {
  const level = Math.max(0, Math.min(TRIGGER_ZONE_FORCE_MAX, strength - 1));
  const zones: TriggerZones = [];
  for (let zone = 0; zone < TRIGGER_ZONE_COUNT; zone += 1) {
    zones.push(zone < position ? null : level);
  }
  return zones;
}

export interface LegacyTriggerLabProfile {
  /** 'feedback' | 'weapon' | 'vibration' as the percent API named them. */
  mode: string;
  startPercent: number;
  wallPercent: number;
  forcePercent: number;
}

export function triggerEffectFromLegacyPercents(profile: LegacyTriggerLabProfile): TriggerEffect {
  const strength = strengthFromPercent(profile.forcePercent);
  if (strength === 0) {
    // The firmware treated zero force as OFF regardless of the other fields.
    return { type: 'off' };
  }

  const startPosition = positionFromPercent(profile.startPercent);
  const wallPosition = positionFromPercent(profile.wallPercent);

  if (profile.mode === 'weapon') {
    // Port of the weapon clamps: start is pinned into 2..7 and the wall must sit past it.
    const start = Math.min(7, Math.max(2, startPosition));
    const end = Math.min(8, Math.max(wallPosition, start + 1));
    return { type: 'zoned-weapon', start, end, force: Math.max(0, strength - 1) };
  }

  if (profile.mode === 'vibration') {
    return {
      type: 'zoned-vibration',
      zones: filledZones(startPosition, strength),
      // Frequency came from the WALL percent, not from a field of its own.
      frequency: frequencyFromPercent(profile.wallPercent)
    };
  }

  return { type: 'zoned-feedback', zones: filledZones(startPosition, strength) };
}
