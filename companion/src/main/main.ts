import { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, screen, shell } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BridgeService } from './bridge-service';
import { SettingsStore } from './settings-store';
import type { BridgePresetId, MuteButtonMode, MuteKeyboardBehavior, PollingRateMode, RemapButtonId, TriggerTestMode, TriggerTestTarget } from '../shared/protocol';
import type { BridgeToast } from './bridge-service';

const APP_NAME = 'DS5 Bridge';
const WINDOWS_APP_USER_MODEL_ID = 'io.github.ds5bridge.companion';
const WINDOWS_TOAST_ACTIVATOR_CLSID = '{A8B3700D-4BB5-4E22-BF57-0C43B7C2FDF6}';
const APP_MARK_PNG = path.join('assets', 'controllers', 'ds5-bridge_mark.png');
const APP_ICON_ICO = path.join('assets', 'controllers', 'ds5-bridge_app-icon-tile.ico');
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridgeService: BridgeService | null = null;
let isQuitting = false;
let shutdownComplete = false;

function windowsAppUserModelId(): string {
  return WINDOWS_APP_USER_MODEL_ID;
}

if (process.platform === 'win32') {
  app.setAppUserModelId(windowsAppUserModelId());
}

function appResourcePath(relativePath: string): string {
  const packagedPath = path.join(app.getAppPath(), relativePath);
  if (fs.existsSync(packagedPath)) {
    return packagedPath;
  }
  return path.resolve(app.getAppPath(), '..', relativePath);
}

function createImageAsset(relativePath: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(appResourcePath(relativePath));
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function createRuntimeIcon(): Electron.NativeImage {
  return createImageAsset(APP_MARK_PNG);
}

async function createTrayIcon(): Promise<Electron.NativeImage> {
  const icon = createRuntimeIcon();
  if (!icon.isEmpty()) {
    return icon.resize({ width: 16, height: 16, quality: 'best' });
  }

  try {
    const fileIcon = await app.getFileIcon(process.execPath, { size: 'normal' });
    return fileIcon.isEmpty() ? nativeImage.createEmpty() : fileIcon;
  } catch {
    return nativeImage.createEmpty();
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 630,
    minWidth: 1120,
    minHeight: 630,
    show: false,
    title: 'DS5 Bridge',
    frame: false,
    resizable: true,
    transparent: false,
    backgroundColor: '#0b1017',
    skipTaskbar: false,
    icon: createRuntimeIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(
      webContents === window.webContents
      && (permission === 'media' || permission === 'speaker-selection')
    );
  });

  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('will-move', () => bridgeService?.pausePollingFor(1200));
  window.on('move', () => bridgeService?.pausePollingFor(700));

  window.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  return window;
}

function sendWindowMaximizedState(): void {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window:maximizedChanged', mainWindow.isMaximized());
}

function showWindowCentered(): void {
  if (!mainWindow) {
    return;
  }

  const display = screen.getPrimaryDisplay();
  const windowBounds = mainWindow.getBounds();
  const x = Math.round(display.workArea.x + (display.workArea.width - windowBounds.width) / 2);
  const y = Math.round(display.workArea.y + (display.workArea.height - windowBounds.height) / 2);

  mainWindow.setPosition(x, y, false);
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function powerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function writeBasicWindowsShortcut(details: {
  shortcutPath: string;
  target: string;
  args: string;
  cwd: string;
  description: string;
  icon: string;
  iconIndex: number;
}): boolean {
  const script = `
$ErrorActionPreference = 'Stop'
$shortcutPath = ${powerShellString(details.shortcutPath)}
$target = ${powerShellString(details.target)}
$arguments = ${powerShellString(details.args)}
$cwd = ${powerShellString(details.cwd)}
$description = ${powerShellString(details.description)}
$icon = ${powerShellString(details.icon)}
$iconIndex = ${details.iconIndex}
$appUserModelId = ${powerShellString(WINDOWS_APP_USER_MODEL_ID)}
$toastActivatorClsid = ${powerShellString(WINDOWS_TOAST_ACTIVATOR_CLSID)}
$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Ds5BridgeShortcut {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class ShellLink { }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
  public interface IPersistFile {
    void GetClassID(out Guid pClassID);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
    void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
  }

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
    public PropertyKey(Guid fmtid, uint pid) { this.fmtid = fmtid; this.pid = pid; }
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr p;
    public int p2;

    public static PropVariant FromString(string value) {
      return new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(value) };
    }

    public static PropVariant FromGuid(Guid value) {
      IntPtr pointer = Marshal.AllocCoTaskMem(16);
      Marshal.StructureToPtr(value, pointer, false);
      return new PropVariant { vt = 72, p = pointer };
    }
  }

  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PropertyKey pkey);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant pv);
    [PreserveSig] int Commit();
  }

  public static class ShortcutWriter {
    [DllImport("ole32.dll", PreserveSig = true)]
    private static extern int PropVariantClear(ref PropVariant pvar);

    public static void Write(
      string shortcutPath,
      string target,
      string args,
      string cwd,
      string description,
      string icon,
      int iconIndex,
      string appUserModelId,
      string toastActivatorClsid
    ) {
      var link = (IShellLinkW)new ShellLink();
      link.SetPath(target);
      if (!String.IsNullOrEmpty(args)) link.SetArguments(args);
      if (!String.IsNullOrEmpty(cwd)) link.SetWorkingDirectory(cwd);
      if (!String.IsNullOrEmpty(description)) link.SetDescription(description);
      if (!String.IsNullOrEmpty(icon)) link.SetIconLocation(icon, iconIndex);

      var store = (IPropertyStore)link;
      var appKey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
      var appValue = PropVariant.FromString(appUserModelId);
      int hr = store.SetValue(ref appKey, ref appValue);
      PropVariantClear(ref appValue);
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);

      if (!String.IsNullOrEmpty(toastActivatorClsid)) {
        var clsidKey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 26);
        var clsidValue = PropVariant.FromGuid(new Guid(toastActivatorClsid));
        hr = store.SetValue(ref clsidKey, ref clsidValue);
        PropVariantClear(ref clsidValue);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      }

      hr = store.Commit();
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      ((IPersistFile)link).Save(shortcutPath, true);
    }
  }
}
'@
Add-Type -TypeDefinition $source
[Ds5BridgeShortcut.ShortcutWriter]::Write(
  $shortcutPath,
  $target,
  $arguments,
  $cwd,
  $description,
  $icon,
  $iconIndex,
  $appUserModelId,
  $toastActivatorClsid
)
$registryPath = "HKCU:\\Software\\Classes\\AppUserModelId\\$appUserModelId"
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name 'DisplayName' -Value $description -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name 'IconUri' -Value $icon -PropertyType String -Force | Out-Null
`;
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.status !== 0) {
    console.warn('Failed to create Windows notification shortcut:', result.stderr.trim() || result.error);
    return false;
  }
  return fs.existsSync(details.shortcutPath);
}

function updateWindowsAppIconRegistry(iconPath: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$registryPath = "HKCU:\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_USER_MODEL_ID}"
New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name 'DisplayName' -Value ${powerShellString(`${APP_NAME} companion`)} -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name 'IconUri' -Value ${powerShellString(iconPath)} -PropertyType String -Force | Out-Null
`;
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], {
    encoding: 'utf8',
    windowsHide: true
  });
}

function ensureWindowsNotificationShortcut(): void {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const programsPath = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const appPath = app.getAppPath();
    const appUserModelId = windowsAppUserModelId();
    const shortcutPath = path.join(programsPath, `${APP_NAME}.lnk`);
    const shortcutDetails = {
      shortcutPath,
      target: process.execPath,
      args: process.defaultApp ? `"${appPath}"` : '',
      cwd: process.defaultApp ? appPath : path.dirname(process.execPath),
      description: `${APP_NAME} companion`,
      icon: appResourcePath(APP_ICON_ICO),
      iconIndex: 0
    };

    updateWindowsAppIconRegistry(shortcutDetails.icon);
    fs.mkdirSync(programsPath, { recursive: true });
    const created = shell.writeShortcutLink(shortcutPath, 'replace', {
      target: shortcutDetails.target,
      args: shortcutDetails.args,
      cwd: shortcutDetails.cwd,
      description: shortcutDetails.description,
      icon: shortcutDetails.icon,
      iconIndex: shortcutDetails.iconIndex,
      appUserModelId,
      toastActivatorClsid: WINDOWS_TOAST_ACTIVATOR_CLSID
    });
    if (!created && !writeBasicWindowsShortcut(shortcutDetails)) {
      console.warn('Windows notification shortcut was not created.');
    }
  } catch {
    // Windows toasts may be unavailable, but shortcut setup should not block
    // the tray app from starting.
  }
}

function showBridgeNotification(toast: BridgeToast): void {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: toast.title,
      body: toast.body,
      icon: createRuntimeIcon(),
      silent: false
    });
    notification.once('failed', (_event, error) => {
      console.warn('Windows notification failed:', error);
    });
    notification.show();
  }
}

function registerIpc(service: BridgeService): void {
  ipcMain.handle('bridge:getStatus', () => service.getSnapshot());
  ipcMain.handle('bridge:listDevices', () => service.listDevices());
  ipcMain.handle('bridge:applyPreset', (_event, value: BridgePresetId) => service.applyPreset(value));
  ipcMain.handle('bridge:setHapticsGain', (_event, value: number) => service.setHapticsGain(value));
  ipcMain.handle('bridge:setHapticsEnabled', (_event, value: boolean) => service.setHapticsEnabled(value));
  ipcMain.handle('bridge:setHapticsBufferLength', (_event, value: number) => service.setHapticsBufferLength(value));
  ipcMain.handle('bridge:setClassicRumbleGain', (_event, value: number) => service.setClassicRumbleGain(value));
  ipcMain.handle('bridge:setClassicRumbleEnabled', (_event, value: boolean) => service.setClassicRumbleEnabled(value));
  ipcMain.handle('bridge:setTriggerEffectIntensity', (_event, value: number) => (
    service.setTriggerEffectIntensity(value)
  ));
  ipcMain.handle('bridge:setTriggerTestMode', (_event, value: TriggerTestMode) => service.setTriggerTestMode(value));
  ipcMain.handle('bridge:setAdaptiveTriggersEnabled', (_event, value: boolean) => (
    service.setAdaptiveTriggersEnabled(value)
  ));
  ipcMain.handle('bridge:setSpeakerVolume', (_event, value: number) => service.setSpeakerVolume(value));
  ipcMain.handle('bridge:setSpeakerEnabled', (_event, value: boolean) => service.setSpeakerEnabled(value));
  ipcMain.handle('bridge:setMicVolume', (_event, value: number) => service.setMicVolume(value));
  ipcMain.handle('bridge:setMicMute', (_event, value: boolean) => service.setMicMute(value));
  ipcMain.handle('bridge:setHostEncodedAudioEnabled', (_event, value: boolean) => (
    service.setHostEncodedAudioEnabled(value)
  ));
  ipcMain.handle('bridge:setDuplexMicEnabled', (_event, value: boolean) => service.setDuplexMicEnabled(value));
  ipcMain.handle('bridge:setLightbarColor', (_event, color: string, brightness: number) => (
    service.setLightbarColor(color, brightness)
  ));
  ipcMain.handle('bridge:setLightbarEnabled', (_event, value: boolean) => service.setLightbarEnabled(value));
  ipcMain.handle('bridge:setLightbarOverrideEnabled', (_event, value: boolean) => (
    service.setLightbarOverrideEnabled(value)
  ));
  ipcMain.handle('bridge:setMuteButtonAction', (
    _event,
    mode: MuteButtonMode,
    usage: number,
    modifiers: number,
    behavior: MuteKeyboardBehavior
  ) => (
    service.setMuteButtonAction(mode, usage, modifiers, behavior)
  ));
  ipcMain.handle('bridge:setLedEnabled', (_event, value: boolean) => service.setLedEnabled(value));
  ipcMain.handle('bridge:setIdleDisconnectEnabled', (_event, value: boolean) => service.setIdleDisconnectEnabled(value));
  ipcMain.handle('bridge:setIdleDisconnectTimeoutMinutes', (_event, value: number) => (
    service.setIdleDisconnectTimeoutMinutes(value)
  ));
  ipcMain.handle('bridge:setUsbSuspendDisconnectEnabled', (_event, value: boolean) => (
    service.setUsbSuspendDisconnectEnabled(value)
  ));
  ipcMain.handle('bridge:setSleepKeybindEnabled', (_event, value: boolean) => (
    service.setSleepKeybindEnabled(value)
  ));
  ipcMain.handle('bridge:setSpeakerVolumeShortcutEnabled', (_event, value: boolean) => (
    service.setSpeakerVolumeShortcutEnabled(value)
  ));
  ipcMain.handle('bridge:setControllerPowerSavingEnabled', (_event, value: boolean) => (
    service.setControllerPowerSavingEnabled(value)
  ));
  ipcMain.handle('bridge:setPollingRateMode', (_event, value: PollingRateMode) => (
    service.setPollingRateMode(value)
  ));
  ipcMain.handle('bridge:sleepController', () => service.sleepController());
  ipcMain.handle('bridge:setNotifyControllerConnection', (_event, value: boolean) => (
    service.setNotifyControllerConnection(value)
  ));
  ipcMain.handle('bridge:setNotifyLowBattery', (_event, value: boolean) => (
    service.setNotifyLowBattery(value)
  ));
  ipcMain.handle('bridge:testNotification', () => service.testNotification());
  ipcMain.handle('bridge:testHaptics', () => service.testHaptics());
  ipcMain.handle('bridge:testSpeaker', () => service.testSpeaker());
  ipcMain.handle('bridge:testClassicRumble', () => service.testClassicRumble());
  ipcMain.handle('bridge:testAdaptiveTriggers', (_event, value?: TriggerTestMode, target?: TriggerTestTarget) => (
    service.testAdaptiveTriggers(value, target)
  ));
  ipcMain.handle('bridge:resetAdaptiveTriggers', () => service.resetAdaptiveTriggers());
  ipcMain.handle('bridge:restoreDefaults', () => service.restoreDefaults());
  ipcMain.handle('bridge:setButtonRemap', (_event, buttonId: RemapButtonId, targetId: RemapButtonId) => (
    service.setButtonRemap(buttonId, targetId)
  ));
  ipcMain.handle('bridge:selectButtonRemappingProfile', (_event, profileId: string) => (
    service.selectButtonRemappingProfile(profileId)
  ));
  ipcMain.handle('bridge:saveButtonRemappingProfile', (_event, name?: string) => (
    service.saveButtonRemappingProfile(name)
  ));
  ipcMain.handle('bridge:updateButtonRemappingProfile', (_event, profileId: string) => (
    service.updateButtonRemappingProfile(profileId)
  ));
  ipcMain.handle('bridge:renameButtonRemappingProfile', (_event, profileId: string, name: string) => (
    service.renameButtonRemappingProfile(profileId, name)
  ));
  ipcMain.handle('bridge:deleteButtonRemappingProfile', (_event, profileId: string) => (
    service.deleteButtonRemappingProfile(profileId)
  ));
  ipcMain.handle('bridge:restoreButtonRemappingDefaults', () => service.restoreButtonRemappingDefaults());
  ipcMain.handle('bridge:getDiagnostics', () => service.getSnapshot().diagnostics);
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle('window:isMaximized', () => Boolean(mainWindow?.isMaximized()));
  ipcMain.handle('window:hide', () => mainWindow?.hide());
  ipcMain.handle('window:openExternal', (_event, url: string) => {
    if (!/^https:\/\/ko-fi\.com\/sundaymoments\/?$/i.test(url)) {
      return;
    }
    void shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  ensureWindowsNotificationShortcut();
  Menu.setApplicationMenu(null);
  bridgeService = new BridgeService(new SettingsStore(app.getPath('userData')));
  registerIpc(bridgeService);

  mainWindow = createWindow();
  mainWindow.on('maximize', sendWindowMaximizedState);
  mainWindow.on('unmaximize', sendWindowMaximizedState);
  mainWindow.once('ready-to-show', showWindowCentered);

  tray = new Tray(await createTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${APP_NAME}`, click: showWindowCentered },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', showWindowCentered);

  bridgeService.on('snapshot', (snapshot) => {
    mainWindow?.webContents.send('bridge:snapshot', snapshot);
  });
  bridgeService.on('toast', (toast) => {
    showBridgeNotification(toast);
  });
  bridgeService.start();
});

app.on('window-all-closed', () => {
  // Keep the companion alive as a tray app after the popover is closed.
});

app.on('before-quit', (event) => {
  if (shutdownComplete) {
    return;
  }
  event.preventDefault();
  isQuitting = true;
  const service = bridgeService;
  bridgeService = null;
  void (async () => {
    try {
      await service?.stop();
    } finally {
      shutdownComplete = true;
      app.quit();
    }
  })();
});
