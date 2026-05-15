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
#include "hardware/clocks.h"
#include "hardware/vreg.h"
#include "hardware/watchdog.h"
#include "pico/cyw43_arch.h"
#ifdef ENABLE_COMPANION
#include "companion.h"
#endif

// Pico SDK support for waiting on conditions.
#include "pico/critical_section.h"

int reportSeqCounter = 0;

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

    if ((data[56] & 1) != (interrupt_in_data[53] & 1)) {
        set_headset(data[56] & 1);
    }

    uint8_t controller_report[63];
    memcpy(controller_report, data + 3, sizeof(controller_report));
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

    std::vector<uint8_t> feature_data = get_feature_data(report_id, reqlen);
    if (!feature_data.empty()) {
        memcpy(buffer, feature_data.data() + 1, feature_data.size() - 1);
    }

    return feature_data.empty() ? 0 : feature_data.size() - 1;
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

    // INTERRUPT OUT
    if (report_id == 0) {
        switch (buffer[0]) {
            case 0x02: {
                usb_note_hid_output();
                uint8_t outputData[78]{};
                outputData[0] = 0x31;
                outputData[1] = reportSeqCounter << 4;
                if (++reportSeqCounter == 256) {
                    reportSeqCounter = 0;
                }
                outputData[2] = 0x10;
                uint16_t payloadLen = 0;
                if (bufsize > 1) {
                    payloadLen = bufsize - 1;
                    if (payloadLen > sizeof(outputData) - 3) {
                        payloadLen = sizeof(outputData) - 3;
                    }
                    memcpy(outputData + 3, buffer + 1, payloadLen);
                }
                const bool hostClearsLeds = dualsense_host_output_clears_leds(outputData + 3, payloadLen);
#ifdef ENABLE_COMPANION
                uint8_t companionOutput[sizeof(outputData)]{};
                memcpy(companionOutput, outputData, sizeof(companionOutput));
                bool sanitizedHostOutput = sanitize_dualsense_host_output_payload(
                    companionOutput + 3,
                    payloadLen,
                    companion_lightbar_override_enabled()
                );
                sanitizedHostOutput = bt_sanitize_host_speaker_amp_ownership(companionOutput, sizeof(companionOutput))
                    || sanitizedHostOutput;
                sanitizedHostOutput = companion_apply_trigger_effect_intensity(companionOutput + 3, payloadLen)
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
                    companion_lightbar_override_enabled()
                );
                audio_set_state_data(audioStateData, static_cast<uint8_t>(payloadLen));
#else
                uint8_t audioStateData[sizeof(outputData) - 3]{};
                if (payloadLen > 0) {
                    memcpy(audioStateData, outputData + 3, payloadLen);
                }
                sanitize_dualsense_host_output_payload(audioStateData, payloadLen);
                audio_set_state_data(audioStateData, static_cast<uint8_t>(payloadLen));
#endif
                bt_write(outputData, sizeof(outputData));
                if (hostClearsLeds) {
                    bt_schedule_lightbar_restore(750);
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
        set_feature_data(report_id,const_cast<uint8_t *>(buffer),bufsize);
        return;
    }
}

int main() {
    vreg_set_voltage(VREG_VOLTAGE_1_20);
    sleep_ms(1000);
    set_sys_clock_khz(320000, true);

    board_init();
    tusb_rhport_init_t dev_init = {
        .role = TUSB_ROLE_DEVICE,
        .speed = TUSB_SPEED_FULL
    };
    tusb_init(BOARD_TUD_RHPORT, &dev_init);
    tud_disconnect();
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
#ifdef ENABLE_COMPANION
        companion_loop();
#endif
        interrupt_loop();
    }
}
