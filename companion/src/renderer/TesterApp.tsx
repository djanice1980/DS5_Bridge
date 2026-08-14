import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeSnapshot } from '../shared/types';
import type { ControllerInputSnapshot, DualSenseInputState } from '../shared/dualsense-input';
import { ControllerDiagram, GyroDial, AccelVector, type AccelZero } from './ControllerDiagram';
import { TriggerEffectEditor } from './TriggerEffectEditor';
import { StickSweep, type DirectionalSweep, createSweep, recordSweep, directionCoverage, sweepIsComplete } from './StickSweep';
import {
  StickDeadzoneScope,
  createDrift,
  driftEstimate,
  driftIsComplete,
  recordDrift,
  resetDrift,
  scopeDomain,
  suggestedDeadzonePercent,
  type StickDrift
} from './StickDeadzoneScope';
import { PermanentCalibrationDialog } from './PermanentCalibrationDialog';
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

/** Matches the firmware's cap; beyond this the rescale leaves too little usable range. */
const STICK_DEADZONE_MAX_PERCENT = 50;

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
  const [accelZeroIsAutomatic, setAccelZeroIsAutomatic] = useState(false);
  const accelRestSamples = useRef<Array<{ x: number; y: number; z: number }>>([]);
  /**
   * The auto-zero fires at most ONCE, and never again after the user has had a say.
   *
   * Clearing the sample buffer alone does not stop it: the buffer refills in eight samples, about
   * a third of a second, and it re-captures. Show absolute therefore flipped straight back and
   * the button could not be clicked.
   */
  const [autoZeroAllowed, setAutoZeroAllowed] = useState(true);
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationStep, setCalibrationStep] = useState<string | null>(null);
  const [calibrationStatus, setCalibrationStatus] = useState<CalibrationStatus | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);
  const [calibrationAwaitingSweep, setCalibrationAwaitingSweep] = useState(false);
  // Refs, not state: this is written at the poll rate and only needs to be READ when rendering.
  const sweepLeft = useRef<DirectionalSweep>(createSweep());
  const sweepRight = useRef<DirectionalSweep>(createSweep());
  // Bumped after each fold so the trace actually repaints.
  const [sweepTick, setSweepTick] = useState(0);
  // Permanent mode is per-run and never sticky: it must be chosen again every time, so it can
  // never be left armed from an earlier session.
  const [permanentPrompt, setPermanentPrompt] = useState<number | null>(null);
  const [permanentArmed, setPermanentArmed] = useState(false);
  /**
   * Deadzone tuning session.
   *
   * The bridge applies the deadzone BEFORE the report reaches this window, so while one is set the
   * stick reads exactly centre and there is nothing to watch bounce -- and the transform cannot be
   * undone here either, because inside the deadzone every position collapses to the same zero.
   * Starting a session therefore un-masks the sticks (deadzone 0) and moves the slider to a local
   * PREVIEW; nothing is written to the bridge until Apply. The saved values are held so Cancel can
   * put them back.
   */
  const [dzSession, setDzSession] = useState<{ savedLeft: number; savedRight: number } | null>(null);
  const [dzPreview, setDzPreview] = useState<{ left: number; right: number }>({ left: 0, right: 0 });
  const driftLeft = useRef<StickDrift>(createDrift());
  const driftRight = useRef<StickDrift>(createDrift());
  const [driftTick, setDriftTick] = useState(0);
  // Read by the teardown paths, which must see the CURRENT session rather than the one captured
  // when the effect was first set up.
  const dzSessionRef = useRef<{ savedLeft: number; savedRight: number } | null>(null);

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

  const runCalibration = useCallback(async (target: number, label: string, permanent = false) => {
    setCalibrationBusy(true);
    setCalibrationError(null);
    setCalibrationStep(`${label}: starting`);
    try {
      if (permanent) {
        // Unlocked for the duration of this run only. The re-lock is in the finally below, so it
        // happens even if a step throws -- leaving NVS unlocked would mean any later write,
        // including one nobody asked for, lands in permanent storage.
        await window.bridge.setNvsUnlocked(true);
      }
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
        setCalibrationStep(
          `${label}: sweep both sticks slowly around the rim -- one full circle clockwise, one counterclockwise -- then press Finish`
        );
        // Fresh trace per run, or the previous attempt's coverage would read as this one's.
        sweepLeft.current = createSweep();
        sweepRight.current = createSweep();
        setSweepTick(0);
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
      if (permanent) {
        // Best effort, and deliberately not conditional on success: a failed run is exactly when
        // leaving the controller writable would matter most.
        await window.bridge.setNvsUnlocked(false).catch(() => {});
      }
      setCalibrationBusy(false);
    }
  }, [beginCalibration, runStep]);

  const finishRangeCalibration = useCallback(async (permanent = false) => {
    setCalibrationBusy(true);
    setCalibrationAwaitingSweep(false);
    setCalibrationStep('Range: storing');
    try {
      if (permanent) {
        await window.bridge.setNvsUnlocked(true);
      }
      const stored = await runStep(
        CALIBRATION_OP.STORE,
        CALIBRATION_TARGET.RANGE,
        CALIBRATION_CODE.COMMITTED
      );
      if (!stored) {
        setCalibrationError('The controller did not confirm the write.');
      }
    } finally {
      if (permanent) {
        await window.bridge.setNvsUnlocked(false).catch(() => {});
      }
      setCalibrationStep(null);
      setCalibrationBusy(false);
    }
  }, [runStep]);

  /**
   * Both sticks travel in one command; the firmware carries them in a single value, so sending
   * them separately would have the second overwrite the first.
   */
  const setDeadzone = useCallback(async (side: 'left' | 'right', percent: number) => {
    const current = snapshot?.settings;
    if (!current) {
      return;
    }
    const left = side === 'left' ? percent : current.stickDeadzoneLeftPercent;
    const right = side === 'right' ? percent : current.stickDeadzoneRightPercent;
    const next = await window.bridge.setStickDeadzone(left, right);
    setSnapshot(next);
  }, [snapshot]);

  const startDeadzoneTuning = useCallback(async () => {
    const current = snapshot?.settings;
    if (!current) {
      return;
    }
    const savedLeft = current.stickDeadzoneLeftPercent;
    const savedRight = current.stickDeadzoneRightPercent;
    setDzPreview({ left: savedLeft, right: savedRight });
    driftLeft.current = createDrift();
    driftRight.current = createDrift();
    // Un-mask, so the drift being measured is the stick's own and not what survived the deadzone.
    const next = await window.bridge.setStickDeadzone(0, 0);
    setSnapshot(next);
    setDzSession({ savedLeft, savedRight });
  }, [snapshot]);

  const endDeadzoneTuning = useCallback(async (left: number, right: number) => {
    const next = await window.bridge.setStickDeadzone(left, right);
    setSnapshot(next);
    setDzSession(null);
  }, []);

  useEffect(() => {
    dzSessionRef.current = dzSession;
  }, [dzSession]);

  /**
   * Never leave the bridge un-masked because the window went away.
   *
   * Closing an Electron window does not reliably unmount the tree, so the restore is hung on
   * unload as well. Neither path can await -- an abrupt kill can still lose the write, which is
   * why the session is not destructive: what is lost is a deadzone setting, and the sticks are
   * left reporting exactly what they really do.
   */
  useEffect(() => {
    const restore = () => {
      const session = dzSessionRef.current;
      if (session) {
        dzSessionRef.current = null;
        void window.bridge.setStickDeadzone(session.savedLeft, session.savedRight).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', restore);
    return () => {
      window.removeEventListener('beforeunload', restore);
      restore();
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

  // Range-sweep gate. sweepTick forces re-render as samples land, so these stay current.
  void sweepTick;
  const sweepDone = sweepIsComplete(sweepLeft.current) && sweepIsComplete(sweepRight.current);
  const sweepWorstDirection = Math.min(
    directionCoverage(sweepLeft.current.cw),
    directionCoverage(sweepLeft.current.ccw),
    directionCoverage(sweepRight.current.cw),
    directionCoverage(sweepRight.current.ccw)
  );

  const bridges = snapshot?.bridgeDevices?.bridges ?? [];
  const directControllers = snapshot?.bridgeDevices?.directControllers ?? [];
  const selectedDirect = directControllers.find((controller) => controller.selectedForTester) ?? null;
  const directMode = selectedDirect !== null;

  // One picker, two kinds of sources. Values are prefixed because bridge port paths and hidraw
  // paths share no namespace guarantees.
  const pickerValue = selectedDirect
    ? `direct|${selectedDirect.path}`
    : (bridges.find((bridge) => bridge.selected)?.path
      ? `bridge|${bridges.find((bridge) => bridge.selected)?.path}`
      : '');

  function onPickSource(value: string): void {
    if (value.startsWith('direct|')) {
      void window.bridge.selectTesterController(value.slice('direct|'.length));
      return;
    }
    // Selecting a bridge (or clearing) also returns the tester to the bridge path.
    void window.bridge.selectTesterController(null);
    if (value.startsWith('bridge|')) {
      void window.bridge.selectBridge(value.slice('bridge|'.length) || null);
    }
  }

  function directLabel(controller: (typeof directControllers)[number]): string {
    const name = (controller.product ?? 'DualSense')
      .replace(/^Sony Interactive Entertainment\s+/i, '')
      .replace(/\s*Wireless Controller$/i, '')
      .trim() || 'DualSense';
    const suffix = controller.chargingViaBridge
      ? ' (charging via USB — data on bridge)'
      : ' — USB direct';
    return `${name}${suffix}`;
  }

  // Fold every sample into the coverage trace while a sweep is being asked for.
  useEffect(() => {
    if (!state || !calibrationAwaitingSweep) {
      return;
    }
    const nowMs = performance.now();
    recordSweep(sweepLeft.current, state.leftStickX, state.leftStickY, nowMs);
    recordSweep(sweepRight.current, state.rightStickX, state.rightStickY, nowMs);
    setSweepTick((tick) => tick + 1);
  }, [state, calibrationAwaitingSweep]);

  // Track how far each stick wanders while a tuning session is open. In direct-USB mode there
  // is no session -- the bridge's deadzone filter is not in this path -- so measurement simply
  // runs whenever input does.
  useEffect(() => {
    if (!state || (!dzSession && !directMode)) {
      return;
    }
    // The controller's sensor clock rides along so a dropped link cannot pass for a still stick.
    recordDrift(
      driftLeft.current,
      state.leftStickX,
      state.leftStickY,
      scopeDomain(dzPreview.left),
      state.sensorTimestamp
    );
    recordDrift(
      driftRight.current,
      state.rightStickX,
      state.rightStickY,
      scopeDomain(dzPreview.right),
      state.sensorTimestamp
    );
    setDriftTick((tick) => tick + 1);
  }, [state, dzSession, dzPreview]);

  /**
   * Capture the resting pose as the needle's origin, once, after the controller has been still.
   *
   * A DualSense rests nose-up on its grips -- about 9 degrees, Z around 1375 -- so referencing an
   * IDEALLY level controller left the dot permanently off centre on every unit. Referencing the
   * pose it is actually in makes "centred" mean "as you left it", which is the question the
   * needle is there to answer.
   *
   * This does not hide a bad sensor: the X/Y/Z numbers below stay absolute and unzeroed, and
   * Clear returns the needle to absolute too. Auto-zeroing was rejected earlier for exactly that
   * risk, before those raw numbers existed to carry it.
   *
   * Waits for STILLNESS rather than firing on the first sample, so a controller picked up as the
   * window opens does not get its tilt baked in as the origin.
   */
  useEffect(() => {
    if (!state || accelZero !== null || !autoZeroAllowed) {
      return;
    }
    const samples = accelRestSamples.current;
    samples.push({ x: state.accelX, y: state.accelY, z: state.accelZ });
    if (samples.length < 8) {
      return;
    }
    samples.shift();

    const spread = (pick: (s: { x: number; y: number; z: number }) => number) => {
      const values = samples.map(pick);
      return Math.max(...values) - Math.min(...values);
    };
    // Tens of units is ordinary sensor noise; hundreds means it is being moved.
    const STILL_ENOUGH = 120;
    if (spread((v) => v.x) > STILL_ENOUGH
      || spread((v) => v.y) > STILL_ENOUGH
      || spread((v) => v.z) > STILL_ENOUGH) {
      return;
    }

    const mean = (pick: (s: { x: number; y: number; z: number }) => number) =>
      Math.round(samples.reduce((total, sample) => total + pick(sample), 0) / samples.length);
    setAccelZero({ x: mean((v) => v.x), y: mean((v) => v.y), z: mean((v) => v.z) });
    setAccelZeroIsAutomatic(true);
    setAutoZeroAllowed(false);
  }, [state, accelZero, autoZeroAllowed]);


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
          <span className="tester-field-label">Controller source</span>
          <select
            aria-label="Controller source"
            value={pickerValue}
            onChange={(event) => onPickSource(event.target.value)}
          >
            {bridges.length === 0 && directControllers.length === 0 && (
              <option value="">No bridge or USB controller detected</option>
            )}
            {bridges.length > 0 && (
              <optgroup label="Bridges">
                {bridges.map((bridge) => (
                  <option key={bridge.path} value={`bridge|${bridge.path}`}>
                    {bridge.name ?? bridge.uniqueId ?? bridge.path}
                    {bridge.connected ? '' : ' (no controller)'}
                  </option>
                ))}
              </optgroup>
            )}
            {directControllers.length > 0 && (
              <optgroup label="USB controllers">
                {directControllers.map((controller) => (
                  <option
                    key={controller.path}
                    value={`direct|${controller.path}`}
                    disabled={controller.chargingViaBridge}
                  >
                    {directLabel(controller)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </header>

      <label className="tester-hold-toggle">
        <input
          type="checkbox"
          checked={holdInput && !directMode}
          disabled={directMode}
          onChange={(event) => setHoldInput(event.target.checked)}
        />
        <span>
          Pause input to this PC while testing
          <span className="tester-subtle">
            {directMode
              ? ' — bridge only: a USB controller reaches this PC through the system driver, which the app cannot pause.'
              : ' — so PS and other buttons do not affect other applications. Releases automatically if the app closes.'}
          </span>
        </span>
      </label>

      <div className={`tester-status${connected ? ' is-live' : ''}`}>
        {connected
          ? `Live — ${pollMs ?? 0} ms read, ${INPUT_POLL_INTERVAL_MS} ms interval`
          : directMode
            ? 'USB controller is not sending input — it may be asleep, or its data link may be on a bridge'
            : 'No controller connected to the selected bridge'}
      </div>

      {directMode && (
        <div className="tester-status">
          Reading this controller directly over USB. Buttons, sticks, triggers, touchpad,
          motion, drift measurement, the raw report and stick calibration all work. Deadzone is
          hidden because it is not a controller feature at all &mdash; the bridge applies it to
          the data stream, which this cable bypasses &mdash; and app trigger effects are not
          wired up for USB yet.
        </div>
      )}

      <div className="tester-grid">
        <section className="tester-card tester-card-wide">
          <h2>Controller</h2>
          <p className="tester-subtle">
            Digital buttons snap on and off. Analogue inputs &mdash; triggers and sticks &mdash;
            fade in proportion to their value, so a sticky trigger or a drifting stick shows up
            as colour that never fully clears.
          </p>
          {/*
            Power and audio sit BESIDE the drawing rather than in a card of their own: the
            controller is portrait in a full-width card, so it left a large empty column, and
            these are the readings you want in view while looking at the controller anyway.
          */}
          <div className="tester-controller-row">
            <dl className="tester-facts tester-controller-facts">
              <div><dt>Battery</dt><dd>{state ? (state.batteryPercent === null ? 'unknown' : `${state.batteryPercent}%`) : '--'}</dd></div>
              <div><dt>Charging</dt><dd>{state ? (state.charging ? 'yes' : 'no') : '--'}</dd></div>
              <div><dt>Power state</dt><dd className="tester-mono">{state ? `0x${state.rawPowerState.toString(16)}` : '--'}</dd></div>
              <div><dt>Headset</dt><dd>{state ? (state.headsetPlugged ? 'plugged' : 'no') : '--'}</dd></div>
              <div><dt>Mic</dt><dd>{state ? (state.microphonePlugged ? 'plugged' : 'no') : '--'}</dd></div>
              <div><dt>Mic muted</dt><dd>{state ? (state.microphoneMuted ? 'yes' : 'no') : '--'}</dd></div>
            </dl>
            <div className="tester-stage">
              <ControllerDiagram state={state} />
            </div>
          </div>
        </section>

        {directMode && (
          <section className="tester-card tester-card-wide">
            <h2>Stick drift</h2>
            <p className="tester-subtle">
              Push a stick right out and let go, three times over. Each release is measured on its
              own, and a release the stick was still moving through is thrown away. Take your hand
              off completely &mdash; a resting thumb reads as drift.
            </p>
            <p className="tester-subtle">
              <strong>Measurement only &mdash; nothing is applied over USB.</strong> Games and the
              system see this controller&rsquo;s raw sticks exactly as they are; there is no
              deadzone to set here because that filter runs inside the bridge, which this cable
              bypasses. To actually correct drift, recalibrate the stick centre below (permanent
              only if you choose to commit it), or connect through the bridge and set a deadzone
              there.
            </p>
            <div className="tester-dzscopes" data-tick={driftTick}>
              <StickDeadzoneScope
                label="Left"
                x={state?.leftStickX ?? 128}
                y={state?.leftStickY ?? 128}
                deadzonePercent={0}
                drift={driftLeft.current}
              />
              <StickDeadzoneScope
                label="Right"
                x={state?.rightStickX ?? 128}
                y={state?.rightStickY ?? 128}
                deadzonePercent={0}
                drift={driftRight.current}
              />
            </div>
            <div className="tester-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  resetDrift(driftLeft.current);
                  resetDrift(driftRight.current);
                  setDriftTick((tick) => tick + 1);
                }}
              >
                Start over
              </button>
              {driftIsComplete(driftLeft.current) && driftIsComplete(driftRight.current) && (
                <span className="tester-mono">
                  Measured drift &mdash; L {(driftEstimate(driftLeft.current) * 100).toFixed(1)}%,
                  R {(driftEstimate(driftRight.current) * 100).toFixed(1)}%
                </span>
              )}
            </div>
          </section>
        )}

        {!directMode && (
        <section className={`tester-card${dzSession ? ' tester-card-wide' : ''}`}>
          {/* A session needs room for two zoomed sticks, and letting it stay a third of a row
              would stretch Gyro and Acceleration to match its height for no reason. */}
          <h2>Stick deadzone</h2>
          {dzSession ? null : (
            <p className="tester-subtle">
              Ignores movement near centre. Saved with the controller profile, and applied by the
              bridge before anything reaches this PC &mdash; so the sticks above show the CORRECTED
              values.
            </p>
          )}

          {dzSession ? (
            <>
              <p className="tester-subtle">
                Deadzone is off while you tune, so the sticks read exactly what they really do.
                Push a stick right out and let go, three times over. Each release is measured on
                its own and takes a second or two, and a release the stick was still moving through
                is thrown away rather than counted. Take your hand off it completely &mdash; a
                thumb left resting reads as drift, which is why it takes three goes that agree.
                The ring is the middle reading, and the shaded disc is the deadzone you are about
                to set. Raise it until the ring sits inside the disc and turns green.
              </p>
              <div className="tester-dzscopes" data-tick={driftTick}>
                <StickDeadzoneScope
                  label="Left"
                  x={state?.leftStickX ?? 128}
                  y={state?.leftStickY ?? 128}
                  deadzonePercent={dzPreview.left}
                  drift={driftLeft.current}
                />
                <StickDeadzoneScope
                  label="Right"
                  x={state?.rightStickX ?? 128}
                  y={state?.rightStickY ?? 128}
                  deadzonePercent={dzPreview.right}
                  drift={driftRight.current}
                />
              </div>
              <div className="tester-deadzone">
                {([['Left', 'left'], ['Right', 'right']] as Array<[string, 'left' | 'right']>).map(
                  ([sideLabel, side]) => (
                    <label key={side} className="tester-slider">
                      <span className="tester-field-label">{sideLabel}</span>
                      <input
                        type="range"
                        aria-label={`${sideLabel} stick deadzone`}
                        min={0}
                        max={STICK_DEADZONE_MAX_PERCENT}
                        value={dzPreview[side]}
                        onChange={(event) => setDzPreview((current) => ({
                          ...current,
                          [side]: Number(event.target.value)
                        }))}
                      />
                      <span className="tester-mono tester-slider-value">{dzPreview[side]}%</span>
                    </label>
                  )
                )}
              </div>
              <div className="tester-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    resetDrift(driftLeft.current);
                    resetDrift(driftRight.current);
                    setDriftTick((tick) => tick + 1);
                  }}
                >
                  Start over
                </button>
                <button
                  type="button"
                  className="secondary"
                  // A half-finished measurement would offer a number that looks like an answer.
                  // Until both sticks have all three readings there is nothing to offer.
                  disabled={!driftIsComplete(driftLeft.current) || !driftIsComplete(driftRight.current)}
                  onClick={() => setDzPreview({
                    left: suggestedDeadzonePercent(driftEstimate(driftLeft.current)),
                    right: suggestedDeadzonePercent(driftEstimate(driftRight.current))
                  })}
                >
                  {driftIsComplete(driftLeft.current) && driftIsComplete(driftRight.current)
                    ? `Use measured (${suggestedDeadzonePercent(driftEstimate(driftLeft.current))}% / ${suggestedDeadzonePercent(driftEstimate(driftRight.current))}%)`
                    : 'Use measured'}
                </button>
                <button
                  type="button"
                  onClick={() => void endDeadzoneTuning(dzPreview.left, dzPreview.right)}
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={() => void endDeadzoneTuning(dzSession.savedLeft, dzSession.savedRight)}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="tester-deadzone">
                {([['Left', 'left'], ['Right', 'right']] as Array<[string, 'left' | 'right']>).map(
                  ([sideLabel, side]) => {
                    const value = side === 'left'
                      ? (snapshot?.settings.stickDeadzoneLeftPercent ?? 0)
                      : (snapshot?.settings.stickDeadzoneRightPercent ?? 0);
                    return (
                      <label key={side} className="tester-slider">
                        <span className="tester-field-label">{sideLabel}</span>
                        <input
                          type="range"
                          aria-label={`${sideLabel} stick deadzone`}
                          min={0}
                          max={STICK_DEADZONE_MAX_PERCENT}
                          value={value}
                          disabled={!connected}
                          onChange={(event) => void setDeadzone(side, Number(event.target.value))}
                        />
                        <span className="tester-mono tester-slider-value">{value}%</span>
                      </label>
                    );
                  }
                )}
              </div>
              <div className="tester-actions">
                <button type="button" disabled={!connected} onClick={() => void startDeadzoneTuning()}>
                  Measure drift
                </button>
              </div>
            </>
          )}

          <p className="tester-subtle">
            A deadzone hides drift rather than fixing it, which is why it starts at zero. If a
            stick will not settle at centre, calibrate below instead of masking it.
          </p>
        </section>
        )}

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
              zeroIsAutomatic={accelZeroIsAutomatic}
              onZero={() => {
                setAccelZero({ x: state.accelX, y: state.accelY, z: state.accelZ });
                setAccelZeroIsAutomatic(false);
              }}
              onClearZero={() => {
                setAccelZero(null);
                setAccelZeroIsAutomatic(false);
                // Show absolute MEANS absolute: stop the auto-zero re-arming behind the user.
                setAutoZeroAllowed(false);
                accelRestSamples.current = [];
              }}
            />
          ) : <p className="tester-subtle">Waiting for input.</p>}
        </section>


        {!directMode && (
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
        )}
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
              <button
                type="button"
                className="tester-danger"
                disabled={calibrationBusy || calibrationAwaitingSweep || !connected}
                onClick={() => setPermanentPrompt(CALIBRATION_TARGET.CENTRE)}
              >
                Make permanent
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
                disabled={!calibrationAwaitingSweep || !sweepDone}
                onClick={() => void finishRangeCalibration(permanentArmed)}
              >
                Finish
              </button>
              {calibrationAwaitingSweep && !sweepDone && sweepWorstDirection >= 0.6 && (
                <button
                  type="button"
                  className="tester-danger"
                  onClick={() => void finishRangeCalibration(permanentArmed)}
                >
                  Store anyway (sweep incomplete)
                </button>
              )}
              <button
                type="button"
                className="tester-danger"
                disabled={calibrationBusy || calibrationAwaitingSweep || !connected}
                onClick={() => setPermanentPrompt(CALIBRATION_TARGET.RANGE)}
              >
                Make permanent
              </button>
              <span className="tester-subtle">
                One slow circle each way per stick &mdash; about two seconds per circle &mdash;
                unlocks Finish. Sweeping faster than the controller can be read earns nothing.
              </span>
            </div>
          </div>
          {calibrationAwaitingSweep && state && (
            <div className="tester-sweeps" data-tick={sweepTick}>
              <StickSweep
                label="Left stick"
                sweep={sweepLeft.current}
                x={state.leftStickX}
                y={state.leftStickY}
              />
              <StickSweep
                label="Right stick"
                sweep={sweepRight.current}
                x={state.rightStickX}
                y={state.rightStickY}
              />
              <p className="tester-subtle tester-sweeps-note">
                Push each stick to its limit and sweep slowly around the rim: one full circle
                clockwise, then one counterclockwise. The filled shape is how far it has reached;
                a gap is a direction the controller has not seen yet.
                {sweepDone ? ' Both sticks fully swept in both directions.' : ''}
              </p>
            </div>
          )}
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

      <PermanentCalibrationDialog
        open={permanentPrompt !== null}
        onCancel={() => setPermanentPrompt(null)}
        onConfirm={() => {
          const target = permanentPrompt;
          setPermanentPrompt(null);
          if (target === null) {
            return;
          }
          // Range stores on Finish, after the sweep, so it has to stay armed until then.
          setPermanentArmed(target === CALIBRATION_TARGET.RANGE);
          void runCalibration(
            target,
            target === CALIBRATION_TARGET.CENTRE ? 'Centre (permanent)' : 'Range (permanent)',
            true
          );
        }}
      />
    </div>
  );
}
