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

## 5. USB send-path breadcrumbs — REMOVE WHEN DONE (hot path)

`src/fault_hooks.cpp` bottom section, plus these in `CMakeLists.txt`:

```
-Wl,--wrap=usbd_edpt_claim
-Wl,--wrap=usbd_edpt_xfer
-Wl,--wrap=dcd_edpt_xfer
```

Added to split the crash between "waiting on the endpoint" and "stuck in the hardware layer"
(`send/claim` vs `send/xfer` vs `send/dcd-xfer`). **That question is answered.**

**Cost: this is the expensive one.** `usbd_edpt_xfer` runs on *every* USB transfer — every
HID report and every audio packet, thousands per second — and each stamp pays the §6 cost.

**To remove:** delete the three `__wrap_*`/`__real_*` pairs at the bottom of
`src/fault_hooks.cpp`, remove the three `--wrap` link options, and drop the `SendClaim`,
`SendXfer`, `SendDcdXfer` enum values and their companion phase names.

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

## 7. Flash-stall probe — REMOVE WHEN DONE

`src/flash_probe.cpp`, plus in `CMakeLists.txt`:

```
-Wl,--wrap=flash_range_erase
-Wl,--wrap=flash_range_program
-Wl,--wrap=flash_safe_execute
```

Added to test whether BTstack link-key flash writes explained a 172ms main-loop stall.
**They did not** — measured `flash worst 0ms over 829 ops`, and the real cause was a
`sleep_ms(150)` re-init running inside a BT callback. Its job is done.

Note the op count is dominated by the BOOTSEL `flash_safe_execute` polling in
`button_check()`, not by link-key writes — do not read it as "829 erases".

**Cost:** negligible per call, but it is dead weight now.

**To remove:** drop `src/flash_probe.cpp` from `CMakeLists.txt`, remove the three `--wrap`
options, and remove the `flash_probe_stats` extern and the `[56..59]` payload writes in
`src/companion.cpp`.

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

## Suggested order if trimming

1. §5 USB send-path wrappers — the only piece on a hot path.
2. §7 flash probe — question answered.
3. §6 per-stamp cost — cheap win, keeps the capability.
4. Keep §1, §3, §4, §9 indefinitely. They cost nothing until something breaks, and they are
   the difference between a named crash address and another ten-build investigation.
