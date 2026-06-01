type DiagnosticsPreset = 'off' | 'audio' | 'traces' | 'host-audio' | 'all';

export const DEBUG_ENV = {
  diagnosticsPreset: 'DS5_BRIDGE_DIAGNOSTICS',
  audioDebugDiagnostics: 'DS5_BRIDGE_AUDIO_DEBUG_DIAGNOSTICS',
  triggerTraceDiagnostics: 'DS5_BRIDGE_TRIGGER_TRACE_DIAGNOSTICS',
  feedbackTraceDiagnostics: 'DS5_BRIDGE_FEEDBACK_TRACE_DIAGNOSTICS',
  micKeepalive: 'DS5_BRIDGE_MIC_KEEPALIVE',
  hostAudioSource: 'DS5_BRIDGE_HOST_AUDIO_SOURCE',
  hostAudioAutoCapture: 'DS5_BRIDGE_HOST_AUDIO_AUTO_CAPTURE',
  hostAudioHelperDiagnostics: 'DS5_BRIDGE_HOST_AUDIO_DIAGNOSTICS',
  hostAudioDump: 'DS5_BRIDGE_HOST_AUDIO_DUMP',
  hostAudioRawCaptureDump: 'DS5_BRIDGE_HOST_AUDIO_RAW_CAPTURE_DUMP',
  hostAudioRawCaptureDumpSeconds: 'DS5_BRIDGE_HOST_AUDIO_RAW_CAPTURE_DUMP_SECONDS',
  hostAudioFrameDump: 'DS5_BRIDGE_HOST_AUDIO_FRAME_DUMP',
  hostAudioFrameDumpLimit: 'DS5_BRIDGE_HOST_AUDIO_FRAME_DUMP_LIMIT'
} as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readDiagnosticsPreset(): DiagnosticsPreset {
  const value = readEnv(DEBUG_ENV.diagnosticsPreset)?.toLowerCase();
  switch (value) {
    case 'audio':
    case 'traces':
    case 'host-audio':
    case 'all':
      return value;
    default:
      return 'off';
  }
}

function readEnvFlag(name: string, fallback = false): boolean {
  const value = readEnv(name)?.toLowerCase();
  if (value == null) {
    return fallback;
  }
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function presetEnablesAudioDiagnostics(preset: DiagnosticsPreset): boolean {
  return preset === 'audio' || preset === 'traces' || preset === 'all';
}

function presetEnablesTraceDiagnostics(preset: DiagnosticsPreset): boolean {
  return preset === 'traces' || preset === 'all';
}

function presetEnablesHostAudioDiagnostics(preset: DiagnosticsPreset): boolean {
  return preset === 'host-audio' || preset === 'all';
}

const diagnosticsPreset = readDiagnosticsPreset();

export const CompanionDebugConfig = {
  diagnosticsPreset,
  audioDebugDiagnosticsEnabled: readEnvFlag(
    DEBUG_ENV.audioDebugDiagnostics,
    presetEnablesAudioDiagnostics(diagnosticsPreset)
  ),
  triggerTraceDiagnosticsEnabled: readEnvFlag(
    DEBUG_ENV.triggerTraceDiagnostics,
    presetEnablesTraceDiagnostics(diagnosticsPreset)
  ),
  feedbackTraceDiagnosticsEnabled: readEnvFlag(
    DEBUG_ENV.feedbackTraceDiagnostics,
    presetEnablesTraceDiagnostics(diagnosticsPreset)
  ),
  micKeepaliveEnabled: readEnvFlag(DEBUG_ENV.micKeepalive),
  hostAudioSource: readEnv(DEBUG_ENV.hostAudioSource),
  hostAudioAutoCaptureEnabled: readEnv(DEBUG_ENV.hostAudioAutoCapture) !== '0',
  hostAudioHelperDiagnosticsEnabled: readEnvFlag(
    DEBUG_ENV.hostAudioHelperDiagnostics,
    presetEnablesHostAudioDiagnostics(diagnosticsPreset)
  ),
  hostAudioDumpEnabled: readEnvFlag(DEBUG_ENV.hostAudioDump)
} as const;
