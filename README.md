# DS5 Bridge

<p align="center">
  <img src="assets/controllers/ds5-bridge_mark.png" width="180" alt="DS5 Bridge mark">
</p>

<p align="center">
  <a href="https://github.com/SundayMoments/DS5_Bridge/actions/workflows/build.yml"><img src="https://github.com/SundayMoments/DS5_Bridge/actions/workflows/build.yml/badge.svg" alt="Build firmware status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg" alt="License: AGPL-3.0-only"></a>
  <a href="https://github.com/SundayMoments/DS5_Bridge/releases/latest"><img src="https://img.shields.io/github/v/release/SundayMoments/DS5_Bridge?label=release" alt="Latest release"></a>
  <br>
  <img src="https://img.shields.io/badge/platform-Windows%20companion%20app%20%7C%20Pico%202%20W%20firmware-287cff" alt="Platform: Windows companion app and Raspberry Pi Pico 2 W firmware">
</p>

<p align="center">
  <a href="https://ko-fi.com/sundaymoments"><img src="assets/readme/support_me_on_kofi_blue.png" width="220" alt="Support me on Ko-fi"></a>
</p>

DS5 Bridge lets a Raspberry Pi Pico 2 W act as a wireless bridge for a real
Sony DualSense or DualSense Edge controller. The controller pairs to the Pico
over Bluetooth, and your PC sees a standard DualSense-compatible USB controller.

The release includes Pico firmware plus a Windows companion app for tuning
runtime settings without reflashing.

## Quick Start

1. Download the firmware UF2 and Windows companion installer from
   [Releases](https://github.com/SundayMoments/DS5_Bridge/releases/latest).
2. With the Pico 2 W unplugged, hold `BOOTSEL`, then connect it to your PC.
3. Copy the release `.uf2` firmware file to the mounted Pico storage device.
4. Put the DualSense controller into Bluetooth pairing mode.
5. Disconnect and reconnect the Pico 2 W, then wait for the controller to pair.
6. Install and open the companion app, then choose a preset or customize the
   controller.

The controller appears on your PC after the bridge connects to the DualSense
over Bluetooth.

## Features

- Wireless DualSense and DualSense Edge bridge through a Pico 2 W.
- Windows companion app with Overview, Audio, Haptics, Triggers, Lighting,
  Button Remapping, and System tabs.
- Runtime controls for haptics, rumble, adaptive triggers, controller audio,
  microphone level, lightbar behavior, shortcuts, notifications, and power
  saving.
- Button remapping with named profiles, unsaved-change tracking, save-as,
  rename, and delete controls.
- Host encoded audio support for smoother controller speaker and headphones
  output.

## Companion App Tour

The app talks to the bridge through a companion HID interface, leaving the
game-facing controller interface alone.

### Overview

Status cards, quick actions, quick sliders, and active setting summaries.

<p align="center">
  <img src="assets/readme/app-overview.png" width="680" alt="Overview dashboard in the DS5 Bridge companion app">
</p>

### Haptics

HD haptics, classic rumble strength, and feedback tests.

<p align="center">
  <img src="assets/readme/app-haptics.png" width="680" alt="Haptics and rumble controls in the DS5 Bridge companion app">
</p>

### Audio

Speaker/headphones output, microphone level, host encoding, and audio tests.

<p align="center">
  <img src="assets/readme/app-audio.png" width="680" alt="Audio controls in the DS5 Bridge companion app">
</p>

### Triggers

Adaptive trigger intensity, test effects, and reset controls.

<p align="center">
  <img src="assets/readme/app-triggers.png" width="680" alt="Adaptive trigger controls in the DS5 Bridge companion app">
</p>

### Lighting

Lightbar brightness, color, and app-controlled lighting behavior.

<p align="center">
  <img src="assets/readme/app-lighting.png" width="680" alt="Lighting controls in the DS5 Bridge companion app">
</p>

### Button Remapping

Visual button remapping with profiles and restore defaults.

<p align="center">
  <img src="assets/readme/app-button-remapping.png" width="680" alt="Button remapping controls in the DS5 Bridge companion app">
</p>

### System

Bridge status, diagnostics, presets, mute button behavior, shortcuts,
notifications, power saving, idle disconnect, PC sleep disconnect, and Pico LED
settings.

<p align="center">
  <img src="assets/readme/app-system.png" width="680" alt="System controls in the DS5 Bridge companion app">
</p>

## Troubleshooting

- If the speaker test tone plays through any speaker other than the controller,
  restart the companion app and try the speaker test again.
- Host Encoding is enabled by default because it helps keep controller audio
  smooth. Turning it off may cause audio stuttering, especially when headphones
  are plugged into the controller.
- Using headphones through the controller is not recommended unless the companion
  app is open with Host Encoding enabled.
- If the controller speaker sounds unnaturally loud, doubled, or distorted,
  reboot the PC, reopen DS5 Bridge, and run the speaker test again.
- Battery level is not reported accurately while the controller is charging.

## Requirements

- Raspberry Pi Pico 2 W.
- Sony DualSense controller.
- USB connection from the Pico 2 W to the PC.
- Windows for the companion app.

## For Developers

See [docs/development.md](docs/development.md) for local build requirements,
firmware build commands, companion app setup, host helper notes, and packaging
steps.

## Project Layout

| Path | Purpose |
| --- | --- |
| `src/main.cpp` | Pico startup, watchdog handling, USB task loop, and HID report bridge. |
| `src/bt.cpp` | Bluetooth inquiry, pairing, L2CAP HID channels, and report queueing. |
| `src/audio.cpp` | USB audio ingestion, haptic resampling, Opus speaker encoding, and audio packet assembly. |
| `src/companion.cpp` | Vendor HID companion protocol, status reports, command ACKs, and runtime setting dispatch. |
| `src/usb.cpp` | TinyUSB audio control callbacks and runtime settings fallback. |
| `src/usb_descriptors.c` | USB device, configuration, HID report, audio, and string descriptors. |
| `companion/` | Electron companion app source, protocol parser, HID service, assets, and UI. |
| `companion/native/HostAudioHelper/` | Windows host audio helper used by the companion app for host encoded audio. |
| `.github/workflows` | CI and release builds. |

## Development Notes

- The bridge presents itself to the host as a standard DualSense-compatible USB
  controller for compatibility.
- The companion app requires firmware built with the companion HID interface
  enabled.
- The project controls runtime behavior through the bridge and does not write
  controller-side profiles.
- Battery level is not reported accurately while the controller is charging.
- During development, Windows may keep stale controller or audio endpoint
  records after descriptor testing. Use
  [docs/windows-device-cleanup.md](docs/windows-device-cleanup.md) only if you
  run into device or endpoint issues while testing.

## License

This repository is distributed as AGPL-3.0-only. See [LICENSE](LICENSE).

This project is derived from [awalol/DS5Dongle](https://github.com/awalol/DS5Dongle),
which is credited in [NOTICE](NOTICE). Third-party submodules and package
dependencies retain their own license terms.

DualSense controller overlay artwork is adapted from
[AL2009man/Gamepad-Asset-Pack](https://github.com/AL2009man/Gamepad-Asset-Pack)
and credited in [NOTICE](NOTICE).

## References

- [awalol/DS5Dongle](https://github.com/awalol/DS5Dongle), the foundation for
  this project.
- [rafaelvaloto/Pico_W-Dualsense](https://github.com/rafaelvaloto/Pico_W-Dualsense)
  for project inspiration.
- [egormanga/SAxense](https://github.com/egormanga/SAxense) for Bluetooth
  haptics proof-of-concept work.
- [Sony DualSense controller documentation](https://controllers.fandom.com/wiki/Sony_DualSense)
  for report structure notes.
- [Paliverse/DualSenseX](https://github.com/Paliverse/DualSenseX) for speaker
  report packet references.
- Alex Smith of The Cynic Project for the speaker test sound, "Crystal Cave"
  (`song18`).

## Disclaimer

This project was vibecoded, so the occasional peculiarity may show through.
That said, it has been tested and edited with care.
