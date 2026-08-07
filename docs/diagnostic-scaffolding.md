# Diagnostic scaffolding — what it is, what it costs, how to remove it

Built between firmware 1.6.26 and 1.6.38 while chasing a reconnect crash. The symptom was
"the bridge reboots when you power the controller off and back on"; the cause turned out to
be a hard fault from a NULL endpoint mutex, hidden behind **two** layers of disguise — a
watchdog reset that looks like a hang, and the SDK's default `isr_hardfault`, which is a
breakpoint that just locks the core until the watchdog fires.

Each piece below is listed with its cost and its removal steps, so this can be unwound
deliberately rather than archaeologically. **Nothing here changes behaviour**; it only
records what happened.

Read alongside [docs/diagnostics.md](diagnostics.md) (how to read the Watchdog row) and the
root-cause write-up in the commit for firmware 1.6.35.

---

## 1. Per-phase watchdog feed — KEEP (not scaffolding)

`src/main.cpp`, `watchdog_update()` after every main-loop phase.

This is a **correctness fix**, not instrumentation, and matches upstream's `RUN_MAIN_PHASE`.
With a single feed per iteration the 1s budget was shared across all phases, so the watchdog
fired wherever the clock ran out rather than in the phase that stalled — which is what made
five builds of telemetry blame the wrong place.

**Cost:** negligible. **Do not remove.**

---

## 2. Phase breadcrumbs in watchdog scratch — KEEP, but see §6

`src/watchdog_telemetry.{h,cpp}`, `WatchdogMainLoopPhase`, `watchdog_telemetry_note_phase()`.

Records which main-loop phase is executing into `watchdog_hw->scratch[0..3,5,6,7]`, which
survive a watchdog reset. Read back at boot by `watchdog_telemetry_boot_capture()` and
surfaced in the companion's Watchdog row.

Schema 3 layout: `scratch[0]` signature+CRC, `[1]` phase, `[2]` sequence *or* fault status,
`[3]` ms *or* faulting PC, `[5]` fault address, `[6]` pre-fault phase, `[7]` R0.
`scratch[4]` is the SDK's `watchdog_enable` magic and must never be touched.

**Cost:** real but modest — see §6, which is where the cost actually lives.

**To remove:** delete the `watchdog_telemetry_note_phase()` calls from `main.cpp`, drop
`src/watchdog_telemetry.*` from `CMakeLists.txt`, and remove the payload bytes in §7.

---

## 3. Fault vectors — KEEP

`src/fault_hooks.cpp` — `isr_hardfault`, `isr_memmanage`, `isr_busfault`, `isr_usagefault`
override the SDK's weak symbols from `crt0.S`. Naked handlers capture the exception frame
(so `frame[6]` is the faulting PC), read `CFSR`/`HFSR`/`BFAR`/`MMFAR`, stamp a breadcrumb,
then park and let the watchdog reset.

This is what turned "mystery reboot" into "hard fault at `mutex_enter_block_until+48`
accessing `0xF0000000`". Without it a crash is indistinguishable from a stall.

**Cost:** **zero** until a fault occurs — they are vector table entries.

**One caveat:** they replace the SDK defaults, so with a debugger attached a fault parks in
our spin loop instead of breaking into the debugger. If you ever do JTAG work, comment out
the `DS5_FAULT_VECTOR` lines.

**To remove:** delete the `DS5_FAULT_VECTOR(...)` block and the `Fault*` enum values.

---

## 4. `--wrap=panic` — KEEP

`src/panic_hook.cpp`, plus `-Wl,--wrap=panic` in `CMakeLists.txt`.

`panic()` is `noreturn` and spins with interrupts off, so a TinyUSB panic looks exactly like
a stall. The hook stamps a breadcrumb carrying `panic()`'s **return address** (which call
site) and preserves the pre-panic main-loop phase.

It deliberately does **not** forward to `__real_panic`: the SDK's version calls `puts()`,
which takes the stdout mutex and can deadlock when panicking from an ISR.

Verification trick worth remembering: if `--wrap` is working, the SDK's real panic body is
no longer referenced and its `"*** PANIC ***"` string **disappears from the linked image**.
That is how the hook was proven installed rather than assumed
(`scripts` note: compare `strings` of a wrapped vs unwrapped build).

**Cost:** zero until a panic occurs.

**To remove:** drop `src/panic_hook.cpp` from `CMakeLists.txt`, remove
`-Wl,--wrap=panic`, and delete the `Panic` enum value.

---

## 5. USB send-path breadcrumbs — REMOVED in firmware 1.6.67

Was `src/fault_hooks.cpp` bottom section plus `--wrap` on `usbd_edpt_claim`, `usbd_edpt_xfer`
and `dcd_edpt_xfer`.

Added to split the crash between "waiting on the endpoint" and "stuck in the hardware layer"
(`send/claim` vs `send/xfer` vs `send/dcd-xfer`). That question was answered — the crash was
in the claim — and this was the only piece of the scaffolding on a hot path:
`usbd_edpt_xfer` ran for every HID report and every audio packet, thousands per second, each
stamp paying the §6 cost.

Phases 28–30 are now unused and were **left unassigned rather than reused**. The companion
still names them, so a breadcrumb retained from firmware 1.6.66 or earlier decodes to what it
meant at the time instead of to something else entirely.

---

## 6. Per-stamp cost — worth trimming even if everything else stays

Every `note_phase()` currently does:

- `time_us_64() / 1000` in `now_ms()` — a **64-bit division**, which Cortex-M33 has no
  instruction for, so it calls `__aeabi_uldivmod`.
- `scratch_crc()` over **6 words = 24 bytes**, each through an 8-iteration `crc8_update`
  loop — roughly **192 loop iterations per stamp**.

That runs 12+ times per main-loop iteration, plus once per §5 wrapper call.

Cheap wins if this is ever profiled: use `time_us_32()` and store microseconds (dropping the
64-bit divide), and/or use a table-driven or simpler checksum. The CRC exists only to reject
garbage scratch registers after a cold boot — it does not need to be strong.

---

## 7. Flash-stall probe — REMOVED in firmware 1.6.67

Was `src/flash_probe.cpp` plus `--wrap` on `flash_range_erase`, `flash_range_program` and
`flash_safe_execute`.

Added to test whether BTstack link-key flash writes explained a 172ms main-loop stall.
**They did not** — measured `flash worst 0ms over 829 ops`, and the real cause was a
`sleep_ms(150)` re-init running inside a BT callback.

Worth preserving from that measurement: the op count was dominated by the BOOTSEL
`flash_safe_execute` polling in `button_check()`, not by link-key writes — it was never
"829 erases".

The companion-side readout went with it, rather than being left to render `0ms over 0 ops`
against firmware that no longer measures. Payload bytes `[56..59]` are free again on non-fault
records.

---

## 8. Companion-side reporting

- `src/companion.cpp` `build_device_identity()` — payload `[43..62]`. Fault-shaped records
  (phase 23–27) use `[56..59]` for the fault address and `[60]` for the pre-fault phase;
  non-fault records reuse `[56..59]` for flash telemetry. The phase byte disambiguates.
- `companion/src/shared/protocol.ts` — `WATCHDOG_PHASE_NAMES`, `isFaultPhase()`,
  `WatchdogTelemetryPayload` parsing at `report[44..63]`.
- `companion/src/main/bridge-service.ts` — builds the `lastWatchdogHang` string.
- `companion/src/renderer/App.tsx` — the **Watchdog** row in System → Diagnostics.

**To remove:** delete the payload writes, the parsing fields, the string builder, and the
row. The payload bytes can then be reclaimed — note only `[61..62]` are currently free.

---

## 9. CI: link map artifact — KEEP

`.github/workflows/build.yml` publishes `ds5-bridge-companion.elf.map` next to the `.uf2`.

Without it, a reported PC is just a number. **Resolve against the map from the SAME build** —
layout shifts between builds, and comparing a PC to a different build's map produced one
wrong conclusion during this investigation (it looked like the crash address was moving when
it was perfectly deterministic at `mutex_enter_block_until+48` every time).

**Cost:** a ~2MB CI artifact. **Worth keeping permanently.**

---

## What is left

§5 and §7 were removed in firmware 1.6.67; §8's flash reporting went with §7. Everything still
here — §1 per-phase feed, §2 phase breadcrumbs, §3 fault vectors, §4 `--wrap=panic`, §9 the CI
link map — **stays indefinitely.** All of it costs nothing until something breaks, and it is the
difference between a named crash address and another ten-build investigation.

The one remaining trim is §6, the per-stamp cost. It keeps the capability and just makes it
cheaper, so it can be done whenever rather than being scheduled.
