import { afterEach, describe, expect, it, vi } from 'vitest';

const DEBUG_ENV_KEYS = [
  'DS5_BRIDGE_DIAGNOSTICS',
  'DS5_BRIDGE_AUDIO_DEBUG_DIAGNOSTICS',
  'DS5_BRIDGE_TRIGGER_TRACE_DIAGNOSTICS',
  'DS5_BRIDGE_FEEDBACK_TRACE_DIAGNOSTICS',
  'DS5_BRIDGE_MIC_KEEPALIVE',
  'DS5_BRIDGE_HOST_AUDIO_SOURCE',
  'DS5_BRIDGE_HOST_AUDIO_AUTO_CAPTURE',
  'DS5_BRIDGE_HOST_AUDIO_DIAGNOSTICS',
  'DS5_BRIDGE_HOST_AUDIO_DUMP',
  'DS5_BRIDGE_HOST_AUDIO_RAW_CAPTURE_DUMP',
  'DS5_BRIDGE_HOST_AUDIO_RAW_CAPTURE_DUMP_SECONDS',
  'DS5_BRIDGE_HOST_AUDIO_FRAME_DUMP',
  'DS5_BRIDGE_HOST_AUDIO_FRAME_DUMP_LIMIT'
] as const;

const originalEnv = { ...process.env };

async function loadConfig(env: Record<string, string | undefined>) {
  for (const key of DEBUG_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.resetModules();
  const module = await import('./debug-config');
  return module.CompanionDebugConfig;
}

afterEach(() => {
  for (const key of DEBUG_ENV_KEYS) {
    delete process.env[key];
    const original = originalEnv[key];
    if (original != null) {
      process.env[key] = original;
    }
  }
  vi.resetModules();
});

describe('CompanionDebugConfig', () => {
  it('defaults to diagnostics off while leaving host audio auto-capture enabled', async () => {
    const config = await loadConfig({});

    expect(config).toMatchObject({
      diagnosticsPreset: 'off',
      audioDebugDiagnosticsEnabled: false,
      triggerTraceDiagnosticsEnabled: false,
      feedbackTraceDiagnosticsEnabled: false,
      micKeepaliveEnabled: false,
      hostAudioSource: undefined,
      hostAudioAutoCaptureEnabled: true,
      hostAudioHelperDiagnosticsEnabled: false,
      hostAudioDumpEnabled: false
    });
  });

  it('maps diagnostics presets to the intended feature families', async () => {
    await expect(loadConfig({ DS5_BRIDGE_DIAGNOSTICS: ' audio ' })).resolves.toMatchObject({
      diagnosticsPreset: 'audio',
      audioDebugDiagnosticsEnabled: true,
      triggerTraceDiagnosticsEnabled: false,
      feedbackTraceDiagnosticsEnabled: false,
      hostAudioHelperDiagnosticsEnabled: false
    });

    await expect(loadConfig({ DS5_BRIDGE_DIAGNOSTICS: 'traces' })).resolves.toMatchObject({
      diagnosticsPreset: 'traces',
      audioDebugDiagnosticsEnabled: true,
      triggerTraceDiagnosticsEnabled: true,
      feedbackTraceDiagnosticsEnabled: true,
      hostAudioHelperDiagnosticsEnabled: false
    });

    await expect(loadConfig({ DS5_BRIDGE_DIAGNOSTICS: 'host-audio' })).resolves.toMatchObject({
      diagnosticsPreset: 'host-audio',
      audioDebugDiagnosticsEnabled: false,
      triggerTraceDiagnosticsEnabled: false,
      feedbackTraceDiagnosticsEnabled: false,
      hostAudioHelperDiagnosticsEnabled: true
    });

    await expect(loadConfig({ DS5_BRIDGE_DIAGNOSTICS: 'all' })).resolves.toMatchObject({
      diagnosticsPreset: 'all',
      audioDebugDiagnosticsEnabled: true,
      triggerTraceDiagnosticsEnabled: true,
      feedbackTraceDiagnosticsEnabled: true,
      hostAudioHelperDiagnosticsEnabled: true
    });
  });

  it('lets explicit env flags override preset defaults', async () => {
    const config = await loadConfig({
      DS5_BRIDGE_DIAGNOSTICS: 'all',
      DS5_BRIDGE_AUDIO_DEBUG_DIAGNOSTICS: '0',
      DS5_BRIDGE_TRIGGER_TRACE_DIAGNOSTICS: 'false',
      DS5_BRIDGE_FEEDBACK_TRACE_DIAGNOSTICS: 'off',
      DS5_BRIDGE_HOST_AUDIO_DIAGNOSTICS: 'no',
      DS5_BRIDGE_MIC_KEEPALIVE: 'yes',
      DS5_BRIDGE_HOST_AUDIO_DUMP: 'on',
      DS5_BRIDGE_HOST_AUDIO_AUTO_CAPTURE: '0',
      DS5_BRIDGE_HOST_AUDIO_SOURCE: '  Bridge Microphone  '
    });

    expect(config).toMatchObject({
      diagnosticsPreset: 'all',
      audioDebugDiagnosticsEnabled: false,
      triggerTraceDiagnosticsEnabled: false,
      feedbackTraceDiagnosticsEnabled: false,
      hostAudioHelperDiagnosticsEnabled: false,
      micKeepaliveEnabled: true,
      hostAudioDumpEnabled: true,
      hostAudioAutoCaptureEnabled: false,
      hostAudioSource: 'Bridge Microphone'
    });
  });
});
