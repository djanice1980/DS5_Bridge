# DS5 Bridge — Linux port: technical change notes (for upstream / Windows backporting)

This document records every substantive fix and feature added in the **CachyOS/Linux port**
([djanice1980/DS5_Bridge](https://github.com/djanice1980/DS5_Bridge)), forked from
[SundayMoments/DS5_Bridge](https://github.com/SundayMoments/DS5_Bridge) at commit `99611b5`.

It's written so the upstream (Windows) author can decide what to backport **without reverse-engineering
the diffs** — each item lists the symptom, the root cause, the exact change (files/functions), and whether
it applies to Windows.

**Legend — applies to Windows:**
- ✅ **Yes** — shared code (firmware, or companion logic the Windows build also has). Backport directly.
- ⚠️ **Latent** — the bug exists in shared code but doesn't *manifest* on Windows today; worth a defensive fix.
- ❌ **Linux-only** — platform plumbing; documented for completeness, not for backport.

---

## Backport priority (TL;DR)

| # | Change | Layer | Windows |
|---|--------|-------|---------|
| 1 | **Adaptive triggers/rumble die while audio streams** — two firmware guards suppressed controller state during audio | Firmware | ✅ **High** |
| 2 | **Fair-interleave output scheduler** (audio vs controller-state arbitration) + runtime tuning command | Firmware | ✅ High |
| 3 | **Switching a controller between two dongles needs a flash-nuke** — stale BT link key | Firmware | ✅ High |
| 4 | **Firmware version lives in two un-synced constants** — flashed build misreports its version | Firmware | ✅ Medium |
| 5 | **`BUNDLED_FIRMWARE_VERSION` silently drifts** from the firmware version | Companion | ✅ Medium |
| 6 | **Blank profile dropdown** — a fixed-column CSS grid assumed a conditionally-rendered icon | Companion | ⚠️ Latent |
| 7 | **App version not surfaced anywhere in the UI** (`app:getVersion` IPC + About line) | Companion | ✅ Low |
| 8 | **`DS5_DEBUG=1` opt-in debug mode** (DevTools + load logging) | Companion | ✅ Low |
| 9 | Linux audio-haptics, libusb transport, uinput, WirePlumber, packaging, KDE icon | Linux plumbing | ❌ |

---

## Firmware (shared `.uf2` source — highest backport value)

### 1. Adaptive triggers & rumble weaken/click while audio streams to the controller ✅

**Symptom.** With audio routed to the DualSense (system audio-haptics, or speaker), adaptive triggers only
"click" instead of fully engaging, and classic rumble weakens. They recover a few seconds *after* audio stops.
Reproduced on Windows too — this is **not** Linux-specific.

**Wrong theory (do not chase).** "Loud audio saturates the controller↔dongle Bluetooth link, so trigger data
can't get through." Disproven: a game that re-asserts the trigger effect **every frame** holds the trigger
firm *through* audio (verified with `tools/trigger-hold.py`). A one-shot command decaying to a click is the
controller latching a single command, not bandwidth starvation.

**Root cause.** `src/bt.cpp` had **two guards, both upstream of the output scheduler**, that discarded
controller-state output whenever audio was being routed to the controller
(`audio_output_route_protected() == audio_recent() || usb_speaker_streaming_active()`):

1. **Guard A** — in `bt_write_classified_output`, an audio-protected **DROP** block threw controller-state
   packets away *before they were ever queued*. (commit `dd2512d`)
2. **Guard A2** — at the scheduler's `CoalescedState` branch, `if (state_send_blocked_by_audio_locked(now)) return false;`
   vetoed a state packet *even after the scheduler had chosen to send it*. During continuous audio this is
   always active. (commit `3b15775`)

Because both sat in front of the scheduler, the fair-interleave logic never got to arbitrate — audio won
every Bluetooth slot and controller state (triggers/rumble/lightbar via the coalesced path) only escaped in
audio-buffer gaps, arriving late/rarely.

**Fix.** Remove both guards so the **output scheduler is the single arbiter** (see #2). Adaptive-trigger
*test* commands still travel the urgent path and click under audio by design; real games re-assert per frame
and now hold firm.

**Windows applicability.** ✅ Direct — the guards and the scheduler are in the shared firmware. Windows shows
the identical symptom. Backport = delete both guards **and** land the scheduler in #2 (without the scheduler,
removing the guards would let audio starve state; with it, both share the link fairly).

---

### 2. Fair-interleave output scheduler + runtime tuning ✅

**What.** A scheduler that balances the audio stream against coalesced controller-state on the single
Bluetooth output path, replacing "audio always wins."

**Files.**
- `src/output_scheduler.h` / `src/output_scheduler.cpp` — `output_scheduler_choose_interrupt_packet(...)`.
- `src/bt.cpp` — per-connection counters + runtime setter.

**Logic** (`output_scheduler.cpp`):
```
state_starved = coalesced_state_available &&
                (consecutive_audio_sends >= max_consecutive_audio_sends ||
                 state_age_us            >= state_max_age_us);
if (state_starved)            return CoalescedState;   // guarantee a slot
if (audio_available)          return AudioStream;      // else keep the audio buffer full
if (coalesced_state_available) return CoalescedState;
return None;
```
So audio wins by default (buffer stays full), but a pending state packet is **guaranteed** a slot after
`max_consecutive_audio_sends` audio packets in a row **or** once it has waited `state_max_age_us`. Steady
gameplay with nothing changing still leaves audio ~100%. New scheduler inputs: `consecutive_audio_sends`
(incremented on each audio send, reset on any non-audio send, tracked in `bt.cpp`) and `state_age_us`.
Defaults: **4 packets / 3000 µs**.

**Runtime tuning (no reflash).** `CommandSetAudioInterleave = 0x34` (`src/companion.cpp`) carries
`value = max_consecutive_audio_sends` and `read_u16(buffer+10) = state_max_age_us`, dispatched to
`bt_set_audio_interleave()` / `bt_reset_audio_interleave()` (`src/bt.cpp`). `CommandRestoreDefaults` calls the
reset. Companion side: shared `AUDIO_INTERLEAVE_*` constants + `SET_AUDIO_INTERLEAVE` in
`companion/src/shared/protocol.ts`, two persisted global settings in `settings-store.ts`, `setAudioInterleave()`
in `bridge-service.ts` (best-effort resend on connect), and an **Interleave** page in the renderer with a
Smooth/Balanced/Responsive preset knob + advanced raw values.

**Note on protocol versioning:** the new command is dispatched by command-id; `PROTOCOL_MINOR` was **not**
bumped, because `protocol.ts assertVersion` is a strict exact `major.minor` match on the status parse — bumping
it breaks old-firmware/new-app pairs. Old firmware NACKs an unknown command harmlessly, so command-id dispatch
is forward/backward compatible. Don't gate new commands on a protocol/firmware-flag version.

**Windows applicability.** ✅ Direct.

---

### 3. Switching a controller between two dongles requires a flash-nuke ✅

**Symptom.** A DualSense paired to dongle A, then paired to dongle B (another PC), will not reconnect to
dongle A. Re-flashing A's firmware doesn't help — only a full flash **nuke** does.

**Root cause** (`src/bt.cpp`). The dongle stores the controller's BT link key in flash (BTstack TLV), which
survives a `.uf2` reflash. Two connection paths exist:
- **Inbound reconnect** — a controller still bonded to *this* dongle pages it → `HCI_EVENT_CONNECTION_REQUEST`.
  Stored key is valid; keep it.
- **Outbound pairing** — the dongle's **inquiry** finds a controller and pages it → `new_pair = true` at
  `HCI_EVENT_INQUIRY_COMPLETE`. A controller is only *discoverable by inquiry when it's in pairing mode*, i.e.
  it wants a **fresh** bond — so any key we still hold for it is stale.

On the outbound path, `HCI_EVENT_LINK_KEY_REQUEST` replied with the **stale** stored key; the controller
(re-bonded elsewhere) rejected it → auth failed. There *is* a drop-key-on-auth-failure
(`gap_drop_link_key_for_bd_addr(current_device_addr)` in `HCI_EVENT_AUTHENTICATION_COMPLETE`), but it doesn't
rescue you: the disconnect that follows a failed auth hits `HCI_EVENT_DISCONNECTION_COMPLETE`, which
**`watchdog_reboot`s the dongle** — almost certainly before the key-drop persists to flash (or the controller
tears down the link before the auth-complete event fires). The stale key survives → the next attempt offers it
again → loop → only a nuke clears it.

**Fix.** Drop the stored key on the outbound path **before** connecting:
```cpp
// at HCI_EVENT_INQUIRY_COMPLETE, where new_pair = true, before hci_create_connection:
gap_drop_link_key_for_bd_addr(current_device_addr);
```
`LINK_KEY_REQUEST` then negative-replies → clean fresh SSP → new key stored → connects. It also clears the key
already in flash on the next pairing, so no nuke is needed to adopt the fix. Inbound reconnection is untouched.

**Windows applicability.** ✅ Direct (shared BT stack). Anyone who moves one controller between two dongles.

---

### 4. Firmware version lives in two un-synced constants ✅

**Symptom.** After bumping the version, the flashed firmware reported the *old* version on the companion's
System page.

**Root cause.** The version is duplicated: the **status report** sends
`kFirmwareMajor/Minor/Patch` from `src/companion.cpp` (bytes 24–26), which is **separate** from
`pico_set_program_version(...)` in `CMakeLists.txt`. Bumping only the CMake one left the reported version stale.

**Fix / rule.** Bump **both** on every firmware version change. (In this port a *third* location — the
companion's `BUNDLED_FIRMWARE_VERSION`, see #5 — must also match; a release-validation test enforces
`bundled == companion.cpp firmware`.)

**Windows applicability.** ✅ Same two constants exist upstream.

---

## Companion — shared logic (backportable)

### 5. `BUNDLED_FIRMWARE_VERSION` silently drifts ✅

**Symptom.** The in-app "firmware update available" check misbehaved; the release-validation script failed.

**Root cause.** `companion/src/main/bridge-service.ts` has `const BUNDLED_FIRMWARE_VERSION = 'x.y.z'` that drives
`firmwareUpdateAvailable` and is asserted equal to the `companion.cpp` firmware version by
`tools/create-release-candidate.ps1`. It had drifted (stuck at an old value through several firmware bumps).

**Fix / rule.** Treat it as the **third** place the firmware version lives (with `companion.cpp` and
`CMakeLists.txt`); bump all three together. Its two unit tests in `bridge-service.test.ts` encode the value and
must move with it.

**Windows applicability.** ✅ Same constant + test upstream.

### 6. Blank controller-profile dropdown ⚠️ (latent on Windows)

**Symptom (Linux).** The System-page profile selector rendered as an empty box with an empty menu, even though
the profile data (`Default`) was correct end-to-end.

**Root cause.** `.system-page .profile-controls` (`companion/src/renderer/styles.css`) used a **fixed
3-column grid** `grid-template-columns: 38px minmax(0,1fr) auto` where the 38px column is for the **Emergency
Repair** icon — which is rendered **only when `IS_WINDOWS_HOST`** (`App.tsx`). With the icon absent, the two
remaining children shifted left: the profile `<CustomSelect>` landed in the 38px column and its label was
clipped to just the chevron; the dropdown menu inherited the ~38px width and looked empty. (Everything else —
`getStatus()`, the React state, the options — was correct; confirmed via DevTools that the button's `<span>`
literally contained "Default", just 38px wide.)

**Fix.** Scope the 38px column to a `.profile-controls--repair` class applied only when the repair icon
renders; otherwise 2 columns.

**Windows applicability.** ⚠️ On Windows the icon **is** present, so the grid balances and it doesn't manifest —
but it's a latent fragility: any future change that conditionally hides that icon re-introduces it. A defensive
"columns follow children" grid is worth adopting.

### 7. App version surfaced in the UI ✅

**What.** There was **no** place in the UI showing the companion's own version — every "which build am I on?"
question was guesswork. Added an `app:getVersion` IPC (`ipcMain.handle('app:getVersion', () => app.getVersion())`
in `main.ts` → `getAppVersion` in `preload.ts` → an `appVersion` state fetched in `App.tsx`) and a
`DS5 Bridge · Version x.y.z` line in **Settings → About**.

**Windows applicability.** ✅ Same gap upstream.

### 8. `DS5_DEBUG=1` opt-in debug mode ✅

**What.** Launching from a terminal with `DS5_DEBUG=1` set (env-gated, invisible otherwise): opens detached
DevTools (`main.ts`) and logs the settings the store loaded from disk to stdout (`settings-store.ts`). Documented
in the README "Debug mode" section. It's what finally cracked #6 (read the live DOM instead of theorizing).

**Windows applicability.** ✅ Generic; a permanent field-diagnostics switch.

---

## Linux-port plumbing (❌ not for backport — reference only)

These are how the Windows features were re-implemented on Linux; they don't apply to a Windows build.

- **Audio haptics via the exposed 4.0 sink.** Windows writes the 4-channel UAC device's ch2/3 (grip actuators)
  via WASAPI. Linux mirrors the default sink's FL,FR → the ported DSP → `pw-play --raw --channels 4
  --channel-map FL,FR,RL,RR` into the bridge sink (RL,RR = USB ch2/3). **Critical fix:** `pw-record`/`pw-play`
  need **`--raw`** (headerless PCM; without it libsndfile rejects the stream and the helper dies). The
  vendor-USB-frames path (interface 5 = lightbar/triggers/rumble control) was the *wrong* transport for haptics
  and flooding it choked triggers — removed.
- **libusb companion transport.** The Windows WinUSB companion bridge is re-implemented as an `AudioHelper
  --companion-transport` NDJSON pipe (control transfers + bulk OUT), used by the app and by `tools/trigger-probe.py`.
- **`uinput`** for keyboard/chord key injection (Windows uses SendInput).
- **WirePlumber UCM fix** (`packaging/linux/52-ds5-bridge-noucm.conf`): the ALSA UCM profile hides the 4-channel
  device; a shipped WirePlumber rule restores it (else the speaker is quiet and grips don't buzz).
- **KDE Wayland taskbar/window icon.** KDE maps a window to its icon by the app-id it reports → a `.desktop`
  file. Electron derived that id from the product name **"DS5 Bridge"** (space + capitals), which doesn't match
  the installed `ds5-bridge.desktop`, so the icon fell back to a placeholder. Fixed with `app.setName('ds5-bridge')`
  on Linux (with `app.setPath('userData', <appData>/'DS5 Bridge')` pinned first so settings are preserved, since
  `setName` also drives the userData dir). Windows uses AppUserModelID, so N/A.
- **Packaging.** AppImage + pacman via electron-builder; udev rules (`60-ds5bridge.rules`) + a
  `pacman-after-install.sh` that SUIDs `chrome-sandbox`, refreshes desktop/icon caches, and loads `uinput`.
- **In-app firmware flash / Nuke on Linux.** The nuke image is built and hash-matched in the same CI step as the
  app (`release.yml`), so the bundled UF2 and the embedded SHA-256 always match; a standalone
  `DS5-Bridge-Flash-Nuke.uf2` (RP2350) is also committed for manual BOOTSEL wipes.

---

## Diagnostic tools added (`tools/`)

- **`trigger-hold.py`** — writes the firmware's exact `set_trigger_feedback` effect to the DualSense gamepad
  hidraw every ~10 ms, to test whether *continuous* maintenance holds a trigger under audio (it does). This is
  the experiment that disproved the BT-saturation theory in #1.
- **`trigger-probe.py`** — drives the companion transport (NDJSON): `engage`/`rumble`/`latency`/`trace` modes;
  trace mode reads the firmware trigger-trace ring and separates audio packets from controller-state packets.
  Needs the `-DDS5_DIAGNOSTICS_PRESET=traces` firmware build.

---

*Generated for the Linux port at companion 1.6.18 / firmware 1.6.13. Commit range: `99611b5..HEAD`.*
