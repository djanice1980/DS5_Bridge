// Diagnostic only -- no behaviour change.
//
// A confirmed watchdog hang localises to tud_hid_report(), which cannot block: it claims an
// endpoint, memcpy's, and queues a transfer. But its call chain reaches
//
//   hw_endpoint_start_next_buffer() -> prepare_ep_buffer()   (sets USB_BUF_CTRL_AVAIL)
//     -> _hw_endpoint_buffer_control_update32()
//       -> panic("ep %02X was already available")
//
// and panic() is noreturn: it spins forever with interrupts off, so the watchdog reset is
// the only exit. From the outside that is identical to a stall, which is why the breadcrumb
// froze at interrupt/send with no fault recorded.
//
// Rather than assume that is what happens, stamp a breadcrumb on the way into panic(). If a
// hang now reports the panic phase, the diagnosis is confirmed rather than inferred.
//
// Hooked with the linker's --wrap rather than PICO_PANIC_FUNCTION: that define is consumed
// when the SDK compiles its own panic.c, so setting it on our target would never reach it.
// --wrap redirects every call site at link time, including the ones inside TinyUSB.

#include "watchdog_telemetry.h"

#include <cstdint>

#include "pico.h"

extern "C" {

// The real SDK panic, kept reachable so behaviour after the stamp is unchanged.
void __attribute__((noreturn)) __real_panic(const char *fmt, ...);

void __attribute__((noreturn)) __wrap_panic(const char *fmt, ...) {
    // Record it first. Anything after this point may not survive to run.
    //
    // note_fault rather than note_phase: it carries the return address (i.e. WHICH call site
    // panicked) and preserves the main-loop phase, which note_phase would overwrite with the
    // panic marker. A panic with no context is only marginally better than a mystery reboot.
    watchdog_telemetry_note_fault(
        WatchdogMainLoopPhase::Panic,
        reinterpret_cast<uint32_t>(__builtin_return_address(0)),
        0, // no CFSR: this is a software abort, not a CPU fault
        0, // no faulting data address
        0  // no argument register capture
    );

    // Deliberately NOT forwarding to __real_panic: it calls puts(), which takes the stdout
    // mutex and can itself deadlock when panicking from an ISR. Spin instead and let the
    // watchdog reset us -- the same visible outcome as today, minus the extra failure mode.
    (void)fmt;
    while (true) {
        tight_loop_contents();
    }
}

} // extern "C"
