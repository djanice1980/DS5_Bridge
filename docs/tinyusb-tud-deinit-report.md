# tud_deinit() stale-state crash — investigated, already fixed upstream

**Outcome: no bug report filed. The defect is real, we hit it, and TinyUSB fixed it in
0.21.0.** Kept as a record so it is not re-investigated from scratch.

## The defect

In **TinyUSB 0.20.0** (the version this firmware pins, `TINYUSB_REF` in
`.github/workflows/build.yml`), `tud_deinit()` sets `_usbd_mutex = NULL` but never clears
`_usbd_dev`. Since `tud_mounted()` is `return _usbd_dev.cfg_num ? true : false`, and the HID
class driver has no `deinit` to clear `_hidd_itf`, **`tud_hid_ready()` keeps returning true
after the stack is deinitialised.**

A caller following the documented contract — check `tud_hid_ready()`, then call
`tud_hid_report()` — dereferences the NULL mutex:

```
tud_hid_report -> usbd_edpt_claim -> tu_edpt_claim(ep_state, NULL)
  -> osal_mutex_lock(NULL, ...) -> mutex_enter_block_until(NULL, ...)
```

Observed on RP2350 as `CFSR = 0x8200` (`PRECISERR | BFARVALID`), `BFAR = 0xF0000000`,
escalated to HardFault. The disassembly is the interesting part:

```
+40   ldr      r1, [r4]      ; r4 = mtx = NULL -> reads address 0.
                             ; On RP2350 address 0 is bootrom: READABLE, so this
                             ; SUCCEEDS and loads a garbage value (0xF0000000).
+42   mrs      ip, primask
+46   cpsid    i
+48   ldaexb   r2, [r1]      ; dereferences 0xF0000000 -> precise bus fault
```

The NULL dereference does not fault where you would expect, because address 0 is readable on
this part. It faults one instruction later, on the value read from it — which is why the
crash did not look like a NULL pointer at first.

## Why no report

`tud_deinit()` on **0.21.0 and master** contains `tu_varclr(&_usbd_dev);`, which zeroes
`cfg_num`, so `tud_mounted()` correctly reports false after deinit. Filing would have been a
duplicate of something already resolved.

Related but distinct, and still open at the time of checking:

- [#2478](https://github.com/hathach/tinyusb/issues/2478) — `tud_connected()`/`tud_mounted()`
  stay true after *disconnection* (not deinit). Open, no fix.
- [#3412](https://github.com/hathach/tinyusb/discussions/3412) — `tusb_deinit()` deletes a
  queue that `tud_task()` is blocked on. Different deinit state-management bug.

## What this means for us

Nothing urgent. This firmware no longer deinitialises the stack at runtime (a controller
disconnect is a soft detach — see [[ds5bridge_tusb_deinit_null_mutex]] and the host-test
invariants in `tests/firmware/usb_descriptor_migration_test.cpp`), so the window that
triggered it does not exist any more.

Two things to remember:

1. If `TINYUSB_REF` is ever bumped, **0.21.0 or later** carries the fix.
2. The `usb_device_stack_ready()` / `tud_inited()` guards stay regardless. On 0.20.0 they are
   load-bearing; on 0.21.0+ they are belt-and-braces. Either way, gating a device-stack call
   on a class ready predicate alone is not sufficient on the pinned version.
