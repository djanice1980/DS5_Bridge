//
// Created by awalol on 2026/3/4.
// Modified for DS5 Bridge companion firmware and app integration.
//

#include <algorithm>
#include <array>
#include <cstdio>
#include "bsp/board_api.h"
#include "button_functions.h"
#include "bt.h"
#include "controller_packet_compositor.h"
#include "controller_output_policy.h"
#include "controller_output_submit.h"
#include "utils.h"
#include "resample.h"
#include "audio.h"
#include "usb.h"
#include "host_input.h"
#include "controller_report.h"
#include "dualsense_input_decoder.h"
#include "feature_report_cache.h"
#include "dualsense_output.h"
#include "persona/ds4_persona.h"
#include "persona/dualsense_persona.h"
#include "persona/host_persona.h"
#include "persona/xusb360_usb.h"
#include "watchdog_telemetry.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "hardware/watchdog.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"
#ifdef ENABLE_COMPANION
#include "companion.h"
#include "host_bridge.h"
#endif

// Pico SDK support for waiting on conditions.
#include "pico/critical_section.h"

int reportSeqCounter = 0;
static constexpr uint32_t HOST_LIGHTBAR_RESTORE_DELAY_MS = 3000;
static constexpr uint32_t HOST_PERSONA_SWITCH_INPUT_FALLBACK_US = 3'000'000;

// Core1 stall gate. The threshold is bounded from the code, not tuned by feel: one core1
// iteration is at most one 10 ms Opus encode (complexity 0) plus one decode plus WDL
// resampling -- single-digit milliseconds on this core -- and the only legitimate long pause
// is flash_safe_execute() parking core1 during a link-key write, tens of milliseconds per
// sector. Three seconds is ~30x above a pessimistic stack of all of those AT ONCE, and a real
// wedge is permanent, so the extra detection latency costs nothing. The high-water log below
// exists to validate that margin from hardware: if a diag-build soak ever shows a legitimate
// gap in the same order of magnitude, this number is wrong and the log is the evidence.
static constexpr uint32_t CORE1_STALL_THRESHOLD_US = 3'000'000;
// A single over-threshold reading is NEVER trusted: the 1.6.69 boot loop was one poisoned
// measurement, not a stalled core. The stall must persist across every re-sampled reading for
// this long before the halt -- thousands of independent samples. A transient artifact cannot
// survive one fresh stamp; a genuinely wedged core1 cannot produce one.
static constexpr uint32_t CORE1_STALL_CONFIRM_US = 250'000;
static constexpr uint32_t CORE1_GAP_REPORT_THRESHOLD_US = 100'000;
static uint32_t core1_heartbeat_max_age_us = 0;
static uint32_t core1_stall_streak_start_us = 0;

enum HidDebugKind : uint8_t {
    HidDebugGetReport = 1,
    HidDebugSetReport = 2,
    HidDebugInputReport = 3,
};

static uint32_t last_input_debug_us = 0;
static uint8_t input_debug_burst_remaining = 0;

static void note_usb_input_report(uint8_t const *report, uint16_t len) {
#if !DS5_AUDIO_DEBUG_ENABLED
    (void)report;
    (void)len;
    return;
#else
    const uint32_t now = time_us_32();
    if (last_input_debug_us == 0 || static_cast<uint32_t>(now - last_input_debug_us) > 250000) {
        input_debug_burst_remaining = 8;
    }
    last_input_debug_us = now;
    if (input_debug_burst_remaining == 0) {
        return;
    }
    input_debug_burst_remaining--;
    audio_debug_note_hid_event(
        HidDebugInputReport,
        0x01,
        0,
        len,
        len > 7 && report != nullptr ? report[7] : 0
    );
#endif
}

static bool companion_lightbar_override_active() {
#ifdef ENABLE_COMPANION
    return companion_lightbar_override_enabled();
#else
    return false;
#endif
}

void controller_output_submit_usb_payload(uint8_t const *payload, uint16_t payload_len) {
    uint8_t outputData[78]{};
    controller_packet_init_bt_output_report(outputData, reportSeqCounter);
    uint16_t payloadLen = payload_len;
    if (payloadLen > sizeof(outputData) - 3) {
        payloadLen = sizeof(outputData) - 3;
    }
    if (payloadLen > 0) {
        if (payload == nullptr) {
            payloadLen = 0;
        } else {
            memcpy(outputData + 3, payload, payloadLen);
        }
    }

    const bool lightbarOverride = companion_lightbar_override_active();
#ifdef ENABLE_COMPANION
    const bool triggerIntensityChanged = companion_apply_trigger_effect_intensity(outputData + 3, payloadLen);
    uint8_t companionOutput[sizeof(outputData)]{};
    memcpy(companionOutput, outputData, sizeof(companionOutput));
    bool sanitizedHostOutput = triggerIntensityChanged || controller_output_policy_sanitize_host_lightbar_payload(
        companionOutput + 3,
        payloadLen,
        lightbarOverride
    );
    sanitizedHostOutput = controller_output_policy_sanitize_host_speaker_amp_report(companionOutput, sizeof(companionOutput))
        || sanitizedHostOutput;
    sanitizedHostOutput = controller_output_policy_sanitize_host_mic_report(companionOutput, sizeof(companionOutput))
        || sanitizedHostOutput;
    if (sanitizedHostOutput) {
        uint8_t forwardedHostReport[48]{};
        uint16_t forwardedLen = static_cast<uint16_t>(payloadLen + 1);
        if (forwardedLen > sizeof(forwardedHostReport)) {
            forwardedLen = sizeof(forwardedHostReport);
        }
        if (forwardedLen > 0) {
            forwardedHostReport[0] = 0x02;
            if (forwardedLen > 1) {
                memcpy(forwardedHostReport + 1, companionOutput + 3, forwardedLen - 1);
            }
            companion_note_host_output_report(forwardedHostReport, forwardedLen);
        }
    }
    uint8_t audioStateData[sizeof(outputData) - 3]{};
    if (payloadLen > 0) {
        memcpy(audioStateData, outputData + 3, payloadLen);
    }
    // 0x36 carries an audio-state snapshot while speaker streaming. Strip
    // game LEDs only when the companion lightbar override is explicitly on.
    controller_output_policy_sanitize_host_lightbar_payload(
        audioStateData,
        payloadLen,
        lightbarOverride
    );
    controller_output_policy_sanitize_host_speaker_amp_payload(audioStateData, payloadLen);
    controller_output_policy_sanitize_host_mic_payload(audioStateData, payloadLen);
    controller_output_policy_apply_classic_rumble_gain_payload(audioStateData, payloadLen);
    audio_set_state_data(audioStateData, static_cast<uint8_t>(payloadLen));
#else
    uint8_t audioStateData[sizeof(outputData) - 3]{};
    if (payloadLen > 0) {
        memcpy(audioStateData, outputData + 3, payloadLen);
    }
    // Must honour the override too. This copy feeds controller_output_state, and
    // controller_output_state_copy_audio_snapshot() memcpys the WHOLE state -- lightbar RGB
    // and LED flags included -- into the composed audio+state packets. Passing false here let
    // the host's lightbar reach the controller by that route while audio was active, so the
    // override held on the direct path and leaked on the audio one.
    controller_output_policy_sanitize_host_lightbar_payload(audioStateData, payloadLen, lightbarOverride);
    controller_output_policy_sanitize_host_speaker_amp_payload(audioStateData, payloadLen);
    controller_output_policy_sanitize_host_mic_payload(audioStateData, payloadLen);
    controller_output_policy_apply_classic_rumble_gain_payload(audioStateData, payloadLen);
    audio_set_state_data(audioStateData, static_cast<uint8_t>(payloadLen));
#endif
    // Keep app-controlled lighting authoritative when override is active.
    controller_output_policy_sanitize_host_lightbar_payload(outputData + 3, payloadLen, lightbarOverride);
    controller_output_policy_sanitize_host_mic_report(outputData, sizeof(outputData));
    // Haptics gain is applied to audio samples. Output report motor
    // bytes are classic rumble and must follow the rumble setting.
    bt_write_classified_output(outputData, sizeof(outputData));
    // The host drives the lightbar during its own startup -- Windows sets it blue -- which
    // lands after the connect-time restore and overwrites the configured colour. Reclaim it
    // ONCE per connection: enough to make the configured colour stick, bounded so a game
    // running a lighting effect is not fought every frame, and never a continuous re-push.
    if (!lightbarOverride
        && controller_output_policy_host_output_touches_leds(outputData + 3, payloadLen)
        && bt_claim_host_lightbar_correction()) {
        bt_schedule_lightbar_restore(HOST_LIGHTBAR_RESTORE_DELAY_MS);
    }
}

// The neutral report is the single source for both the constant and the live cache. These
// were two byte-identical 63-byte literals; nothing tied them together, so editing one and
// not the other would have gone unnoticed until a controller reported something odd.
static constexpr std::array<uint8_t, 63> kNeutralDualSenseUsbInputReport = {{
    0x7f, 0x7d, 0x7f, 0x7e, 0x00, 0x00, 0xa7,
    0x08, 0x00, 0x00, 0x00, 0x52, 0x43, 0x30, 0x41,
    0x01, 0x00, 0x0e, 0x00, 0xef, 0xff, 0x03, 0x03,
    0x7b, 0x1b, 0x18, 0xf0, 0xcc, 0x9c, 0x60, 0x00,
    0xfc, 0x80, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x09, 0x09, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xa7, 0xad, 0x60, 0x00, 0x29, 0x18, 0x00,
    0x53, 0x9f, 0x28, 0x35, 0xa5, 0xa8, 0x0c, 0x8b
}};

// Copy-initialised at compile time, so there is no window during startup where the cache
// holds anything other than the neutral report.
std::array<uint8_t, kNeutralDualSenseUsbInputReport.size()> interrupt_in_data =
    kNeutralDualSenseUsbInputReport;

critical_section_t report_cs;
volatile bool report_dirty = false;
BridgeControllerState interrupt_in_state{};
static volatile bool host_input_waiting_for_mount = false;
static volatile uint32_t host_input_fallback_until_us = 0;

static bool time_reached_u32(uint32_t now, uint32_t target) {
    return static_cast<int32_t>(now - target) >= 0;
}

// Input-forwarding hold, used by the tester so pressing PS does not open Steam while you are
// checking buttons.
//
// A LEASE, not a toggle: the app renews it while the tester is open and it expires on its own.
// A plain on/off flag would leave the controller dead to the host if the app crashed, was killed,
// or lost the bridge with the hold set -- and the user would have no way to clear it except by
// power-cycling. Expiry means the worst case is a couple of seconds of lost input.
static uint32_t host_input_hold_until_us = 0;
static bool host_input_hold_neutral_sent = false;

void host_input_hold_forwarding(uint32_t duration_us) {
    host_input_hold_until_us = duration_us == 0 ? 0 : time_us_32() + duration_us;
}

static bool host_input_hold_active(uint32_t now) {
    if (host_input_hold_until_us == 0) {
        return false;
    }
    if (time_reached_u32(now, host_input_hold_until_us)) {
        host_input_hold_until_us = 0;
        return false;
    }
    return true;
}

static bool host_input_quiet_active(uint32_t now) {
    if (!host_input_waiting_for_mount) {
        return false;
    }
    if (host_input_fallback_until_us != 0 && time_reached_u32(now, host_input_fallback_until_us)) {
        host_input_waiting_for_mount = false;
        host_input_fallback_until_us = 0;
        return false;
    }
    return true;
}

static BridgeControllerState neutral_controller_state() {
    BridgeControllerState state{};
    (void)dualsense_decode_usb_input_report(
        kNeutralDualSenseUsbInputReport.data(),
        kNeutralDualSenseUsbInputReport.size(),
        state
    );
    return state;
}

static bool host_input_ready_for_persona(HostPersonaMode persona) {
    // The stack check must come first: tud_hid_ready() answers true off stale state whenever
    // the stack is not initialised, and the send that follows would dereference a null
    // endpoint mutex. That window is closed now that disconnect is a soft detach, so this is
    // defence rather than the active fix.
    if (!usb_device_stack_ready()) {
        return false;
    }
    return persona == HostPersonaModeXusb360 ? xusb360_usb_ready() : tud_hid_ready();
}

static bool host_input_send_report_for_persona(HostPersonaMode persona, BridgeControllerState const &state) {
    if (!host_input_ready_for_persona(persona)) {
        return false;
    }

    HostPersonaInputReport report{};
    if (!host_persona_encode_input(persona, state, report)) {
        return false;
    }

    note_usb_input_report(report.bytes, report.len);
    return persona == HostPersonaModeXusb360
        ? xusb360_usb_send_report(report.bytes, report.len)
        : tud_hid_report(report.report_id, report.bytes, report.len);
}

static uint16_t ds4_copy_input_report_payload(uint8_t report_id, uint8_t *buffer, uint16_t reqlen) {
    if (report_id != kDs4InputReportId || buffer == nullptr) {
        return 0;
    }

    BridgeControllerState safe_state{};
    critical_section_enter_blocking(&report_cs);
    safe_state = interrupt_in_state;
    critical_section_exit(&report_cs);

    HostPersonaInputReport report{};
    if (!host_persona_encode_input(HostPersonaModeDs4, safe_state, report)) {
        return 0;
    }

    const uint16_t copy_len = std::min<uint16_t>(report.len, reqlen);
    if (copy_len > 0) {
        memcpy(buffer, report.bytes, copy_len);
    }
    return copy_len;
}

static bool dualsense_feature_report_may_use_bt_passthrough(
    HostPersonaMode output_persona,
    uint8_t report_id
) {
    if (report_id != 0x20 && report_id != 0x22) {
        return true;
    }

    const uint8_t upstream_type = bt_controller_type();
    if (output_persona == HostPersonaModeDualSenseEdge) {
        return upstream_type == ControllerTypeDualSenseEdge;
    }
    // Keep the two Sony identities isolated. A mismatched or non-DualSense
    // upstream controller uses the persona's synthesized identity instead.
    return upstream_type == ControllerTypeDualSense;
}

void host_input_prepare_persona_switch() {
    const HostPersonaMode current_persona = host_persona_active();
    const BridgeControllerState neutral_state = neutral_controller_state();
    const uint32_t now = time_us_32();

    critical_section_enter_blocking(&report_cs);
    interrupt_in_data = kNeutralDualSenseUsbInputReport;
    interrupt_in_state = neutral_state;
    report_dirty = false;
    host_input_waiting_for_mount = true;
    host_input_fallback_until_us = now + HOST_PERSONA_SWITCH_INPUT_FALLBACK_US;
    critical_section_exit(&report_cs);

    (void)host_input_send_report_for_persona(current_persona, neutral_state);
}

void host_input_note_usb_mounted() {
    host_input_waiting_for_mount = false;
    host_input_fallback_until_us = 0;
}

size_t controller_input_report_snapshot(uint8_t *out, size_t capacity) {
    if (out == nullptr || capacity == 0) {
        return 0;
    }
    const size_t length = capacity < interrupt_in_data.size() ? capacity : interrupt_in_data.size();
    critical_section_enter_blocking(&report_cs);
    memcpy(out, interrupt_in_data.data(), length);
    critical_section_exit(&report_cs);
    return length;
}

void reset_controller_input_report_cache() {
    BridgeControllerState default_state{};
    (void)dualsense_decode_usb_input_report(
        kNeutralDualSenseUsbInputReport.data(),
        kNeutralDualSenseUsbInputReport.size(),
        default_state
    );

    critical_section_enter_blocking(&report_cs);
    interrupt_in_data = kNeutralDualSenseUsbInputReport;
    interrupt_in_state = default_state;
    report_dirty = false;
    critical_section_exit(&report_cs);
}

void interrupt_loop() {
    // Sub-step breadcrumbs: a confirmed watchdog hang lands in this function, but every call
    // here returns immediately when read in isolation. Stamping each step means the retained
    // breadcrumb names the statement that actually blocked instead of the stage.
    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptQuietCheck);
    const uint32_t now = time_us_32();
    if (host_input_quiet_active(now)) {
        return;
    }

    // While held, keep reporting NEUTRAL rather than simply not sending. Skipping would leave
    // the host latched on whatever was pressed at the moment the hold started -- a held trigger
    // or stick would stay stuck down for the whole session.
    if (host_input_hold_active(now)) {
        if (!host_input_hold_neutral_sent) {
            host_input_hold_neutral_sent = true;
            (void)host_input_send_report_for_persona(host_persona_active(), neutral_controller_state());
        }
        return;
    }
    host_input_hold_neutral_sent = false;

    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptReadyCheck);
    const HostPersonaMode persona = host_persona_active();
    const bool xusb = persona == HostPersonaModeXusb360;
    if (!host_input_ready_for_persona(persona)) {
        return;
    }

    bool should_send = false;
    BridgeControllerState safe_state{};


    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptLockAcquire);
    critical_section_enter_blocking(&report_cs);
    if (report_dirty) {
        safe_state = interrupt_in_state;
        report_dirty = false;
        should_send = true;
    }
    critical_section_exit(&report_cs);

    // Only send to TinyUSB if we actually grabbed fresh data
    if (should_send) {
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptEncode);
        HostPersonaInputReport safe_report{};
        if (!host_persona_encode_input(persona, safe_state, safe_report)) {
            return;
        }
        note_usb_input_report(safe_report.bytes, safe_report.len);
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptSend);
        const bool queued = xusb
            ? xusb360_usb_send_report(safe_report.bytes, safe_report.len)
            : tud_hid_report(safe_report.report_id, safe_report.bytes, safe_report.len);
        if (!queued) {
            DS5_LOG("[USBHID] tud_hid_report error\n");

            // If the report failed to queue, restore the dirty flag
            // so we try again on the next loop iteration.
            watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptRelock);
            critical_section_enter_blocking(&report_cs);
            report_dirty = true;
            critical_section_exit(&report_cs);
        }
    }
    watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptTail);
}

void on_bt_data(CHANNEL_TYPE channel, uint8_t *data, uint16_t len) {
    // DS5_LOG("[Main] BT data callback: channel=%u len=%u\n", channel, len);
    if (data == nullptr || channel != INTERRUPT || len <= 2 || data[1] != 0x31) {
        return;
    }

    if ((data[2] & 0x02) != 0) {
        // Only form data + 4 once there is something at that offset. audio_mic_add_packet
        // treats a zero length as a no-op, so the old call was harmless in practice, but at
        // len 3 or 4 it still built a pointer past the end of the buffer to pass in.
        if (len > 4) {
            audio_mic_add_packet(data + 4, static_cast<uint16_t>(len - 4));
        }
        return;
    }

    if (len < 3 + interrupt_in_data.size()) {
        return;
    }

    uint8_t controller_report[63];
    memcpy(controller_report, data + 3, sizeof(controller_report));
    set_headset((controller_report[53] & 1) != 0);
#ifdef ENABLE_COMPANION
    companion_process_controller_report(controller_report, sizeof(controller_report));
#endif

    BridgeControllerState controller_state{};
    if (!dualsense_decode_usb_input_report(controller_report, sizeof(controller_report), controller_state)) {
        return;
    }

    // We add the critical section here to avoid any race conditions when writing to the interrupt_in_data buffer,
    // which is shared between the main loop and this callback.
    // The critical section ensures that only one thread can access the buffer at a time,
    // preventing data corruption and ensuring thread safety.
    // We also set the report_dirty flag to true to indicate that new data is available
    //  and needs to be sent in the next interrupt report.
    critical_section_enter_blocking(&report_cs);
    memcpy(interrupt_in_data.data(), controller_report, sizeof(controller_report));
    interrupt_in_state = controller_state;
    report_dirty = true;
    critical_section_exit(&report_cs);
#ifdef ENABLE_COMPANION
    companion_update_controller_report(controller_report, sizeof(controller_report));
#endif
}

// Invoked when received GET_REPORT control request
// Application must fill buffer report's content and return its length.
// Return zero will cause the stack to STALL request
uint16_t tud_hid_get_report_cb(uint8_t itf, uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer,
                               uint16_t reqlen) {
    (void) itf;
    (void) report_id;
    (void) report_type;
    (void) buffer;
    (void) reqlen;

#ifdef ENABLE_COMPANION
    if (itf == host_persona_keyboard_hid_instance()) {
        return 0;
    }
#endif

    const HostPersonaMode active_persona = host_persona_active();
    if (active_persona == HostPersonaModeDs4) {
        if (report_type == HID_REPORT_TYPE_INPUT) {
            return ds4_copy_input_report_payload(report_id, buffer, reqlen);
        }
        if (report_type == HID_REPORT_TYPE_FEATURE) {
            return ds4_persona_get_feature_report(report_id, buffer, reqlen);
        }
        return 0;
    }

    audio_debug_note_hid_event(
        HidDebugGetReport,
        report_id,
        static_cast<uint8_t>(report_type),
        reqlen,
        0
    );
    if (report_type != HID_REPORT_TYPE_FEATURE) {
        return 0;
    }

    // Cached BT feature report, on the stack: [0] is the report id, the payload follows --
    // the same layout the old heap vector carried.
    uint8_t cached_feature[kFeatureReportCacheSlotBytes];
    uint16_t cached_len = 0;
    if (dualsense_feature_report_may_use_bt_passthrough(active_persona, report_id)) {
        cached_len = get_feature_data(report_id, cached_feature, sizeof(cached_feature));
    }
    if (cached_len > 0 && buffer != nullptr) {
        const uint16_t available = static_cast<uint16_t>(cached_len - 1);
        const uint16_t copy_len = available < reqlen ? available : reqlen;
        if (copy_len > 0) {
            memcpy(buffer, cached_feature + 1, copy_len);
        }

        return copy_len;
    }

    return dualsense_persona_get_feature_report(active_persona, report_id, buffer, reqlen);
}

// Invoked when received SET_REPORT control request or
// received data on OUT endpoint ( Report ID = 0, Type = 0 )
void tud_hid_set_report_cb(uint8_t itf, uint8_t report_id, hid_report_type_t report_type, uint8_t const *buffer,
                           uint16_t bufsize) {
    (void) itf;
    (void) report_id;
    (void) report_type;
    (void) buffer;
    (void) bufsize;

#ifdef ENABLE_COMPANION
    if (itf == host_persona_keyboard_hid_instance()) {
        return;
    }
#endif

    const HostPersonaMode active_persona = host_persona_active();
    audio_debug_note_hid_event(
        HidDebugSetReport,
        report_id,
        static_cast<uint8_t>(report_type),
        bufsize,
        bufsize > 0 && buffer != nullptr ? buffer[0] : 0
    );

    if (active_persona == HostPersonaModeDs4) {
        if (report_type == HID_REPORT_TYPE_FEATURE) {
            ds4_persona_set_feature_report(report_id, buffer, bufsize);
            return;
        }

        uint8_t output_report[64]{};
        uint8_t const *output_data = buffer;
        uint16_t output_len = bufsize;
        if (report_id != 0) {
            output_report[0] = report_id;
            const uint16_t copy_len = static_cast<uint16_t>(std::min<uint16_t>(bufsize, sizeof(output_report) - 1));
            if (copy_len > 0 && buffer != nullptr) {
                memcpy(output_report + 1, buffer, copy_len);
            }
            output_data = output_report;
            output_len = static_cast<uint16_t>(copy_len + 1);
        }

        uint8_t payload[ds5::output::kCommonPayloadSize]{};
        uint16_t payload_len = 0;
        if (host_persona_decode_output_to_ds5_payload(
            active_persona,
            output_data,
            output_len,
            payload,
            sizeof(payload),
            payload_len
        )) {
            usb_note_hid_output();
#ifdef ENABLE_COMPANION
            companion_note_trigger_trace_report(CompanionTriggerTraceHost, output_data, output_len);
            companion_note_feedback_trace_report(CompanionFeedbackTraceHost, output_data, output_len);
#endif
            controller_output_submit_usb_payload(payload, payload_len);
        }
        return;
    }

    // INTERRUPT OUT
    if (report_id == 0) {
        if (buffer == nullptr || bufsize == 0) {
            return;
        }
        switch (buffer[0]) {
            case 0x02: {
                usb_note_hid_output();
#ifdef ENABLE_COMPANION
                companion_note_trigger_trace_report(CompanionTriggerTraceHost, buffer, bufsize);
                companion_note_feedback_trace_report(CompanionFeedbackTraceHost, buffer, bufsize);
#endif
                controller_output_submit_usb_payload(buffer + 1, static_cast<uint16_t>(bufsize - 1));
                break;
            }
        }
    }
    if (
        report_id == 0x80
        || report_id == 0x60
        || report_id == 0x62
        || report_id == 0x61
    ) {
        set_feature_data(report_id,buffer,bufsize);
        return;
    }
}

int main() {
#if SYS_CLOCK_KHZ != 150000
    vreg_set_voltage(VREG_VOLTAGE_1_20);
    sleep_ms(1000);
    set_sys_clock_khz(SYS_CLOCK_KHZ, true);
#endif

    board_init();
    watchdog_telemetry_boot_capture(); // Before watchdog_enable() clobbers the reset marker.
    usb_device_stack_init_disconnected();
#ifdef ENABLE_COMPANION
    // Come up as the companion-only device so the app can reach the bridge before any
    // controller has connected. A controller arriving cancels this and attaches the full
    // device instead.
    usb_attach_companion_only_idle();
#endif
    board_init_after_tusb();

    if (cyw43_arch_init()) {
        DS5_LOG("Failed to initialize CYW43\n");
        return 1;
    }
    cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, false);

    if (watchdog_caused_reboot()) {
        DS5_LOG("Rebooted by Watchdog!\n");
        // Blink the LED three times after a crash reboot.
        for (int i = 0;i < 6;i++) {
            if (i % 2 == 0) {
                cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, true);
            }else {
                cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, false);
            }
            sleep_ms(500);
        }
    } else {
        DS5_LOG("Clean boot\n");
    }
  
    // Initialize the critical section for the report buffer
    critical_section_init(&report_cs);
#ifdef ENABLE_COMPANION
    companion_init();
#endif

    bt_init();
    bt_register_data_callback(on_bt_data);

    audio_init();

#ifdef DS5_PAIRING_DIAG
    usb_diag_force_connect();
#endif

    watchdog_enable(1000, true);

    while (1) {
        // Core1 liveness gate, BEFORE any feed this iteration. Core1 runs the whole audio
        // pipeline and used to sit outside the watchdog entirely: a wedge there left the
        // bridge running forever with dead audio and no diagnostic. If the heartbeat goes
        // silent past the threshold, stamp the dedicated breadcrumb and halt this loop --
        // withholding every feed -- so the 1s watchdog resets us with a record that names
        // core1 rather than whichever phase stamped last.
        const uint32_t core1_age_us = audio_core1_heartbeat_age_us();
        if (core1_age_us <= CORE1_STALL_THRESHOLD_US) {
            core1_stall_streak_start_us = 0;
        } else {
            const uint32_t stall_now_us = time_us_32();
            if (core1_stall_streak_start_us == 0) {
                // | 1 keeps a legitimate 0 timestamp from reading as "no streak".
                core1_stall_streak_start_us = stall_now_us | 1;
            } else if (static_cast<uint32_t>(stall_now_us - core1_stall_streak_start_us) > CORE1_STALL_CONFIRM_US) {
                watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Core1Stall);
                DS5_LOG("[WD] core1 heartbeat silent for %u us (confirmed) -- halting for watchdog reset\n",
                    static_cast<unsigned>(core1_age_us));
                while (true) {
                    tight_loop_contents();
                }
            }
        }
        if (core1_age_us > core1_heartbeat_max_age_us) {
            core1_heartbeat_max_age_us = core1_age_us;
            if (core1_heartbeat_max_age_us > CORE1_GAP_REPORT_THRESHOLD_US) {
                DS5_LOG("[WD] core1 heartbeat gap high-water: %u us\n",
                    static_cast<unsigned>(core1_heartbeat_max_age_us));
            }
        }

        // Each stage stamps a breadcrumb into the watchdog scratch registers, which survive
        // the reset. If the 1s watchdog fires, the next boot reports exactly which stage was
        // running -- otherwise a hang is indistinguishable from any other restart.
        // Feed the watchdog after EVERY phase, matching upstream. With a single feed per
        // iteration the 1s budget was shared across all phases, so the watchdog fired
        // wherever the clock happened to run out rather than in the phase that was slow --
        // which made the retained breadcrumb point at the wrong place.
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Cyw43);
        cyw43_arch_poll();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::TinyUsb);
        tud_task();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptBeforeAudio);
        interrupt_loop();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::UsbPower);
        usb_pm_poll();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Audio);
        audio_loop();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Button);
        button_check();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Lightbar);
        bt_lightbar_loop();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Rssi);
        bt_signal_strength_loop();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Inquiry);
        bt_inquiry_loop();
        watchdog_update();
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::ConnectionRecovery);
        bt_connection_recovery_loop();
        watchdog_update();
#ifdef ENABLE_COMPANION
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::Companion);
        // Keep the companion's bulk OUT endpoint armed. Without this a single lost arm means
        // every command from the app disappears for the rest of the session while the app
        // still reads status happily over control transfers.
        host_bridge_service();
        companion_loop();
        watchdog_update();
#endif
        watchdog_telemetry_note_phase(WatchdogMainLoopPhase::InterruptAfterCompanion);
        interrupt_loop();
    }
}
