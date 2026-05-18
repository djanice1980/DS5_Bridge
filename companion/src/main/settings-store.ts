import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_BUTTON_REMAP_PROFILE,
  DEFAULT_BUTTON_REMAP_PROFILE_ID,
  REMAP_BUTTON_IDS,
  isRemapButtonId,
  normalizeBridgePresetId
} from '../shared/protocol';
import type { BridgePresetId, ButtonRemapMap, ButtonRemapProfile, RemapButtonId } from '../shared/protocol';
import type { CompanionSettings } from '../shared/types';

export const DEFAULT_SETTINGS: CompanionSettings = {
  selectedPresetId: 'balanced',
  hapticsEnabled: true,
  hapticsGainPercent: 100,
  hapticsBufferLength: 64,
  classicRumbleEnabled: true,
  classicRumbleGainPercent: 100,
  adaptiveTriggersEnabled: true,
  triggerEffectIntensityPercent: 100,
  triggerTestMode: 'feedback',
  speakerEnabled: true,
  speakerVolumePercent: 30,
  micVolumePercent: 100,
  micMuted: false,
  lightbarEnabled: true,
  lightbarColor: '#ffd700',
  lightbarBrightnessPercent: 100,
  lightbarOverrideEnabled: false,
  muteButtonMode: 'normal',
  muteKeyboardUsage: 0x68,
  muteKeyboardModifiers: 0,
  muteKeyboardBehavior: 'tap',
  ledEnabled: true,
  idleDisconnectEnabled: true,
  idleDisconnectTimeoutMinutes: 15,
  usbSuspendDisconnectEnabled: true,
  sleepKeybindEnabled: false,
  speakerVolumeShortcutEnabled: false,
  pollingRateMode: '1000',
  notifyControllerConnection: false,
  notifyLowBattery: false,
  hostEncodedAudioEnabled: false,
  duplexMicEnabled: false,
  selectedButtonRemappingProfileId: DEFAULT_BUTTON_REMAP_PROFILE_ID,
  buttonRemappingProfiles: [DEFAULT_BUTTON_REMAP_PROFILE],
  buttonRemappingDraft: { ...DEFAULT_BUTTON_REMAP_PROFILE.mappings }
};

function normalizeColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    return DEFAULT_SETTINGS.lightbarColor;
  }
  return value.toLowerCase();
}

function normalizePresetId(value: unknown): CompanionSettings['selectedPresetId'] {
  return normalizeBridgePresetId(value, DEFAULT_SETTINGS.selectedPresetId);
}

function normalizePollingRateMode(value: unknown): CompanionSettings['pollingRateMode'] {
  switch (value) {
    case '250':
    case '500':
    case '1000':
      return value;
    default:
      return DEFAULT_SETTINGS.pollingRateMode;
  }
}

function cloneRemapMap(map: ButtonRemapMap): ButtonRemapMap {
  return { ...map };
}

function normalizeRemapMap(value: unknown): ButtonRemapMap {
  const source = value && typeof value === 'object' ? value as Partial<Record<RemapButtonId, unknown>> : {};
  return Object.fromEntries(REMAP_BUTTON_IDS.map((id) => {
    const target = source[id];
    return [id, isRemapButtonId(target) ? target : id];
  })) as ButtonRemapMap;
}

function normalizeRemapProfile(value: unknown): ButtonRemapProfile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<ButtonRemapProfile>;
  if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
    return null;
  }
  const name = typeof candidate.name === 'string' && candidate.name.trim().length > 0
    ? candidate.name.trim().slice(0, 48)
    : 'Custom Profile';
  return {
    id: candidate.id.trim().slice(0, 64),
    name,
    mappings: normalizeRemapMap(candidate.mappings)
  };
}

function normalizeRemapProfiles(value: unknown): ButtonRemapProfile[] {
  const profiles = Array.isArray(value)
    ? value.map(normalizeRemapProfile).filter((profile): profile is ButtonRemapProfile => profile !== null)
    : [];
  const uniqueProfiles = new Map<string, ButtonRemapProfile>();
  uniqueProfiles.set(DEFAULT_BUTTON_REMAP_PROFILE_ID, {
    ...DEFAULT_BUTTON_REMAP_PROFILE,
    mappings: cloneRemapMap(DEFAULT_BUTTON_REMAP_PROFILE.mappings)
  });
  for (const profile of profiles) {
    if (profile.id === DEFAULT_BUTTON_REMAP_PROFILE_ID) {
      continue;
    }
    uniqueProfiles.set(profile.id, profile);
  }
  return Array.from(uniqueProfiles.values());
}

function normalizeSelectedRemapProfileId(value: unknown, profiles: ButtonRemapProfile[]): string {
  return typeof value === 'string' && profiles.some((profile) => profile.id === value)
    ? value
    : DEFAULT_BUTTON_REMAP_PROFILE_ID;
}

function cloneSettings(settings: CompanionSettings): CompanionSettings {
  return {
    ...settings,
    buttonRemappingProfiles: settings.buttonRemappingProfiles.map((profile) => ({
      ...profile,
      mappings: cloneRemapMap(profile.mappings)
    })),
    buttonRemappingDraft: cloneRemapMap(settings.buttonRemappingDraft)
  };
}

type PersistedSettings = Partial<CompanionSettings> & {
  customProfile?: Partial<CompanionSettings>;
};

function normalizeSettings(value: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  const selectedPresetId = normalizePresetId(value?.selectedPresetId);
  const buttonRemappingProfiles = normalizeRemapProfiles(value?.buttonRemappingProfiles);
  const selectedButtonRemappingProfileId = normalizeSelectedRemapProfileId(
    value?.selectedButtonRemappingProfileId,
    buttonRemappingProfiles
  );

  return {
    selectedPresetId,
    hapticsEnabled: typeof value?.hapticsEnabled === 'boolean'
      ? value.hapticsEnabled
      : DEFAULT_SETTINGS.hapticsEnabled,
    hapticsGainPercent: Number.isFinite(value?.hapticsGainPercent)
      ? Math.max(0, Math.min(200, Math.round(value!.hapticsGainPercent!)))
      : DEFAULT_SETTINGS.hapticsGainPercent,
    hapticsBufferLength: Number.isFinite(value?.hapticsBufferLength)
      ? Math.max(64, Math.min(255, Math.round(value!.hapticsBufferLength!)))
      : DEFAULT_SETTINGS.hapticsBufferLength,
    classicRumbleEnabled: typeof value?.classicRumbleEnabled === 'boolean'
      ? value.classicRumbleEnabled
      : DEFAULT_SETTINGS.classicRumbleEnabled,
    classicRumbleGainPercent: Number.isFinite(value?.classicRumbleGainPercent)
      ? Math.max(0, Math.min(200, Math.round(value!.classicRumbleGainPercent!)))
      : DEFAULT_SETTINGS.classicRumbleGainPercent,
    adaptiveTriggersEnabled: typeof value?.adaptiveTriggersEnabled === 'boolean'
      ? value.adaptiveTriggersEnabled
      : DEFAULT_SETTINGS.adaptiveTriggersEnabled,
    triggerEffectIntensityPercent: Number.isFinite(value?.triggerEffectIntensityPercent)
      ? Math.max(0, Math.min(100, Math.round(value!.triggerEffectIntensityPercent!)))
      : DEFAULT_SETTINGS.triggerEffectIntensityPercent,
    triggerTestMode: value?.triggerTestMode === 'weapon' || value?.triggerTestMode === 'vibration' || value?.triggerTestMode === 'feedback'
      ? value.triggerTestMode
      : DEFAULT_SETTINGS.triggerTestMode,
    speakerEnabled: typeof value?.speakerEnabled === 'boolean'
      ? value.speakerEnabled
      : DEFAULT_SETTINGS.speakerEnabled,
    speakerVolumePercent: Number.isFinite(value?.speakerVolumePercent)
      ? Math.max(0, Math.min(100, Math.round(value!.speakerVolumePercent!)))
      : DEFAULT_SETTINGS.speakerVolumePercent,
    micVolumePercent: Number.isFinite(value?.micVolumePercent)
      ? Math.max(0, Math.min(100, Math.round(value!.micVolumePercent!)))
      : DEFAULT_SETTINGS.micVolumePercent,
    micMuted: typeof value?.micMuted === 'boolean'
      ? value.micMuted
      : DEFAULT_SETTINGS.micMuted,
    lightbarEnabled: typeof value?.lightbarEnabled === 'boolean'
      ? value.lightbarEnabled
      : DEFAULT_SETTINGS.lightbarEnabled,
    lightbarColor: normalizeColor(value?.lightbarColor),
    lightbarBrightnessPercent: Number.isFinite(value?.lightbarBrightnessPercent)
      ? Math.max(0, Math.min(100, Math.round(value!.lightbarBrightnessPercent!)))
      : DEFAULT_SETTINGS.lightbarBrightnessPercent,
    lightbarOverrideEnabled: typeof value?.lightbarOverrideEnabled === 'boolean'
      ? value.lightbarOverrideEnabled
      : DEFAULT_SETTINGS.lightbarOverrideEnabled,
    muteButtonMode: value?.muteButtonMode === 'keyboard' || value?.muteButtonMode === 'quiet' || value?.muteButtonMode === 'normal'
      ? value.muteButtonMode
      : DEFAULT_SETTINGS.muteButtonMode,
    muteKeyboardUsage: Number.isFinite(value?.muteKeyboardUsage)
      ? Math.max(1, Math.min(0x73, Math.round(value!.muteKeyboardUsage!)))
      : DEFAULT_SETTINGS.muteKeyboardUsage,
    muteKeyboardModifiers: Number.isFinite(value?.muteKeyboardModifiers)
      ? Math.max(0, Math.min(0x0f, Math.round(value!.muteKeyboardModifiers!)))
      : DEFAULT_SETTINGS.muteKeyboardModifiers,
    muteKeyboardBehavior: value?.muteKeyboardBehavior === 'hold' || value?.muteKeyboardBehavior === 'tap'
      ? value.muteKeyboardBehavior
      : DEFAULT_SETTINGS.muteKeyboardBehavior,
    ledEnabled: typeof value?.ledEnabled === 'boolean' ? value.ledEnabled : DEFAULT_SETTINGS.ledEnabled,
    idleDisconnectEnabled: typeof value?.idleDisconnectEnabled === 'boolean'
      ? value.idleDisconnectEnabled
      : DEFAULT_SETTINGS.idleDisconnectEnabled,
    idleDisconnectTimeoutMinutes: Number.isFinite(value?.idleDisconnectTimeoutMinutes)
      ? Math.max(1, Math.min(120, Math.round(value!.idleDisconnectTimeoutMinutes!)))
      : DEFAULT_SETTINGS.idleDisconnectTimeoutMinutes,
    usbSuspendDisconnectEnabled: typeof value?.usbSuspendDisconnectEnabled === 'boolean'
      ? value.usbSuspendDisconnectEnabled
      : DEFAULT_SETTINGS.usbSuspendDisconnectEnabled,
    sleepKeybindEnabled: typeof value?.sleepKeybindEnabled === 'boolean'
      ? value.sleepKeybindEnabled
      : DEFAULT_SETTINGS.sleepKeybindEnabled,
    speakerVolumeShortcutEnabled: typeof value?.speakerVolumeShortcutEnabled === 'boolean'
      ? value.speakerVolumeShortcutEnabled
      : DEFAULT_SETTINGS.speakerVolumeShortcutEnabled,
    pollingRateMode: normalizePollingRateMode(value?.pollingRateMode),
    notifyControllerConnection: typeof value?.notifyControllerConnection === 'boolean'
      ? value.notifyControllerConnection
      : DEFAULT_SETTINGS.notifyControllerConnection,
    notifyLowBattery: typeof value?.notifyLowBattery === 'boolean'
      ? value.notifyLowBattery
      : DEFAULT_SETTINGS.notifyLowBattery,
    hostEncodedAudioEnabled: typeof value?.hostEncodedAudioEnabled === 'boolean'
      ? value.hostEncodedAudioEnabled
      : DEFAULT_SETTINGS.hostEncodedAudioEnabled,
    duplexMicEnabled: typeof value?.duplexMicEnabled === 'boolean'
      ? value.duplexMicEnabled
      : DEFAULT_SETTINGS.duplexMicEnabled,
    selectedButtonRemappingProfileId,
    buttonRemappingProfiles,
    buttonRemappingDraft: normalizeRemapMap(value?.buttonRemappingDraft)
  };
}

function customSettingsFrom(value: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return normalizeSettings({ ...value, selectedPresetId: 'custom' });
}

export class SettingsStore {
  private readonly filePath: string;
  private settings: CompanionSettings;
  private customSettings: CompanionSettings;

  constructor(public readonly userDataPath: string) {
    this.filePath = path.join(userDataPath, 'settings.json');
    const persisted = this.read();
    this.settings = persisted.settings;
    this.customSettings = persisted.customSettings;
  }

  get(): CompanionSettings {
    return cloneSettings(this.settings);
  }

  update(next: Partial<CompanionSettings>): CompanionSettings {
    this.settings = normalizeSettings({ ...this.settings, ...next });
    if (this.settings.selectedPresetId === 'custom') {
      this.customSettings = { ...this.settings };
    }
    this.write();
    return this.get();
  }

  applyPreset(
    presetId: BridgePresetId,
    presetSettings?: Partial<CompanionSettings>
  ): CompanionSettings {
    const normalizedPresetId = normalizePresetId(presetId);
    if (this.settings.selectedPresetId === 'custom') {
      this.customSettings = { ...this.settings, selectedPresetId: 'custom' };
    }

    if (normalizedPresetId === 'custom') {
      this.settings = { ...this.customSettings, selectedPresetId: 'custom' };
    } else {
      this.settings = normalizeSettings({ ...this.settings, ...presetSettings, selectedPresetId: normalizedPresetId });
    }

    this.write();
    return this.get();
  }

  restoreDefaults(): CompanionSettings {
    this.settings = cloneSettings(DEFAULT_SETTINGS);
    this.customSettings = customSettingsFrom(DEFAULT_SETTINGS);
    this.write();
    return this.get();
  }

  setButtonRemap(buttonId: RemapButtonId, targetId: RemapButtonId): CompanionSettings {
    if (!isRemapButtonId(buttonId) || !isRemapButtonId(targetId)) {
      return this.get();
    }
    return this.update({
      buttonRemappingDraft: {
        ...this.settings.buttonRemappingDraft,
        [buttonId]: targetId
      }
    });
  }

  selectButtonRemappingProfile(profileId: string): CompanionSettings {
    const profile = this.settings.buttonRemappingProfiles.find((candidate) => candidate.id === profileId)
      ?? this.settings.buttonRemappingProfiles[0]
      ?? DEFAULT_BUTTON_REMAP_PROFILE;
    return this.update({
      selectedButtonRemappingProfileId: profile.id,
      buttonRemappingDraft: profile.mappings
    });
  }

  saveButtonRemappingProfile(name?: string): CompanionSettings {
    const profileName = typeof name === 'string' && name.trim().length > 0
      ? name.trim().slice(0, 48)
      : this.nextButtonRemappingProfileName();
    const profile: ButtonRemapProfile = {
      id: `profile-${Date.now().toString(36)}`,
      name: profileName,
      mappings: cloneRemapMap(this.settings.buttonRemappingDraft)
    };
    return this.update({
      selectedButtonRemappingProfileId: profile.id,
      buttonRemappingProfiles: [...this.settings.buttonRemappingProfiles, profile],
      buttonRemappingDraft: profile.mappings
    });
  }

  updateButtonRemappingProfile(profileId: string): CompanionSettings {
    if (profileId === DEFAULT_BUTTON_REMAP_PROFILE_ID) {
      return this.get();
    }
    const profileExists = this.settings.buttonRemappingProfiles.some((profile) => profile.id === profileId);
    if (!profileExists) {
      return this.get();
    }
    const mappings = cloneRemapMap(this.settings.buttonRemappingDraft);
    return this.update({
      buttonRemappingProfiles: this.settings.buttonRemappingProfiles.map((profile) => (
        profile.id === profileId ? { ...profile, mappings } : profile
      )),
      buttonRemappingDraft: mappings
    });
  }

  renameButtonRemappingProfile(profileId: string, name: string): CompanionSettings {
    const nextName = name.trim().slice(0, 48);
    if (profileId === DEFAULT_BUTTON_REMAP_PROFILE_ID || nextName.length === 0) {
      return this.get();
    }
    return this.update({
      buttonRemappingProfiles: this.settings.buttonRemappingProfiles.map((profile) => (
        profile.id === profileId ? { ...profile, name: nextName } : profile
      ))
    });
  }

  deleteButtonRemappingProfile(profileId: string): CompanionSettings {
    if (profileId === DEFAULT_BUTTON_REMAP_PROFILE_ID) {
      return this.get();
    }
    const profiles = this.settings.buttonRemappingProfiles.filter((profile) => profile.id !== profileId);
    const fallback = profiles.find((profile) => profile.id === DEFAULT_BUTTON_REMAP_PROFILE_ID)
      ?? DEFAULT_BUTTON_REMAP_PROFILE;
    return this.update({
      selectedButtonRemappingProfileId: fallback.id,
      buttonRemappingProfiles: profiles,
      buttonRemappingDraft: fallback.mappings
    });
  }

  restoreButtonRemappingDefaults(): CompanionSettings {
    return this.update({
      selectedButtonRemappingProfileId: DEFAULT_BUTTON_REMAP_PROFILE_ID,
      buttonRemappingDraft: DEFAULT_BUTTON_REMAP_PROFILE.mappings
    });
  }

  private read(): { settings: CompanionSettings; customSettings: CompanionSettings } {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedSettings;
      const settings = normalizeSettings(parsed);
      const fallbackCustom = settings.selectedPresetId === 'custom' ? settings : DEFAULT_SETTINGS;
      return {
        settings,
        customSettings: customSettingsFrom(parsed.customProfile ?? fallbackCustom)
      };
    } catch {
      return {
        settings: cloneSettings(DEFAULT_SETTINGS),
        customSettings: customSettingsFrom(DEFAULT_SETTINGS)
      };
    }
  }

  private nextButtonRemappingProfileName(): string {
    const names = new Set(this.settings.buttonRemappingProfiles.map((profile) => profile.name));
    let index = 1;
    while (names.has(`Custom Profile ${index}`)) {
      index += 1;
    }
    return `Custom Profile ${index}`;
  }

  private write(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({
      ...this.settings,
      customProfile: this.customSettings
    }, null, 2)}\n`, 'utf8');
  }
}
