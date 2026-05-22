import { contextBridge, ipcRenderer } from 'electron';
import type { BridgePresetId, MuteButtonMode, MuteKeyboardBehavior, PollingRateMode, RemapButtonId, TriggerTestMode, TriggerTestTarget } from './shared/protocol';
import type { BridgeDiagnostics, BridgeSnapshot, WindowsDeviceCleanupResult } from './shared/types';

const api = {
  getStatus: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:getStatus'),
  listDevices: () => ipcRenderer.invoke('bridge:listDevices'),
  applyPreset: (value: BridgePresetId): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:applyPreset', value),
  selectControllerProfile: (profileId: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:selectControllerProfile', profileId)
  ),
  saveControllerProfile: (name?: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:saveControllerProfile', name)
  ),
  updateControllerProfile: (profileId: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:updateControllerProfile', profileId)
  ),
  renameControllerProfile: (profileId: string, name: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:renameControllerProfile', profileId, name)
  ),
  deleteControllerProfile: (profileId: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:deleteControllerProfile', profileId)
  ),
  setHapticsGain: (value: number): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setHapticsGain', value),
  setHapticsEnabled: (value: boolean): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setHapticsEnabled', value),
  setHapticsBufferLength: (value: number): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setHapticsBufferLength', value)
  ),
  setClassicRumbleGain: (value: number): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setClassicRumbleGain', value)
  ),
  setClassicRumbleEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setClassicRumbleEnabled', value)
  ),
  setTriggerEffectIntensity: (value: number): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setTriggerEffectIntensity', value)
  ),
  setTriggerTestMode: (value: TriggerTestMode): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setTriggerTestMode', value)
  ),
  setAdaptiveTriggersEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setAdaptiveTriggersEnabled', value)
  ),
  setSpeakerVolume: (value: number): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setSpeakerVolume', value),
  setSpeakerEnabled: (value: boolean): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setSpeakerEnabled', value),
  setMicVolume: (value: number): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setMicVolume', value),
  setMicMute: (value: boolean): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setMicMute', value),
  setHostEncodedAudioEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setHostEncodedAudioEnabled', value)
  ),
  setDuplexMicEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setDuplexMicEnabled', value)
  ),
  setLightbarColor: (color: string, brightness: number): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setLightbarColor', color, brightness)
  ),
  setLightbarEnabled: (value: boolean): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setLightbarEnabled', value),
  setLightbarOverrideEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setLightbarOverrideEnabled', value)
  ),
  setMuteButtonAction: (
    mode: MuteButtonMode,
    usage: number,
    modifiers: number,
    behavior: MuteKeyboardBehavior
  ): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setMuteButtonAction', mode, usage, modifiers, behavior)
  ),
  setLedEnabled: (value: boolean): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setLedEnabled', value),
  setIdleDisconnectEnabled: (value: boolean): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setIdleDisconnectEnabled', value),
  setIdleDisconnectTimeoutMinutes: (value: number): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setIdleDisconnectTimeoutMinutes', value)
  ),
  setUsbSuspendDisconnectEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setUsbSuspendDisconnectEnabled', value)
  ),
  setSleepKeybindEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setSleepKeybindEnabled', value)
  ),
  setSpeakerVolumeShortcutEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setSpeakerVolumeShortcutEnabled', value)
  ),
  setControllerPowerSavingEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setControllerPowerSavingEnabled', value)
  ),
  setLaunchAtStartupEnabled: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setLaunchAtStartupEnabled', value)
  ),
  setUiScalePercent: (value: number): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:setUiScalePercent', value),
  setPollingRateMode: (value: PollingRateMode): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setPollingRateMode', value)
  ),
  sleepController: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:sleepController'),
  setNotifyControllerConnection: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setNotifyControllerConnection', value)
  ),
  setNotifyLowBattery: (value: boolean): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setNotifyLowBattery', value)
  ),
  testNotification: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:testNotification'),
  testHaptics: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:testHaptics'),
  testSpeaker: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:testSpeaker'),
  testClassicRumble: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:testClassicRumble'),
  testAdaptiveTriggers: (mode?: TriggerTestMode, target?: TriggerTestTarget): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:testAdaptiveTriggers', mode, target)
  ),
  resetAdaptiveTriggers: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:resetAdaptiveTriggers'),
  restoreDefaults: (): Promise<BridgeSnapshot> => ipcRenderer.invoke('bridge:restoreDefaults'),
  setButtonRemap: (buttonId: RemapButtonId, targetId: RemapButtonId): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:setButtonRemap', buttonId, targetId)
  ),
  selectButtonRemappingProfile: (profileId: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:selectButtonRemappingProfile', profileId)
  ),
  saveButtonRemappingProfile: (name?: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:saveButtonRemappingProfile', name)
  ),
  updateButtonRemappingProfile: (profileId: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:updateButtonRemappingProfile', profileId)
  ),
  renameButtonRemappingProfile: (profileId: string, name: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:renameButtonRemappingProfile', profileId, name)
  ),
  deleteButtonRemappingProfile: (profileId: string): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:deleteButtonRemappingProfile', profileId)
  ),
  restoreButtonRemappingDefaults: (): Promise<BridgeSnapshot> => (
    ipcRenderer.invoke('bridge:restoreButtonRemappingDefaults')
  ),
  repairWindowsDeviceCache: (): Promise<WindowsDeviceCleanupResult> => (
    ipcRenderer.invoke('bridge:repairWindowsDeviceCache')
  ),
  getDiagnostics: (): Promise<BridgeDiagnostics> => ipcRenderer.invoke('bridge:getDiagnostics'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:toggleMaximize'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  hideWindow: (): Promise<void> => ipcRenderer.invoke('window:hide'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('window:openExternal', url),
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized);
    ipcRenderer.on('window:maximizedChanged', listener);
    return () => ipcRenderer.removeListener('window:maximizedChanged', listener);
  },
  onSnapshot: (callback: (snapshot: BridgeSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: BridgeSnapshot) => callback(snapshot);
    ipcRenderer.on('bridge:snapshot', listener);
    return () => ipcRenderer.removeListener('bridge:snapshot', listener);
  }
};

contextBridge.exposeInMainWorld('bridge', api);

export type BridgeApi = typeof api;
