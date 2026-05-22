//
// Created by awalol on 2026/3/4.
// Modified for DS5 Bridge companion firmware and app integration.
//

#include <cstdio>
#include "bsp/board_api.h"
#include "bt.h"
#include "utils.h"
#include "resample.h"
#include "audio.h"
#include "usb.h"
#include "controller_report.h"
#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "hardware/watchdog.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"
#ifdef ENABLE_COMPANION
#include "companion.h"
#endif

// Pico SDK support for waiting on conditions.
#include "pico/critical_section.h"

int reportSeqCounter = 0;
static constexpr uint32_t HOST_LIGHTBAR_RESTORE_DELAY_MS = 3000;

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

uint8_t interrupt_in_data[63] = {
    0x7f, 0x7d, 0x7f, 0x7e, 0x00, 0x00, 0xa7,
    0x08, 0x00, 0x00, 0x00, 0x52, 0x43, 0x30, 0x41,
    0x01, 0x00, 0x0e, 0x00, 0xef, 0xff, 0x03, 0x03,
    0x7b, 0x1b, 0x18, 0xf0, 0xcc, 0x9c, 0x60, 0x00,
    0xfc, 0x80, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00,
    0x00, 0x00, 0x09, 0x09, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xa7, 0xad, 0x60, 0x00, 0x29, 0x18, 0x00,
    0x53, 0x9f, 0x28, 0x35, 0xa5, 0xa8, 0x0c, 0x8b
};

critical_section_t report_cs;
volatile bool report_dirty = false;

void reset_controller_input_report_cache() {
    static constexpr uint8_t default_interrupt_in_data[63] = {
        0x7f, 0x7d, 0x7f, 0x7e, 0x00, 0x00, 0xa7,
        0x08, 0x00, 0x00, 0x00, 0x52, 0x43, 0x30, 0x41,
        0x01, 0x00, 0x0e, 0x00, 0xef, 0xff, 0x03, 0x03,
        0x7b, 0x1b, 0x18, 0xf0, 0xcc, 0x9c, 0x60, 0x00,
        0xfc, 0x80, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00,
        0x00, 0x00, 0x09, 0x09, 0x00, 0x00, 0x00, 0x00,
        0x00, 0xa7, 0xad, 0x60, 0x00, 0x29, 0x18, 0x00,
        0x53, 0x9f, 0x28, 0x35, 0xa5, 0xa8, 0x0c, 0x8b
    };

    critical_section_enter_blocking(&report_cs);
    memcpy(interrupt_in_data, default_interrupt_in_data, sizeof(interrupt_in_data));
    report_dirty = false;
    critical_section_exit(&report_cs);
}

void interrupt_loop() {
    if (!tud_hid_ready()) return;

    bool should_send = false;
    // Local buffer to hold the report data while we prepare it to send. 
    uint8_t safe_report[63];


    critical_section_enter_blocking(&report_cs);
    if (report_dirty) {
        memcpy(safe_report, interrupt_in_data, 63);
        report_dirty = false;
        should_send = true;
    }
    critical_section_exit(&report_cs);

    // Only send to TinyUSB if we actually grabbed fresh data
    if (should_send) {
        note_usb_input_report(safe_report, sizeof(safe_report));
        if (!tud_hid_report(0x01, safe_report, 63)) {
            DS5_LOG("[USBHID] tud_hid_report error\n");
            
            // If the report failed to queue, restore the dirty flag 
            // so we try again on the next loop iteration.
            critical_section_enter_blocking(&report_cs);
            report_dirty = true;
            critical_section_exit(&report_cs);
        }
    }
}

void on_bt_data(CHANNEL_TYPE channel, uint8_t *data, uint16_t len) {
    // DS5_LOG("[Main] BT data callback: channel=%u len=%u\n", channel, len);
    if (data == nullptr || channel != INTERRUPT || len <= 2 || data[1] != 0x31) {
        return;
    }

    if ((data[2] & 0x02) != 0) {
        audio_mic_add_packet(data + 4, len > 4 ? static_cast<uint16_t>(len - 4) : 0);
        return;
    }

    if (len < 3 + sizeof(interrupt_in_data)) {
        return;
    }

    uint8_t controller_report[63];
    memcpy(controller_report, data + 3, sizeof(controller_report));
    set_headset((controller_report[53] & 1) != 0);
#ifdef ENABLE_COMPANION
    companion_process_controller_report(controller_report, sizeof(controller_report));
#endif

    // We add the critical section here to avoid any race conditions when writing to the interrupt_in_data buffer,
    // which is shared between the main loop and this callback.
    // The critical section ensures that only one thread can access the buffer at a time,
    // preventing data corruption and ensuring thread safety.
    // We also set the report_dirty flag to true to indicate that new data is available
    //  and needs to be sent in the next interrupt report.
    critical_section_enter_blocking(&report_cs);
    memcpy(interrupt_in_data, controller_report, sizeof(controller_report));
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
    if (itf == COMPANION_HID_INSTANCE) {
        return companion_get_report(report_id, report_type, buffer, reqlen);
    }
    if (itf == KEYBOARD_HID_INSTANCE) {
        return 0;
    }
#endif

    audio_debug_note_hid_event(
        HidDebugGetReport,
        report_id,
        static_cast<uint8_t>(report_type),
        reqlen,
        0
    );
    std::vector<uint8_t> feature_data = get_feature_data(report_id, reqlen);
    if (feature_data.empty() || buffer == nullptr) {
        return 0;
    }

    const uint16_t available = static_cast<uint16_t>(feature_data.size() - 1);
    const uint16_t copy_len = available < reqlen ? available : reqlen;
    if (copy_len > 0) {
        memcpy(buffer, feature_data.data() + 1, copy_len);
    }

    return copy_len;
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
    if (itf == COMPANION_HID_INSTANCE) {
        companion_set_report(report_id, report_type, buffer, bufsize);
        return;
    }
    if (itf == KEYBOARD_HID_INSTANCE) {
        return;
    }
#endif

    audio_debug_note_hid_event(
        HidDebugSetReport,
        report_id,
        static_cast<uint8_t>(report_type),
        bufsize,
        bufsize > 0 && buffer != nullptr ? buffer[0] : 0
    );

    // INTERRUPT OUT
    if (report_id == 0) {
        if (buffer == nullptr || bufsize == 0) {
            return;
        }
        switch (buffer[0]) {
            case 0x02: {
                usb_note_hid_output();
                uint8_t outputData[78]{};
                outputData[0] = 0x31;
                outputData[1] = reportSeqCounter << 4;
                reportSeqCounter = (reportSeqCounter + 1) & 0x0F;
                outputData[2] = 0x10;
                uint16_t payloadLen = 0;
                if (bufsize > 1) {
                    payloadLen = bufsize - 1;
                    if (payloadLen > sizeof(outputData) - 3) {
                        payloadLen = sizeof(outputData) - 3;
                    }
                    memcpy(outputData + 3, buffer + 1, payloadLen);
                }
                const bool lightbarOverride = companion_lightbar_override_active();
                const bool hostClearsLeds = dualsense_host_output_clears_leds(outputData + 3, payloadLen);
#ifdef ENABLE_COMPANION
                const bool triggerIntensityChanged = companion_apply_trigger_effect_intensity(outputData + 3, payloadLen);
                uint8_t companionOutput[sizeof(outputData)]{};
                memcpy(companionOutput, outputData, sizeof(companionOutput));
                bool sanitizedHostOutput = triggerIntensityChanged || sanitize_dualsense_host_output_payload(
                    companionOutput + 3,
                    payloadLen,
                    lightbarOverride
                );
                sanitizedHostOutput = bt_sanitize_host_speaker_amp_ownership(companionOutput, sizeof(companionOutput))
                    || sanitizedHostOutput;
                sanitizedHostOutput = bt_sanitize_host_mic_ownership(companionOutput, sizeof(companionOutput))
                    || sanitizedHostOutput;
                if (sanitizedHostOutput) {
                    uint8_t forwardedHostReport[48]{};
                    uint16_t forwardedLen = bufsize > sizeof(forwardedHostReport)
                        ? sizeof(forwardedHostReport)
                        : bufsize;
                    if (forwardedLen > 0) {
                        forwardedHostReport[0] = buffer[0];
                        memcpy(forwardedHostReport + 1, companionOutput + 3, forwardedLen - 1);
                        companion_note_host_output_report(forwardedHostReport, forwardedLen);
                    }
                }
                uint8_t audioStateData[sizeof(outputData) - 3]{};
                if (payloadLen > 0) {
                    memcpy(audioStateData, outputData + 3, payloadLen);
                }
                // 0x36 carries an audio-state snapshot while speaker streaming. Strip
                // game LEDs only when the companion lightbar override is explicitly on.
                sanitize_dualsense_host_output_payload(
                    audioStateData,
                    payloadLen,
                    lightbarOverride
                );
                bt_sanitize_host_speaker_amp_ownership_payload(audioStateData, payloadLen);
                bt_sanitize_host_mic_ownership_payload(audioStateData, payloadLen);
                bt_apply_classic_rumble_gain_payload(audioStateData, payloadLen);
                audio_set_state_data(audioStateData, static_cast<uint8_t>(payloadLen));
#else
                uint8_t audioStateData[sizeof(outputData) - 3]{};
                if (payloadLen > 0) {
                    memcpy(audioStateData, outputData + 3, payloadLen);
                }
                sanitize_dualsense_host_output_payload(audioStateData, payloadLen);
                bt_sanitize_host_speaker_amp_ownership_payload(audioStateData, payloadLen);
                bt_sanitize_host_mic_ownership_payload(audioStateData, payloadLen);
                bt_apply_classic_rumble_gain_payload(audioStateData, payloadLen);
                audio_set_state_data(audioStateData, static_cast<uint8_t>(payloadLen));
#endif
                // Keep app-controlled lighting authoritative when override is active.
                sanitize_dualsense_host_output_payload(outputData + 3, payloadLen, lightbarOverride);
                bt_sanitize_host_mic_ownership(outputData, sizeof(outputData));
                // Haptics gain is applied to audio samples. Output report motor
                // bytes are classic rumble and must follow the rumble setting.
                bt_write_classified_output(outputData, sizeof(outputData));
                if (hostClearsLeds && !lightbarOverride) {
                    bt_schedule_lightbar_restore(HOST_LIGHTBAR_RESTORE_DELAY_MS);
                }
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
    vreg_set_voltage(VREG_VOLTAGE_1_20);
    sleep_ms(1000);
    set_sys_clock_khz(320000, true);

    board_init();
    usb_device_stack_init_disconnected();
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

    watchdog_enable(1000, true);

    while (1) {
        watchdog_update();
        cyw43_arch_poll();
        tud_task();
        usb_pm_poll();
        audio_loop();
        bt_lightbar_loop();
        bt_signal_strength_loop();
        bt_connection_recovery_loop();
#ifdef ENABLE_COMPANION
        companion_loop();
#endif
        interrupt_loop();
    }
}
