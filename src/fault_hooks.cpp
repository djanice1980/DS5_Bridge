// Diagnostic only -- no behaviour change.
//
// State of the investigation: a confirmed, reproducible watchdog reset localises to
// tud_hid_report(), which does not return (interrupt/tail is never stamped). The panic()
// theory was tested in 1.6.30 and REFUTED -- the panic hook was verified installed (the
// SDK's "*** PANIC ***" string drops out of the linked image once --wrap=panic captures
// every call site) and the breadcrumb still came back as interrupt/send.
//
// So the CPU is stopping somewhere that is neither a return nor a panic. Two candidates
// were never ruled out, and this file covers both:
//
//   1. A CPU fault. The SDK's default isr_hardfault is a breakpoint, which without a
//      debugger locks the core until the watchdog resets it -- visually identical to a
//      stall, and it never touches panic(). Override all four fault vectors so a fault
//      leaves a breadcrumb.
//
//   2. A genuine block inside the transfer path. usbd_edpt_claim -> usbd_edpt_xfer ->
//      dcd_edpt_xfer are wrapped so the breadcrumb says WHICH of the three is entered
//      last, which separates "waiting on the endpoint mutex" from "stuck in the hardware
//      layer".
//
// The wrappers use the linker's --wrap, the same mechanism proven to work in 1.6.30.

#include "watchdog_telemetry.h"

#include "pico.h"

#include <cstdint>

namespace {

// Record, then stop and let the watchdog reset us. Deliberately not attempting to recover:
// the goal is to learn what happened, and a fault we "handled" would hide its own cause.
[[noreturn]] void stamp_and_park(WatchdogMainLoopPhase phase) {
    watchdog_telemetry_note_phase(phase);
    while (true) {
        tight_loop_contents();
    }
}

} // namespace

extern "C" {

// The SDK declares these weak in crt0.S; defining them here takes over the vectors.
void __not_in_flash_func(isr_hardfault)() {
    stamp_and_park(WatchdogMainLoopPhase::FaultHard);
}

void __not_in_flash_func(isr_memmanage)() {
    stamp_and_park(WatchdogMainLoopPhase::FaultMemManage);
}

void __not_in_flash_func(isr_busfault)() {
    stamp_and_park(WatchdogMainLoopPhase::FaultBus);
}

void __not_in_flash_func(isr_usagefault)() {
    stamp_and_park(WatchdogMainLoopPhase::FaultUsage);
}

// --- transfer path breadcrumbs -------------------------------------------------------
// These sit on a hot path (every audio packet also lands here), so they only stamp. The
// last one entered before a reset is the one that did not return.

bool __real_usbd_edpt_claim(uint8_t rhport, uint8_t ep_addr);
bool __real_usbd_edpt_xfer(uint8_t rhport, uint8_t ep_addr, uint8_t *buffer, uint16_t total_bytes);
bool __real_dcd_edpt_xfer(uint8_t rhport, uint8_t ep_addr, uint8_t *buffer, uint16_t total_bytes);

bool __wrap_usbd_edpt_claim(uint8_t rhport, uint8_t ep_addr) {
    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::SendClaim);
    return __real_usbd_edpt_claim(rhport, ep_addr);
}

bool __wrap_usbd_edpt_xfer(uint8_t rhport, uint8_t ep_addr, uint8_t *buffer, uint16_t total_bytes) {
    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::SendXfer);
    return __real_usbd_edpt_xfer(rhport, ep_addr, buffer, total_bytes);
}

bool __wrap_dcd_edpt_xfer(uint8_t rhport, uint8_t ep_addr, uint8_t *buffer, uint16_t total_bytes) {
    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::SendDcdXfer);
    return __real_dcd_edpt_xfer(rhport, ep_addr, buffer, total_bytes);
}

} // extern "C"
