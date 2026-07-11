# DS5 Bridge companion on CachyOS (and other Arch-based systems)

The Linux companion has the same feature set as the Windows app: Overview,
Audio (speaker/headset/mic/duplex), Haptics and classic rumble, Audio Haptics
(system or per-app), adaptive Triggers and Trigger Lab, Lighting, Button
Remapping, System settings, Chords (keyboard, media, and controller actions),
profiles, presets, firmware Mount/Flash/Nuke, tray + start-at-login, and
notifications.

Two Windows-only items do not exist on Linux by design:

- **Emergency Device Repair** — it cleans the Windows PnP device cache, which
  Linux does not have. The button is hidden.
- The Windows toast-branding plumbing — Linux notifications work natively.

Tested target: CachyOS on an AMD BC-250. Everything below applies to any
Arch-based distro with PipeWire.

## 1. Install the app

Download from the project's GitHub Releases page:

- `DS5-Bridge-Companion-<version>-linux-x86_64.AppImage` — no install needed, or
- `DS5-Bridge-Companion-<version>-linux-x64.pacman` — native package.

AppImage:

```bash
chmod +x DS5-Bridge-Companion-*.AppImage
./DS5-Bridge-Companion-*.AppImage
```

pacman package:

```bash
sudo pacman -U DS5-Bridge-Companion-*-linux-x64.pacman
```

Runtime dependencies are part of every CachyOS install already: `pipewire`
(pw-record/pw-play/pw-dump), `wireplumber` (wpctl), `libusb`. Nothing else to
install.

## 2. Install the udev rules (required once)

The companion needs unprivileged access to the bridge's USB interfaces and to
`/dev/uinput` for chord key injection.

**pacman package: nothing to do.** The package installs the rules to
`/usr/lib/udev/rules.d/`, reloads udev, and enables `uinput` automatically
(and cleans up on uninstall). Just replug the bridge after installing.

**AppImage: one command.** Download `install-udev-rules.sh` from the same
release into the folder that holds the AppImage, then:

```bash
sudo bash install-udev-rules.sh
```

It installs the rules (extracting them from the AppImage if the standalone
`60-ds5bridge.rules` isn't next to it), reloads udev, and enables the
`uinput` module now and on boot. Then unplug and replug the bridge.

Manual fallback (what the script does): copy `60-ds5bridge.rules` to
`/etc/udev/rules.d/`, run `sudo udevadm control --reload && sudo udevadm
trigger`, and ensure `uinput` is loaded
(`echo uinput | sudo tee /etc/modules-load.d/ds5bridge-uinput.conf`).

## 3. Flash firmware and pair (same as Windows)

1. Hold `BOOTSEL` on the Pico 2 W, plug it in, and copy the release
   `DS5-Bridge-Firmware-v*.uf2` onto the `RP2350` drive that appears (your
   file manager mounts it; the companion's Bridge Settings > Firmware >
   Mount/Flash buttons work too and can mount it via udisks even without a
   file manager).
2. Pair the DualSense to the Pico: hold `Create` + `PS` until the lightbar
   blinks rapidly.
3. Launch DS5 Bridge — the Overview page should show the connected bridge.

## 4. Route game audio to the controller

The bridge shows up in PipeWire as a normal audio device (4-channel output +
microphone). Pick it as the output device in the desktop audio settings, or:

```bash
wpctl status          # find the "DualSense Wireless Controller" sink id
wpctl set-default <id>
```

The app's persona switch offers to move the default output to the bridge on
Linux exactly as it does on Windows.

## 5. BC-250 / Steam machine notes

- The companion is a desktop tray app. Configure it in desktop mode; every
  controller-side setting (haptics, triggers, remaps, chords, lighting…)
  lives on the bridge and keeps working in the gamescope Steam session with
  the app closed.
- Host-side features (Audio Haptics mirroring, chord keyboard/media actions,
  notifications) need the companion running. Enable **Launch at Startup** in
  Bridge Settings so it starts with the desktop session, or add
  `ds5-bridge --start-in-tray` to the session autostart.
- In the gamescope session the DualSense persona is picked up by the kernel
  `hid-playstation` driver, so Steam Input sees a real DualSense (gyro,
  touchpad, rumble). The Xbox 360 persona binds `xpad` through the shipped
  udev rule.
- Battery, signal, and all telemetry are on the app's Overview tab as on
  Windows.

## 6. Feature smoke-test checklist

After installing, verify in this order (each maps to a Windows-parity path):

1. Overview shows firmware version, battery, BT signal → companion transport
   (libusb) works.
2. Audio tab > Test Speaker plays the chime from the controller → PipeWire
   playback to the bridge sink works.
3. Test Mic (Listen) plays your voice back → UAC mic + renderer capture work.
4. Haptics > Test Haptics buzzes → frame path over the vendor interface works.
5. Audio Haptics > enable with music playing → system capture + DSP work;
   switch Source to a specific app and confirm it follows that app only.
6. Triggers > Test Triggers stiffens L2/R2; Trigger Lab preview works.
7. Lighting color/brightness changes apply immediately.
8. Button Remapping: swap Cross/Circle, verify in a game or gamepad tester,
   then restore.
9. Chords: assign PS+D-Pad Up to a keyboard function (e.g. F13) and check it
   types into `sudo libinput debug-events` or any text field → uinput works.
10. Bridge Settings > Firmware > Mount shows the RP2350 drive path.
11. Quit to tray, relaunch — settings persist (`~/.config/DS5 Bridge/`).

## 7. Building from source on CachyOS

```bash
sudo pacman -S --needed git nodejs npm dotnet-sdk base-devel
git clone https://github.com/djanice1980/DS5_Bridge.git
cd DS5_Bridge/companion
npm ci
npm run build:audio-helper:linux
npm run build:app
npx electron .            # run from source
```

To produce the AppImage/pacman packages locally you also need the bundled
flash-nuke firmware, which requires the Pico toolchain
(`sudo pacman -S cmake ninja arm-none-eabi-gcc arm-none-eabi-newlib` plus a
pico-sdk 2.2.0 checkout with `PICO_SDK_PATH` set), then:

```bash
./tools/build-pico-universal-flash-nuke.sh
cd companion && npm run package:linux
```

Otherwise just use the CI-built packages from Releases.

## 8. Troubleshooting

- **"No bridge detected"** — udev rules not applied: re-run step 2, replug the
  bridge, and check `lsusb` lists `054c:0ce6` (or the active persona's id).
- **Test Speaker errors mentioning MP3** — the tone decoder needs
  libsndfile with mpg123 support (CachyOS ships it; on minimal installs run
  `sudo pacman -S libsndfile mpg123`).
- **Audio Haptics shows "capture unavailable"** — confirm `pw-record` exists
  (`pacman -Qo $(which pw-record)` should say pipewire) and that a default
  output device is set.
- **Chords don't type** — `/dev/uinput` permissions; re-run step 2 and log out
  and back in (the `uaccess` tag applies to your seat at login).
- **Xbox persona has no gamepad** — replug the bridge after switching personas
  so the udev rule can teach `xpad` the device id.
- Diagnostics: run the AppImage from a terminal with
  `DS5_BRIDGE_DIAGNOSTICS=all` for verbose logs, and use System > Diagnostics
  in the app.
