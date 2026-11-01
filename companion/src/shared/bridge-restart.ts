import {
  isFaultPhase,
  WATCHDOG_PHASE_NAMES,
  type ForkResetRecordPayload,
  type UpstreamResetEvidencePayload,
  type WatchdogTelemetryPayload
} from './protocol';
import type { BridgeRestart } from './types';

const CORE1_STALL_PHASE = 31;

const SUMMARY: Record<BridgeRestart['kind'], string> = {
  crash: "The bridge's firmware crashed and the bridge restarted itself.",
  hang: "The bridge's firmware stopped responding and the bridge restarted itself.",
  'audio-stall': "The bridge's audio processor stopped responding and the bridge restarted itself.",
  unknown: "The bridge restarted itself unexpectedly, but its record of why did not survive."
};

// Firmware phase names (both lineages) to what a person would recognise. Names not listed
// fall back to null rather than leaking a developer name into the sentence.
const AREA_BY_PHASE: Record<string, string> = {
  boot: 'starting up',
  cyw43: 'running the Bluetooth radio',
  'cyw43-second': 'running the Bluetooth radio',
  tinyusb: 'handling USB',
  'usb-power': 'handling USB sleep and wake',
  audio: 'handling audio',
  button: 'checking button shortcuts',
  lightbar: 'updating the lightbar',
  rssi: 'checking Bluetooth signal strength',
  inquiry: 'searching for a controller',
  'connection-recovery': 'reconnecting the controller',
  'feature-prefetch': 'reading controller settings',
  'output-retry': 'sending rumble or trigger effects',
  companion: 'talking to the DS5 Bridge app',
  'firmware-log-flush': 'writing its log',
  'wake-on-lan': 'running Wake-on-LAN'
};

export function restartAreaForPhaseName(name: string | undefined): string | null {
  if (!name) return null;
  if (name.startsWith('interrupt') || name.startsWith('send/')) {
    return 'sending controller input to the PC';
  }
  return AREA_BY_PHASE[name] ?? null;
}

function restartedAt(nowMs: number, uptimeSeconds: number | null): number | null {
  return uptimeSeconds === null ? null : nowMs - uptimeSeconds * 1000;
}

/**
 * Fork firmware: the identity report's retained breadcrumb, plus report 0x61 when the
 * firmware has it (1.6.78+). Null after a clean boot or when the firmware predates both.
 */
export function describeForkRestart(input: {
  watchdog: WatchdogTelemetryPayload | null;
  record: ForkResetRecordPayload | null;
  /** The raw detail line the Diagnostics tab already shows. */
  technical: string;
  nowMs: number;
}): BridgeRestart | null {
  const { watchdog, record } = input;
  if (watchdog === null || !watchdog.priorTimeout) {
    return null;
  }

  let kind: BridgeRestart['kind'];
  let area: string | null;
  if (!watchdog.priorValid) {
    kind = 'unknown';
    area = null;
  } else if (watchdog.priorPhase === CORE1_STALL_PHASE) {
    kind = 'audio-stall';
    area = 'processing audio';
  } else if (isFaultPhase(watchdog.priorPhase)) {
    kind = 'crash';
    // The fault vector overwrote the phase byte; what the main loop was doing travels
    // separately, and 0 there means it was not captured.
    area = watchdog.phaseBeforeFault !== 0
      ? restartAreaForPhaseName(WATCHDOG_PHASE_NAMES[watchdog.phaseBeforeFault])
      : null;
  } else {
    kind = 'hang';
    area = restartAreaForPhaseName(WATCHDOG_PHASE_NAMES[watchdog.priorPhase]);
  }

  const consecutive = record?.abnormalReset ? record.consecutiveAbnormalResets : null;
  const uptimeBeforeSeconds = record?.abnormalReset ? record.priorUptimeSeconds : null;
  const uptimeNow = record?.uptimeSeconds ?? null;
  return {
    kind,
    summary: SUMMARY[kind],
    area,
    consecutive,
    uptimeBeforeSeconds,
    restartedAtUnixMs: restartedAt(input.nowMs, uptimeNow),
    technical: input.technical,
    key: [
      'fork',
      watchdog.priorPhase,
      watchdog.priorSequence,
      watchdog.priorPhaseEnteredAtMs,
      watchdog.faultAddress,
      watchdog.phaseBeforeFault,
      uptimeBeforeSeconds ?? '-',
      consecutive ?? '-'
    ].join(':')
  };
}

/** Upstream firmware (2.0+): report 0x13. */
export function describeUpstreamRestart(
  evidence: UpstreamResetEvidencePayload | null,
  nowMs: number
): BridgeRestart | null {
  if (evidence === null || !evidence.watchdogReset) {
    return null;
  }
  const kind: BridgeRestart['kind'] = !evidence.evidenceValid
    ? 'unknown'
    : evidence.reason === 'watchdog-timeout'
      ? 'hang'
      : 'crash';
  const uptimeBeforeSeconds = evidence.evidenceValid ? Math.floor(evidence.uptimeBeforeResetMs / 1000) : null;
  const technical = evidence.evidenceValid
    ? `${evidence.reason} in ${evidence.phase}, detail 0x${evidence.detail.toString(16).padStart(8, '0')}`
    : 'watchdog reset, breadcrumb invalid';
  return {
    kind,
    summary: SUMMARY[kind],
    area: evidence.evidenceValid ? restartAreaForPhaseName(evidence.phase) : null,
    consecutive: evidence.consecutiveAbnormalResets > 0 ? evidence.consecutiveAbnormalResets : null,
    uptimeBeforeSeconds,
    restartedAtUnixMs: restartedAt(nowMs, Math.floor(evidence.uptimeMs / 1000)),
    technical,
    key: [
      'upstream',
      evidence.phase,
      evidence.reason,
      evidence.uptimeBeforeResetMs,
      evidence.detail,
      evidence.consecutiveAbnormalResets
    ].join(':')
  };
}

/** "2 h 14 min", "45 s": short enough for one line of the Device page. */
export function formatRestartDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${whole} s`;
}

/** Plain text for "Copy details": everything a bug report needs, nothing that needs decoding. */
export function formatRestartReport(restart: BridgeRestart, context: {
  firmwareVersion: string | null;
  appVersion: string | null;
}): string {
  const lines = [
    restart.summary,
    restart.area ? `It was ${restart.area}.` : null,
    restart.uptimeBeforeSeconds !== null
      ? `It had been running for ${formatRestartDuration(restart.uptimeBeforeSeconds)}.`
      : null,
    restart.consecutive !== null && restart.consecutive > 1
      ? `This is ${restart.consecutive} abnormal restarts in a row.`
      : null,
    restart.restartedAtUnixMs !== null ? `Restarted at ${new Date(restart.restartedAtUnixMs).toISOString()}.` : null,
    `Firmware ${context.firmwareVersion ?? 'unknown'}, app ${context.appVersion ?? 'unknown'}.`,
    `Record: ${restart.technical}`
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}
