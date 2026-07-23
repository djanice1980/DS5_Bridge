# DS5 Bridge — Linux (CachyOS) port

<p align="center">
  <img src="assets/controllers/ds5-bridge_mark.png" width="180" alt="DS5 Bridge mark">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg" alt="License: AGPL-3.0-only"></a>
  <a href="https://github.com/djanice1980/DS5_Bridge/releases/latest"><img src="https://img.shields.io/github/v/release/djanice1980/DS5_Bridge?label=release&include_prereleases" alt="Latest release"></a>
  <br>
  <img src="https://img.shields.io/badge/platform-Linux%20companion%20app%20%7C%20Pico%202%20W%20firmware-287cff" alt="Platform: Linux companion app and Raspberry Pi Pico 2 W firmware">
</p>

> ### This is the Linux/CachyOS port of DS5 Bridge
> The original DS5 Bridge — the Windows companion app and the Pico 2 W firmware — was created
> by **[SundayMoments](https://github.com/SundayMoments/DS5_Bridge)**. This fork adds native
> Linux support (PipeWire audio + audio-driven haptics, libusb device access, `uinput` chord
> injection, and CachyOS/Arch packaging), including BC-250 Steam machines.
>
> - **Linux version support / issues → here:** [github.com/djanice1980/DS5_Bridge](https://github.com/djanice1980/DS5_Bridge/issues)
> - **Windows version → the upstream project:** [github.com/SundayMoments/DS5_Bridge](https://github.com/SundayMoments/DS5_Bridge)
>
> Please don't file Linux-port issues on the upstream repo, and don't ask SundayMoments for
> support on this port — they didn't build it.

DS5 Bridge lets you use a real Sony DualSense or DualSense Edge controller wirelessly through
a Raspberry Pi Pico 2 W. The controller pairs to the Pico over Bluetooth, and the Pico plugs
into your PC over USB.

The companion app gives you a clean place to adjust audio, haptics, trigger strength,
lighting, button remaps, shortcuts, firmware tools, and other controller behavior without
rebuilding firmware.

## Quick Start (Linux / CachyOS)

The complete walkthrough — dependencies, install, the WirePlumber audio rule that exposes the
controller's speaker + haptic channels, and testing — is in
**[docs/cachyos-install.md](docs/cachyos-install.md)**. In short:

1. Download the firmware `.uf2` and the Linux companion — `.pacman` for Arch/CachyOS (or the
   `.AppImage`) — from [Releases](https://github.com/djanice1980/DS5_Bridge/releases/latest).
2. With the Pico 2 W unplugged, hold `BOOTSEL`, connect it, and copy the `.uf2` onto the Pico
   drive that appears.
3. Put the DualSense into pairing mode by holding `Create` and `PS` until the lightbar rapidly
   blinks blue, then **single-click the Pico's `BOOTSEL` button** to open the pairing window (the
   Pico's LED blinks). The controller pairs to the Pico — not directly to your PC. See
   [Syncing a Controller](#syncing-a-controller).
4. Install the companion (`sudo pacman -U DS5-Bridge-Companion-*.pacman`) and open DS5 Bridge.
   The Overview page should show the connected bridge and firmware version.

Once the controller connects to the Pico, Linux sees it as a normal DualSense-compatible USB
controller.

## Syncing a Controller

Pairing a controller to the bridge — "syncing" — uses the **`BOOTSEL` button** on the Pico 2 W
board.

**Sync a new controller:**

1. Put the DualSense into pairing mode: hold **`Create`** + **`PS`** until the lightbar rapidly
   blinks blue.
2. **Single-click** the Pico's `BOOTSEL` button. Its onboard LED blinks while a **60-second
   pairing window** is open.
3. The controller pairs to the Pico (not to your PC). The LED stops blinking once it connects.

**You only sync each controller once.** The bridge remembers paired controllers and reconnects
them automatically whenever you power them on — no button press needed. Only a brand-new
controller needs the sync button. And because the bridge advertises for new controllers *only*
during the sync window, a stray controller in pairing mode nearby can't latch onto your dongle on
its own.

**Waking a sleeping PC.** Connecting a controller can wake the PC from sleep — an already-paired
controller as it reconnects, or a new one as soon as its Bluetooth link comes up during a sync. On
Windows, enable the bridge's *"Allow this device to wake the computer"* power setting; on Linux the
companion sets USB wakeup up for you.

| `BOOTSEL` gesture | Action |
| --- | --- |
| **Single-click** | Open a 60-second window to sync a new controller (LED blinks). |
| **Triple-click** | Reboot the Pico into firmware-flashing (`BOOTSEL`) mode. |

*The sync button requires firmware **1.6.16** or newer; earlier firmware pairs any controller
automatically without a button press.*

## Features

- Use a DualSense or DualSense Edge wirelessly through a Pico 2 W.
- Sync a new controller on demand with a single button press; connecting one can wake a sleeping PC.
- Use the controller speaker, headset jack, microphone, and audio-driven haptics.
- Tune audio, haptics, adaptive triggers, and lighting from the app.
- Use Audio Haptics to turn system or app audio into controller feedback.
- Save controller setups as profiles.
- Remap buttons and assign chord shortcuts.
- Switch the host persona between DualSense, DualShock 4, and Xbox modes.
- See Bluetooth signal quality at a glance.
- Mount, flash, or nuke Pico firmware from Bridge Settings.

## Companion App Tour

The companion app is where you check the bridge, adjust the controller, and save the setup you
actually want to play with.

### Overview

See connection health, firmware version, battery, audio route, Bluetooth signal quality, host
persona, and the settings most likely to matter during play.

<p align="center">
  <img src="assets/readme/app-overview.png" width="680" alt="Overview dashboard in the DS5 Bridge companion app">
</p>

### Audio

Control the controller speaker, headphone-jack route, microphone level, speaker gain, and
buffer length.

<p align="center">
  <img src="assets/readme/app-audio.png" width="680" alt="Audio controls in the DS5 Bridge companion app">
</p>

### Haptics

Adjust HD haptics, classic rumble, feedback boost, and audio buffer length, then test the feel
before opening a game.

<p align="center">
  <img src="assets/readme/app-haptics.png" width="680" alt="Haptics and rumble controls in the DS5 Bridge companion app">
</p>

### Audio Haptics

Turn system audio or an app session into controller haptic feedback.

<p align="center">
  <img src="assets/readme/app-audio-haptics.png" width="680" alt="Audio Haptics controls in the DS5 Bridge companion app">
</p>

### Triggers

Set adaptive trigger strength, try effects, or open Trigger Lab for per-trigger profiles.

<p align="center">
  <img src="assets/readme/app-triggers.png" width="680" alt="Adaptive trigger controls in the DS5 Bridge companion app">
</p>

### Trigger Lab

Build and preview adaptive trigger effects before applying them to the controller.

<p align="center">
  <img src="assets/readme/app-trigger-lab.png" width="680" alt="Trigger Lab controls in the DS5 Bridge companion app">
</p>

### Lighting

Choose lightbar brightness and color, or let the app manage lighting behavior for you.

<p align="center">
  <img src="assets/readme/app-lighting.png" width="680" alt="Lighting controls in the DS5 Bridge companion app">
</p>

### Button Remapping

Change what each controller button does, then save the remap when you are happy with it.

<p align="center">
  <img src="assets/readme/app-button-remapping.png" width="680" alt="Button remapping controls in the DS5 Bridge companion app">
</p>

### System

Manage profiles, mute button behavior, polling rate, host persona, diagnostics, and device
repair.

<p align="center">
  <img src="assets/readme/app-system.png" width="680" alt="System controls in the DS5 Bridge companion app">
</p>

### Chords

Create reusable keyboard, media, and controller actions, then assign them to starter chords.

<p align="center">
  <img src="assets/readme/app-chords.png" width="680" alt="Chord assignment controls in the DS5 Bridge companion app">
</p>

### Bridge Settings

Set theme, UI scale, tray and startup behavior, firmware maintenance, power saving, LEDs,
shortcuts, idle disconnect, and PC sleep disconnect.

<p align="center">
  <img src="assets/readme/app-bridge-settings.png" width="680" alt="Bridge Settings dialog in the DS5 Bridge companion app">
</p>

## Moving a controller between bridges

A DualSense remembers exactly **one** host: pairing it to a different bridge
makes it forget the previous one (same as moving between PS5 consoles). A
plain `PS` press always reconnects to the **last** bridge it paired with — so
moving a controller back is always a fresh pairing, never just a PS press:

1. Single-click the target Pico's `BOOTSEL` button (60 s pairing window,
   onboard LED blinks).
2. Hold `Create` + `PS` on the controller until the lightbar rapidly blinks.

The bridge clears its own stale bond automatically during this (firmware
1.6.13+), and with profile bindings (companion 1.6.26+) the controller's
settings follow it to the new bridge on their own.

## Known behavior: controller bridged AND cabled to the PC at the same time

A DualSense that is connected to the bridge over Bluetooth treats a USB cable
plugged in afterwards as **charge-only**: Windows enumerates audio endpoints
for the wired controller, but the controller never activates them (its data
session stays on Bluetooth), so the wired speaker/mic stay silent. This is the
controller's own transport policy, not a bridge fault.

If the bridge is then unplugged while the cable is still in, the controller
loses its Bluetooth host, blinks orange, powers off — and **will not power on
again until the USB cable is removed**. Unplug the cable, press `PS`, and it
reconnects to the bridge normally.

To use a controller wired-only: disconnect it from the bridge first (or power
it off), then plug in the USB cable from a fresh start.

## Troubleshooting (Linux)

- Use the companion app and firmware from the same release when possible.
- For first-time flashing, hold `BOOTSEL` before plugging the Pico 2 W into the PC. The Pico
  should appear as a USB drive.
- Pair the controller to the Pico, not your PC. Hold `Create` and `PS` until the lightbar
  rapidly blinks blue, then single-click the Pico's `BOOTSEL` button to open the pairing window
  (firmware 1.6.16+). Already-paired controllers reconnect on their own — see
  [Syncing a Controller](#syncing-a-controller).
- If the bridge isn't detected, use a direct USB port and a data-capable micro-USB cable
  (not a charge-only cable), then plug the bridge in *before* powering the controller on.
- If the controller speaker is quiet or the grips don't buzz, the ALSA UCM profile is likely
  hiding the 4-channel device. The companion ships a WirePlumber rule that fixes this; see
  [docs/cachyos-install.md](docs/cachyos-install.md).
- Adaptive triggers hold through audio as of firmware **1.6.12**. A one-shot trigger *test* still
  eases off while audio plays (the controller decays a single command), but in games — which
  re-assert the effect every frame — the triggers stay firm. If audio ever stutters, ease the
  **Interleave** page toward *Smooth*.
- Battery level may be inaccurate while the controller is charging.

### Debug mode

If something misbehaves and you want to gather diagnostics (or you've been asked to), launch the
companion from a terminal with the `DS5_DEBUG` environment variable set:

```bash
DS5_DEBUG=1 ds5-bridge                            # pacman install
DS5_DEBUG=1 ./DS5-Bridge-Companion-*.AppImage     # AppImage
```

This turns on two things — both completely off without the variable, so normal use is unaffected:

- **Developer Tools.** A DevTools window opens next to the app. DS5 Bridge is built on Electron, so
  this is the same DevTools you'd find in a web browser; its **Console** tab can read the app's live
  state, e.g. `window.bridge.getStatus().then(s => console.log(s.settings))`.
- **Extra terminal logging.** The app prints diagnostic lines to the terminal it was launched from
  (for example, which settings and controller profiles it loaded on startup).

Copy whatever it prints — or a DevTools console result — into your bug report.

## Requirements

- Raspberry Pi Pico 2 W.
- Sony DualSense or DualSense Edge controller.
- Data-capable USB cable with a micro-USB end for the Pico 2 W.
- Linux: CachyOS/Arch with PipeWire + WirePlumber, including BC-250 Steam machines. See
  [docs/cachyos-install.md](docs/cachyos-install.md). *(Windows users: use the
  [upstream project](https://github.com/SundayMoments/DS5_Bridge).)*

## For Developers

See [docs/development.md](docs/development.md) for build requirements, firmware build commands,
companion app setup, audio helper notes, and packaging. Linux-port internals (PipeWire audio,
libusb transport, `uinput`, packaging) are covered in [docs/linux-port.md](docs/linux-port.md).

**Backporting to the Windows / upstream build:**
[docs/upstream-backport-notes.md](docs/upstream-backport-notes.md) is a per-fix technical changelog of
everything this port changed — firmware *and* companion — each item with its symptom, root cause, exact
files/functions, and a flag for whether it applies to Windows. Written so the
[upstream author](https://github.com/SundayMoments/DS5_Bridge) can adopt applicable fixes without
reverse-engineering the diffs. The three firmware fixes (adaptive-triggers-die-under-audio, the fair-interleave
output scheduler, and the stale-link-key / dongle-switch fix) apply to the Windows build directly.

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
| `companion/native/AudioHelper/` | Audio helper used by the companion app. Windows (WASAPI/WinUSB) and Linux (`Linux/` — PipeWire, libusb, `uinput`) backends. |
| `.github/workflows` | CI and release builds. |

## Credits &amp; License

This repository is a **Linux port** of
[**SundayMoments/DS5_Bridge**](https://github.com/SundayMoments/DS5_Bridge) — the original
Windows companion app and Pico 2 W firmware. All credit for the original project goes to
SundayMoments. This fork adds the Linux companion backends and CachyOS/Arch packaging.

Distributed under AGPL-3.0-only. See [LICENSE](LICENSE).

SundayMoments' DS5 Bridge is itself derived from
[awalol/DS5Dongle](https://github.com/awalol/DS5Dongle), credited in [NOTICE](NOTICE).
Third-party submodules and package dependencies retain their own license terms. DualSense
controller overlay artwork is adapted from
[AL2009man/Gamepad-Asset-Pack](https://github.com/AL2009man/Gamepad-Asset-Pack) and credited
in [NOTICE](NOTICE).

## References

- [awalol/DS5Dongle](https://github.com/awalol/DS5Dongle), the foundation for the original project.
- [rafaelvaloto/Pico_W-Dualsense](https://github.com/rafaelvaloto/Pico_W-Dualsense) for project inspiration.
- [egormanga/SAxense](https://github.com/egormanga/SAxense) for Bluetooth haptics proof-of-concept work.
- [Sony DualSense controller documentation](https://controllers.fandom.com/wiki/Sony_DualSense) for report structure notes.
- [Paliverse/DualSenseX](https://github.com/Paliverse/DualSenseX) for speaker report packet references.
- Alex Smith of The Cynic Project for the speaker test sound, "Crystal Cave" (`song18`).
