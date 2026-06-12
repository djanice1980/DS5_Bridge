# Development

This page covers local builds for the Pico 2 W firmware and the Windows
companion app.

## Prerequisites

Install these tools before building:

- Git with submodule support.
- CMake and Ninja.
- Arm GNU toolchain for embedded builds, such as `gcc-arm-none-eabi`.
- Raspberry Pi Pico SDK `2.2.0`.
- Node.js `22`.
- .NET SDK `9.0`.
- Windows, for building and running the companion app.

The firmware CI currently builds with Pico SDK `2.2.0` and TinyUSB `0.20.0`.
For the closest local match, use the same versions.

For debug presets and runtime diagnostic flags, see `docs/diagnostics.md`.

## Clone

Initialize the bundled third-party source submodules:

```powershell
git submodule update --init --recursive
```

## Firmware

Build the companion firmware with the Pico SDK toolchain:

```powershell
cmake -S . -B build/companion -G Ninja `
  -DCMAKE_BUILD_TYPE=Release `
  -DPICO_SDK_PATH=/path/to/pico-sdk `
  -DENABLE_COMPANION=ON
cmake --build build/companion --target ds5-bridge
```

The resulting firmware is:

```text
build/companion/ds5-bridge.uf2
```

## Companion App

Install dependencies from the lockfile and run the checks:

```powershell
cd companion
npm ci
npm run typecheck
npm test
```

The companion app also keeps a repo-local `.npmrc` that blocks git dependencies
and avoids newly published packages younger than three days.

For a stricter supply-chain check, install without lifecycle scripts and then
explicitly rebuild the packages that are expected to need native or tool binary
setup:

```powershell
npm ci --ignore-scripts
npm rebuild electron esbuild node-hid electron-winstaller --ignore-scripts=false
npm run build:audio-helper
npm run typecheck
npm test
```

Build the companion app:

```powershell
npm run build
```

`npm run build` also publishes the audio helper from:

```text
companion/native/AudioHelper
```

The helper output is written to:

```text
companion/native/AudioHelper/bin/publish/win-x64
```

For local development:

```powershell
npm run dev
```

## Packaging

Build an unpacked Windows package:

```powershell
npm run package:win
```

Build the Windows installer:

```powershell
npm run installer:win
```

The installer build includes the published audio helper as an Electron
extra resource.

## Release Candidate Bundle

Create a timestamped release candidate folder in Documents with the firmware
UF2, Windows installer, portable companion folder, portable ZIP, and a manifest:

```powershell
.\tools\create-release-candidate.ps1
```

Useful options:

```powershell
.\tools\create-release-candidate.ps1 -Label rc1
.\tools\create-release-candidate.ps1 -OutputRoot "$env:USERPROFILE\Desktop"
.\tools\create-release-candidate.ps1 -SkipBuild
.\tools\create-release-candidate.ps1 -NoZip
```

## Audio Helper Runtime

The audio helper is published as a self-contained Windows x64 build so end
users do not need to install a separate .NET runtime. Developer machines still
need the .NET SDK to build or publish the helper locally. The helper is used for
audio session discovery, audio-reactive haptics mirroring, default endpoint
setup, speaker test playback, mic keepalive, media metadata, game discovery, and
icon extraction.

Enable helper diagnostics while developing companion-side audio integrations:

```powershell
$env:DS5_BRIDGE_AUDIO_HELPER_DIAGNOSTICS="1"
cd companion
npm run dev
```

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
| `companion/native/AudioHelper/` | Native audio helper source. |
| `.github/workflows` | CI and release builds. |
