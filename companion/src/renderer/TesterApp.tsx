import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeSnapshot } from '../shared/types';
import type { ControllerInputSnapshot, DualSenseInputState } from '../shared/dualsense-input';
import { ControllerDiagram, GyroDial, AccelVector, type AccelZero } from './ControllerDiagram';
import { TriggerEffectEditor } from './TriggerEffectEditor';
import {
  CALIBRATION_CODE,
  CALIBRATION_OP,
  CALIBRATION_TARGET,
  calibrationStepAccepted,
  type CalibrationStatus
} from '../shared/protocol';
import {
  defaultTriggerEffect,
  type TriggerEffect
} from '../shared/trigger-effects';

/**
 * Input polling cadence. The app already polls shortcuts at 50ms, so this is the same order of
 * magnitude as work the process does anyway. It costs no Bluetooth bandwidth -- the report has
 * already crossed the BT link to reach the host, and this reads the bridge's cached copy over
 * USB -- and it stops entirely when the window closes.
 */
const INPUT_POLL_INTERVAL_MS = 40;

/**
 * While this window is open the bridge stops forwarding input to the host, so pressing PS to
 * check it does not open Steam and a stick sweep does not move the game behind.
 *
 * Held as a short LEASE that this window renews, not a flag it sets once: if the app is killed,
 * crashes, or loses the bridge, the hold expires by itself and the controller comes back. The
 * hold is comfortably longer than the renewal so ordinary scheduling jitter never lets it lapse
 * mid-session.
 */
const INPUT_HOLD_MS = 2000;
const INPUT_HOLD_RENEW_MS = 700;

export function TesterApp() {
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [input, setInput] = useState<ControllerInputSnapshot | null>(null);
  const [rightEffect, setRightEffect] = useState<TriggerEffect>(() => defaultTriggerEffect('weapon'));
  const [leftEffect, setLeftEffect] = useState<TriggerEffect>(() => defaultTriggerEffect('resistance'));
  const [sendError, setSendError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState<number | null>(null);
  const [holdInput, setHoldInput] = useState(true);
  // Deliberately not persisted: a zero captured in one session must not silently apply in the
  // next, where the controller is somewhere else entirely.
  const [accelZero, setAccelZero] = useState<AccelZero | null>(null);
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState<string | null>(null);
  const [calibrationStatus, setCalibrationStatus] = useState<CalibrationStatus | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrationAwaitingSweep, setCalibrationAwaitingSweep] = useState(false);

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
    if (!holdInput) {
      // Release immediately rather than waiting for the lease to lapse.
      void window.bridge.holdInputForwarding(0).catch(() => {});
      return;
    }

    let cancelled = false;
    const renew = () => {
      if (!cancelled) {
        void window.bridge.holdInputForwarding(INPUT_HOLD_MS).catch(() => {});
      }
    };

    renew();
    const timer = setInterval(renew, INPUT_HOLD_RENEW_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      void window.bridge.holdInputForwarding(0).catch(() => {});
    };
  }, [holdInput]);

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

  /**
   * Run one calibration step and CHECK the controller accepted it.
   *
   * Verified against the controller's own 0x83 reply rather than assumed. The expected code
   * differs by step -- begin and sample answer OPEN, store answers COMMITTED -- so there is no
   * single success value to test for.
   */
  const runStep = useCallback(async (
    op: number,
    target: number,
    expectedCode: number
  ): Promise<boolean> => {
    await window.bridge.sendStickCalibration(op, target);
    // The reply crosses Bluetooth asynchronously; give it a moment before reading.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = await window.bridge.readCalibrationStatus();
    setCalibrationStatus(status);
    return calibrationStepAccepted(status, target, expectedCode);
  }, []);

  /**
   * Begin a calibration, recovering from a session an earlier run left open.
   *
   * There is NO cancel opcode. If a previous attempt was interrupted -- controller unplugged, a
   * step refused -- the session stays open in the controller's firmware and every later begin
   * fails until the controller is restarted. The only way to close one is to commit it.
   *
   * So a refused begin is retried ONCE behind a commit. That commit can itself change the
   * controller's calibration, which is why it returns whether it fired: the caller has to say so
   * rather than let the user believe nothing happened.
   */
  const beginCalibration = useCallback(async (target: number): Promise<{
    ok: boolean;
    committedDuringRepair: boolean;
  }> => {
    if (await runStep(CALIBRATION_OP.BEGIN, target, CALIBRATION_CODE.OPEN)) {
      return { ok: false || true, committedDuringRepair: false };
    }
    await runStep(CALIBRATION_OP.STORE, target, CALIBRATION_CODE.COMMITTED);
    const ok = await runStep(CALIBRATION_OP.BEGIN, target, CALIBRATION_CODE.OPEN);
    return { ok, committedDuringRepair: true };
  }, [runStep]);

  const runCalibration = useCallback(async (target: number, label: string) => {
    setCalibrationBusy(true);
    setCalibrationError(null);
    setCalibrationStep(`${label}: starting`);
    try {
      const begun = await beginCalibration(target);
      if (begun.committedDuringRepair) {
        setCalibrationError(
          'A previous calibration session was still open and had to be closed to continue. '
          + "That close is itself a commit, so this controller's calibration may already have "
          + 'changed. Finish this run, or reset the controller to revert.'
        );
      }
      if (!begun.ok) {
        setCalibrationStep(null);
        setCalibrationError(
          (begun.committedDuringRepair ? '' : '')
          + 'Could not start calibration. Restart the controller and try again.'
        );
        return;
      }

      if (target === CALIBRATION_TARGET.CENTRE) {
        setCalibrationStep(`${label}: sampling centre, leave the sticks alone`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (!await runStep(CALIBRATION_OP.SAMPLE, target, CALIBRATION_CODE.OPEN)) {
          setCalibrationError('Sampling was refused. Nothing was stored.');
          setCalibrationStep(null);
          return;
        }
      } else {
        // The range pass records what the sticks reach while the session is open, so the sweep
        // happens between begin and store rather than at a sample call.
        setCalibrationStep(`${label}: sweep both sticks fully, then press Finish`);
        setCalibrationAwaitingSweep(true);
        return;
      }

      setCalibrationStep(`${label}: storing`);
      const stored = await runStep(CALIBRATION_OP.STORE, target, CALIBRATION_CODE.COMMITTED);
      setCalibrationStep(null);
      if (!stored) {
        setCalibrationError('The controller did not confirm the write.');
      }
    } catch (error) {
      setCalibrationError(error instanceof Error ? error.message : String(error));
      setCalibrationStep(null);
    } finally {
      setCalibrationBusy(false);
    }
  }, [beginCalibration, runStep]);

  const finishRangeCalibration = useCallback(async () => {
    setCalibrationBusy(true);
    setCalibrationAwaitingSweep(false);
    setCalibrationStep('Range: storing');
    try {
      const stored = await runStep(
        CALIBRATION_OP.STORE,
        CALIBRATION_TARGET.RANGE,
        CALIBRATION_CODE.COMMITTED
      );
      if (!stored) {
        setCalibrationError('The controller did not confirm the write.');
      }
    } finally {
      setCalibrationStep(null);
      setCalibrationBusy(false);
    }
  }, [runStep]);

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

      <label className="tester-hold-toggle">
        <input
          type="checkbox"
          checked={holdInput}
          onChange={(event) => setHoldInput(event.target.checked)}
        />
        <span>
          Pause input to this PC while testing
          <span className="tester-subtle"> &mdash; so PS does not open Steam. Releases automatically if the app closes.</span>
        </span>
      </label>

      <div className={`tester-status${connected ? ' is-live' : ''}`}>
        {connected
          ? `Live — ${pollMs ?? 0} ms read, ${INPUT_POLL_INTERVAL_MS} ms interval`
          : 'No controller connected to the selected bridge'}
      </div>

      <div className="tester-grid">
        <section className="tester-card tester-card-wide">
          <h2>Controller</h2>
          <p className="tester-subtle">
            Digital buttons snap on and off. Analogue inputs &mdash; triggers and sticks &mdash;
            fade in proportion to their value, so a sticky trigger or a drifting stick shows up
            as colour that never fully clears.
          </p>
          <div className="tester-stage">
            <ControllerDiagram state={state} />
          </div>
        </section>

        <section className="tester-card">
          <h2>Gyro</h2>
          <p className="tester-subtle">Angular rate per axis. At rest every dial should sit at neutral.</p>
          {state ? (
            <div className="tester-dials">
              <GyroDial label="Pitch" value={state.gyroX} />
              <GyroDial label="Yaw" value={state.gyroY} />
              <GyroDial label="Roll" value={state.gyroZ} />
            </div>
          ) : <p className="tester-subtle">Waiting for input.</p>}
        </section>

        <section className="tester-card">
          <h2>Acceleration</h2>
          <p className="tester-subtle">
            Needle shows tilt in the plane of the desk; Lift is the vertical axis, right when
            raised and left when dropped.
          </p>
          {state ? (
            <AccelVector
              x={state.accelX}
              y={state.accelY}
              z={state.accelZ}
              zero={accelZero}
              onZero={() => setAccelZero({ x: state.accelX, y: state.accelY, z: state.accelZ })}
              onClearZero={() => setAccelZero(null)}
            />
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
          <h2>Trigger effects</h2>
          <p className="tester-subtle">
            Composed in the app and sent verbatim. These are the controller&rsquo;s native ranges,
            not the percentages the main Triggers page maps onto zones.
          </p>
          <div className="tester-effects">
            <TriggerEffectEditor title="L2" effect={leftEffect} onChange={setLeftEffect} />
            <TriggerEffectEditor title="R2" effect={rightEffect} onChange={setRightEffect} />
          </div>
          <div className="tester-actions">
            <button type="button" onClick={() => void sendEffects(rightEffect, leftEffect)}>
              Send to controller
            </button>
            {/* Sends OFF to the controller but leaves the editors alone. Rewriting them to
                'off' discarded whatever you had dialled in, and left the panel in a state the
                app never starts in -- so re-sending meant rebuilding the effect from scratch. */}
            <button type="button" onClick={() => void sendEffects({ type: 'off' }, { type: 'off' })}>
              Stop both
            </button>
          </div>
          {sendError && <p className="tester-error">{sendError}</p>}
        </section>
        <section className="tester-card tester-card-wide">
          <h2>Stick calibration</h2>
          <p className="tester-subtle">
            Writes to the controller, not the bridge. These changes are <strong>temporary</strong>
            &mdash; the controller reverts them on reset, because nothing here unlocks its
            permanent storage. Every step is checked against the controller&rsquo;s own reply.
          </p>
          <p className="tester-subtle">
            <strong>Centre:</strong> begin, leave the sticks alone, sample, then store.{' '}
            <strong>Range:</strong> begin, sweep both sticks fully around their travel, then store.
          </p>
          <div className="tester-calibration">
            <div className="tester-calibration-row">
              <span className="tester-field-label">Centre</span>
              <button
                type="button"
                disabled={calibrationBusy || calibrationAwaitingSweep || !connected}
                onClick={() => void runCalibration(CALIBRATION_TARGET.CENTRE, 'Centre')}
              >
                Calibrate centre
              </button>
              <span className="tester-subtle">Leave both sticks untouched.</span>
            </div>
            <div className="tester-calibration-row">
              <span className="tester-field-label">Range</span>
              <button
                type="button"
                disabled={calibrationBusy || calibrationAwaitingSweep || !connected}
                onClick={() => void runCalibration(CALIBRATION_TARGET.RANGE, 'Range')}
              >
                Calibrate range
              </button>
              <button
                type="button"
                disabled={!calibrationAwaitingSweep}
                onClick={() => void finishRangeCalibration()}
              >
                Finish
              </button>
              <span className="tester-subtle">Sweep both sticks fully, then Finish.</span>
            </div>
          </div>
          <p className="tester-subtle">
            {calibrationStep
              ? calibrationStep
              : calibrationStatus?.received
                ? `Controller replied: target ${calibrationStatus.target}, code ${calibrationStatus.code}`
                : 'No calibration run yet.'}
          </p>
          {calibrationError && <p className="tester-error">{calibrationError}</p>}
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
      </div>
    </div>
  );
}
