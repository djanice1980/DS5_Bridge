#include "watchdog_telemetry.h"

#include <cstring>

#include "pico.h"
#include "hardware/structs/watchdog.h"
#include "hardware/watchdog.h"
#include "pico/time.h"

namespace {

// Upper 24 bits are the schema marker; the low byte is the checksum.
// Schema 2 adds the fault detail words in scratch[5]/[6]. scratch[4] is the SDK's
// watchdog_enable magic and must never be touched; scratch[5..7] are only used by
// watchdog_reboot(), which this firmware no longer calls.
constexpr uint32_t kScratchSignature = 0x44540200u; // "DT", schema 2.

WatchdogTelemetrySnapshot state{};
uint32_t current_sequence = 0;
uint8_t active_phase = 0;
uint32_t active_phase_started_us = 0;
uint8_t worst_phase_id = 0;
uint32_t worst_phase_us = 0;

uint32_t now_ms() {
    return static_cast<uint32_t>(time_us_64() / 1000u);
}

uint8_t __not_in_flash_func(crc8_update)(uint8_t crc, uint8_t value) {
    crc ^= value;
    for (uint8_t bit = 0; bit < 8; ++bit) {
        crc = (crc & 0x80u) != 0
            ? static_cast<uint8_t>((crc << 1u) ^ 0x07u)
            : static_cast<uint8_t>(crc << 1u);
    }
    return crc;
}

uint8_t __not_in_flash_func(scratch_crc)(
    uint32_t word1,
    uint32_t word2,
    uint32_t word3,
    uint32_t word4,
    uint32_t word5
) {
    uint8_t crc = 0;
    const uint32_t words[] = {word1, word2, word3, word4, word5};
    for (uint32_t word : words) {
        for (uint8_t shift = 0; shift < 32; shift += 8) {
            crc = crc8_update(
                crc,
                static_cast<uint8_t>(word >> shift)
            );
        }
    }
    return crc;
}

void __not_in_flash_func(commit_words)(
    uint32_t word1,
    uint32_t word2,
    uint32_t word3,
    uint32_t word4,
    uint32_t word5
) {
    // Publish the signature last. A reset partway through this update is reported as an
    // invalid breadcrumb instead of a misleading valid phase.
    watchdog_hw->scratch[0] = 0;
    watchdog_hw->scratch[1] = word1;
    watchdog_hw->scratch[2] = word2;
    watchdog_hw->scratch[3] = word3;
    watchdog_hw->scratch[5] = word4;
    watchdog_hw->scratch[6] = word5;
    watchdog_hw->scratch[0] =
        kScratchSignature | scratch_crc(word1, word2, word3, word4, word5);
}

void commit_phase(WatchdogMainLoopPhase phase) {
    commit_words(static_cast<uint8_t>(phase), ++current_sequence, now_ms(), 0, 0);
}

} // namespace

void watchdog_telemetry_boot_capture() {
    std::memset(&state, 0, sizeof(state));

    const bool timeout_reset = watchdog_caused_reboot();
    const bool enable_timeout_reset = watchdog_enable_caused_reboot();
    const uint32_t word0 = watchdog_hw->scratch[0];
    const uint32_t word1 = watchdog_hw->scratch[1];
    const uint32_t word2 = watchdog_hw->scratch[2];
    const uint32_t word3 = watchdog_hw->scratch[3];
    const uint32_t word4 = watchdog_hw->scratch[5];
    const uint32_t word5 = watchdog_hw->scratch[6];
    const bool signature_valid =
        (word0 & 0xffffff00u) == kScratchSignature;
    const bool crc_valid =
        static_cast<uint8_t>(word0) == scratch_crc(word1, word2, word3, word4, word5);

    state.prior_watchdog_timeout = timeout_reset;
    state.prior_watchdog_enable_timeout = enable_timeout_reset;
    // Validity is a property of the breadcrumb alone. Tying it to the reset predicate meant
    // a disagreeing predicate discarded a perfectly good phase record.
    state.prior_snapshot_valid = signature_valid && crc_valid;
    if (state.prior_snapshot_valid) {
        state.prior_phase = static_cast<uint8_t>(word1);
        state.prior_sequence = word2;
        state.prior_phase_entered_at_ms = word3;
        state.prior_fault_address = word4;
        state.prior_phase_before_fault = static_cast<uint8_t>(word5);
        current_sequence = word2;
    }

    commit_phase(WatchdogMainLoopPhase::Boot);
}

void watchdog_telemetry_note_phase(WatchdogMainLoopPhase phase) {
    // Close out the phase that was running and remember the worst one seen. time_us_32() is
    // a bare timer read, so this stays cheap enough to run on every phase of every iteration.
    const uint32_t now_us = time_us_32();
    if (active_phase_started_us != 0) {
        const uint32_t elapsed = now_us - active_phase_started_us;
        if (elapsed > worst_phase_us) {
            worst_phase_us = elapsed;
            worst_phase_id = active_phase;
        }
    }
    active_phase = static_cast<uint8_t>(phase);
    active_phase_started_us = now_us;

    commit_phase(phase);
}

void __not_in_flash_func(watchdog_telemetry_note_fault)(
    WatchdogMainLoopPhase phase,
    uint32_t pc,
    uint32_t status,
    uint32_t fault_address
) {
    // Runs from RAM: a fault can be raised while executing from flash in a state where
    // fetching more flash is exactly what fails.
    //
    // active_phase is captured too, because stamping the fault phase overwrites the record
    // of what the main loop was doing -- and that is the context that makes the crash
    // address meaningful.
    commit_words(static_cast<uint8_t>(phase), status, pc, fault_address, active_phase);
}

void watchdog_telemetry_worst_phase(uint8_t *phase, uint32_t *duration_us) {
    if (phase != nullptr) {
        *phase = worst_phase_id;
    }
    if (duration_us != nullptr) {
        *duration_us = worst_phase_us;
    }
}

void watchdog_telemetry_snapshot(WatchdogTelemetrySnapshot *snapshot) {
    if (snapshot != nullptr) {
        *snapshot = state;
    }
}

const char *watchdog_telemetry_phase_name(uint8_t phase) {
    switch (static_cast<WatchdogMainLoopPhase>(phase)) {
        case WatchdogMainLoopPhase::Boot:
            return "boot";
        case WatchdogMainLoopPhase::Cyw43:
            return "cyw43";
        case WatchdogMainLoopPhase::TinyUsb:
            return "tinyusb";
        case WatchdogMainLoopPhase::InterruptBeforeAudio:
            return "interrupt-before-audio";
        case WatchdogMainLoopPhase::UsbPower:
            return "usb-power";
        case WatchdogMainLoopPhase::Audio:
            return "audio";
        case WatchdogMainLoopPhase::Button:
            return "button";
        case WatchdogMainLoopPhase::Lightbar:
            return "lightbar";
        case WatchdogMainLoopPhase::Rssi:
            return "rssi";
        case WatchdogMainLoopPhase::Inquiry:
            return "inquiry";
        case WatchdogMainLoopPhase::ConnectionRecovery:
            return "connection-recovery";
        case WatchdogMainLoopPhase::FeaturePrefetch:
            return "feature-prefetch";
        case WatchdogMainLoopPhase::OutputRetry:
            return "output-retry";
        case WatchdogMainLoopPhase::Companion:
            return "companion";
        case WatchdogMainLoopPhase::InterruptAfterCompanion:
            return "interrupt-after-companion";
        case WatchdogMainLoopPhase::FirmwareLogFlush:
            return "firmware-log-flush";
        default:
            return "unknown";
    }
}
