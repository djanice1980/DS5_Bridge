import { useMemo } from 'react';
import {
  TRIGGER_EFFECT_TYPES,
  TRIGGER_FREQUENCY_MAX,
  TRIGGER_ZONE_FREQUENCY_MAX,
  TRIGGER_ZONE_COUNT,
  TRIGGER_ZONE_FORCE_MAX,
  defaultTriggerEffect,
  encodeTriggerEffect,
  formatTriggerEffectBytes,
  type TriggerEffect,
  type TriggerEffectType
} from '../shared/trigger-effects';

/**
 * Native-range trigger effect editor, shared by the tester window and the main window's Trigger
 * Lab.
 *
 * Shared on purpose rather than reimplemented: the Lab and the tester must offer the SAME
 * controls over the same value ranges, or an effect dialled in one place cannot be reproduced in
 * the other and neither can be trusted to represent what the controller received.
 *
 * "Bytes on the wire" is part of that contract -- it shows exactly what will be sent, so a
 * surprising result can be checked against the encoding rather than guessed at.
 */

export function TriggerEffectEditor({
  title,
  effect,
  onChange
}: {
  title: string;
  effect: TriggerEffect;
  onChange: (next: TriggerEffect) => void;
}) {
  const bytes = useMemo(() => encodeTriggerEffect(effect), [effect]);

  function setZone(index: number, value: number | null): void {
    if (effect.type !== 'zoned-feedback' && effect.type !== 'zoned-vibration') {
      return;
    }
    const zones = [...effect.zones];
    zones[index] = value;
    onChange({ ...effect, zones });
  }

  return (
    <div className="tester-effect">
      <div className="tester-effect-head">
        <h3>{title}</h3>
        <select
          aria-label={`${title} effect type`}
          value={effect.type}
          onChange={(event) => onChange(defaultTriggerEffect(event.target.value as TriggerEffectType))}
        >
          {TRIGGER_EFFECT_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      {effect.type === 'resistance' && (
        <>
          <Slider label="Start" min={0} max={255} value={effect.start} onChange={(v) => onChange({ ...effect, start: v })} />
          <Slider label="Force" min={0} max={255} value={effect.force} onChange={(v) => onChange({ ...effect, force: v })} />
        </>
      )}

      {effect.type === 'weapon' && (
        <>
          <Slider label="Start" min={0} max={254} value={effect.start} onChange={(v) => onChange({ ...effect, start: v })} />
          <Slider label="End" min={1} max={255} value={effect.end} onChange={(v) => onChange({ ...effect, end: v })} />
          <Slider label="Force" min={0} max={255} value={effect.force} onChange={(v) => onChange({ ...effect, force: v })} />
        </>
      )}

      {effect.type === 'auto' && (
        <>
          <Slider label="Start" min={0} max={255} value={effect.start} onChange={(v) => onChange({ ...effect, start: v })} />
          <Slider label="Force" min={0} max={255} value={effect.force} onChange={(v) => onChange({ ...effect, force: v })} />
          <Slider
            label="Frequency"
            min={0}
            max={TRIGGER_FREQUENCY_MAX}
            value={effect.frequency}
            onChange={(v) => onChange({ ...effect, frequency: v })}
          />
        </>
      )}

      {effect.type === 'zoned-weapon' && (
        <>
          <Slider label="Start zone" min={0} max={TRIGGER_ZONE_COUNT - 2} value={effect.start} onChange={(v) => onChange({ ...effect, start: v })} />
          <Slider label="End zone" min={1} max={TRIGGER_ZONE_COUNT - 1} value={effect.end} onChange={(v) => onChange({ ...effect, end: v })} />
          <Slider label="Force" min={0} max={TRIGGER_ZONE_FORCE_MAX} value={effect.force} onChange={(v) => onChange({ ...effect, force: v })} />
        </>
      )}

      {(effect.type === 'zoned-feedback' || effect.type === 'zoned-vibration') && (
        <div className="tester-zones">
          <span className="tester-field-label">
            Zones &mdash; lowest position is off, then 0&ndash;{TRIGGER_ZONE_FORCE_MAX}
          </span>
          <div className="tester-zone-grid">
            {effect.zones.map((level, index) => (
              <label key={index} className="tester-zone">
                {/*
                  One below zero is OFF, because a zone active at force 0 and a zone that does not
                  participate are different effects on the controller. A plain 0-7 slider cannot
                  say which one you meant.
                */}
                <input
                  type="range"
                  aria-label={`Zone ${index}`}
                  min={-1}
                  max={TRIGGER_ZONE_FORCE_MAX}
                  value={level ?? -1}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setZone(index, next < 0 ? null : next);
                  }}
                />
                <span className="tester-mono">{level === null ? '-' : level}</span>
                <span className="tester-zone-index">{index}</span>
              </label>
            ))}
          </div>
          {effect.type === 'zoned-vibration' && (
            <Slider
              label="Frequency"
              min={0}
              max={TRIGGER_ZONE_FREQUENCY_MAX}
              value={effect.frequency}
              onChange={(v) => onChange({ ...effect, frequency: v })}
            />
          )}
        </div>
      )}

      <div className="tester-bytes">
        <span className="tester-field-label">Bytes on the wire</span>
        <code className="tester-mono">{formatTriggerEffectBytes(bytes)}</code>
      </div>
    </div>
  );
}

export function Slider({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="tester-slider">
      <span className="tester-field-label">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="tester-mono tester-slider-value">{value}</span>
    </label>
  );
}
