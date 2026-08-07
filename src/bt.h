//
// Created by awalol on 2026/3/4.
// Modified for DS5 Bridge companion firmware and app integration.
//

#ifndef DS5_BRIDGE_BT_H
#define DS5_BRIDGE_BT_H

#include <cstdint>
#include <vector>

enum CHANNEL_TYPE {
    INTERRUPT,
    CONTROL
};

enum ControllerType : uint8_t {
    ControllerTypeUnknown = 0,
    ControllerTypeDualSense = 1,
    ControllerTypeDualSenseEdge = 2,
};

typedef void (*bt_data_callback_t)(CHANNEL_TYPE channel, uint8_t *data, uint16_t len);

int bt_init();
void bt_register_data_callback(bt_data_callback_t callback);
bool bt_is_controller_connected();
bool bt_get_connected_controller_addr(uint8_t out[6]);
uint8_t bt_copy_pairing_events(uint8_t *out, uint8_t max_events);
uint8_t bt_controller_type();
int8_t bt_get_signal_strength();
bool bt_has_signal_strength();
bool bt_disconnect();
bool bt_power_off_controller();
bool bt_set_idle_disconnect_timeout_minutes(uint16_t minutes);
uint16_t bt_idle_disconnect_timeout_minutes();
void bt_write(uint8_t* data,uint16_t len);
bool bt_write_classified_output(uint8_t* data,uint16_t len);
bool bt_sanitize_host_speaker_amp_ownership(uint8_t* data,uint16_t len);
bool bt_sanitize_host_speaker_amp_ownership_payload(uint8_t* payload,uint16_t len);
bool bt_sanitize_host_mic_ownership(uint8_t* data,uint16_t len);
bool bt_sanitize_host_mic_ownership_payload(uint8_t* payload,uint16_t len);
bool bt_apply_classic_rumble_gain_payload(uint8_t* payload,uint16_t len);
bool bt_write_audio_stream(uint8_t* data,uint16_t len);
void bt_drain_audio_stream();
void bt_reset_output_debug_stats();
struct bt_output_debug_stats {
    uint32_t audio_0x36_enqueue_to_send_max_us;
    uint32_t audio_0x36_send_gap_max_us;
    uint32_t audio_0x36_late_count_over_12000_us;
    uint32_t audio_0x36_drop_oldest_count;
    uint32_t non_audio_reports_between_audio_max;
    uint32_t bt_audio_queue_depth_max;
    uint32_t audio_0x36_enqueued_count;
    uint32_t audio_0x36_sent_count;
    // How often the host packed audio and controller state into ONE 0x31 report and we
    // split them apart, against the total 0x31 reports received. Splitting turns one host
    // packet into two on the Bluetooth link, so this ratio is what says whether that cost is
    // negligible or whether we are routinely re-serialising work the host had already
    // combined. Reported unconditionally -- it must be readable on a release build.
    uint32_t mixed_0x31_split_count;
    uint32_t normal_0x31_rx_count;
};
void bt_get_output_debug_stats(bt_output_debug_stats *stats);
void bt_set_lightbar_color(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness_percent);
void bt_set_player_led_enabled(bool enabled);
void bt_set_mute_led(bool enabled);
void bt_set_microphone_state(uint8_t volume_percent, bool muted, bool control_mute_led, bool mute_led);
void bt_set_speaker_output_gain(uint8_t gain);
uint8_t bt_speaker_output_gain();
void bt_set_speaker_output_enabled(bool enabled, bool headset_plugged = false, bool force = false);
void bt_rearm_speaker_output_route(bool headset_plugged);
void bt_refresh_speaker_output();
void bt_set_classic_rumble_gain(uint16_t gain_percent);
uint16_t bt_classic_rumble_gain();
void bt_set_classic_rumble_v1_enabled(bool enabled);
bool bt_classic_rumble_v1_enabled();
void bt_set_classic_rumble_output(uint8_t right, uint8_t left);
void bt_set_adaptive_trigger_effect(uint8_t mode, uint8_t intensity_percent, uint8_t target = 0);
void bt_set_custom_adaptive_trigger_effect(
    uint8_t mode,
    uint8_t start_percent,
    uint8_t wall_percent,
    uint8_t force_percent,
    uint8_t target = 0
);
void bt_set_custom_adaptive_trigger_effects(
    uint8_t right_mode,
    uint8_t right_start_percent,
    uint8_t right_wall_percent,
    uint8_t right_force_percent,
    bool right_active,
    uint8_t left_mode,
    uint8_t left_start_percent,
    uint8_t left_wall_percent,
    uint8_t left_force_percent,
    bool left_active
);
// Send effect bytes the app composed itself. The firmware does NOT interpret or validate them --
// deliberately, so the app can drive any effect the controller understands, including ones this
// firmware has no encoder for, without a reflash per effect type. The controller rejects what it
// does not recognise. This is what the advanced tester window and the native-range sliders use;
// the percent-based helpers above quantize to zones and 3-bit force and cannot express them.
// Encode the percent form into the same 11 bytes bt_set_custom_adaptive_trigger_effects would
// have sent. Exposed so a caller holding a mix of percent-form and app-composed effects can
// reduce both to bytes and send them down ONE path, instead of branching on which sender to use
// and getting the mixed case wrong. Writes exactly 11 bytes.
void bt_encode_custom_trigger_effect(
    uint8_t *out,
    uint8_t mode,
    uint8_t start_percent,
    uint8_t wall_percent,
    uint8_t force_percent
);
void bt_set_raw_adaptive_trigger_effects(
    uint8_t const *right_trigger,
    bool right_active,
    uint8_t const *left_trigger,
    bool left_active
);
void bt_replay_adaptive_trigger_effect(
    uint8_t const *right_trigger,
    bool right_valid,
    uint8_t const *left_trigger,
    bool left_valid,
    uint8_t motor_power,
    bool motor_power_valid
);
void bt_reset_adaptive_triggers();
void bt_schedule_lightbar_restore(uint32_t delay_ms);
// True at most once per controller connection -- see bt.cpp.
bool bt_claim_host_lightbar_correction();
void bt_lightbar_loop();
void bt_signal_strength_loop();
void bt_inquiry_loop();
void bt_arm_pairing_window();
// Companion-initiated pairing: opens the window even if a controller is attached, then
// disconnects it so the new controller can be found.
bool bt_request_pairing();
// Clears every stored Bluetooth link key. This is what a flash nuke used to be needed for --
// reflashing firmware does not wipe stored keys.
bool bt_forget_pairings();
// Forget a single controller by BT address. Both forget paths record the address in a
// durable blacklist BEFORE deleting any key, so a controller that is still powered on
// cannot silently re-pair and make the forget look like it did nothing. An explicit pairing
// window still lets it back in -- that is the intended way to undo this.
bool bt_forget_pairing(const uint8_t address[6]);
void bt_connection_recovery_loop();
/**
 * Stick calibration, as reverse-engineered by dualshock-tools/ds4-tools.
 *
 * op: 1 = begin, 2 = store, 3 = sample. target: 1 = centre, 2 = range.
 *
 * TEMPORARY unless the controller's NVS has been unlocked first (feature report 0x80). Without
 * that unlock the controller reverts on reset, which is what makes the sequence safe to drive
 * and verify. The unlock is deliberately NOT implemented here.
 */
bool bt_send_stick_calibration(uint8_t op, uint8_t target);
/**
 * Unlock or re-lock the controller's non-volatile storage.
 *
 * THIS IS THE STEP THAT MAKES CALIBRATION PERMANENT, and the one that can leave a controller
 * unusable. The unlock sequence is reverse-engineered, not documented by the manufacturer, and
 * was established on a small number of units.
 *
 * Callers MUST re-lock on every exit path, including failure. Leaving NVS unlocked means any
 * later write -- including one the user never asked for -- lands in permanent storage.
 */
bool bt_set_nvs_unlocked(bool unlocked);
/** Ask for the calibration status report (0x83). The reply lands asynchronously. */
void bt_request_stick_calibration_status();
/** Latest cached 0x83 payload. Returns bytes copied; 0 when nothing has arrived yet. */
uint8_t bt_stick_calibration_status(uint8_t *out, uint8_t capacity);

std::vector<uint8_t> get_feature_data(uint8_t reportId,uint16_t len);
void init_feature();
void set_feature_data(uint8_t reportId, uint8_t const* data,uint16_t len);

#endif //DS5_BRIDGE_BT_H
