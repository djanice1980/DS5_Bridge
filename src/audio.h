//
// Created by awalol on 2026/3/5.
// Modified for DS5 Bridge companion firmware and app integration.
//

#ifndef DS5_BRIDGE_AUDIO_H
#define DS5_BRIDGE_AUDIO_H

#include <cstdint>
#include "debug_config.h"

enum AudioRuntimeMode : uint8_t {
    AudioRuntimeFallbackPicoLocal = 0,
    AudioRuntimeHostEncodedActive = 1,
};

enum AudioFallbackReason : uint8_t {
    AudioFallbackNone = 0,
    AudioFallbackHostDisabled = 1,
    AudioFallbackHeartbeatTimeout = 2,
    AudioFallbackStreamTimeout = 3,
    AudioFallbackInvalidPacket = 4,
    AudioFallbackCompanionStop = 5,
    AudioFallbackControllerDisconnected = 6,
};

struct audio_host_status {
    uint8_t mode;
    uint8_t fallback_reason;
    bool host_requested;
    bool heartbeat_healthy;
    bool stream_active;
    bool stream_healthy;
    bool duplex_requested;
    bool duplex_active;
    bool controller_state_ready;
    bool headset_plugged;
    bool headset_audio_route;
    uint16_t stream_generation;
    uint32_t heartbeat_age_ms;
    uint32_t frame_age_ms;
    uint32_t host_frames_received;
    uint32_t host_frames_dropped;
    uint32_t mic_packets_received;
    uint32_t mic_packets_dropped;
    uint32_t mic_decode_success;
    uint32_t mic_decode_fail;
    uint32_t mic_usb_write_success;
    uint32_t mic_usb_write_short;
    uint32_t mic_usb_conceal_count;
    uint32_t mic_plc_count;
    uint16_t mic_last_decoded_samples;
    uint16_t mic_last_written_bytes;
    uint16_t mic_peak_permille;
    bool mic_usb_streaming;
};

void audio_init();
void audio_loop();
void audio_test_haptics_loop();
bool audio_schedule_test_haptics();
bool audio_test_haptics_busy();
bool audio_test_haptics_cooldown();
bool audio_recent();
bool audio_host_encoded_active();
bool audio_haptics_ready();
void audio_set_quiet_mode(bool enabled);
bool audio_quiet_mode_enabled();
void audio_debug_copy_report_payload(uint8_t *buffer, uint8_t max_len);
struct audio_debug_stats {
    uint32_t usb_audio_gap_max_us;
    uint32_t usb_audio_gap_over_1500_count;
    uint32_t opus_encode_max_us;
    uint32_t opus_encode_over_budget_count;
    uint32_t audio_generation_drop_count;
};
void audio_debug_get_stats(audio_debug_stats *stats);
void audio_debug_note_usb_event(
    uint8_t kind,
    uint32_t arg1 = 0,
    uint32_t arg2 = 0,
    uint32_t arg3 = 0,
    uint32_t arg4 = 0
);
void audio_debug_note_hid_event(
    uint8_t kind,
    uint32_t report_id = 0,
    uint32_t report_type = 0,
    uint32_t len = 0,
    uint32_t first_byte = 0
);
void audio_debug_note_bt_event(
    uint8_t kind,
    uint32_t arg1 = 0,
    uint32_t arg2 = 0,
    uint32_t arg3 = 0,
    uint32_t arg4 = 0
);
void audio_set_haptics_buffer_length(uint8_t length);
uint8_t audio_haptics_buffer_length();
void audio_set_state_data(uint8_t const *data, uint8_t len);
void audio_set_adaptive_trigger_state(
    uint8_t const *right_trigger,
    bool right_valid,
    uint8_t const *left_trigger,
    bool left_valid,
    uint8_t motor_power,
    bool motor_power_valid
);
void audio_set_lightbar_state(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness_percent);
void audio_handle_controller_disconnect();
void set_headset(bool state);
bool audio_controller_state_ready();
void audio_host_set_requested(bool enabled);
void audio_host_note_heartbeat();
void audio_host_start_stream();
void audio_host_stop_stream(AudioFallbackReason reason = AudioFallbackCompanionStop);
bool audio_host_receive_packet(uint8_t const *data, uint16_t len);
void audio_host_set_duplex_requested(bool enabled);
bool audio_duplex_active();
void audio_get_host_status(audio_host_status *status);
void audio_mic_add_packet(uint8_t const *data, uint16_t len);
void audio_set_mic_output_state(uint8_t volume_percent, bool muted);

#endif //DS5_BRIDGE_AUDIO_H
