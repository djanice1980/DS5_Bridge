# Linux (CachyOS) companion port

Goal: run the DS5 Bridge companion app on Linux — first target CachyOS on an AMD
BC-250 Steam machine — with the same feature set as the Windows companion.
The Pico firmware is host-agnostic and unchanged.

## Architecture: one codebase, platform backends

| Layer | Windows today | Linux port |
| --- | --- | --- |
| Companion control transport | `AudioHelper.exe --companion-transport` (WinUSB, NDJSON over stdio) | Same helper verb + same NDJSON contract, implemented with libusb |
| Bridge discovery | node-hid enumeration (win32 prebuild) | node-hid hidraw prebuild + udev rules |
| System/app audio capture (Audio Haptics) | WASAPI loopback + process loopback | PipeWire capture (`pw-record`, per-node targeting) |
| Audio session list | WASAPI session enumeration | `pw-dump` node enumeration + .desktop/Steam icon resolution |
| Default output get/set (persona swaps) | IPolicyConfig COM | `wpctl` (WirePlumber) |
| Speaker/haptics test playback | NAudio render onto bridge endpoint | `pw-play`/PipeWire stream onto bridge sink |
| Mic keepalive | WASAPI capture hold | PipeWire capture hold on bridge source |
| Chord keyboard/media injection | `powershell.exe` + `user32!keybd_event` (Windows VK) | `/dev/uinput` virtual keyboard (evdev), persistent helper process |
| Media metadata | WinRT GlobalSystemMediaTransportControls | MPRIS over D-Bus |
| UF2 bootloader drive detection | Drive-letter scan A:–Z: for `INFO_UF2.TXT` | `/run/media/$USER/*`, `/media/*` scan (+ udisks2 mount assist) |
| Launch at startup | `app.setLoginItemSettings` | XDG autostart `.desktop` with `--start-in-tray` |
| Toast plumbing | AppUserModelID + Start-menu .lnk + registry | not needed — libnotify path already works |
| Emergency device repair | elevated PowerShell PnP cleanup | Windows-only concept; hidden on Linux |
| Packaging | electron-builder NSIS | electron-builder AppImage + pacman, udev rules, .desktop |

The .NET AudioHelper becomes multi-targeted: `net9.0-windows10.0.19041.0`
(existing code) and `net9.0` for Linux. Protocol framing, DSP, Opus
(Concentus), and the CLI surface are shared; OS integrations sit behind
platform interfaces. Electron main-process code gains small platform branches;
Windows behavior stays byte-identical.

## USB contract (from firmware descriptors, companion build)

Personas keep Sony/third-party identities: DualSense `054C:0CE6`, DualSense
Edge `054C:0DF2`, DualShock 4 `054C:09CC`, Xbox `1209:DB05`.

| Interface | Function | Linux driver |
| --- | --- | --- |
| 0–2 | UAC1 audio: 4-ch 48 kHz 16-bit OUT (ch0/1 speaker, ch2/3 haptics), 1-ch mic IN | `snd-usb-audio` → PipeWire sink/source |
| 3 | Gamepad HID (persona) | `hid-playstation` (DualSense/DS4), `xpad` for Xbox persona — needs a `new_id` udev rule because `1209:DB05` is not in xpad's table |
| 4 | Bridge Keyboard HID (firmware-typed mute-button key) | `hid-generic` |
| 5 | Vendor bridge (class 0xFF), control transfers GET `0xC1/0x31` / SET `0x41/0x32` (wIndex=5, 64-byte reports) + bulk OUT | libusb (udev uaccess rule) |
| 6 | Vendor PCM (48 kHz S16LE stereo; 784-byte bulk packets = 16-byte header + 192 frames) | libusb |

On Windows the vendor interfaces bind WinUSB via MS OS 2.0 descriptors; on
Linux they are driverless and libusb can claim them directly — device matching
is VID/PID + `bInterfaceClass 0xFF` + interface number instead of the Windows
device-interface GUIDs.

## udev rules (shipped as `60-ds5bridge.rules`)

- `uaccess` tag for hidraw + usb device nodes of all four persona VID/PIDs
  (companion HID interface access for node-hid, vendor interface access for the
  helper).
- `uaccess` for `/dev/uinput` (chord key injection), matching what
  `game-devices-udev` already does on CachyOS.
- `xpad new_id` handler for `1209:DB05` so the Xbox persona binds the kernel
  driver.

## Feature-parity notes

- Chord keyboard functions keep the same stored key names; the Linux helper
  maps them to evdev codes (`KEY_LEFTCTRL`, `KEY_F13`, media keys as
  `KEY_PLAYPAUSE` etc.). The "Win" modifier maps to `KEY_LEFTMETA`.
- Audio Haptics passthrough mode (firmware-side reactive haptics when the
  default output is already the bridge) works unchanged — the Linux helper
  reports the equivalent "default sink is the bridge" condition.
- Mic Listen in the renderer uses getUserMedia; Chromium on Linux enumerates
  PipeWire devices, label matching may need widening.
- Emergency Device Repair is not shown on Linux (no PnP device cache).
- Firmware Mount/Flash/Nuke works with the RP2350 UF2 mass-storage drive
  mounted by the desktop session/udisks.

## BC-250 / CachyOS specifics

- CachyOS ships PipeWire + WirePlumber; `pw-record`/`pw-play`/`pw-dump` come
  with `pipewire`, `wpctl` with `wireplumber`, `parec` fallback with
  `libpulse`.
- The companion is a tray app; in the gamescope Steam session there is no tray
  — run it in desktop mode for configuration, settings persist on the bridge.
- AppImage for zero-install use; pacman package (`ds5-bridge-companion`) as the
  native option, installing udev rules automatically.
