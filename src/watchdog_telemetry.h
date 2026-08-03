#ifndef DS5_BRIDGE_WATCHDOG_TELEMETRY_H
#define DS5_BRIDGE_WATCHDOG_TELEMETRY_H

#include <cstdint>

enum class WatchdogMainLoopPhase : uint8_t {
    Boot = 0,
    Cyw43 = 1,
    TinyUsb = 2,
    InterruptBeforeAudio = 3,
    UsbPower = 4,
    Audio = 5,
    Button = 6,
    Lightbar = 7,
    Rssi = 8,
    Inquiry = 9,
    ConnectionRecovery = 10,
    FeaturePrefetch = 11,
    OutputRetry = 12,
    Companion = 13,
    InterruptAfterCompanion = 14,
    FirmwareLogFlush = 15,
    // Sub-steps INSIDE interrupt_loop(). The phase-level breadcrumb narrowed a confirmed
    // hang to interrupt_loop, but every statement in it returns immediately on inspection
    // -- so the breadcrumb has to name the exact statement rather than the stage.
    InterruptQuietCheck = 16,
    InterruptReadyCheck = 17,
    InterruptLockAcquire = 18,
    InterruptEncode = 19,
    InterruptSend = 20,
    InterruptRelock = 21,
    InterruptTail = 22,
    // An SDK/TinyUSB panic() was reached. panic() is noreturn and spins with interrupts
    // off, so the watchdog is the only thing that ends it -- which is indistinguishable
    // from a stall unless we stamp it on the way in.
    Panic = 23,
    // CPU faults. The SDK default for these is a breakpoint that locks the core until the
    // watchdog fires, which looks exactly like a stall and never reaches panic().
    FaultHard = 24,
    FaultMemManage = 25,
    FaultBus = 26,
    FaultUsage = 27,
    // Steps within the USB send, to separate "waiting on the endpoint" from "stuck in the
    // hardware layer". The last one entered before a reset is the one that did not return.
    SendClaim = 28,
    SendXfer = 29,
    SendDcdXfer = 30,
};

struct WatchdogTelemetrySnapshot {
    // Broad predicate -- matches the 3-blink boot indicator in main().
    bool prior_watchdog_timeout;
    // Narrow SDK predicate (requires the watchdog_enable magic in scratch[4]). Reported
    // separately because it can disagree with the broad one, and gating on it silently
    // threw away good breadcrumbs.
    bool prior_watchdog_enable_timeout;
    bool prior_snapshot_valid;
    uint8_t prior_phase;
    uint32_t prior_sequence;
    uint32_t prior_phase_entered_at_ms;
    // Fault records only: the data address that faulted, and what the main loop was doing
    // before the fault vector overwrote the phase byte.
    uint32_t prior_fault_address;
    uint8_t prior_phase_before_fault;
    // First argument register at the fault. For the mutex crash this is the mutex pointer,
    // which is what separates "the pointer is garbage" from "its contents are".
    uint32_t prior_fault_arg0;
};

// Capture must happen before watchdog_enable() overwrites the SDK reset marker.
void watchdog_telemetry_boot_capture();
void watchdog_telemetry_note_phase(WatchdogMainLoopPhase phase);
void watchdog_telemetry_snapshot(WatchdogTelemetrySnapshot *snapshot);
// Worst single-phase duration observed since boot, so a slow phase is visible without
// having to wait for it to trip the watchdog.
void watchdog_telemetry_worst_phase(uint8_t *phase, uint32_t *duration_us);

// Record a CPU fault. On a fault the sequence/timestamp words carry the faulting PC and the
// fault status register instead -- a crash address identifies the defect, a timestamp does
// not. The phase byte says which record shape applies, so nothing is ambiguous.
void watchdog_telemetry_note_fault(
    WatchdogMainLoopPhase phase,
    uint32_t pc,
    uint32_t status,
    uint32_t fault_address,
    uint32_t arg0
);
const char *watchdog_telemetry_phase_name(uint8_t phase);

#endif // DS5_BRIDGE_WATCHDOG_TELEMETRY_H
