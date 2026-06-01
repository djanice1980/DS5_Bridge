import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BUTTON_REMAP_PROFILE_ID,
  DEFAULT_CONTROLLER_PROFILE_ID
} from '../shared/protocol';
import { DEFAULT_SETTINGS, SettingsStore } from './settings-store';

describe('SettingsStore', () => {
  const tempDirs: string[] = [];

  function tempUserDataPath(): string {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'ds5-settings-store-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  function persistedSettings(userDataPath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(userDataPath, 'settings.json'), 'utf8')) as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('starts with the protected default controller profile and base settings', () => {
    const store = new SettingsStore(tempUserDataPath());
    const settings = store.get();

    expect(settings.selectedControllerProfileId).toBe(DEFAULT_CONTROLLER_PROFILE_ID);
    expect(settings.controllerProfiles).toHaveLength(1);
    expect(settings.controllerProfiles[0]).toMatchObject({
      id: DEFAULT_CONTROLLER_PROFILE_ID,
      name: 'Default',
      settings: {
        speakerVolumePercent: 100,
        micVolumePercent: 100,
        micMuted: true,
        hostEncodedAudioEnabled: true,
        duplexMicEnabled: false,
        feedbackBoostEnabled: false,
        lightbarColor: '#0000ff'
      }
    });
    expect(settings.hostEncodedAudioEnabled).toBe(true);
    expect(settings.duplexMicEnabled).toBe(false);
    expect(settings.micVolumePercent).toBe(100);
    expect(settings.micMuted).toBe(true);
    expect(settings.lightbarColor).toBe('#0000ff');
  });

  it('migrates legacy custom-only profile data without stealing selection', () => {
    const userDataPath = tempUserDataPath();
    writeFileSync(path.join(userDataPath, 'settings.json'), JSON.stringify({
      selectedControllerProfileId: 'profile-personalized',
      duplexMicEnabled: true,
      micMuted: false,
      controllerProfiles: [{
        id: 'profile-personalized',
        name: 'Personalized',
        settings: {
          speakerVolumePercent: 30,
          micMuted: false,
          duplexMicEnabled: true,
          hostEncodedAudioEnabled: false
        }
      }]
    }), 'utf8');

    const settings = new SettingsStore(userDataPath).get();

    expect(settings.controllerProfiles.map((profile) => profile.name)).toEqual(['Default', 'Personalized']);
    expect(settings.selectedControllerProfileId).toBe('profile-personalized');
    expect(settings.controllerProfiles.find((profile) => profile.id === 'profile-personalized')?.settings).toMatchObject({
      speakerVolumePercent: 30,
      micMuted: true,
      duplexMicEnabled: false,
      hostEncodedAudioEnabled: false
    });
    expect(settings.micMuted).toBe(true);
    expect(settings.duplexMicEnabled).toBe(false);
    expect(settings.controllerProfiles.find((profile) => profile.id === DEFAULT_CONTROLLER_PROFILE_ID)?.settings.speakerVolumePercent).toBe(100);
  });

  it('auto-forks default controller changes into a saved custom profile', () => {
    const userDataPath = tempUserDataPath();
    const store = new SettingsStore(userDataPath);

    const updated = store.update({
      speakerVolumePercent: 35,
      hapticsGainPercent: 70,
      lightbarBrightnessPercent: 60
    });

    expect(updated.selectedControllerProfileId).toBe('custom');
    expect(updated.controllerProfiles.map((profile) => profile.name)).toEqual(['Default', 'Custom']);
    expect(updated.controllerProfiles.find((profile) => profile.id === DEFAULT_CONTROLLER_PROFILE_ID)?.settings).toMatchObject({
      speakerVolumePercent: 100,
      hapticsGainPercent: 100,
      lightbarBrightnessPercent: 100
    });
    expect(updated.controllerProfiles.find((profile) => profile.id === 'custom')?.settings).toMatchObject({
      speakerVolumePercent: 35,
      hapticsGainPercent: 70,
      lightbarBrightnessPercent: 60
    });

    const restartedSettings = new SettingsStore(userDataPath).get();
    expect(restartedSettings.selectedControllerProfileId).toBe('custom');
    expect(restartedSettings.speakerVolumePercent).toBe(35);
  });

  it('persists boosted feedback gains in controller profiles', () => {
    const userDataPath = tempUserDataPath();
    const store = new SettingsStore(userDataPath);

    const updated = store.update({
      feedbackBoostEnabled: true,
      hapticsGainPercent: 500,
      classicRumbleGainPercent: 480
    });

    expect(updated.feedbackBoostEnabled).toBe(true);
    expect(updated.hapticsGainPercent).toBe(500);
    expect(updated.classicRumbleGainPercent).toBe(480);
    expect(updated.controllerProfiles.find((profile) => profile.id === 'custom')?.settings).toMatchObject({
      feedbackBoostEnabled: true,
      hapticsGainPercent: 500,
      classicRumbleGainPercent: 480
    });

    const restartedSettings = new SettingsStore(userDataPath).get();
    expect(restartedSettings.feedbackBoostEnabled).toBe(true);
    expect(restartedSettings.hapticsGainPercent).toBe(500);
    expect(restartedSettings.classicRumbleGainPercent).toBe(480);
  });

  it('saves, renames, updates, and deletes custom controller profiles while protecting default', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0x12345)
      .mockReturnValueOnce(0x12346);
    const store = new SettingsStore(tempUserDataPath());

    const saved = store.saveControllerProfile('Couch');
    const profileId = saved.selectedControllerProfileId;
    expect(profileId).toMatch(/^profile-/);
    expect(saved.controllerProfiles.find((profile) => profile.id === profileId)?.name).toBe('Couch');

    const renamedDefault = store.renameControllerProfile(DEFAULT_CONTROLLER_PROFILE_ID, 'Base');
    expect(renamedDefault.controllerProfiles.find((profile) => profile.id === DEFAULT_CONTROLLER_PROFILE_ID)?.name).toBe('Default');

    const renamed = store.renameControllerProfile(profileId, 'Desk');
    expect(renamed.controllerProfiles.find((profile) => profile.id === profileId)?.name).toBe('Desk');

    store.update({ speakerVolumePercent: 42 });
    const savedProfile = store.updateControllerProfile(profileId);
    expect(savedProfile.controllerProfiles.find((profile) => profile.id === profileId)?.settings.speakerVolumePercent).toBe(42);

    const deletedDefault = store.deleteControllerProfile(DEFAULT_CONTROLLER_PROFILE_ID);
    expect(deletedDefault.controllerProfiles.some((profile) => profile.id === DEFAULT_CONTROLLER_PROFILE_ID)).toBe(true);

    const deleted = store.deleteControllerProfile(profileId);
    expect(deleted.selectedControllerProfileId).toBe(DEFAULT_CONTROLLER_PROFILE_ID);
    expect(deleted.controllerProfiles.map((profile) => profile.id)).toEqual([DEFAULT_CONTROLLER_PROFILE_ID]);
  });

  it('restores the default profile to base settings without discarding custom profiles', () => {
    const userDataPath = tempUserDataPath();
    const store = new SettingsStore(userDataPath);
    store.saveControllerProfile('Personalized');
    store.update({ speakerVolumePercent: 25 });
    store.updateControllerProfile(store.get().selectedControllerProfileId);

    const restored = store.restoreDefaults();

    expect(restored.selectedControllerProfileId).toBe(DEFAULT_CONTROLLER_PROFILE_ID);
    expect(restored.controllerProfiles.map((profile) => profile.name)).toEqual(['Default', 'Personalized']);
    expect(restored.controllerProfiles[0]?.settings).toMatchObject({
      speakerVolumePercent: 100,
      hostEncodedAudioEnabled: true,
      lightbarColor: '#0000ff'
    });
    expect(restored.speakerVolumePercent).toBe(100);
    expect(persistedSettings(userDataPath).selectedControllerProfileId).toBe(DEFAULT_CONTROLLER_PROFILE_ID);
  });

  it('returns defensive copies so callers cannot mutate in-memory settings', () => {
    const store = new SettingsStore(tempUserDataPath());

    const firstRead = store.get();
    firstRead.controllerProfiles[0]!.settings.speakerVolumePercent = 1;
    firstRead.buttonRemappingProfiles[0]!.mappings.cross = 'circle';
    firstRead.buttonRemappingDraft.cross = 'circle';

    const secondRead = store.get();
    expect(secondRead.controllerProfiles[0]!.settings.speakerVolumePercent).toBe(100);
    expect(secondRead.buttonRemappingProfiles[0]!.mappings.cross).toBe('cross');
    expect(secondRead.buttonRemappingDraft.cross).toBe('cross');

    const updated = store.update({ speakerVolumePercent: 35 });
    updated.controllerProfiles.find((profile) => profile.id === 'custom')!.settings.speakerVolumePercent = 2;
    updated.buttonRemappingDraft.square = 'triangle';

    const afterMutation = store.get();
    expect(afterMutation.speakerVolumePercent).toBe(35);
    expect(afterMutation.controllerProfiles.find((profile) => profile.id === 'custom')?.settings.speakerVolumePercent).toBe(35);
    expect(afterMutation.buttonRemappingDraft.square).toBe('square');
  });

  it('deduplicates persisted custom profiles while preserving the selected winner', () => {
    const userDataPath = tempUserDataPath();
    writeFileSync(path.join(userDataPath, 'settings.json'), JSON.stringify({
      selectedControllerProfileId: 'profile-dupe',
      controllerProfiles: [{
        id: 'profile-dupe',
        name: 'First',
        settings: {
          speakerVolumePercent: 25
        }
      }, {
        id: 'profile-dupe',
        name: 'Second',
        settings: {
          speakerVolumePercent: 55,
          micVolumePercent: 40
        }
      }],
      selectedButtonRemappingProfileId: 'remap-dupe',
      buttonRemappingProfiles: [{
        id: 'remap-dupe',
        name: 'Arcade',
        mappings: {
          cross: 'circle'
        }
      }, {
        id: 'remap-dupe',
        name: 'Southpaw',
        mappings: {
          cross: 'square',
          circle: 'cross'
        }
      }]
    }), 'utf8');

    const settings = new SettingsStore(userDataPath).get();

    expect(settings.controllerProfiles.map((profile) => profile.name)).toEqual(['Default', 'Second']);
    expect(settings.selectedControllerProfileId).toBe('profile-dupe');
    expect(settings.controllerProfiles.find((profile) => profile.id === 'profile-dupe')?.settings).toMatchObject({
      speakerVolumePercent: 55,
      micVolumePercent: 40
    });
    expect(settings.buttonRemappingProfiles.map((profile) => profile.name)).toEqual(['Default', 'Southpaw']);
    expect(settings.selectedButtonRemappingProfileId).toBe('remap-dupe');
    expect(settings.buttonRemappingProfiles.find((profile) => profile.id === 'remap-dupe')?.mappings).toMatchObject({
      cross: 'square',
      circle: 'cross'
    });
  });

  it('recovers from corrupt settings files and can persist fresh settings afterward', () => {
    const userDataPath = tempUserDataPath();
    writeFileSync(path.join(userDataPath, 'settings.json'), '{ not json', 'utf8');

    const store = new SettingsStore(userDataPath);
    expect(store.get().selectedControllerProfileId).toBe(DEFAULT_CONTROLLER_PROFILE_ID);

    store.update({ speakerVolumePercent: 45 });
    expect(persistedSettings(userDataPath).speakerVolumePercent).toBe(45);
  });

  it('auto-forks default button remapping changes into a saved custom profile', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0x23456);
    const store = new SettingsStore(tempUserDataPath());

    const changedDraft = store.setButtonRemap('cross', 'circle');
    expect(changedDraft.selectedButtonRemappingProfileId).toBe('custom');
    expect(changedDraft.buttonRemappingProfiles.map((profile) => profile.name)).toEqual(['Default', 'Custom']);
    expect(changedDraft.buttonRemappingDraft.cross).toBe('circle');
    expect(changedDraft.buttonRemappingProfiles[0]?.mappings.cross).toBe('cross');
    expect(changedDraft.buttonRemappingProfiles.find((profile) => profile.id === 'custom')?.mappings.cross).toBe('circle');

    const blockedDefaultUpdate = store.updateButtonRemappingProfile(DEFAULT_BUTTON_REMAP_PROFILE_ID);
    expect(blockedDefaultUpdate.buttonRemappingProfiles[0]?.mappings.cross).toBe('cross');

    const updatedCustom = store.setButtonRemap('square', 'triangle');
    expect(updatedCustom.buttonRemappingProfiles.find((profile) => profile.id === 'custom')?.mappings.square).toBe('triangle');

    const saved = store.saveButtonRemappingProfile('FPS');
    const profileId = saved.selectedButtonRemappingProfileId;
    expect(saved.buttonRemappingProfiles.find((profile) => profile.id === profileId)?.mappings.cross).toBe('circle');

    const updated = store.setButtonRemap('square', 'options');
    expect(updated.buttonRemappingProfiles.find((profile) => profile.id === profileId)?.mappings.square).toBe('options');

    const renamedDefault = store.renameButtonRemappingProfile(DEFAULT_BUTTON_REMAP_PROFILE_ID, 'Base');
    expect(renamedDefault.buttonRemappingProfiles[0]?.name).toBe('Default');

    const deleted = store.deleteButtonRemappingProfile(profileId);
    expect(deleted.selectedButtonRemappingProfileId).toBe(DEFAULT_BUTTON_REMAP_PROFILE_ID);
    expect(deleted.buttonRemappingProfiles.map((profile) => profile.id)).toEqual([DEFAULT_BUTTON_REMAP_PROFILE_ID, 'custom']);
  });

  it('normalizes invalid persisted values back to safe defaults', () => {
    const userDataPath = tempUserDataPath();
    writeFileSync(path.join(userDataPath, 'settings.json'), JSON.stringify({
      uiScalePercent: 110,
      lightbarColor: '#golden',
      speakerVolumePercent: 999,
      idleDisconnectTimeoutMinutes: -10,
      controllerProfiles: [{
        id: DEFAULT_CONTROLLER_PROFILE_ID,
        name: 'Modified Default',
        settings: {
          speakerVolumePercent: 1
        }
      }, {
        id: 'profile-personalized',
        name: 'Personalized',
        settings: {
          pollingRateMode: 'garbage',
          lightbarColor: '#123456'
        }
      }]
    }), 'utf8');

    const settings = new SettingsStore(userDataPath).get();

    expect(settings.uiScalePercent).toBe(100);
    expect(settings.lightbarColor).toBe(DEFAULT_SETTINGS.lightbarColor);
    expect(settings.speakerVolumePercent).toBe(100);
    expect(settings.idleDisconnectTimeoutMinutes).toBe(1);
    expect(settings.controllerProfiles[0]?.name).toBe('Default');
    expect(settings.controllerProfiles[0]?.settings.speakerVolumePercent).toBe(100);
    expect(settings.controllerProfiles[1]?.settings.pollingRateMode).toBe(DEFAULT_SETTINGS.pollingRateMode);
    expect(settings.controllerProfiles[1]?.settings.lightbarColor).toBe('#123456');
  });
});
