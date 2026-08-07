# Diagnostics

Debugging has two layers:

- Firmware diagnostics are compile-time CMake options.
- Companion diagnostics are runtime environment variables.

## Firmware Presets

Use one preset first, then add individual legacy flags only when needed:

```powershell
cmake -S . -B build-ninja -G Ninja `
  -DENABLE_COMPANION=ON `
  -DDS5_DIAGNOSTICS_PRESET=audio
cmake --build build-ninja --target ds5-bridge
```

Presets:

```text
off     Release default. No companion debug reports or UART logs.
audio   Enables audio debug/stats feature reports.
traces  Enables audio debug/stats plus trigger and feedback trace reports.
all     Enables traces plus UART/BTstack logs.
custom  Honors the individual legacy flags below.
```

Presets are authoritative, so `off` really means off even if an old build
directory has stale debug flags cached. Use `custom` only when you need the old
individual flags:

```text
ENABLE_DEBUG_LOGS
ENABLE_AUDIO_DEBUG_REPORTS
ENABLE_TRIGGER_TRACE_REPORTS
ENABLE_FEEDBACK_TRACE_REPORTS
ENABLE_COMPANION_DEBUG
```

Firmware defaults and aliases live in `src/debug_config.h`.

## Companion Runtime

Launch the companion with one high-level runtime preset:

```powershell
$env:DS5_BRIDGE_DIAGNOSTICS="audio"
cd companion
npm run dev
```

Runtime presets:

```text
off         Default. No extra feature-report polling.
audio       Poll audio debug/stats reports.
traces      Poll audio debug/stats plus trigger and feedback trace reports.
helper      Enable audio helper diagnostics.
all         Enable all companion diagnostic polling and audio helper diagnostics.
```

Individual runtime flags override the preset:

```text
DS5_BRIDGE_AUDIO_DEBUG_DIAGNOSTICS=1
DS5_BRIDGE_TRIGGER_TRACE_DIAGNOSTICS=1
DS5_BRIDGE_FEEDBACK_TRACE_DIAGNOSTICS=1
DS5_BRIDGE_MIC_KEEPALIVE=1
DS5_BRIDGE_AUDIO_HELPER_DIAGNOSTICS=1
```

Companion runtime defaults and environment variable names live in
`companion/src/main/debug-config.ts`.

## Watchdog Telemetry

A hardware watchdog resets the Pico if the firmware's main loop ever goes more than a
second without checking in. On the next boot the LED does three slow blinks, which is the
only outward sign that a reset was a hang rather than a normal power-up.

No setup is needed for this one — it is always on. The **Watchdog** row in
**System -> Diagnostics** reads:

```text
clean boot                              Previous reset was not a watchdog timeout.
HANG in <phase>                         The main loop stalled in that phase.
HANG (breadcrumb invalid)               It hung, but the retained record did not survive.
... - slowest <phase> <n>ms             Worst single phase since the CURRENT boot.
```

The phase names match the stages of the main loop: `cyw43`, `tinyusb`,
`interrupt-before-audio`, `usb-power`, `audio`, `button`, `lightbar`, `rssi`, `inquiry`,
`connection-recovery`, `companion`, `interrupt-after-companion`.

Two distinct things are being reported. The `HANG in` part is retained from the *previous*
boot in the watchdog's scratch registers, which survive the reset. The `slowest` part is
live from the current boot and needs no crash at all -- it is there because a phase can be
slow enough to matter while still staying under the one-second budget, and that would
otherwise be invisible.

Firmware 1.6.28 and later feeds the watchdog after every phase, so the budget applies to
each phase individually. That matters for interpretation: on earlier builds the whole
iteration shared one budget, so the reported phase was only where the clock happened to
run out, not necessarily the phase that was slow.

## Pairing breadcrumbs

The **Pairing breadcrumbs** row in **System -> Diagnostics** is a ring of the last ten
connection events, printed verbatim as `stage/status`. They are deliberately not translated
into prose in the app -- the raw pair is what gets pasted into a bug report, and a wrong
translation is worse than none.

```text
1/0    inquiry found the controller -> connecting
2/0    inbound connection during the pairing window -> drop the stale key
3/nn   connection complete, nn = HCI status
4/0    link key requested, none stored -> fresh SSP pairing
4/1    link key requested, stored key replied (an ordinary reconnect)
4/2    stored key found during a re-pair -> dropped to force SSP
5/0    SSP user confirmation -> auto-accepted
6/0    legacy PIN requested -> replied 0000
7/nn   authentication complete, nn = HCI status
8/nn   encryption change, nn = HCI status (0xEE = succeeded but not enabled)
9/nn   disconnection complete, nn = HCI reason
10/nn  L2CAP HID channel opened, nn = status
11/1   a link key drop missed, but the re-drop took
11/2   the link key DB delete itself is broken
11/3   the drop on the event's own address did not take
13/1   hci_disconnect went unacknowledged for 2s -> re-sent
13/2   it never completed at all for 30s -> torn down locally
```

`12/nn` appears only on firmware 1.6.59 and earlier: a retired phase-disagreement probe whose
status byte packed two phase numbers as `(tracked << 4) | derived`, printed in decimal.

**13/2 is the one worth reporting.** It means a disconnect never completed and the bridge
recovered by giving up on it. The hole it covers is theoretical -- that breadcrumb exists so
that if it ever stops being theoretical, there is evidence rather than a mystery wedge.

## Common Recipes

Audio-only firmware and companion diagnostics:

```powershell
cmake -S . -B build-ninja -G Ninja `
  -DENABLE_COMPANION=ON `
  -DDS5_DIAGNOSTICS_PRESET=audio
cmake --build build-ninja --target ds5-bridge

$env:DS5_BRIDGE_DIAGNOSTICS="audio"
cd companion
npm run dev
```

Trace-heavy firmware and companion diagnostics:

```powershell
cmake -S . -B build-ninja -G Ninja `
  -DENABLE_COMPANION=ON `
  -DDS5_DIAGNOSTICS_PRESET=traces
cmake --build build-ninja --target ds5-bridge

$env:DS5_BRIDGE_DIAGNOSTICS="traces"
cd companion
npm run dev
```

Audio helper diagnostics:

```powershell
$env:DS5_BRIDGE_DIAGNOSTICS="helper"
cd companion
npm run dev
```
