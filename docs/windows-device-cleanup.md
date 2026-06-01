# Windows Device Cleanup After USB Descriptor Testing

Windows does not treat every flashed DS5 Bridge firmware image as an update to
the same controller. If the USB identity changes, Windows creates a new PnP
instance and keeps the old one cached.

Common identity-changing fields in this project are:

- USB PID: `0x0CE6` for DualSense, `0x0DF2` for DualSense Edge.
- USB serial behavior: `iSerialNumber = 0x03` versus `iSerialNumber = 0x00`.
- Interface layout: standard firmware, companion firmware, and any
  temporary diagnostic layouts.
- Audio topology: no audio, speaker-only, speaker plus mic, or different audio
  interface ordering.
- HID report descriptor shape and length.
- Product string: for example `DualSense Wireless Controller`,
  `DualSense Edge Wireless Controller`, or `Wireless Controller`.
- USB port/location when no serial number is exposed.

Audio devices are cached separately. Windows creates MMDevice endpoint records
such as `Speakers (DualSense Wireless Controller)` and `Headset Microphone
(DualSense Wireless Controller)`. When stale endpoints with the same friendly
name already exist, Windows can add duplicate suffixes like `2-`.

## Current Canonical Firmware Identity

The current firmware intentionally exposes no USB serial number:

- `iSerialNumber = 0x00`.
- Standard firmware uses Sony VID `0x054C`, PID `0x0CE6`, and product
  `DualSense Wireless Controller`.
- DualSense Edge firmware uses Sony VID `0x054C`, PID `0x0DF2`, and product
  `DualSense Edge Wireless Controller`.
- Audio interfaces come first, followed by the game-facing HID interface.
- Companion firmware appends the companion vendor HID interface and bridge
  keyboard HID interface after the game-facing HID interface.

Avoid changing those fields during normal firmware work unless the task is
explicit USB descriptor identity testing.

## Safe Cleanup Workflow

1. Unplug the Pico bridge.
2. Disconnect or power off the controller if it was paired directly to Windows
   over Bluetooth.
3. Close Steam, games, the companion app, Device Manager windows, and any tools
   that may hold HID/audio handles.
4. Open PowerShell as Administrator.
5. From the repo root, run a dry-run inventory:

   ```powershell
   .\tools\windows\clean-ds5bridge-devices.ps1
   ```

6. Review the matched instances.
7. Apply removal:

   ```powershell
   .\tools\windows\clean-ds5bridge-devices.ps1 -Apply
   ```

8. Reconnect the bridge and wait for Windows to rebuild one clean live stack.

Use `-IncludePresent` only when the bridge and direct controller connection are
unplugged and you intentionally want to remove entries that Windows reports as
currently OK.

Use `-IncludeBluetooth` only when you also want to remove direct DualSense
Bluetooth pairing records such as `BTHENUM\...`. That is separate from the Pico
USB bridge identity.

Use `-SkipAudioEndpoints` if you want to leave Windows audio endpoint records
alone while cleaning only the USB/HID stack.

## What The Script Targets

By default, the script lists or removes non-present instances matching:

- `VID_054C&PID_0CE6`.
- `VID_054C&PID_0DF2`.
- DualSense-named Windows audio endpoints.
- DS5 Bridge-named Windows audio endpoints and System devices.

It does not remove currently present `Status = OK` entries unless
`-IncludePresent` is supplied.

It does not remove direct Bluetooth pairing entries unless `-IncludeBluetooth`
is supplied.
