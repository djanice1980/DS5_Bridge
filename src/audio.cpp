//
// Created by awalol on 2026/3/5.
// Modified for DS5 Bridge companion firmware and app integration.
//

#include "audio.h"
#include "bt.h"
#include "resample.h"
#include "tusb.h"
#include "usb.h"
#include <algorithm>
#include <cstdio>
#include <cstring>

#include "opus.h"
#include "utils.h"
#include "pico/critical_section.h"
#include "pico/multicore.h"
#include "pico/time.h"
#include "pico/util/queue.h"

#define INPUT_CHANNELS    4
#define OUTPUT_CHANNELS   2
#define SAMPLE_SIZE       64
#define REPORT_SIZE       398
#define REPORT_ID         0x36
#define AUDIO_SECTION_ENABLE_MASK 0b11111111
#define DEFAULT_HAPTICS_BUFFER_LENGTH 64
#define MIN_HAPTICS_BUFFER_LENGTH 64
#define MAX_HAPTICS_BUFFER_LENGTH 255
#define TEST_HAPTICS_PACKET_COUNT 36
#define TEST_HAPTICS_PACKET_INTERVAL_US 10666
#define TEST_HAPTICS_COOLDOWN_US 500000
#define TEST_HAPTICS_BASE_AMPLITUDE 72
#define TEST_HAPTICS_NEUTRAL_PACKET_COUNT 5
#define USB_AUDIO_ACTIVE_THRESHOLD 8
#define AUDIO_LOOP_MAX_USB_READS 4
#define STATE_FLAG1_LIGHTBAR_CONTROL_ENABLE 0x04
#define STATE_FLAG1_RELEASE_LEDS 0x08
#define STATE_FLAG1_PLAYER_INDICATOR_CONTROL_ENABLE 0x10
#define STATE_FLAG0_SPEAKER_VOLUME_ENABLE 0x20
#define STATE_FLAG0_AUDIO_CONTROL_ENABLE 0x80
#define STATE_FLAG1_AUDIO_CONTROL2_ENABLE 0x80
#define STATE_FLAG0_RIGHT_TRIGGER_EFFECT 0x04
#define STATE_FLAG0_LEFT_TRIGGER_EFFECT 0x08
#define STATE_FLAG1_TRIGGER_MOTOR_POWER_ENABLE 0x40
#define STATE_PAYLOAD_VALID_FLAG0_OFFSET 0
#define STATE_PAYLOAD_VALID_FLAG1_OFFSET 1
#define STATE_PAYLOAD_TRIGGER_RIGHT_OFFSET 10
#define STATE_PAYLOAD_TRIGGER_LEFT_OFFSET 21
#define STATE_PAYLOAD_TRIGGER_EFFECT_SIZE 11
#define STATE_PAYLOAD_TRIGGER_POWER_OFFSET 36
#define STATE_PAYLOAD_HEADPHONE_VOLUME_OFFSET 4
#define STATE_PAYLOAD_SPEAKER_VOLUME_OFFSET 5
#define STATE_PAYLOAD_AUDIO_CONTROL_OFFSET 7
#define STATE_PAYLOAD_AUDIO_CONTROL2_OFFSET 37
#define STATE_PAYLOAD_VALID_FLAG2_OFFSET 38
#define STATE_PAYLOAD_LED_BRIGHTNESS_OFFSET 42
#define STATE_PAYLOAD_PLAYER_LEDS_OFFSET 43
#define STATE_PAYLOAD_LIGHTBAR_RED_OFFSET 44
#define STATE_PAYLOAD_LIGHTBAR_GREEN_OFFSET 45
#define STATE_PAYLOAD_LIGHTBAR_BLUE_OFFSET 46
#define STATE_PAYLOAD_HEADPHONE_VOLUME_MAX 0x7f
#define STATE_PAYLOAD_SPEAKER_VOLUME_SAFE_MAX 0x64
#define STATE_AUDIO_FLAGS_OUTPUT_PATH_HEADPHONES 0x00
#define STATE_AUDIO_FLAGS_OUTPUT_PATH_SPEAKER 0x30
#define STATE_AUDIO_FLAGS2_SPEAKER_PREAMP_GAIN 0x02
#define STATE_LIGHTBAR_SETUP_CONTROL_MASK 0x03
#define STATE_PLAYER_LED_1_INSTANT 0x24
#define AUDIO_DEBUG_RING_SIZE 96
#define AUDIO_DEBUG_REPORT_HEADER_SIZE 8
#define AUDIO_DEBUG_RECORD_SIZE 14
#define OPUS_ENCODE_BUDGET_US 10000
#define SPEAKER_USB_SILENCE_TAIL_US 500000
#define SPEAKER_SILENCE_PREROLL_USB_PACKETS 24
#define SPEAKER_SILENCE_PREROLL_INTERVAL_US 10666
#define SPEAKER_TRANSITION_FADE_SAMPLES 1920.0f
#define HOST_HEARTBEAT_TIMEOUT_US 750000
#define HOST_STREAM_TIMEOUT_US 250000
#define HOST_STREAM_START_GRACE_US 2000000
#define HOST_STREAM_RECOVERY_HOLD_US 10000000
#define HOST_STARTUP_DROP_FRAMES 8
#define HOST_PACKET_HEADER_SIZE 16
#define HOST_PACKET_PAYLOAD_SIZE 47
#define HOST_FRAME_REASSEMBLY_SIZE 448
#define HOST_AUDIO_REPORT_SIZE REPORT_SIZE
#define HOST_AUDIO_COMPACT_REPORT_SIZE (SAMPLE_SIZE + 200)
#define HOST_MIC_OPUS_SIZE 71
#define HOST_MIC_OPUS_FRAMES 480
#define HOST_MIC_INPUT_CHANNELS 1
#define HOST_MIC_USB_CHANNELS 1
#define HOST_MIC_QUEUE_DEPTH 8
#define HOST_MIC_USB_PACKET_BYTES (48 * HOST_MIC_USB_CHANNELS * sizeof(int16_t))
#define HOST_MIC_USB_PREFILL_BYTES (10 * HOST_MIC_USB_PACKET_BYTES)
#define HOST_MIC_USB_FILL_MAX_CHUNKS 6
#define HOST_MIC_CORE1_BURST_LIMIT 2
#define HOST_MIC_PLAYOUT_START_DEPTH 3
#define HOST_MIC_OPUS_FRAME_INTERVAL_US 10000
#define HOST_MIC_PLC_TARGET_DEPTH 2
using std::clamp;
using std::max;

enum AudioDebugEventCode : uint8_t {
    AudioDebugAudioStart = 1,
    AudioDebugResetGap = 2,
    AudioDebugCore1Reset = 3,
    AudioDebugSkipOpusPacket = 4,
    AudioDebugSendSpeakerPacket = 5,
    AudioDebugNoOpusPacket = 6,
    AudioDebugAudioFifoDrop = 7,
    AudioDebugAudioFifoAddFail = 8,
    AudioDebugOpusFifoDrop = 9,
    AudioDebugOpusFifoAddFail = 10,
    AudioDebugTestHapticsStart = 11,
    AudioDebugTestHapticsStop = 12,
    AudioDebugSpeakerRoute = 13,
    AudioDebugQuietMode = 14,
    AudioDebugSilencePreroll = 15,
    AudioDebugUsbSilenceTail = 16,
    AudioDebugHostMode = 17,
    AudioDebugHostFrame = 18,
    AudioDebugMicPacket = 19,
    AudioDebugUsbEvent = 20,
    AudioDebugHidEvent = 21,
    AudioDebugBtEvent = 22,
};

enum HostAudioPacketType : uint8_t {
    HostAudioHello = 1,
    HostAudioHeartbeat = 2,
    HostAudioStart = 3,
    HostAudioStop = 4,
    HostAudioFrameChunk = 5,
    HostAudioSetDuplexEnabled = 6,
    HostAudioSetDuplexDisabled = 7,
    HostAudioFastFrameFragment = 8,
};

enum HostPacketOffsets : uint8_t {
    HostPacketMagic0 = 0,
    HostPacketMagic1 = 1,
    HostPacketMagic2 = 2,
    HostPacketMagic3 = 3,
    HostPacketProtocolMajor = 4,
    HostPacketProtocolMinor = 5,
    HostPacketType = 6,
    HostPacketFlags = 7,
    HostPacketGeneration = 8,
    HostPacketSequence = 10,
    HostPacketChunkIndex = 12,
    HostPacketChunkCount = 13,
    HostPacketPayloadLength = 14,
    HostPacketPayload = 16,
};

enum HostFastPacketOffsets : uint8_t {
    HostFastPacketType = 0,
    HostFastPacketSequence = 1,
    HostFastPacketFragmentIndex = 3,
    HostFastPacketFragmentCount = 4,
    HostFastPacketPayloadLength = 5,
    HostFastPacketPayload = 6,
};

struct mic_packet_element {
    uint8_t data[HOST_MIC_OPUS_SIZE];
};

struct mic_decode_element {
    int16_t data[HOST_MIC_OPUS_FRAMES * HOST_MIC_USB_CHANNELS];
    uint16_t len;
};

struct audio_debug_event {
    uint32_t sequence;
    uint32_t timestamp_us;
    uint8_t code;
    uint8_t arg0;
    uint8_t arg1;
    uint8_t arg2;
    uint8_t arg3;
    uint8_t arg4;
};

static WDL_Resampler resampler;
static uint8_t reportSeqCounter = 0;
static uint8_t packetCounter = 0;
static bool plug_headset = false;
static bool controller_state_ready = false;
static bool audio_initialized = false;
static uint32_t last_audio_us = 0;
static bool speaker_route_active = false;
static bool speaker_route_headset = false;
static bool host_route_primer_toggle_pending = false;
static bool test_haptics_active = false;
static uint8_t test_haptics_packets_remaining = 0;
static uint8_t test_haptics_neutral_packets_remaining = 0;
static uint32_t test_haptics_last_packet_us = 0;
static uint32_t test_haptics_cooldown_until_us = 0;
static bool quiet_mode_enabled = false;
static volatile uint32_t audio_stream_generation = 1;
static uint8_t haptics_buffer_length = DEFAULT_HAPTICS_BUFFER_LENGTH;
static critical_section_t audio_debug_cs;
static bool audio_debug_cs_ready = false;
static audio_debug_event audio_debug_ring[AUDIO_DEBUG_RING_SIZE];
static uint32_t audio_debug_next_sequence = 1;
static uint32_t audio_debug_read_sequence = 1;
static uint16_t audio_debug_dropped_count = 0;
static uint8_t audio_debug_count = 0;
static uint8_t audio_debug_head = 0;
static uint8_t audio_debug_packet_log_budget = 0;
static audio_debug_stats audio_stats{};
static uint32_t last_usb_audio_read_us = 0;
static uint32_t last_usb_discard_debug_us = 0;
static uint32_t last_hid_output_debug_us = 0;
static uint8_t hid_output_debug_burst_remaining = 0;
static bool audio_silence_tail_logged = false;
static uint8_t speaker_silence_preroll_packets_remaining = 0;
static uint32_t speaker_silence_preroll_last_packet_us = 0;
static float fallback_speaker_gain = 1.0f;
static float fallback_speaker_target_gain = 1.0f;
alignas(8) static uint32_t audio_core1_stack[8192];
queue_t audio_fifo;
queue_t mic_fifo;
queue_t mic_decode_fifo;
static uint8_t opus_buf[200];
static uint32_t opus_buf_generation = 0;
static bool opus_buf_valid = false;
static critical_section_t opus_cs;
static bool opus_cs_ready = false;
struct audio_raw_element {
    float data[512 * 2];
    uint32_t generation;
};

static uint8_t state_data[63] = {
    0xfd, 0xe3, 0x0, 0x0,
    0x7f, 0x64,
    0xff, 0x9, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
    0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
    0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
    0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0xa,
    0x4, 0x0, 0x0, 0x0, 0x1,
    0x00,
    0x00, 0x00, 0xff,
};
static uint8_t cached_state_right_trigger[STATE_PAYLOAD_TRIGGER_EFFECT_SIZE]{};
static uint8_t cached_state_left_trigger[STATE_PAYLOAD_TRIGGER_EFFECT_SIZE]{};
static bool cached_state_right_trigger_valid = false;
static bool cached_state_left_trigger_valid = false;
static uint8_t cached_state_trigger_power = 0;
static bool cached_state_trigger_power_valid = false;

static float audio_buf[512 * 2];
static uint audio_buf_pos = 0;
static int8_t audio_haptic_buf[SAMPLE_SIZE];
static int audio_haptic_buf_pos = 0;
static volatile bool host_audio_requested = false;
static volatile bool host_stream_active = false;
static volatile bool host_duplex_requested = false;
static volatile uint32_t host_last_heartbeat_us = 0;
static volatile uint32_t host_stream_started_us = 0;
static volatile uint32_t host_last_frame_us = 0;
static volatile uint32_t host_request_started_us = 0;
static uint16_t host_stream_generation = 0;
static AudioRuntimeMode audio_runtime_mode = AudioRuntimeFallbackPicoLocal;
static AudioFallbackReason audio_fallback_reason = AudioFallbackHostDisabled;
static uint16_t host_reassembly_generation = 0;
static uint16_t host_reassembly_sequence = 0;
static uint8_t host_reassembly_chunk_count = 0;
static uint16_t host_reassembly_received_mask = 0;
static uint16_t host_reassembly_expected_length = 0;
static uint16_t host_reassembly_received_bytes = 0;
static uint8_t host_reassembly_buffer[HOST_FRAME_REASSEMBLY_SIZE];
static uint32_t host_frames_received = 0;
static uint32_t host_frames_dropped = 0;
static uint8_t host_startup_drop_frames_remaining = 0;
static uint32_t mic_packets_received = 0;
static uint32_t mic_packets_dropped = 0;
static uint32_t mic_decode_success = 0;
static uint32_t mic_decode_fail = 0;
static uint32_t mic_usb_write_success = 0;
static uint32_t mic_usb_write_short = 0;
static uint16_t mic_last_decoded_samples = 0;
static uint16_t mic_last_written_bytes = 0;
static uint16_t mic_peak_permille = 0;
static volatile bool mic_usb_playout_started = false;
static volatile uint8_t mic_output_volume_percent = 100;
static volatile bool mic_output_muted = false;
static mic_decode_element mic_usb_pending{};
static uint16_t mic_usb_pending_offset = 0;
static uint16_t mic_usb_pending_len = 0;
static uint32_t mic_next_plc_us = 0;

static void core1_entry();
static void reset_core1_audio_pipeline(uint32_t generation);
static void clear_host_reassembly();
static void clear_mic_queues();
static void audio_host_poll();
static void process_mic_usb_output();
static void clear_partial_audio_state();
static void reset_controller_audio_report_counters();
static void schedule_host_route_primer();
static bool prime_host_audio_route_if_needed();
static uint8_t clamp_debug_u8(uint32_t value);
#if DS5_AUDIO_DEBUG_ENABLED
static void audio_debug_log_impl(
    AudioDebugEventCode code,
    uint8_t a = 0,
    uint8_t b = 0,
    uint8_t c = 0,
    uint8_t d = 0,
    uint8_t e = 0
);
#define audio_debug_log(...) audio_debug_log_impl(__VA_ARGS__)
#else
#define audio_debug_log(...) do { } while (0)
#endif
static void copy_routed_state_data(uint8_t *destination);

static bool host_mic_path_active() {
    return host_duplex_requested
        && audio_runtime_mode == AudioRuntimeHostEncodedActive
        && bt_is_controller_connected();
}

static void reset_controller_audio_report_counters() {
    reportSeqCounter = 0;
    packetCounter = 0;
}

static void schedule_host_route_primer() {
    if (speaker_route_active && speaker_route_headset == plug_headset) {
        host_route_primer_toggle_pending = false;
        return;
    }

    host_route_primer_toggle_pending = true;
    speaker_route_active = false;
    speaker_route_headset = false;
    audio_debug_packet_log_budget = max<uint8_t>(audio_debug_packet_log_budget, 6);
}

static bool prime_host_audio_route_if_needed() {
    if (!host_route_primer_toggle_pending || !controller_state_ready) {
        return false;
    }

    bt_rearm_speaker_output_route(plug_headset);
    speaker_route_active = true;
    speaker_route_headset = plug_headset;
    host_route_primer_toggle_pending = false;
    audio_debug_log(
        AudioDebugSpeakerRoute,
        1,
        clamp_debug_u8(static_cast<uint32_t>(volume[0] * 100.0f)),
        quiet_mode_enabled ? 1 : 0,
        plug_headset ? 1 : 0,
        2
    );
    return true;
}

static void clamp_state_speaker_volume() {
    if (state_data[STATE_PAYLOAD_SPEAKER_VOLUME_OFFSET] > STATE_PAYLOAD_SPEAKER_VOLUME_SAFE_MAX) {
        state_data[STATE_PAYLOAD_SPEAKER_VOLUME_OFFSET] = STATE_PAYLOAD_SPEAKER_VOLUME_SAFE_MAX;
    }
}

void audio_set_state_data(uint8_t const *data, uint8_t len) {
    if (data == nullptr) {
        return;
    }
    const uint8_t copy_len = len > sizeof(state_data) ? sizeof(state_data) : len;
    memcpy(state_data, data, copy_len);
    if (copy_len < sizeof(state_data)) {
        memset(state_data + copy_len, 0, sizeof(state_data) - copy_len);
    }

    if (
        (state_data[STATE_PAYLOAD_VALID_FLAG0_OFFSET] & STATE_FLAG0_RIGHT_TRIGGER_EFFECT) != 0
        && copy_len > STATE_PAYLOAD_TRIGGER_RIGHT_OFFSET + STATE_PAYLOAD_TRIGGER_EFFECT_SIZE - 1
    ) {
        memcpy(
            cached_state_right_trigger,
            state_data + STATE_PAYLOAD_TRIGGER_RIGHT_OFFSET,
            sizeof(cached_state_right_trigger)
        );
        cached_state_right_trigger_valid = true;
    } else if (cached_state_right_trigger_valid) {
        state_data[STATE_PAYLOAD_VALID_FLAG0_OFFSET] |= STATE_FLAG0_RIGHT_TRIGGER_EFFECT;
        memcpy(
            state_data + STATE_PAYLOAD_TRIGGER_RIGHT_OFFSET,
            cached_state_right_trigger,
            sizeof(cached_state_right_trigger)
        );
    }

    if (
        (state_data[STATE_PAYLOAD_VALID_FLAG0_OFFSET] & STATE_FLAG0_LEFT_TRIGGER_EFFECT) != 0
        && copy_len > STATE_PAYLOAD_TRIGGER_LEFT_OFFSET + STATE_PAYLOAD_TRIGGER_EFFECT_SIZE - 1
    ) {
        memcpy(
            cached_state_left_trigger,
            state_data + STATE_PAYLOAD_TRIGGER_LEFT_OFFSET,
            sizeof(cached_state_left_trigger)
        );
        cached_state_left_trigger_valid = true;
    } else if (cached_state_left_trigger_valid) {
        state_data[STATE_PAYLOAD_VALID_FLAG0_OFFSET] |= STATE_FLAG0_LEFT_TRIGGER_EFFECT;
        memcpy(
            state_data + STATE_PAYLOAD_TRIGGER_LEFT_OFFSET,
            cached_state_left_trigger,
            sizeof(cached_state_left_trigger)
        );
    }

    if (
        (state_data[STATE_PAYLOAD_VALID_FLAG1_OFFSET] & STATE_FLAG1_TRIGGER_MOTOR_POWER_ENABLE) != 0
        && copy_len > STATE_PAYLOAD_TRIGGER_POWER_OFFSET
    ) {
        cached_state_trigger_power = state_data[STATE_PAYLOAD_TRIGGER_POWER_OFFSET];
        cached_state_trigger_power_valid = true;
    } else if (cached_state_trigger_power_valid) {
        state_data[STATE_PAYLOAD_VALID_FLAG1_OFFSET] |= STATE_FLAG1_TRIGGER_MOTOR_POWER_ENABLE;
        state_data[STATE_PAYLOAD_TRIGGER_POWER_OFFSET] = cached_state_trigger_power;
    }

    clamp_state_speaker_volume();
}

void audio_set_adaptive_trigger_state(
    uint8_t const *right_trigger,
    bool right_valid,
    uint8_t const *left_trigger,
    bool left_valid,
    uint8_t motor_power,
    bool motor_power_valid
) {
    if (right_valid && right_trigger != nullptr) {
        memcpy(cached_state_right_trigger, right_trigger, sizeof(cached_state_right_trigger));
        cached_state_right_trigger_valid = true;
        state_data[STATE_PAYLOAD_VALID_FLAG0_OFFSET] |= STATE_FLAG0_RIGHT_TRIGGER_EFFECT;
        memcpy(state_data + STATE_PAYLOAD_TRIGGER_RIGHT_OFFSET, right_trigger, STATE_PAYLOAD_TRIGGER_EFFECT_SIZE);
    }
    if (left_valid && left_trigger != nullptr) {
        memcpy(cached_state_left_trigger, left_trigger, sizeof(cached_state_left_trigger));
        cached_state_left_trigger_valid = true;
        state_data[STATE_PAYLOAD_VALID_FLAG0_OFFSET] |= STATE_FLAG0_LEFT_TRIGGER_EFFECT;
        memcpy(state_data + STATE_PAYLOAD_TRIGGER_LEFT_OFFSET, left_trigger, STATE_PAYLOAD_TRIGGER_EFFECT_SIZE);
    }
    if (motor_power_valid) {
        cached_state_trigger_power = motor_power;
        cached_state_trigger_power_valid = true;
        state_data[STATE_PAYLOAD_VALID_FLAG1_OFFSET] |= STATE_FLAG1_TRIGGER_MOTOR_POWER_ENABLE;
        state_data[STATE_PAYLOAD_TRIGGER_POWER_OFFSET] = motor_power;
    }
}

static uint8_t scale_lightbar_channel_for_state(uint8_t channel, uint8_t brightness_percent) {
    return static_cast<uint8_t>((static_cast<uint16_t>(channel) * brightness_percent + 50) / 100);
}

void audio_set_lightbar_state(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness_percent) {
    const uint8_t brightness = brightness_percent > 100 ? 100 : brightness_percent;
    state_data[STATE_PAYLOAD_VALID_FLAG1_OFFSET] = static_cast<uint8_t>(
        (
            state_data[STATE_PAYLOAD_VALID_FLAG1_OFFSET]
            & static_cast<uint8_t>(~STATE_FLAG1_RELEASE_LEDS)
        )
        | STATE_FLAG1_LIGHTBAR_CONTROL_ENABLE
        | STATE_FLAG1_PLAYER_INDICATOR_CONTROL_ENABLE
    );
    state_data[STATE_PAYLOAD_VALID_FLAG2_OFFSET] = static_cast<uint8_t>(
        state_data[STATE_PAYLOAD_VALID_FLAG2_OFFSET]
        & static_cast<uint8_t>(~STATE_LIGHTBAR_SETUP_CONTROL_MASK)
    );
    state_data[STATE_PAYLOAD_LED_BRIGHTNESS_OFFSET] = 0x01;
    state_data[STATE_PAYLOAD_PLAYER_LEDS_OFFSET] = STATE_PLAYER_LED_1_INSTANT;
    state_data[STATE_PAYLOAD_LIGHTBAR_RED_OFFSET] = scale_lightbar_channel_for_state(red, brightness);
    state_data[STATE_PAYLOAD_LIGHTBAR_GREEN_OFFSET] = scale_lightbar_channel_for_state(green, brightness);
    state_data[STATE_PAYLOAD_LIGHTBAR_BLUE_OFFSET] = scale_lightbar_channel_for_state(blue, brightness);
}

void set_headset(bool state) {
    const bool first_report_after_connect = !controller_state_ready;
    controller_state_ready = true;
    if (plug_headset == state) {
        if (first_report_after_connect && host_audio_requested) {
            schedule_host_route_primer();
        }
        return;
    }

    plug_headset = state;
    if (speaker_route_active && speaker_route_headset != plug_headset) {
        bt_rearm_speaker_output_route(plug_headset);
        speaker_route_headset = plug_headset;
        audio_debug_log(
            AudioDebugSpeakerRoute,
            1,
            clamp_debug_u8(static_cast<uint32_t>(volume[0] * 100.0f)),
            quiet_mode_enabled ? 1 : 0,
            plug_headset ? 1 : 0,
            1
        );
    }
    if (host_audio_requested) {
        schedule_host_route_primer();
    }
}

bool audio_controller_state_ready() {
    return controller_state_ready;
}

static bool time_reached(uint32_t now, uint32_t target) {
    return static_cast<int32_t>(now - target) >= 0;
}

static uint8_t clamp_debug_u8(uint32_t value) {
    return value > 255 ? 255 : static_cast<uint8_t>(value);
}

static void copy_routed_state_data(uint8_t *destination) {
    if (destination == nullptr) {
        return;
    }

    memcpy(destination, state_data, sizeof(state_data));
    if (plug_headset) {
        destination[STATE_PAYLOAD_VALID_FLAG0_OFFSET] = static_cast<uint8_t>(
            (destination[STATE_PAYLOAD_VALID_FLAG0_OFFSET] | STATE_FLAG0_AUDIO_CONTROL_ENABLE)
            & static_cast<uint8_t>(~STATE_FLAG0_SPEAKER_VOLUME_ENABLE)
        );
        destination[STATE_PAYLOAD_VALID_FLAG1_OFFSET] = static_cast<uint8_t>(
            destination[STATE_PAYLOAD_VALID_FLAG1_OFFSET]
            & static_cast<uint8_t>(~STATE_FLAG1_AUDIO_CONTROL2_ENABLE)
        );
        destination[STATE_PAYLOAD_HEADPHONE_VOLUME_OFFSET] = STATE_PAYLOAD_HEADPHONE_VOLUME_MAX;
        destination[STATE_PAYLOAD_SPEAKER_VOLUME_OFFSET] = 0x00;
        destination[STATE_PAYLOAD_AUDIO_CONTROL_OFFSET] = STATE_AUDIO_FLAGS_OUTPUT_PATH_HEADPHONES;
        destination[STATE_PAYLOAD_AUDIO_CONTROL2_OFFSET] = 0x00;
        return;
    }

    destination[STATE_PAYLOAD_VALID_FLAG0_OFFSET] |= static_cast<uint8_t>(
        STATE_FLAG0_AUDIO_CONTROL_ENABLE | STATE_FLAG0_SPEAKER_VOLUME_ENABLE
    );
    destination[STATE_PAYLOAD_HEADPHONE_VOLUME_OFFSET] = STATE_PAYLOAD_HEADPHONE_VOLUME_MAX;
    destination[STATE_PAYLOAD_VALID_FLAG1_OFFSET] |= STATE_FLAG1_AUDIO_CONTROL2_ENABLE;
    destination[STATE_PAYLOAD_SPEAKER_VOLUME_OFFSET] = STATE_PAYLOAD_SPEAKER_VOLUME_SAFE_MAX;
    destination[STATE_PAYLOAD_AUDIO_CONTROL_OFFSET] = STATE_AUDIO_FLAGS_OUTPUT_PATH_SPEAKER;
    destination[STATE_PAYLOAD_AUDIO_CONTROL2_OFFSET] = STATE_AUDIO_FLAGS2_SPEAKER_PREAMP_GAIN;
}

static void write_debug_u16(uint8_t *data, uint16_t value) {
    data[0] = static_cast<uint8_t>(value & 0xFF);
    data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

static uint16_t read_le_u16(uint8_t const *data) {
    return static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
}

static void write_debug_u32(uint8_t *data, uint32_t value) {
    data[0] = static_cast<uint8_t>(value & 0xFF);
    data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
    data[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
    data[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

static bool host_packet_has_magic(uint8_t const *data) {
    return data != nullptr
        && data[HostPacketMagic0] == 'D'
        && data[HostPacketMagic1] == 'S'
        && data[HostPacketMagic2] == '5'
        && data[HostPacketMagic3] == 'B';
}

static void audio_debug_update_max_u32(uint32_t &current, uint32_t candidate) {
    if (candidate > current) {
        current = candidate;
    }
}

static void audio_debug_increment_u32(uint32_t &value) {
    if (value != 0xffffffffu) {
        value++;
    }
}

static void audio_stats_note_usb_read(uint32_t now) {
#if DS5_AUDIO_DEBUG_ENABLED
    if (!audio_debug_cs_ready) {
        last_usb_audio_read_us = now;
        return;
    }
    if (last_usb_audio_read_us != 0) {
        const uint32_t gap_us = static_cast<uint32_t>(now - last_usb_audio_read_us);
        critical_section_enter_blocking(&audio_debug_cs);
        audio_debug_update_max_u32(audio_stats.usb_audio_gap_max_us, gap_us);
        if (gap_us > 1500) {
            audio_debug_increment_u32(audio_stats.usb_audio_gap_over_1500_count);
        }
        critical_section_exit(&audio_debug_cs);
    }
    last_usb_audio_read_us = now;
#else
    (void)now;
#endif
}

static void audio_stats_note_opus_encode(uint32_t encode_us) {
#if DS5_AUDIO_DEBUG_ENABLED
    if (!audio_debug_cs_ready) {
        return;
    }
    critical_section_enter_blocking(&audio_debug_cs);
    audio_debug_update_max_u32(audio_stats.opus_encode_max_us, encode_us);
    if (encode_us > OPUS_ENCODE_BUDGET_US) {
        audio_debug_increment_u32(audio_stats.opus_encode_over_budget_count);
    }
    critical_section_exit(&audio_debug_cs);
#else
    (void)encode_us;
#endif
}

static void audio_stats_note_generation_drop() {
#if DS5_AUDIO_DEBUG_ENABLED
    if (!audio_debug_cs_ready) {
        return;
    }
    critical_section_enter_blocking(&audio_debug_cs);
    audio_debug_increment_u32(audio_stats.audio_generation_drop_count);
    critical_section_exit(&audio_debug_cs);
#endif
}

#if DS5_AUDIO_DEBUG_ENABLED
static void audio_debug_log_impl(
    AudioDebugEventCode code,
    uint8_t arg0,
    uint8_t arg1,
    uint8_t arg2,
    uint8_t arg3,
    uint8_t arg4
) {
    if (!audio_debug_cs_ready) {
        return;
    }

    critical_section_enter_blocking(&audio_debug_cs);
    const uint32_t sequence = audio_debug_next_sequence++;
    audio_debug_ring[audio_debug_head] = {
        sequence,
        time_us_32(),
        static_cast<uint8_t>(code),
        arg0,
        arg1,
        arg2,
        arg3,
        arg4
    };
    audio_debug_head = static_cast<uint8_t>((audio_debug_head + 1) % AUDIO_DEBUG_RING_SIZE);
    if (audio_debug_count < AUDIO_DEBUG_RING_SIZE) {
        audio_debug_count++;
    } else {
        if (audio_debug_dropped_count != 0xffff) {
            audio_debug_dropped_count++;
        }
        const uint32_t oldest_sequence = audio_debug_next_sequence - audio_debug_count;
        if (audio_debug_read_sequence < oldest_sequence) {
            audio_debug_read_sequence = oldest_sequence;
        }
    }
    critical_section_exit(&audio_debug_cs);
}
#endif

static void audio_debug_reset_stats() {
#if DS5_AUDIO_DEBUG_ENABLED
    if (audio_debug_cs_ready) {
        critical_section_enter_blocking(&audio_debug_cs);
        memset(&audio_stats, 0, sizeof(audio_stats));
        critical_section_exit(&audio_debug_cs);
    } else {
        memset(&audio_stats, 0, sizeof(audio_stats));
    }
    last_usb_audio_read_us = 0;
#endif
}

void audio_debug_note_usb_event(
    uint8_t kind,
    uint32_t arg1,
    uint32_t arg2,
    uint32_t arg3,
    uint32_t arg4
) {
#if !DS5_AUDIO_DEBUG_ENABLED
    (void)kind;
    (void)arg1;
    (void)arg2;
    (void)arg3;
    (void)arg4;
    return;
#else
    audio_debug_log(
        AudioDebugUsbEvent,
        kind,
        clamp_debug_u8(arg1),
        clamp_debug_u8(arg2),
        clamp_debug_u8(arg3),
        clamp_debug_u8(arg4)
    );
#endif
}

void audio_debug_note_hid_event(
    uint8_t kind,
    uint32_t report_id,
    uint32_t report_type,
    uint32_t len,
    uint32_t first_byte
) {
#if !DS5_AUDIO_DEBUG_ENABLED
    (void)kind;
    (void)report_id;
    (void)report_type;
    (void)len;
    (void)first_byte;
    return;
#else
    if (kind == 2 && report_id == 0 && first_byte == 0x02) {
        const uint32_t now = time_us_32();
        if (last_hid_output_debug_us == 0 || static_cast<uint32_t>(now - last_hid_output_debug_us) > 250000) {
            hid_output_debug_burst_remaining = 8;
        }
        last_hid_output_debug_us = now;
        if (hid_output_debug_burst_remaining == 0) {
            return;
        }
        hid_output_debug_burst_remaining--;
    }

    audio_debug_log(
        AudioDebugHidEvent,
        kind,
        clamp_debug_u8(report_id),
        clamp_debug_u8(report_type),
        clamp_debug_u8(len),
        clamp_debug_u8(first_byte)
    );
#endif
}

void audio_debug_note_bt_event(
    uint8_t kind,
    uint32_t arg1,
    uint32_t arg2,
    uint32_t arg3,
    uint32_t arg4
) {
#if !DS5_AUDIO_DEBUG_ENABLED
    (void)kind;
    (void)arg1;
    (void)arg2;
    (void)arg3;
    (void)arg4;
    return;
#else
    audio_debug_log(
        AudioDebugBtEvent,
        kind,
        clamp_debug_u8(arg1),
        clamp_debug_u8(arg2),
        clamp_debug_u8(arg3),
        clamp_debug_u8(arg4)
    );
#endif
}

static bool usb_audio_has_signal(int16_t const *raw, int frames) {
    for (int frame = 0; frame < frames; frame++) {
        for (int channel = 0; channel < INPUT_CHANNELS; channel++) {
            const int sample = raw[frame * INPUT_CHANNELS + channel];
            const int magnitude = sample < 0 ? -sample : sample;
            if (magnitude > USB_AUDIO_ACTIVE_THRESHOLD) {
                return true;
            }
        }
    }
    return false;
}

static void drain_queue(queue_t *queue) {
    while (!queue_is_empty(queue)) {
        queue_try_remove(queue, NULL);
    }
}

static uint8_t opus_debug_level() {
    return opus_buf_valid ? 1 : 0;
}

static void clear_opus_buffer() {
    if (opus_cs_ready) {
        critical_section_enter_blocking(&opus_cs);
    }
    opus_buf_valid = false;
    opus_buf_generation = 0;
    memset(opus_buf, 0, sizeof(opus_buf));
    if (opus_cs_ready) {
        critical_section_exit(&opus_cs);
    }
}

static void drain_audio_queues() {
    uint32_t next_generation = audio_stream_generation + 1;
    if (next_generation == 0) {
        next_generation = 1;
    }
    audio_stream_generation = next_generation;
    drain_queue(&audio_fifo);
    clear_opus_buffer();
    bt_drain_audio_stream();
}

static void set_fallback_speaker_target_gain(float gain) {
    fallback_speaker_target_gain = clamp(gain, 0.0f, 1.0f);
}

static void restart_fallback_speaker_fade_in() {
    fallback_speaker_gain = 0.0f;
    set_fallback_speaker_target_gain(1.0f);
}

static float next_fallback_speaker_gain() {
    const float step = 1.0f / SPEAKER_TRANSITION_FADE_SAMPLES;
    if (fallback_speaker_gain < fallback_speaker_target_gain) {
        fallback_speaker_gain = std::min(fallback_speaker_gain + step, fallback_speaker_target_gain);
    } else if (fallback_speaker_gain > fallback_speaker_target_gain) {
        fallback_speaker_gain = max(fallback_speaker_gain - step, fallback_speaker_target_gain);
    }
    return fallback_speaker_gain;
}

static void clear_host_reassembly() {
    host_reassembly_generation = 0;
    host_reassembly_sequence = 0;
    host_reassembly_chunk_count = 0;
    host_reassembly_received_mask = 0;
    host_reassembly_expected_length = 0;
    host_reassembly_received_bytes = 0;
    memset(host_reassembly_buffer, 0, sizeof(host_reassembly_buffer));
}

static void note_incomplete_host_reassembly(uint8_t reason) {
    if (host_reassembly_received_mask == 0) {
        return;
    }

    host_frames_dropped++;
    audio_debug_log(
        AudioDebugHostFrame,
        reason,
        clamp_debug_u8(host_reassembly_sequence),
        clamp_debug_u8(host_reassembly_received_mask),
        clamp_debug_u8(host_reassembly_chunk_count),
        clamp_debug_u8(host_reassembly_expected_length)
    );
}

static void clear_mic_queues() {
    drain_queue(&mic_fifo);
    drain_queue(&mic_decode_fifo);
    if (usb_mic_streaming_active()) {
        tud_audio_clear_ep_in_ff();
    }
    mic_usb_playout_started = false;
    mic_usb_pending_offset = 0;
    mic_usb_pending_len = 0;
    mic_next_plc_us = 0;
}

static void enter_fallback(AudioFallbackReason reason) {
    const bool changed = audio_runtime_mode != AudioRuntimeFallbackPicoLocal || audio_fallback_reason != reason;
    if (!changed) {
        return;
    }
    const bool was_host_encoded = audio_runtime_mode == AudioRuntimeHostEncodedActive;
    audio_debug_log(
        AudioDebugHostMode,
        static_cast<uint8_t>(AudioRuntimeFallbackPicoLocal),
        static_cast<uint8_t>(reason),
        clamp_debug_u8(host_stream_generation),
        0,
        0
    );
    audio_runtime_mode = AudioRuntimeFallbackPicoLocal;
    audio_fallback_reason = reason;
    host_stream_active = false;
    host_last_frame_us = 0;
    if (was_host_encoded) {
        restart_fallback_speaker_fade_in();
    } else {
        set_fallback_speaker_target_gain(1.0f);
    }
    clear_host_reassembly();
    if (!audio_initialized) {
        return;
    }
    clear_mic_queues();
    drain_audio_queues();
}

static bool host_heartbeat_healthy(uint32_t now) {
    return host_last_heartbeat_us != 0
        && static_cast<uint32_t>(now - host_last_heartbeat_us) < HOST_HEARTBEAT_TIMEOUT_US;
}

static bool host_stream_healthy(uint32_t now) {
    if (!host_stream_active) {
        return false;
    }
    if (host_heartbeat_healthy(now)) {
        return true;
    }
    if (host_last_frame_us != 0) {
        return static_cast<uint32_t>(now - host_last_frame_us) < HOST_STREAM_TIMEOUT_US;
    }
    return host_stream_started_us != 0
        && static_cast<uint32_t>(now - host_stream_started_us) < HOST_STREAM_START_GRACE_US;
}

static bool host_start_grace_active(uint32_t now) {
    const uint32_t started = host_stream_active ? host_stream_started_us : host_request_started_us;
    return started != 0 && static_cast<uint32_t>(now - started) < HOST_STREAM_START_GRACE_US;
}

static uint32_t host_last_contact_us() {
    uint32_t contact = host_last_heartbeat_us;
    if (host_last_frame_us != 0 && (contact == 0 || static_cast<int32_t>(host_last_frame_us - contact) > 0)) {
        contact = host_last_frame_us;
    }
    if (host_stream_started_us != 0 && (contact == 0 || static_cast<int32_t>(host_stream_started_us - contact) > 0)) {
        contact = host_stream_started_us;
    }
    return contact;
}

static bool host_recovery_hold_active(uint32_t now) {
    if (audio_runtime_mode != AudioRuntimeHostEncodedActive || !host_audio_requested || !host_stream_active) {
        return false;
    }
    const uint32_t contact = host_last_contact_us();
    return contact != 0 && static_cast<uint32_t>(now - contact) < HOST_STREAM_RECOVERY_HOLD_US;
}

static void audio_host_poll() {
    const uint32_t now = time_us_32();
    if (!host_audio_requested) {
        if (audio_runtime_mode != AudioRuntimeFallbackPicoLocal || audio_fallback_reason != AudioFallbackHostDisabled) {
            enter_fallback(AudioFallbackHostDisabled);
        }
        return;
    }

    if (!host_stream_healthy(now)) {
        if (host_start_grace_active(now)) {
            if (audio_fallback_reason == AudioFallbackHostDisabled) {
                audio_fallback_reason = AudioFallbackNone;
            }
            return;
        }
        if (host_recovery_hold_active(now)) {
            return;
        }
        enter_fallback(host_heartbeat_healthy(now) ? AudioFallbackStreamTimeout : AudioFallbackHeartbeatTimeout);
        return;
    }

    if (audio_runtime_mode != AudioRuntimeHostEncodedActive) {
        audio_runtime_mode = AudioRuntimeHostEncodedActive;
        audio_fallback_reason = AudioFallbackNone;
        drain_audio_queues();
        clear_partial_audio_state();
        schedule_host_route_primer();
        audio_debug_log(
            AudioDebugHostMode,
            static_cast<uint8_t>(AudioRuntimeHostEncodedActive),
            0,
            clamp_debug_u8(host_stream_generation),
            0,
            0
        );
    }
}

static void clear_partial_audio_state() {
    audio_buf_pos = 0;
    audio_haptic_buf_pos = 0;
    audio_silence_tail_logged = false;
    memset(audio_buf, 0, sizeof(audio_buf));
    memset(audio_haptic_buf, 0, sizeof(audio_haptic_buf));
    resampler.Reset();
}

static void schedule_speaker_silence_preroll() {
    speaker_silence_preroll_packets_remaining = SPEAKER_SILENCE_PREROLL_USB_PACKETS;
    speaker_silence_preroll_last_packet_us = 0;
    audio_debug_packet_log_budget = max<uint8_t>(audio_debug_packet_log_budget, 4);
}

void audio_handle_controller_disconnect() {
    test_haptics_active = false;
    test_haptics_packets_remaining = 0;
    test_haptics_neutral_packets_remaining = 0;
    cached_state_right_trigger_valid = false;
    cached_state_left_trigger_valid = false;
    cached_state_trigger_power = 0;
    cached_state_trigger_power_valid = false;
    plug_headset = false;
    controller_state_ready = false;
    host_route_primer_toggle_pending = false;
    reset_controller_audio_report_counters();
    drain_audio_queues();
    clear_partial_audio_state();
    speaker_silence_preroll_packets_remaining = 0;
    speaker_silence_preroll_last_packet_us = 0;
    speaker_route_active = false;
    speaker_route_headset = false;
    last_audio_us = 0;
}

static bool should_keep_speaker_route_open() {
    return bt_is_controller_connected() && controller_state_ready && volume[0] > 0.0f;
}

static void update_persistent_speaker_route() {
    if (quiet_mode_enabled) {
        return;
    }

    if (should_keep_speaker_route_open()) {
        if (!speaker_route_active) {
            bt_set_speaker_output_enabled(true, plug_headset, true);
            speaker_route_active = true;
            speaker_route_headset = plug_headset;
            schedule_speaker_silence_preroll();
            audio_debug_log(
                AudioDebugSpeakerRoute,
                1,
                clamp_debug_u8(static_cast<uint32_t>(volume[0] * 100.0f)),
                quiet_mode_enabled ? 1 : 0,
                plug_headset ? 1 : 0,
                0
            );
        }
        return;
    }

    if (speaker_route_active) {
        bt_set_speaker_output_enabled(false);
        speaker_route_active = false;
        speaker_route_headset = false;
        audio_debug_log(
            AudioDebugSpeakerRoute,
            0,
            clamp_debug_u8(static_cast<uint32_t>(volume[0] * 100.0f)),
            quiet_mode_enabled ? 1 : 0,
            0,
            0
        );
    }
}

static bool send_audio_haptics_packet(const int8_t *haptic_buf, bool include_speaker) {
    uint8_t pkt[REPORT_SIZE]{};
    pkt[0] = REPORT_ID;
    pkt[1] = reportSeqCounter << 4;
    reportSeqCounter = (reportSeqCounter + 1) & 0x0F;
    pkt[2] = 0x11 | (1 << 7);
    pkt[3] = 7;
    pkt[4] = AUDIO_SECTION_ENABLE_MASK;
    const uint8_t buffer_length = haptics_buffer_length;
    pkt[5] = buffer_length;
    pkt[6] = buffer_length;
    pkt[7] = buffer_length;
    pkt[8] = buffer_length;
    pkt[9] = buffer_length;
    pkt[10] = packetCounter++;
    pkt[11] = 0x10 | (1 << 7);
    pkt[12] = sizeof(state_data);
    copy_routed_state_data(pkt + 13);
    pkt[76] = 0x12 | (1 << 7);
    pkt[77] = SAMPLE_SIZE;
    memcpy(pkt + 78, haptic_buf, SAMPLE_SIZE);

    if (include_speaker) {
        uint8_t speaker_data[sizeof(opus_buf)]{};
        bool have_opus_packet = false;
        critical_section_enter_blocking(&opus_cs);
        if (opus_buf_valid && opus_buf_generation == audio_stream_generation) {
            memcpy(speaker_data, opus_buf, sizeof(speaker_data));
            have_opus_packet = true;
        }
        critical_section_exit(&opus_cs);

        if (have_opus_packet) {
            const bool force_route = !speaker_route_active || speaker_route_headset != plug_headset;
            bt_set_speaker_output_enabled(true, plug_headset, force_route);
            speaker_route_active = true;
            speaker_route_headset = plug_headset;
            pkt[142] = (plug_headset ? 0x16 : 0x13) | 0 << 6 | 1 << 7;
            pkt[143] = sizeof(speaker_data);
            memcpy(pkt + 144, speaker_data, sizeof(speaker_data));
            if (audio_debug_packet_log_budget != 0) {
                const uint8_t speaker_flags = plug_headset ? 0x01 : 0x00;
                audio_debug_packet_log_budget--;
                audio_debug_log(
                    AudioDebugSendSpeakerPacket,
                    clamp_debug_u8(queue_get_level(&audio_fifo)),
                    opus_debug_level(),
                    pkt[10],
                    reportSeqCounter,
                    speaker_flags
                );
            }
        } else {
            if (audio_debug_packet_log_budget != 0) {
                audio_debug_packet_log_budget--;
                audio_debug_log(
                    AudioDebugNoOpusPacket,
                    clamp_debug_u8(queue_get_level(&audio_fifo)),
                    opus_debug_level(),
                    pkt[10],
                    reportSeqCounter,
                    0
                );
            }
            return false;
        }
    }

    return bt_write_audio_stream(pkt, sizeof(pkt));
}

static void apply_haptics_gain_to_packet(uint8_t *data) {
    if (data == nullptr) {
        return;
    }

    const float gain = clamp(volume[1], 0.0f, 2.0f);
    if (gain == 1.0f) {
        return;
    }

    int8_t *samples = reinterpret_cast<int8_t *>(data);
    for (uint16_t i = 0; i < SAMPLE_SIZE; i++) {
        const int scaled = static_cast<int>(samples[i] * gain);
        samples[i] = static_cast<int8_t>(clamp(scaled, -128, 127));
    }
}

static void build_host_audio_report_header(uint8_t *packet) {
    memset(packet, 0, HOST_AUDIO_REPORT_SIZE);
    packet[0] = REPORT_ID;
    packet[2] = 0x11 | (1 << 7);
    packet[3] = 7;
    packet[4] = AUDIO_SECTION_ENABLE_MASK;
    const uint8_t buffer_length = haptics_buffer_length;
    packet[5] = buffer_length;
    packet[6] = buffer_length;
    packet[7] = buffer_length;
    packet[8] = buffer_length;
    packet[9] = buffer_length;
    packet[11] = 0x10 | (1 << 7);
    packet[12] = sizeof(state_data);
    copy_routed_state_data(packet + 13);
    packet[76] = 0x12 | (1 << 7);
    packet[77] = SAMPLE_SIZE;
    packet[142] = (plug_headset ? 0x16 : 0x13) | (1 << 7);
    packet[143] = 200;
}

static bool write_host_audio_packet(uint8_t *packet, bool count_host_frame) {
    if (packet == nullptr) {
        host_frames_dropped++;
        return false;
    }

    packet[0] = REPORT_ID;
    packet[1] = reportSeqCounter << 4;
    reportSeqCounter = (reportSeqCounter + 1) & 0x0F;
    packet[10] = packetCounter++;

    const bool force_route =
        !speaker_route_active
        || speaker_route_headset != plug_headset;

    bt_set_speaker_output_enabled(true, plug_headset, force_route);
    speaker_route_active = true;
    speaker_route_headset = plug_headset;

    if (!bt_write_audio_stream(packet, HOST_AUDIO_REPORT_SIZE)) {
        host_frames_dropped++;
        return false;
    }

    if (count_host_frame) {
        host_frames_received++;
    }
    host_last_frame_us = time_us_32();
    return true;
}

bool audio_schedule_test_haptics() {
    const uint32_t now = time_us_32();
    const bool haptics_cooling_down = test_haptics_cooldown_until_us != 0
        && !time_reached(now, test_haptics_cooldown_until_us);
    if (
        quiet_mode_enabled
        || usb_host_hid_output_recent()
        || test_haptics_active
        || haptics_cooling_down
    ) {
        return false;
    }
    test_haptics_cooldown_until_us = 0;

    drain_audio_queues();
    clear_partial_audio_state();
    bt_set_speaker_output_enabled(false);
    speaker_route_active = false;
    speaker_route_headset = false;
    last_audio_us = 0;
    test_haptics_active = true;
    test_haptics_packets_remaining = TEST_HAPTICS_PACKET_COUNT;
    test_haptics_neutral_packets_remaining = 0;
    test_haptics_last_packet_us = 0;
    audio_debug_log(
        AudioDebugTestHapticsStart,
        clamp_debug_u8(queue_get_level(&audio_fifo)),
        opus_debug_level(),
        clamp_debug_u8(static_cast<uint32_t>(volume[1] * 100.0f)),
        0,
        0
    );
    return true;
}

bool audio_test_haptics_busy() {
    return test_haptics_active;
}

bool audio_test_haptics_cooldown() {
    if (!bt_is_controller_connected()) {
        return false;
    }
    if (test_haptics_cooldown_until_us == 0) {
        return false;
    }
    if (time_reached(time_us_32(), test_haptics_cooldown_until_us)) {
        test_haptics_cooldown_until_us = 0;
        return false;
    }
    return true;
}

static bool audio_silence_tail_active(uint32_t now) {
    return last_audio_us != 0 && static_cast<uint32_t>(now - last_audio_us) < SPEAKER_USB_SILENCE_TAIL_US;
}

bool audio_recent() {
    const uint32_t now = time_us_32();
    if (audio_silence_tail_active(now)) {
        return true;
    }
    return audio_runtime_mode == AudioRuntimeHostEncodedActive
        && host_last_frame_us != 0
        && static_cast<uint32_t>(now - host_last_frame_us) < SPEAKER_USB_SILENCE_TAIL_US;
}

bool audio_host_encoded_active() {
    return audio_runtime_mode == AudioRuntimeHostEncodedActive && host_stream_active;
}

bool audio_haptics_ready() {
    return audio_initialized;
}

void audio_set_quiet_mode(bool enabled) {
    if (quiet_mode_enabled == enabled) {
        return;
    }

    quiet_mode_enabled = enabled;
    if (!enabled) {
        return;
    }

    test_haptics_active = false;
    test_haptics_packets_remaining = 0;
    test_haptics_neutral_packets_remaining = 0;
    drain_audio_queues();
    clear_partial_audio_state();
    bt_set_speaker_output_enabled(false);
    speaker_route_active = false;
    speaker_route_headset = false;
    last_audio_us = 0;
    audio_debug_log(
        AudioDebugQuietMode,
        enabled ? 1 : 0,
        clamp_debug_u8(queue_get_level(&audio_fifo)),
        opus_debug_level(),
        0,
        0
    );
}

bool audio_quiet_mode_enabled() {
    return quiet_mode_enabled;
}

void audio_host_set_requested(bool enabled) {
    host_audio_requested = enabled;
    if (!enabled) {
        host_request_started_us = 0;
        set_fallback_speaker_target_gain(1.0f);
        enter_fallback(AudioFallbackHostDisabled);
    } else {
        const uint32_t now = time_us_32();
        host_request_started_us = now;
        host_last_heartbeat_us = now;
        set_fallback_speaker_target_gain(0.0f);
        if (audio_initialized) {
            drain_audio_queues();
            clear_partial_audio_state();
            speaker_silence_preroll_packets_remaining = 0;
        }
        if (audio_fallback_reason == AudioFallbackHostDisabled) {
            audio_fallback_reason = AudioFallbackNone;
        }
    }
}

void audio_host_note_heartbeat() {
    host_last_heartbeat_us = time_us_32();
}

void audio_host_start_stream() {
    host_audio_requested = true;
    host_stream_active = true;
    set_fallback_speaker_target_gain(0.0f);
    host_stream_started_us = time_us_32();
    host_request_started_us = host_stream_started_us;
    host_last_heartbeat_us = host_stream_started_us;
    host_last_frame_us = 0;
    reset_controller_audio_report_counters();
    host_frames_received = 0;
    host_frames_dropped = 0;
    host_startup_drop_frames_remaining = HOST_STARTUP_DROP_FRAMES;
    audio_debug_reset_stats();
    bt_reset_output_debug_stats();
    schedule_host_route_primer();
    host_stream_generation++;
    if (host_stream_generation == 0) {
        host_stream_generation = 1;
    }
    clear_host_reassembly();
    if (audio_initialized) {
        audio_runtime_mode = AudioRuntimeHostEncodedActive;
        audio_fallback_reason = AudioFallbackNone;
        drain_audio_queues();
        clear_partial_audio_state();
        schedule_host_route_primer();
    }
}

void audio_host_stop_stream(AudioFallbackReason reason) {
    host_stream_active = false;
    host_request_started_us = 0;
    host_last_frame_us = 0;
    clear_host_reassembly();
    enter_fallback(reason);
}

void audio_host_set_duplex_requested(bool enabled) {
    const bool changed = host_duplex_requested != enabled;
    host_duplex_requested = enabled;
    if (changed && !enabled) {
        clear_mic_queues();
    }
}

bool audio_duplex_active() {
    return host_mic_path_active();
}

void audio_set_mic_output_state(uint8_t volume_percent, bool muted) {
    mic_output_volume_percent = volume_percent > 100 ? 100 : volume_percent;
    mic_output_muted = muted;
}

static bool submit_host_audio_report(uint8_t const *report, uint16_t len) {
    if (!controller_state_ready) {
        host_frames_dropped++;
        return false;
    }

    if (report == nullptr) {
        host_frames_dropped++;
        enter_fallback(AudioFallbackInvalidPacket);
        return false;
    }

    uint8_t packet[HOST_AUDIO_REPORT_SIZE];
    if (len == HOST_AUDIO_COMPACT_REPORT_SIZE) {
        build_host_audio_report_header(packet);
        memcpy(packet + 78, report, SAMPLE_SIZE);
        apply_haptics_gain_to_packet(packet + 78);
        memcpy(packet + 144, report + SAMPLE_SIZE, 200);
    } else if (len == HOST_AUDIO_REPORT_SIZE && report[0] == REPORT_ID) {
        memcpy(packet, report, sizeof(packet));
        copy_routed_state_data(packet + 13);
        packet[142] = (plug_headset ? 0x16 : 0x13) | (1 << 7);
        apply_haptics_gain_to_packet(packet + 78);
    } else {
        host_frames_dropped++;
        enter_fallback(AudioFallbackInvalidPacket);
        return false;
    }

    (void)prime_host_audio_route_if_needed();
    if (host_startup_drop_frames_remaining != 0) {
        host_startup_drop_frames_remaining--;
        host_frames_dropped++;
        host_last_frame_us = time_us_32();
        return true;
    }

    return write_host_audio_packet(packet, true);
}

bool audio_host_receive_packet(uint8_t const *data, uint16_t len) {
    if (data != nullptr && len >= HostFastPacketPayload && data[HostFastPacketType] == HostAudioFastFrameFragment) {
        audio_host_note_heartbeat();
        if (!host_audio_requested || !host_stream_active) {
            host_frames_dropped++;
            return false;
        }

        const uint16_t sequence = read_le_u16(data + HostFastPacketSequence);
        const uint8_t fragment_index = data[HostFastPacketFragmentIndex];
        const uint8_t fragment_count = data[HostFastPacketFragmentCount];
        const uint8_t payload_length = data[HostFastPacketPayloadLength];
        if (
            payload_length == 0
            || payload_length > 57
            || fragment_count == 0
            || fragment_count > 5
            || fragment_index >= fragment_count
            || static_cast<uint16_t>(payload_length + HostFastPacketPayload) > len
        ) {
            host_frames_dropped++;
            enter_fallback(AudioFallbackInvalidPacket);
            return false;
        }

        if (host_reassembly_sequence != sequence || host_reassembly_chunk_count != fragment_count) {
            note_incomplete_host_reassembly(0xfe);
            clear_host_reassembly();
            host_reassembly_sequence = sequence;
            host_reassembly_chunk_count = fragment_count;
        }

        const uint16_t offset = static_cast<uint16_t>(fragment_index) * 57;
        if (offset + payload_length > HOST_AUDIO_COMPACT_REPORT_SIZE) {
            host_frames_dropped++;
            clear_host_reassembly();
            return false;
        }

        memcpy(host_reassembly_buffer + offset, data + HostFastPacketPayload, payload_length);
        host_reassembly_received_mask = static_cast<uint16_t>(host_reassembly_received_mask | (1u << fragment_index));
        const uint16_t received_end = offset + payload_length;
        if (received_end > host_reassembly_received_bytes) {
            host_reassembly_received_bytes = received_end;
        }
        if (fragment_index + 1 == fragment_count) {
            host_reassembly_expected_length = received_end;
        }
        host_last_frame_us = time_us_32();
        const uint16_t expected_mask = static_cast<uint16_t>((1u << fragment_count) - 1u);
        if (
            host_reassembly_received_mask != expected_mask
            || host_reassembly_expected_length != HOST_AUDIO_COMPACT_REPORT_SIZE
            || host_reassembly_received_bytes < HOST_AUDIO_COMPACT_REPORT_SIZE
        ) {
            return true;
        }

        const bool submitted = submit_host_audio_report(host_reassembly_buffer, HOST_AUDIO_COMPACT_REPORT_SIZE);
        clear_host_reassembly();
        return submitted;
    }

    if (data == nullptr || len < HOST_PACKET_HEADER_SIZE || !host_packet_has_magic(data)) {
        host_frames_dropped++;
        enter_fallback(AudioFallbackInvalidPacket);
        return false;
    }
    if (data[HostPacketProtocolMajor] != 1) {
        host_frames_dropped++;
        enter_fallback(AudioFallbackInvalidPacket);
        return false;
    }

    const uint8_t type = data[HostPacketType];
    const uint16_t packet_generation = read_le_u16(data + HostPacketGeneration);
    const uint16_t sequence = read_le_u16(data + HostPacketSequence);
    const uint8_t chunk_index = data[HostPacketChunkIndex];
    const uint8_t chunk_count = data[HostPacketChunkCount];
    const uint16_t payload_length = read_le_u16(data + HostPacketPayloadLength);

    switch (type) {
        case HostAudioHello:
        case HostAudioHeartbeat:
            audio_host_note_heartbeat();
            return true;

        case HostAudioStart:
            audio_host_start_stream();
            return true;

        case HostAudioStop:
            audio_host_stop_stream(AudioFallbackCompanionStop);
            return true;

        case HostAudioSetDuplexEnabled:
            audio_host_set_duplex_requested(true);
            audio_host_note_heartbeat();
            return true;

        case HostAudioSetDuplexDisabled:
            audio_host_set_duplex_requested(false);
            audio_host_note_heartbeat();
            return true;

        case HostAudioFrameChunk:
            break;

        default:
            host_frames_dropped++;
            enter_fallback(AudioFallbackInvalidPacket);
            return false;
    }

    audio_host_note_heartbeat();
    if (!host_audio_requested || !host_stream_active || packet_generation != host_stream_generation) {
        host_frames_dropped++;
        return false;
    }
    if (chunk_count == 0 || chunk_count > 10 || chunk_index >= chunk_count || payload_length > HOST_PACKET_PAYLOAD_SIZE) {
        host_frames_dropped++;
        enter_fallback(AudioFallbackInvalidPacket);
        return false;
    }

    host_last_frame_us = time_us_32();
    if (
        host_reassembly_generation != packet_generation
        || host_reassembly_sequence != sequence
        || host_reassembly_chunk_count != chunk_count
    ) {
        note_incomplete_host_reassembly(0xfd);
        clear_host_reassembly();
        host_reassembly_generation = packet_generation;
        host_reassembly_sequence = sequence;
        host_reassembly_chunk_count = chunk_count;
    }

    const uint16_t offset = static_cast<uint16_t>(chunk_index) * HOST_PACKET_PAYLOAD_SIZE;
    if (offset + payload_length > sizeof(host_reassembly_buffer)) {
        host_frames_dropped++;
        enter_fallback(AudioFallbackInvalidPacket);
        return false;
    }
    memcpy(host_reassembly_buffer + offset, data + HostPacketPayload, payload_length);
    host_reassembly_received_mask = static_cast<uint16_t>(host_reassembly_received_mask | (1u << chunk_index));
    const uint16_t received_end = offset + payload_length;
    if (received_end > host_reassembly_received_bytes) {
        host_reassembly_received_bytes = received_end;
    }
    if (chunk_index + 1 == chunk_count) {
        host_reassembly_expected_length = received_end;
    }

    const uint16_t expected_mask = static_cast<uint16_t>((1u << chunk_count) - 1u);
    if (
        host_reassembly_received_mask != expected_mask
        || host_reassembly_expected_length == 0
        || host_reassembly_received_bytes < host_reassembly_expected_length
    ) {
        return true;
    }

    const bool submitted = submit_host_audio_report(host_reassembly_buffer, host_reassembly_expected_length);
    clear_host_reassembly();
    return submitted;
}

void audio_get_host_status(audio_host_status *status) {
    if (status == nullptr) {
        return;
    }

    const uint32_t now = time_us_32();
    memset(status, 0, sizeof(*status));
    status->mode = static_cast<uint8_t>(audio_runtime_mode);
    status->fallback_reason = static_cast<uint8_t>(audio_fallback_reason);
    status->host_requested = host_audio_requested;
    status->heartbeat_healthy = host_heartbeat_healthy(now);
    status->stream_active = host_stream_active;
    status->stream_healthy = host_stream_healthy(now);
    status->duplex_requested = host_duplex_requested;
    status->duplex_active = audio_duplex_active();
    status->controller_state_ready = controller_state_ready;
    status->headset_plugged = plug_headset;
    status->headset_audio_route = speaker_route_active && speaker_route_headset;
    status->stream_generation = host_stream_generation;
    status->heartbeat_age_ms = host_last_heartbeat_us == 0 ? 0xffffffffu : static_cast<uint32_t>(now - host_last_heartbeat_us) / 1000u;
    status->frame_age_ms = host_last_frame_us == 0 ? 0xffffffffu : static_cast<uint32_t>(now - host_last_frame_us) / 1000u;
    status->host_frames_received = host_frames_received;
    status->host_frames_dropped = host_frames_dropped;
    status->mic_packets_received = mic_packets_received;
    status->mic_packets_dropped = mic_packets_dropped;
    status->mic_decode_success = mic_decode_success;
    status->mic_decode_fail = mic_decode_fail;
    status->mic_usb_write_success = mic_usb_write_success;
    status->mic_usb_write_short = mic_usb_write_short;
    status->mic_last_decoded_samples = mic_last_decoded_samples;
    status->mic_last_written_bytes = mic_last_written_bytes;
    status->mic_peak_permille = mic_peak_permille;
    status->mic_usb_streaming = host_mic_path_active() && usb_mic_streaming_active();
}

void audio_set_haptics_buffer_length(uint8_t length) {
    haptics_buffer_length = clamp<uint8_t>(length, MIN_HAPTICS_BUFFER_LENGTH, MAX_HAPTICS_BUFFER_LENGTH);
}

uint8_t audio_haptics_buffer_length() {
    return haptics_buffer_length;
}

void audio_debug_copy_report_payload(uint8_t *buffer, uint8_t max_len) {
    if (buffer == nullptr || max_len < AUDIO_DEBUG_REPORT_HEADER_SIZE) {
        return;
    }

    memset(buffer, 0, max_len);
    buffer[1] = AUDIO_DEBUG_RECORD_SIZE;

#if DS5_AUDIO_DEBUG_ENABLED
    if (!audio_debug_cs_ready) {
        return;
    }

    critical_section_enter_blocking(&audio_debug_cs);

    const uint32_t latest_sequence = audio_debug_next_sequence > 1 ? audio_debug_next_sequence - 1 : 0;
    write_debug_u32(buffer + 2, latest_sequence);
    write_debug_u16(buffer + 6, audio_debug_dropped_count);

    const uint8_t max_records = static_cast<uint8_t>((max_len - AUDIO_DEBUG_REPORT_HEADER_SIZE) / AUDIO_DEBUG_RECORD_SIZE);
    const uint32_t oldest_sequence = audio_debug_next_sequence - audio_debug_count;
    if (audio_debug_read_sequence < oldest_sequence) {
        audio_debug_read_sequence = oldest_sequence;
    }

    const uint32_t available_records = audio_debug_next_sequence > audio_debug_read_sequence
        ? audio_debug_next_sequence - audio_debug_read_sequence
        : 0;
    const uint8_t record_count = static_cast<uint8_t>(std::min<uint32_t>(available_records, max_records));
    buffer[0] = record_count;

    const uint8_t oldest_index = static_cast<uint8_t>(
        (audio_debug_head + AUDIO_DEBUG_RING_SIZE - audio_debug_count) % AUDIO_DEBUG_RING_SIZE
    );
    for (uint8_t i = 0; i < record_count; i++) {
        const uint32_t sequence = audio_debug_read_sequence + i;
        const uint8_t ring_index = static_cast<uint8_t>(
            (oldest_index + (sequence - oldest_sequence)) % AUDIO_DEBUG_RING_SIZE
        );
        const audio_debug_event &event = audio_debug_ring[ring_index];
        uint8_t *record = buffer + AUDIO_DEBUG_REPORT_HEADER_SIZE + (i * AUDIO_DEBUG_RECORD_SIZE);
        write_debug_u32(record, event.sequence);
        write_debug_u32(record + 4, event.timestamp_us);
        record[8] = event.code;
        record[9] = event.arg0;
        record[10] = event.arg1;
        record[11] = event.arg2;
        record[12] = event.arg3;
        record[13] = event.arg4;
    }
    audio_debug_read_sequence += record_count;

    critical_section_exit(&audio_debug_cs);
#endif
}

void audio_debug_get_stats(audio_debug_stats *stats) {
    if (stats == nullptr) {
        return;
    }
    memset(stats, 0, sizeof(*stats));
#if DS5_AUDIO_DEBUG_ENABLED
    if (!audio_debug_cs_ready) {
        return;
    }
    critical_section_enter_blocking(&audio_debug_cs);
    *stats = audio_stats;
    critical_section_exit(&audio_debug_cs);
#endif
}

void audio_test_haptics_loop() {
    if (quiet_mode_enabled) {
        return;
    }

    if (!test_haptics_active) {
        return;
    }
    if (!bt_is_controller_connected()) {
        test_haptics_active = false;
        test_haptics_packets_remaining = 0;
        test_haptics_neutral_packets_remaining = 0;
        test_haptics_cooldown_until_us = 0;
        audio_debug_log(AudioDebugTestHapticsStop, 0, 0, 0, 0, 0);
        return;
    }

    const uint32_t now = time_us_32();
    if (
        test_haptics_last_packet_us != 0
        && static_cast<uint32_t>(now - test_haptics_last_packet_us) < TEST_HAPTICS_PACKET_INTERVAL_US
    ) {
        return;
    }

    int8_t haptic_buf[SAMPLE_SIZE]{};
    if (test_haptics_packets_remaining != 0) {
        const bool positive_phase = (test_haptics_packets_remaining & 1) != 0;
        const int amplitude = clamp(
            static_cast<int>(TEST_HAPTICS_BASE_AMPLITUDE * clamp(volume[1], 0.0f, 2.0f)),
            0,
            127
        );
        for (int i = 0; i < SAMPLE_SIZE; i += 2) {
            haptic_buf[i] = positive_phase ? amplitude : -amplitude;
            haptic_buf[i + 1] = positive_phase ? -amplitude : amplitude;
        }
    }

    send_audio_haptics_packet(haptic_buf, false);
    test_haptics_last_packet_us = now;
    if (test_haptics_packets_remaining != 0) {
        test_haptics_packets_remaining--;
        if (test_haptics_packets_remaining == 0) {
            test_haptics_neutral_packets_remaining = TEST_HAPTICS_NEUTRAL_PACKET_COUNT;
        }
    } else if (test_haptics_neutral_packets_remaining != 0) {
        test_haptics_neutral_packets_remaining--;
    }

    if (test_haptics_packets_remaining == 0 && test_haptics_neutral_packets_remaining == 0) {
        test_haptics_active = false;
        test_haptics_cooldown_until_us = now + TEST_HAPTICS_COOLDOWN_US;
        audio_debug_log(
            AudioDebugTestHapticsStop,
            1,
            clamp_debug_u8(queue_get_level(&audio_fifo)),
            opus_debug_level(),
            0,
            0
        );
    }
}

static bool process_usb_audio_packet() {
    const uint32_t now = time_us_32();
    if (!tud_audio_available()) {
        return false;
    }

    int16_t raw[192];
    uint32_t bytes_read = tud_audio_read(raw, sizeof(raw)); // Reads 384 bytes at a time.
    int frames = bytes_read / (INPUT_CHANNELS * sizeof(int16_t));
    if (frames == 0) {
        return false;
    }
    audio_stats_note_usb_read(now);
    const bool has_signal = usb_audio_has_signal(raw, frames);
    const bool use_silence_preroll = !has_signal && speaker_silence_preroll_packets_remaining != 0;
    if (!has_signal && !use_silence_preroll && !audio_silence_tail_active(now)) {
        return true;
    }

    if (use_silence_preroll) {
        speaker_silence_preroll_packets_remaining--;
        if (speaker_silence_preroll_packets_remaining == SPEAKER_SILENCE_PREROLL_USB_PACKETS - 1) {
            audio_debug_log(
                AudioDebugSilencePreroll,
                SPEAKER_SILENCE_PREROLL_USB_PACKETS,
                clamp_debug_u8(queue_get_level(&audio_fifo)),
                opus_debug_level(),
                packetCounter,
                reportSeqCounter
            );
        }
    } else if (has_signal && last_audio_us == 0) {
        speaker_silence_preroll_packets_remaining = 0;
        audio_silence_tail_logged = false;
        audio_debug_packet_log_budget = 4;
        audio_debug_log(
            AudioDebugAudioStart,
            clamp_debug_u8(queue_get_level(&audio_fifo)),
            opus_debug_level(),
            clamp_debug_u8(static_cast<uint32_t>(frames)),
            packetCounter,
            reportSeqCounter
        );
    } else if (has_signal && !audio_recent()) {
        speaker_silence_preroll_packets_remaining = 0;
        audio_silence_tail_logged = false;
        const uint32_t gap_ms = static_cast<uint32_t>(now - last_audio_us) / 1000;
        const uint8_t audio_level = clamp_debug_u8(queue_get_level(&audio_fifo));
        const uint8_t opus_level = opus_debug_level();
        clear_partial_audio_state();
        drain_audio_queues();
        audio_debug_packet_log_budget = 4;
        audio_debug_log(
            AudioDebugResetGap,
            audio_level,
            opus_level,
            clamp_debug_u8(gap_ms),
            packetCounter,
            0
        );
    } else if (has_signal) {
        audio_silence_tail_logged = false;
    } else if (!audio_silence_tail_logged) {
        audio_silence_tail_logged = true;
        audio_debug_packet_log_budget = max<uint8_t>(audio_debug_packet_log_budget, 4);
        audio_debug_log(
            AudioDebugUsbSilenceTail,
            clamp_debug_u8(static_cast<uint32_t>(frames)),
            clamp_debug_u8(queue_get_level(&audio_fifo)),
            opus_debug_level(),
            packetCounter,
            reportSeqCounter
        );
    }
    if (has_signal) {
        last_audio_us = time_us_32();
    }

    // 2. Extract ch3/ch4 from 4-channel audio as float resampler input.
    WDL_ResampleSample *in_buf;
    int nframes = resampler.ResamplePrepare(frames, OUTPUT_CHANNELS, &in_buf);

    const float speaker_gain = usb_host_mute[0] ? 0.0f : clamp(volume[0], 0.0f, 1.0f) * usb_host_speaker_gain;
    for (int i = 0; i < nframes; i++) {
        const float transition_gain = next_fallback_speaker_gain();
        audio_buf[audio_buf_pos++] = raw[i * INPUT_CHANNELS] / 32768.0f * speaker_gain * transition_gain;
        audio_buf[audio_buf_pos++] = raw[i * INPUT_CHANNELS + 1] / 32768.0f * speaker_gain * transition_gain;
        if (audio_buf_pos == 512 * 2) {
            static audio_raw_element element{};
            memcpy(element.data,audio_buf,512 * 2 * 4);
            element.generation = audio_stream_generation;
            if (queue_is_full(&audio_fifo)){
                audio_debug_log(
                    AudioDebugAudioFifoDrop,
                    clamp_debug_u8(queue_get_level(&audio_fifo)),
                    opus_debug_level(),
                    packetCounter,
                    reportSeqCounter,
                    0
                );
                queue_try_remove(&audio_fifo,NULL);
            }
            if (!queue_try_add(&audio_fifo,&element)) {
                audio_debug_log(
                    AudioDebugAudioFifoAddFail,
                    clamp_debug_u8(queue_get_level(&audio_fifo)),
                    opus_debug_level(),
                    packetCounter,
                    reportSeqCounter,
                    0
                );
            }
            audio_buf_pos = 0;
        }

        in_buf[i * 2] = (WDL_ResampleSample) raw[i * INPUT_CHANNELS + 2] / 32768.0f;
        in_buf[i * 2 + 1] = (WDL_ResampleSample) raw[i * INPUT_CHANNELS + 3] / 32768.0f;
    }

    // 3. Resample 48 kHz to 3 kHz.
    static WDL_ResampleSample out_buf[SAMPLE_SIZE]; // 64 floats = 32 frames x 2 channels.
    int out_frames = resampler.ResampleOut(out_buf, nframes, SAMPLE_SIZE / OUTPUT_CHANNELS, OUTPUT_CHANNELS);

    // 4. Convert to int8 and buffer until a 64-byte haptic packet is ready.
    for (int i = 0; i < out_frames; i++) {
        int val_l = (int) (out_buf[i * 2] * 127.0f * max(volume[1],0.0f));
        int val_r = (int) (out_buf[i * 2 + 1] * 127.0f * max(volume[1],0.0f));
        audio_haptic_buf[audio_haptic_buf_pos++] = (int8_t) clamp(val_l, -128, 127); // Clamp defensively.
        audio_haptic_buf[audio_haptic_buf_pos++] = (int8_t) clamp(val_r, -128, 127);

        if (audio_haptic_buf_pos != SAMPLE_SIZE) {
            continue;
        }
        send_audio_haptics_packet(audio_haptic_buf, true);
        audio_haptic_buf_pos = 0;
    }
    return true;
}

static void discard_usb_audio_packets(uint8_t max_reads) {
    int16_t discard[192];
    uint8_t reads = 0;
    for (uint8_t i = 0; i < max_reads && tud_audio_available(); i++) {
        tud_audio_read(discard, sizeof(discard));
        reads++;
    }
    if (reads == 0) {
        return;
    }

#if !DS5_AUDIO_DEBUG_ENABLED
    return;
#else
    const uint32_t now = time_us_32();
    if (last_usb_discard_debug_us == 0 || static_cast<uint32_t>(now - last_usb_discard_debug_us) > 100000) {
        last_usb_discard_debug_us = now;
        audio_debug_note_usb_event(
            4,
            reads,
            max_reads,
            static_cast<uint8_t>(audio_runtime_mode),
            tud_audio_available() ? 1 : 0
        );
    }
#endif
}

static void queue_silent_speaker_block() {
    static audio_raw_element element{};
    memset(&element, 0, sizeof(element));
    element.generation = audio_stream_generation;
    if (queue_is_full(&audio_fifo)) {
        queue_try_remove(&audio_fifo, NULL);
    }
    (void)queue_try_add(&audio_fifo, &element);
}

static void process_idle_speaker_silence_preroll(uint32_t now) {
    if (
        speaker_silence_preroll_packets_remaining == 0
        || !speaker_route_active
        || quiet_mode_enabled
        || tud_audio_available()
    ) {
        return;
    }
    if (
        speaker_silence_preroll_last_packet_us != 0
        && !time_reached(now, speaker_silence_preroll_last_packet_us + SPEAKER_SILENCE_PREROLL_INTERVAL_US)
    ) {
        return;
    }

    queue_silent_speaker_block();
    speaker_silence_preroll_last_packet_us = now;

    int8_t haptic_buf[SAMPLE_SIZE]{};
    if (!send_audio_haptics_packet(haptic_buf, true)) {
        return;
    }

    speaker_silence_preroll_packets_remaining--;
    last_audio_us = now;
}

static void process_mic_usb_output() {
    if (!host_mic_path_active() || !usb_mic_streaming_active()) {
        if (mic_usb_playout_started || mic_usb_pending_len != 0) {
            tud_audio_clear_ep_in_ff();
        }
        mic_usb_playout_started = false;
        mic_usb_pending_offset = 0;
        mic_usb_pending_len = 0;
        return;
    }

    tu_fifo_t *ep_in_fifo = tud_audio_get_ep_in_ff();
    if (!mic_usb_playout_started) {
        if (queue_get_level(&mic_decode_fifo) < HOST_MIC_PLAYOUT_START_DEPTH) {
            return;
        }
        mic_usb_playout_started = true;
    }

    uint8_t chunks_written = 0;
    while (chunks_written < HOST_MIC_USB_FILL_MAX_CHUNKS) {
        const uint16_t fifo_level = ep_in_fifo != nullptr ? tu_fifo_count(ep_in_fifo) : 0;
        if (fifo_level >= HOST_MIC_USB_PREFILL_BYTES) {
            return;
        }

        if (mic_usb_pending_offset >= mic_usb_pending_len) {
            if (!queue_try_remove(&mic_decode_fifo, &mic_usb_pending)) {
                if (fifo_level < HOST_MIC_USB_PACKET_BYTES) {
                    mic_usb_playout_started = false;
                    mic_packets_dropped++;
                    audio_debug_log(
                        AudioDebugMicPacket,
                        3,
                        clamp_debug_u8(fifo_level),
                        clamp_debug_u8(queue_get_level(&mic_decode_fifo)),
                        clamp_debug_u8(mic_packets_dropped),
                        0
                    );
                }
                return;
            }
            mic_usb_pending_offset = 0;
            mic_usb_pending_len = mic_usb_pending.len;
        }

        const uint16_t remaining = static_cast<uint16_t>(mic_usb_pending_len - mic_usb_pending_offset);
        uint16_t target_len = std::min<uint16_t>(remaining, HOST_MIC_USB_PACKET_BYTES);
        if (ep_in_fifo != nullptr) {
            target_len = std::min<uint16_t>(target_len, tu_fifo_remaining(ep_in_fifo));
        }
        if (target_len == 0) {
            return;
        }

        const uint8_t *data = reinterpret_cast<uint8_t const *>(mic_usb_pending.data) + mic_usb_pending_offset;
        alignas(2) uint8_t scaled_data[HOST_MIC_USB_PACKET_BYTES]{};
        uint8_t const *write_data = data;
        const uint8_t output_percent = mic_output_muted ? 0 : mic_output_volume_percent;
        if (output_percent < 100) {
            const int16_t *samples = reinterpret_cast<int16_t const *>(data);
            int16_t *scaled_samples = reinterpret_cast<int16_t *>(scaled_data);
            const uint16_t sample_count = target_len / sizeof(int16_t);
            for (uint16_t i = 0; i < sample_count; i++) {
                scaled_samples[i] = static_cast<int16_t>((static_cast<int32_t>(samples[i]) * output_percent) / 100);
            }
            write_data = scaled_data;
        }
        const uint16_t written = tud_audio_write(write_data, target_len);
        mic_last_written_bytes = written;
        if (written > 0) {
            mic_usb_pending_offset = static_cast<uint16_t>(mic_usb_pending_offset + written);
            chunks_written++;
        }
        if (mic_usb_pending_offset >= mic_usb_pending_len) {
            mic_usb_pending_offset = 0;
            mic_usb_pending_len = 0;
        }

        if (written != target_len) {
            mic_usb_write_short++;
            mic_packets_dropped++;
            audio_debug_log(
                AudioDebugMicPacket,
                1,
                clamp_debug_u8(written),
                clamp_debug_u8(target_len),
                clamp_debug_u8(mic_packets_dropped),
                0
            );
            return;
        }

        mic_usb_write_success++;
    }
}

void audio_mic_add_packet(uint8_t const *data, uint16_t len) {
    if (!host_mic_path_active()) {
        return;
    }
    if (data == nullptr || len < HOST_MIC_OPUS_SIZE) {
        if (len != 0) {
            mic_packets_dropped++;
            audio_debug_log(AudioDebugMicPacket, 6, clamp_debug_u8(len), clamp_debug_u8(mic_packets_dropped), 0, 0);
        }
        return;
    }

    static mic_packet_element packet{};
    memcpy(packet.data, data, HOST_MIC_OPUS_SIZE);
    if (queue_is_full(&mic_fifo)) {
        queue_try_remove(&mic_fifo, NULL);
        mic_packets_dropped++;
        audio_debug_log(
            AudioDebugMicPacket,
            4,
            clamp_debug_u8(queue_get_level(&mic_fifo)),
            clamp_debug_u8(mic_packets_dropped),
            0,
            0
        );
    }
    if (queue_try_add(&mic_fifo, &packet)) {
        mic_packets_received++;
        audio_debug_log(
            AudioDebugMicPacket,
            2,
            clamp_debug_u8(mic_packets_received),
            clamp_debug_u8(queue_get_level(&mic_fifo)),
            0,
            0
        );
    } else {
        mic_packets_dropped++;
        audio_debug_log(AudioDebugMicPacket, 5, clamp_debug_u8(queue_get_level(&mic_fifo)), clamp_debug_u8(mic_packets_dropped), 0, 0);
    }
    if (mic_usb_playout_started && mic_next_plc_us == 0) {
        mic_next_plc_us = time_us_32() + HOST_MIC_OPUS_FRAME_INTERVAL_US;
    }
}

void audio_loop() {
    const uint32_t now = time_us_32();
    process_mic_usb_output();
    audio_host_poll();

    if (!bt_is_controller_connected()) {
        discard_usb_audio_packets(AUDIO_LOOP_MAX_USB_READS);
        if (speaker_route_active || last_audio_us != 0) {
            audio_handle_controller_disconnect();
        }
        if (audio_runtime_mode == AudioRuntimeHostEncodedActive) {
            enter_fallback(AudioFallbackControllerDisconnected);
        }
        return;
    }

    if (quiet_mode_enabled) {
        discard_usb_audio_packets(AUDIO_LOOP_MAX_USB_READS);
        if (speaker_route_active) {
            bt_set_speaker_output_enabled(false);
            speaker_route_active = false;
            speaker_route_headset = false;
        }
        return;
    }

    if (host_audio_requested && host_start_grace_active(time_us_32())) {
        (void)prime_host_audio_route_if_needed();
        discard_usb_audio_packets(AUDIO_LOOP_MAX_USB_READS);
        return;
    }

    if (audio_runtime_mode == AudioRuntimeHostEncodedActive) {
        (void)prime_host_audio_route_if_needed();
        discard_usb_audio_packets(AUDIO_LOOP_MAX_USB_READS);
        return;
    }

    update_persistent_speaker_route();
    process_idle_speaker_silence_preroll(now);

    for (uint8_t i = 0; i < AUDIO_LOOP_MAX_USB_READS; i++) {
        if (!process_usb_audio_packet()) {
            break;
        }
    }
}

void audio_init() {
#if DS5_AUDIO_DEBUG_ENABLED
    critical_section_init(&audio_debug_cs);
    audio_debug_cs_ready = true;
#endif
    resampler.SetMode(true, 0, false);
    resampler.SetRates(48000, 3000);
    resampler.SetFeedMode(true);
    resampler.Prealloc(2, 24, 6);
    queue_init(&audio_fifo,sizeof(audio_raw_element),2);
    queue_init(&mic_fifo,sizeof(mic_packet_element),HOST_MIC_QUEUE_DEPTH);
    queue_init(&mic_decode_fifo,sizeof(mic_decode_element),HOST_MIC_QUEUE_DEPTH);
    critical_section_init(&opus_cs);
    opus_cs_ready = true;
    multicore_launch_core1_with_stack(core1_entry,audio_core1_stack,sizeof(audio_core1_stack));
    audio_initialized = true;
}

static OpusEncoder *encoder;
static OpusDecoder *mic_decoder;
static WDL_Resampler resampler_audio;
static uint32_t core1_audio_stream_generation = 0;

static void reset_core1_audio_pipeline(uint32_t generation) {
    if (encoder != nullptr) {
        opus_encoder_ctl(encoder, OPUS_RESET_STATE);
    }
    resampler_audio.Reset();
    core1_audio_stream_generation = generation;
    audio_debug_log(
        AudioDebugCore1Reset,
        clamp_debug_u8(queue_get_level(&audio_fifo)),
        opus_debug_level(),
        clamp_debug_u8(generation),
        0,
        0
    );
}

static bool queue_mic_decoded_samples(int16_t const *decoded_mono, int decoded_samples, bool count_packet_decode) {
    if (decoded_mono == nullptr || decoded_samples <= 0) {
        return false;
    }

    static mic_decode_element decoded{};
    const int frames = std::min(decoded_samples, HOST_MIC_OPUS_FRAMES);
    uint32_t peak = 0;
    for (int frame = 0; frame < frames; frame++) {
        const int32_t sample = decoded_mono[frame];
        const uint32_t magnitude = static_cast<uint32_t>(sample < 0 ? -sample : sample);
        if (magnitude > peak) {
            peak = magnitude;
        }
        for (int channel = 0; channel < HOST_MIC_USB_CHANNELS; channel++) {
            decoded.data[frame * HOST_MIC_USB_CHANNELS + channel] = decoded_mono[frame];
        }
    }
    decoded.len = static_cast<uint16_t>(frames * HOST_MIC_USB_CHANNELS * sizeof(int16_t));
    if (count_packet_decode) {
        mic_decode_success++;
    }
    mic_last_decoded_samples = static_cast<uint16_t>(decoded_samples);
    mic_peak_permille = static_cast<uint16_t>(std::min<uint32_t>((peak * 1000U) / 32768U, 1000U));
    if (queue_is_full(&mic_decode_fifo)) {
        queue_try_remove(&mic_decode_fifo, NULL);
        mic_packets_dropped++;
        audio_debug_log(
            AudioDebugMicPacket,
            7,
            clamp_debug_u8(queue_get_level(&mic_decode_fifo)),
            clamp_debug_u8(mic_packets_dropped),
            0,
            0
        );
    }
    if (!queue_try_add(&mic_decode_fifo, &decoded)) {
        mic_packets_dropped++;
        audio_debug_log(AudioDebugMicPacket, 8, clamp_debug_u8(queue_get_level(&mic_decode_fifo)), clamp_debug_u8(mic_packets_dropped), 0, 0);
        return false;
    }
    return true;
}

static bool core1_process_mic() {
    static mic_packet_element mic_packet{};
    if (!queue_try_remove(&mic_fifo, &mic_packet)) {
        return false;
    }
    if (mic_decoder == nullptr) {
        return true;
    }

    static int16_t decoded_mono[HOST_MIC_OPUS_FRAMES * HOST_MIC_INPUT_CHANNELS];
    const int decoded_samples = opus_decode(
        mic_decoder,
        mic_packet.data,
        HOST_MIC_OPUS_SIZE,
        decoded_mono,
        HOST_MIC_OPUS_FRAMES,
        false
    );
    if (decoded_samples <= 0) {
        mic_decode_fail++;
        mic_last_decoded_samples = 0;
        mic_packets_dropped++;
        audio_debug_log(AudioDebugMicPacket, 0, clamp_debug_u8(decoded_samples < 0 ? -decoded_samples : decoded_samples), clamp_debug_u8(mic_packets_dropped), 0, 0);
        return true;
    }

    queue_mic_decoded_samples(decoded_mono, decoded_samples, true);
    mic_next_plc_us = time_us_32() + HOST_MIC_OPUS_FRAME_INTERVAL_US;
    return true;
}

static bool core1_process_mic_plc() {
    if (
        mic_decoder == nullptr
        || !mic_usb_playout_started
        || !usb_mic_streaming_active()
        || queue_get_level(&mic_decode_fifo) >= HOST_MIC_PLC_TARGET_DEPTH
        || !queue_is_empty(&mic_fifo)
    ) {
        return false;
    }

    const uint32_t now = time_us_32();
    if (mic_next_plc_us == 0) {
        mic_next_plc_us = now + HOST_MIC_OPUS_FRAME_INTERVAL_US;
        return false;
    }
    if (!time_reached(now, mic_next_plc_us)) {
        return false;
    }

    static int16_t decoded_mono[HOST_MIC_OPUS_FRAMES * HOST_MIC_INPUT_CHANNELS];
    const int decoded_samples = opus_decode(
        mic_decoder,
        nullptr,
        0,
        decoded_mono,
        HOST_MIC_OPUS_FRAMES,
        false
    );
    if (decoded_samples <= 0) {
        mic_decode_fail++;
        mic_last_decoded_samples = 0;
        mic_packets_dropped++;
        audio_debug_log(AudioDebugMicPacket, 9, clamp_debug_u8(decoded_samples < 0 ? -decoded_samples : decoded_samples), clamp_debug_u8(mic_packets_dropped), 0, 0);
        mic_next_plc_us = now + HOST_MIC_OPUS_FRAME_INTERVAL_US;
        return true;
    }

    queue_mic_decoded_samples(decoded_mono, decoded_samples, false);
    audio_debug_log(
        AudioDebugMicPacket,
        10,
        clamp_debug_u8(queue_get_level(&mic_decode_fifo)),
        clamp_debug_u8(decoded_samples),
        0,
        0
    );
    mic_next_plc_us += HOST_MIC_OPUS_FRAME_INTERVAL_US;
    if (time_reached(now, mic_next_plc_us + HOST_MIC_OPUS_FRAME_INTERVAL_US)) {
        mic_next_plc_us = now + HOST_MIC_OPUS_FRAME_INTERVAL_US;
    }
    return true;
}

static bool core1_process_mic_burst() {
    if (!host_mic_path_active()) {
        return false;
    }
    bool did_mic = false;
    for (uint8_t packet = 0; packet < HOST_MIC_CORE1_BURST_LIMIT; packet++) {
        if (!core1_process_mic()) {
            break;
        }
        did_mic = true;
    }
    return did_mic;
}

static bool core1_process_speaker() {
    static audio_raw_element audio_element{};
    if (!queue_try_remove(&audio_fifo, &audio_element)) {
        return false;
    }

    uint32_t current_generation = audio_stream_generation;
    if (audio_element.generation != current_generation) {
        audio_stats_note_generation_drop();
        reset_core1_audio_pipeline(current_generation);
        return true;
    }
    if (core1_audio_stream_generation != current_generation) {
        reset_core1_audio_pipeline(current_generation);
    }

    // Resample 512 frames to 480 frames to avoid noise. Thanks @Junhoo.
    WDL_ResampleSample *in_buf;
    int nframes = resampler_audio.ResamplePrepare(512, 2, &in_buf);
    for (int i = 0; i < nframes * 2;i++) {
        in_buf[i] = audio_element.data[i];
    }
    static WDL_ResampleSample out_buf[480 * 2];
    resampler_audio.ResampleOut(out_buf,nframes,480,2);
    static uint8_t encoded[sizeof(opus_buf)];
#if DS5_AUDIO_DEBUG_ENABLED
    const uint32_t encode_start_us = time_us_32();
#endif
    const opus_int32 encoded_bytes = opus_encode_float(encoder,out_buf,480,encoded,sizeof(encoded));
#if DS5_AUDIO_DEBUG_ENABLED
    audio_stats_note_opus_encode(static_cast<uint32_t>(time_us_32() - encode_start_us));
#endif
    if (encoded_bytes < 0) {
        audio_debug_log(
            AudioDebugOpusFifoAddFail,
            clamp_debug_u8(queue_get_level(&audio_fifo)),
            opus_debug_level(),
            0,
            0,
            0
        );
        return true;
    }
    current_generation = audio_stream_generation;
    if (audio_element.generation != current_generation) {
        audio_stats_note_generation_drop();
        reset_core1_audio_pipeline(current_generation);
        return true;
    }
    critical_section_enter_blocking(&opus_cs);
    memcpy(opus_buf, encoded, sizeof(opus_buf));
    opus_buf_generation = audio_element.generation;
    opus_buf_valid = true;
    critical_section_exit(&opus_cs);
    return true;
}

static void core1_entry() {
    int error = 0;
    encoder = opus_encoder_create(48000,2,OPUS_APPLICATION_AUDIO,&error);
    if (error != 0) {
        DS5_LOG("[Audio] OpusEncoder create failed\n");
        return;
    }
    opus_encoder_ctl(encoder,OPUS_SET_EXPERT_FRAME_DURATION(OPUS_FRAMESIZE_10_MS));
    opus_encoder_ctl(encoder,OPUS_SET_BITRATE(200 * 8 * 100));
    opus_encoder_ctl(encoder,OPUS_SET_VBR(false));
    opus_encoder_ctl(encoder,OPUS_SET_COMPLEXITY(0)); // max 4
    resampler_audio.SetMode(true,0,false);
    resampler_audio.SetRates(51200,48000);
    resampler_audio.SetFeedMode(true);
    resampler_audio.Prealloc(2, 512, 480);
    mic_decoder = opus_decoder_create(48000, HOST_MIC_INPUT_CHANNELS, &error);
    if (error != 0) {
        DS5_LOG("[Audio] OpusDecoder create failed\n");
        mic_decoder = nullptr;
    }

    while (true) {
        const bool did_mic = core1_process_mic_burst();
        const bool did_mic_plc = core1_process_mic_plc();
        const bool did_speaker = core1_process_speaker();
        if (!did_speaker && !did_mic && !did_mic_plc) {
            sleep_us(250);
        }
    }
}
