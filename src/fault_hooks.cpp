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

// ARMv8-M System Control Block. Read directly rather than pulling in CMSIS headers.
constexpr uintptr_t kScbCfsr = 0xE000ED28u; // Configurable Fault Status
constexpr uintptr_t kScbHfsr = 0xE000ED2Cu; // HardFault Status
constexpr uintptr_t kScbMmfar = 0xE000ED34u; // MemManage Fault Address
constexpr uintptr_t kScbBfar = 0xE000ED38u;  // BusFault Address

inline uint32_t read_reg(uintptr_t addr) {
    return *reinterpret_cast<volatile uint32_t *>(addr);
}

// Record the faulting PC, then stop and let the watchdog reset us. Deliberately not
// attempting to recover: a fault we silently "handled" would hide its own cause.
//
// `frame` is the exception stack frame the CPU pushed. Layout is R0, R1, R2, R3, R12, LR,
// PC, xPSR -- so frame[6] is the instruction that faulted, which is the whole point. That
// holds for the FP extended frame too, since the FP registers are stacked after xPSR.
[[noreturn]] void __not_in_flash_func(report_fault)(WatchdogMainLoopPhase phase, uint32_t *frame) {
    const uint32_t pc = frame != nullptr ? frame[6] : 0;
    // CFSR says what kind of fault; HFSR's FORCED bit (30) says a configurable fault
    // escalated to hard. Pack both: CFSR in the low half, HFSR's top bits in the high half.
    const uint32_t cfsr = read_reg(kScbCfsr);
    const uint32_t status = (cfsr & 0xFFFFu) | (read_reg(kScbHfsr) & 0xFFFF0000u);
    // The faulting DATA address -- the one number that separates "the pointer was null"
    // from "the pointer was garbage" from "the stack ran off its end". Only meaningful
    // when the matching valid bit is set: BFARVALID (bit 15) or MMARVALID (bit 7).
    uint32_t fault_address = 0;
    if ((cfsr & (1u << 15)) != 0) {
        fault_address = read_reg(kScbBfar);
    } else if ((cfsr & (1u << 7)) != 0) {
        fault_address = read_reg(kScbMmfar);
    }
    watchdog_telemetry_note_fault(phase, pc, status, fault_address);
    while (true) {
        tight_loop_contents();
    }
}

} // namespace

extern "C" {

// Called from the naked vectors below with the stack frame pointer already resolved.
[[noreturn]] void __not_in_flash_func(ds5_fault_dispatch)(uint32_t *frame, uint32_t which) {
    report_fault(static_cast<WatchdogMainLoopPhase>(which), frame);
}

// The SDK declares these weak in crt0.S; defining them here takes over the vectors.
//
// Naked, because the compiler must not touch the stack before we capture the frame.
// EXC_RETURN bit 2 selects which stack the frame was pushed to.
#define DS5_FAULT_VECTOR(name, phase_value)                                                \
    __attribute__((naked)) void __not_in_flash_func(name)() {                              \
        __asm volatile(                                                                    \
            "movs r1, %0        \n"                                                        \
            "tst  lr, #4        \n"                                                        \
            "ite  eq            \n"                                                        \
            "mrseq r0, msp      \n"                                                        \
            "mrsne r0, psp      \n"                                                        \
            "b    ds5_fault_dispatch\n"                                                    \
            :                                                                              \
            : "I"(phase_value)                                                             \
            : "r0", "r1"                                                                   \
        );                                                                                 \
    }

DS5_FAULT_VECTOR(isr_hardfault, 24)
DS5_FAULT_VECTOR(isr_memmanage, 25)
DS5_FAULT_VECTOR(isr_busfault, 26)
DS5_FAULT_VECTOR(isr_usagefault, 27)

// The vector macro needs literal immediates, so the enum cannot be used directly there.
// Keep the two in lockstep.
static_assert(static_cast<int>(WatchdogMainLoopPhase::FaultHard) == 24);
static_assert(static_cast<int>(WatchdogMainLoopPhase::FaultMemManage) == 25);
static_assert(static_cast<int>(WatchdogMainLoopPhase::FaultBus) == 26);
static_assert(static_cast<int>(WatchdogMainLoopPhase::FaultUsage) == 27);

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
