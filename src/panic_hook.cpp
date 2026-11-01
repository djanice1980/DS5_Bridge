// Panic and C++ abort paths: stamp a breadcrumb, then reset immediately.
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

#include "hardware/watchdog.h"
#include "pico.h"

namespace {

// Reset NOW through the watchdog rather than spinning until it fires. A zero-delay
// watchdog_enable triggers the same immediate reset as a zero-delay reboot but also
// writes the SDK's scratch[4] magic, so the next boot decodes the retained breadcrumb
// as an abnormal reset (telemetry never touches scratch[4], so the breadcrumb itself
// survives). Spinning was fatal before watchdog_enable() had armed -- a panic during
// early boot or core 1 codec setup left the bridge dead until it was unplugged.
// (Ported from upstream 2.0, 70dc3d6.)
[[noreturn]] void reset_after_stamp() {
    watchdog_enable(0, false);
    while (true) {
        tight_loop_contents();
    }
}

} // namespace

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
    // mutex and can itself deadlock when panicking from an ISR.
    (void)fmt;
    reset_after_stamp();
}

} // extern "C"

// Exceptions are disabled in the firmware, so an allocation or container contract
// failure cannot be recovered from. Defining these locally resets through the same
// stamped path and keeps libstdc++'s exception construction, demangling and verbose
// termination machinery out of the link. (Ported from upstream 2.0, 70dc3d6.)
namespace std {

[[noreturn]] void __throw_bad_alloc() {
    watchdog_telemetry_note_fault(
        WatchdogMainLoopPhase::Panic,
        reinterpret_cast<uint32_t>(__builtin_return_address(0)),
        0, 0, 0);
    reset_after_stamp();
}

[[noreturn]] void __throw_bad_array_new_length() {
    watchdog_telemetry_note_fault(
        WatchdogMainLoopPhase::Panic,
        reinterpret_cast<uint32_t>(__builtin_return_address(0)),
        0, 0, 0);
    reset_after_stamp();
}

[[noreturn]] void __throw_length_error(char const *) {
    watchdog_telemetry_note_fault(
        WatchdogMainLoopPhase::Panic,
        reinterpret_cast<uint32_t>(__builtin_return_address(0)),
        0, 0, 0);
    reset_after_stamp();
}

[[noreturn]] void __throw_out_of_range_fmt(char const *, ...) {
    watchdog_telemetry_note_fault(
        WatchdogMainLoopPhase::Panic,
        reinterpret_cast<uint32_t>(__builtin_return_address(0)),
        0, 0, 0);
    reset_after_stamp();
}

} // namespace std

// Opus is compiled with cmake/opus_fatal_override.h, which rewrites celt_fatal(message, file,
// line) to this argument-free hook so the diagnostic strings are never emitted and fprintf is
// never linked. The hardening checks still run. (Ported from upstream 2.0, 75cc3d6.)
extern "C" [[noreturn]] void ds5_celt_fatal_noargs() {
    watchdog_telemetry_note_fault(
        WatchdogMainLoopPhase::Panic,
        reinterpret_cast<uint32_t>(__builtin_return_address(0)),
        0, 0, 0);
    reset_after_stamp();
}

// audio.cpp creates the speaker encoder with OPUS_APPLICATION_RESTRICTED_CELT, which never
// allocates, initializes or runs the SILK encoder, so the link wraps both SILK entry points here
// and --gc-sections discards that encoder tree from SRAM. Reaching either stub means the codec
// configuration regressed. The SILK decoder stays for the microphone path.
extern "C" [[noreturn]] void __wrap_silk_Encode() {
    ds5_celt_fatal_noargs();
}

extern "C" [[noreturn]] void __wrap_silk_InitEncoder() {
    ds5_celt_fatal_noargs();
}

// The encoder runs at complexity 0, below the threshold (7) at which Opus runs its tonality
// analysis, so the analysis code and its MLP weights are retired the same way. Initialization and
// reset are reached on every encoder create and OPUS_RESET_STATE; they only touched the analysis
// state, which stays zeroed. tonality_get_info is only called after a completed analysis frame and
// leaves the caller's AnalysisInfo at its "not valid" default.
extern "C" [[noreturn]] void __wrap_run_analysis() {
    ds5_celt_fatal_noargs();
}

// These three run from the SRAM codec on core 1, so they stay beside it.
extern "C" void __not_in_flash_func(__wrap_tonality_analysis_init)(void *, int) {}

extern "C" void __not_in_flash_func(__wrap_tonality_analysis_reset)(void *) {}

extern "C" void __not_in_flash_func(__wrap_tonality_get_info)(void *, void *, int) {}
