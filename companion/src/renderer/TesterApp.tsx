import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeSnapshot } from '../shared/types';
import type { ControllerInputSnapshot, DualSenseInputState } from '../shared/dualsense-input';
import { DUALSENSE_TOUCHPAD_HEIGHT, DUALSENSE_TOUCHPAD_WIDTH } from '../shared/dualsense-input';
import {
  TRIGGER_EFFECT_TYPES,
  TRIGGER_FREQUENCY_MAX,
  TRIGGER_ZONE_COUNT,
  TRIGGER_ZONE_FORCE_MAX,
  defaultTriggerEffect,
  encodeTriggerEffect,
  formatTriggerEffectBytes,
  type TriggerEffect,
  type TriggerEffectType
} from '../shared/trigger-effects';

/**
 * Input polling cadence. The app already polls shortcuts at 50ms, so this is the same order of
 * magnitude as work the process does anyway. It costs no Bluetooth bandwidth -- the report has
 * already crossed the BT link to reach the host, and this reads the bridge's cached copy over
 * USB -- and it stops entirely when the window closes.
 */
const INPUT_POLL_INTERVAL_MS = 40;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Stick bytes are 0-255 with 128 nominal centre; map to -1..1 for display. */
function stickAxis(value: number): number {
  return (value - 128) / 127;
}

function StickView({ x, y, label, pressed }: { x: number; y: number; label: string; pressed: boolean }) {
  const nx = stickAxis(x);
  const ny = stickAxis(y);
  return (
    <div className="tester-stick">
      <div className={`tester-stick-well${pressed ? ' is-pressed' : ''}`}>
        <div className="tester-stick-crosshair" />
        <div
          className="tester-stick-dot"
          style={{
            left: `${50 + clamp01((nx + 1) / 2) * 100 - 50}%`,
            top: `${50 + clamp01((ny + 1) / 2) * 100 - 50}%`
          }}
        />
      </div>
      <div className="tester-stick-label">
        {label}
        <span className="tester-mono">
          {x.toString().padStart(3, ' ')}, {y.toString().padStart(3, ' ')}
        </span>
      </div>
    </div>
  );
}

function TriggerBar({ label, value, pressed }: { label: string; value: number; pressed: boolean }) {
  return (
    <div className="tester-trigger">
      <div className="tester-trigger-head">
        <span>{label}</span>
        <span className="tester-mono">{value}</span>
      </div>
      <div className="tester-bar">
        <div className="tester-bar-fill" style={{ width: `${(value / 255) * 100}%` }} />
      </div>
      <div className={`tester-pill${pressed ? ' is-on' : ''}`}>digital</div>
    </div>
  );
}

function ButtonLamp({ label, on }: { label: string; on: boolean }) {
  return <div className={`tester-lamp${on ? ' is-on' : ''}`}>{label}</div>;
}

function TouchpadView({ state }: { state: DualSenseInputState }) {
  return (
    <div className={`tester-touchpad${state.touchpadButton ? ' is-pressed' : ''}`}>
      {state.touchPoints.map((point, index) => (
        point.active
          ? (
            <div
              key={index}
              className={`tester-touch-dot tester-touch-${index}`}
              style={{
                left: `${clamp01(point.x / DUALSENSE_TOUCHPAD_WIDTH) * 100}%`,
                top: `${clamp01(point.y / DUALSENSE_TOUCHPAD_HEIGHT) * 100}%`
              }}
              title={`id ${point.contactId} — ${point.x}, ${point.y}`}
            />
          )
          : null
      ))}
    </div>
  );
}

function MotionRow({ label, x, y, z }: { label: string; x: number; y: number; z: number }) {
  return (
    <div className="tester-motion-row">
      <span className="tester-motion-label">{label}</span>
      {[x, y, z].map((value, index) => (
        <span key={index} className="tester-mono tester-motion-value">
          {value > 0 ? '+' : ''}{value}
        </span>
      ))}
    </div>
  );
}

function EffectEditor({
  title,
  effect,
  onChange
}: {
  title: string;
  effect: TriggerEffect;
  onChange: (next: TriggerEffect) => void;
}) {
  const bytes = useMemo(() => encodeTriggerEffect(effect), [effect]);

  function setZone(index: number, value: number): void {
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
          <span className="tester-field-label">Zones (0&ndash;{TRIGGER_ZONE_FORCE_MAX})</span>
          <div className="tester-zone-grid">
            {effect.zones.map((level, index) => (
              <label key={index} className="tester-zone">
                <input
                  type="range"
                  aria-label={`Zone ${index}`}
                  min={0}
                  max={TRIGGER_ZONE_FORCE_MAX}
                  value={level}
                  onChange={(event) => setZone(index, Number(event.target.value))}
                />
                <span className="tester-mono">{index}</span>
              </label>
            ))}
          </div>
          {effect.type === 'zoned-vibration' && (
            <Slider
              label="Frequency"
              min={0}
              max={TRIGGER_FREQUENCY_MAX}
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

function Slider({
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

export function TesterApp() {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [input, setInput] = useState<ControllerInputSnapshot | null>(null);
  const [rightEffect, setRightEffect] = useState<TriggerEffect>(() => defaultTriggerEffect('weapon'));
  const [leftEffect, setLeftEffect] = useState<TriggerEffect>(() => defaultTriggerEffect('resistance'));
  const [sendError, setSendError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState<number | null>(null);

  const pollBusy = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function tick(): Promise<void> {
      // Skip rather than queue: a slow read must not build a backlog that keeps reporting
      // stale input long after the controller moved.
      if (pollBusy.current) {
        return;
      }
      pollBusy.current = true;
      const startedAt = performance.now();
      try {
        const next = await window.bridge.readControllerInput();
        if (!cancelled) {
          setInput(next);
          setPollMs(Math.round(performance.now() - startedAt));
        }
      } catch {
        if (!cancelled) {
          setInput(null);
        }
      } finally {
        pollBusy.current = false;
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), INPUT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const next = await window.bridge.getStatus();
        if (!cancelled) {
          setSnapshot(next);
        }
      } catch {
        // The main window owns error surfacing; a failed status read here just leaves the
        // previous snapshot on screen rather than blanking the picker.
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sendEffects = useCallback(async (right: TriggerEffect, left: TriggerEffect) => {
    try {
      setSendError(null);
      await window.bridge.setRawTriggerEffect('both', right, left);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const state = input?.state ?? null;
  const connected = input?.controllerConnected === true;
  const bridges = snapshot?.bridgeDevices?.bridges ?? [];

  return (
    <div className="tester-root">
      <header className="tester-header">
        <div>
          <h1>Tester</h1>
          <p className="tester-subtle">
            Live controller state and app-composed trigger effects. Shares the main window&rsquo;s
            bridge selection.
          </p>
        </div>
        <label className="tester-bridge-picker">
          <span className="tester-field-label">Active bridge</span>
          <select
            aria-label="Active bridge"
            value={bridges.find((bridge) => bridge.selected)?.path ?? ''}
            onChange={(event) => {
              void window.bridge.selectBridge(event.target.value || null);
            }}
          >
            {bridges.length === 0 && <option value="">No bridge detected</option>}
            {bridges.map((bridge) => (
              <option key={bridge.path} value={bridge.path}>
                {bridge.name ?? bridge.uniqueId ?? bridge.path}
                {bridge.connected ? '' : ' (no controller)'}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className={`tester-status${connected ? ' is-live' : ''}`}>
        {connected
          ? `Live — ${pollMs ?? 0} ms read, ${INPUT_POLL_INTERVAL_MS} ms interval`
          : 'No controller connected to the selected bridge'}
      </div>

      <div className="tester-grid">
        <section className="tester-card">
          <h2>Sticks &amp; triggers</h2>
          {state ? (
            <>
              <div className="tester-sticks">
                <StickView label="Left" x={state.leftStickX} y={state.leftStickY} pressed={state.l3} />
                <StickView label="Right" x={state.rightStickX} y={state.rightStickY} pressed={state.r3} />
              </div>
              <div className="tester-triggers">
                <TriggerBar label="L2" value={state.leftTrigger} pressed={state.l2Pressed} />
                <TriggerBar label="R2" value={state.rightTrigger} pressed={state.r2Pressed} />
              </div>
            </>
          ) : <p className="tester-subtle">Waiting for input.</p>}
        </section>

        <section className="tester-card">
          <h2>Buttons</h2>
          {state ? (
            <div className="tester-lamps">
              <ButtonLamp label="△" on={state.triangle} />
              <ButtonLamp label="○" on={state.circle} />
              <ButtonLamp label="✕" on={state.cross} />
              <ButtonLamp label="□" on={state.square} />
              <ButtonLamp label="↑" on={state.dpadUp} />
              <ButtonLamp label="→" on={state.dpadRight} />
              <ButtonLamp label="↓" on={state.dpadDown} />
              <ButtonLamp label="←" on={state.dpadLeft} />
              <ButtonLamp label="L1" on={state.l1} />
              <ButtonLamp label="R1" on={state.r1} />
              <ButtonLamp label="L3" on={state.l3} />
              <ButtonLamp label="R3" on={state.r3} />
              <ButtonLamp label="Create" on={state.create} />
              <ButtonLamp label="Options" on={state.options} />
              <ButtonLamp label="PS" on={state.home} />
              <ButtonLamp label="Mute" on={state.mute} />
            </div>
          ) : <p className="tester-subtle">Waiting for input.</p>}
        </section>

        <section className="tester-card">
          <h2>Touchpad</h2>
          {state ? <TouchpadView state={state} /> : <p className="tester-subtle">Waiting for input.</p>}
        </section>

        <section className="tester-card">
          <h2>Motion</h2>
          {state ? (
            <div className="tester-motion">
              <MotionRow label="Gyro" x={state.gyroX} y={state.gyroY} z={state.gyroZ} />
              <MotionRow label="Accel" x={state.accelX} y={state.accelY} z={state.accelZ} />
              <div className="tester-motion-row">
                <span className="tester-motion-label">Timestamp</span>
                <span className="tester-mono tester-motion-value">{state.sensorTimestamp}</span>
              </div>
            </div>
          ) : <p className="tester-subtle">Waiting for input.</p>}
        </section>

        <section className="tester-card">
          <h2>Power &amp; audio</h2>
          {state ? (
            <dl className="tester-facts">
              <div><dt>Battery</dt><dd>{state.batteryPercent === null ? 'unknown' : `${state.batteryPercent}%`}</dd></div>
              <div><dt>Charging</dt><dd>{state.charging ? 'yes' : 'no'}</dd></div>
              <div><dt>Power state</dt><dd className="tester-mono">0x{state.rawPowerState.toString(16)}</dd></div>
              <div><dt>Headset</dt><dd>{state.headsetPlugged ? 'plugged' : 'no'}</dd></div>
              <div><dt>Mic</dt><dd>{state.microphonePlugged ? 'plugged' : 'no'}</dd></div>
              <div><dt>Mic muted</dt><dd>{state.microphoneMuted ? 'yes' : 'no'}</dd></div>
            </dl>
          ) : <p className="tester-subtle">Waiting for input.</p>}
        </section>

        <section className="tester-card tester-card-wide">
          <h2>Raw input report</h2>
          <p className="tester-subtle">
            Exactly what the bridge forwarded to the host. Everything above is decoded from these
            bytes in the app, so this is the ground truth to check a reading against.
          </p>
          <code className="tester-mono tester-hex">
            {input && input.raw.length > 0
              ? input.raw.map((byte, index) => (
                <span key={index} className="tester-hex-byte">
                  {byte.toString(16).padStart(2, '0')}
                </span>
              ))
              : '—'}
          </code>
        </section>

        <section className="tester-card tester-card-wide">
          <h2>Trigger effects</h2>
          <p className="tester-subtle">
            Composed in the app and sent verbatim. These are the controller&rsquo;s native ranges,
            not the percentages the main Triggers page maps onto zones.
          </p>
          <div className="tester-effects">
            <EffectEditor title="R2" effect={rightEffect} onChange={setRightEffect} />
            <EffectEditor title="L2" effect={leftEffect} onChange={setLeftEffect} />
          </div>
          <div className="tester-actions">
            <button type="button" onClick={() => void sendEffects(rightEffect, leftEffect)}>
              Send to controller
            </button>
            <button
              type="button"
              onClick={() => {
                setRightEffect({ type: 'off' });
                setLeftEffect({ type: 'off' });
                void sendEffects({ type: 'off' }, { type: 'off' });
              }}
            >
              Clear both
            </button>
          </div>
          {sendError && <p className="tester-error">{sendError}</p>}
        </section>
      </div>
    </div>
  );
}
