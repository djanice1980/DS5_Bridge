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
#define STATE_PAYLOAD_VALID_FLAG1_OFFSET 1
#define STATE_PAYLOAD_SPEAKER_VOLUME_OFFSET 5
#define STATE_PAYLOAD_VALID_FLAG2_OFFSET 38
#define STATE_PAYLOAD_LED_BRIGHTNESS_OFFSET 42
#define STATE_PAYLOAD_PLAYER_LEDS_OFFSET 43
#define STATE_PAYLOAD_LIGHTBAR_RED_OFFSET 44
#define STATE_PAYLOAD_LIGHTBAR_GREEN_OFFSET 45
#define STATE_PAYLOAD_LIGHTBAR_BLUE_OFFSET 46
#define STATE_PAYLOAD_SPEAKER_VOLUME_SAFE_MAX 0x64
#define STATE_LIGHTBAR_SETUP_CONTROL_MASK 0x03
#define STATE_PLAYER_LED_1_INSTANT 0x24
#define AUDIO_DEBUG_RING_SIZE 96
#define AUDIO_DEBUG_REPORT_HEADER_SIZE 8
#define AUDIO_DEBUG_RECORD_SIZE 14
#define OPUS_ENCODE_BUDGET_US 10000
#define SPEAKER_USB_SILENCE_TAIL_US 500000
#define SPEAKER_SILENCE_PREROLL_USB_PACKETS 24
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
static bool audio_initialized = false;
static uint32_t last_audio_us = 0;
static bool speaker_route_active = false;
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
static bool audio_silence_tail_logged = false;
static uint8_t speaker_silence_preroll_packets_remaining = 0;
alignas(8) static uint32_t audio_core1_stack[8192];
queue_t audio_fifo;
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
    0xff, 0xd7, 0x00,
};

static float audio_buf[512 * 2];
static uint audio_buf_pos = 0;
static int8_t audio_haptic_buf[SAMPLE_SIZE];
static int audio_haptic_buf_pos = 0;

static void core1_entry();
static void reset_core1_audio_pipeline(uint32_t generation);

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
    clamp_state_speaker_volume();
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
    plug_headset = state;
}

static bool time_reached(uint32_t now, uint32_t target) {
    return static_cast<int32_t>(now - target) >= 0;
}

static uint8_t clamp_debug_u8(uint32_t value) {
    return value > 255 ? 255 : static_cast<uint8_t>(value);
}

static void write_debug_u16(uint8_t *data, uint16_t value) {
    data[0] = static_cast<uint8_t>(value & 0xFF);
    data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

static void write_debug_u32(uint8_t *data, uint32_t value) {
    data[0] = static_cast<uint8_t>(value & 0xFF);
    data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
    data[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
    data[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
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
#ifdef DS5_ENABLE_AUDIO_DEBUG_REPORTS
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
#ifdef DS5_ENABLE_AUDIO_DEBUG_REPORTS
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
#ifdef DS5_ENABLE_AUDIO_DEBUG_REPORTS
    if (!audio_debug_cs_ready) {
        return;
    }
    critical_section_enter_blocking(&audio_debug_cs);
    audio_debug_increment_u32(audio_stats.audio_generation_drop_count);
    critical_section_exit(&audio_debug_cs);
#endif
}

static void audio_debug_log(
    uint8_t code,
    uint8_t arg0 = 0,
    uint8_t arg1 = 0,
    uint8_t arg2 = 0,
    uint8_t arg3 = 0,
    uint8_t arg4 = 0
) {
#ifdef DS5_ENABLE_AUDIO_DEBUG_REPORTS
    if (!audio_debug_cs_ready) {
        return;
    }

    critical_section_enter_blocking(&audio_debug_cs);
    const uint32_t sequence = audio_debug_next_sequence++;
    audio_debug_ring[audio_debug_head] = {
        sequence,
        time_us_32(),
        code,
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
#else
    (void)code;
    (void)arg0;
    (void)arg1;
    (void)arg2;
    (void)arg3;
    (void)arg4;
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
    audio_debug_packet_log_budget = max<uint8_t>(audio_debug_packet_log_budget, 4);
}

void audio_handle_controller_disconnect() {
    test_haptics_active = false;
    test_haptics_packets_remaining = 0;
    test_haptics_neutral_packets_remaining = 0;
    drain_audio_queues();
    clear_partial_audio_state();
    speaker_silence_preroll_packets_remaining = 0;
    speaker_route_active = false;
    last_audio_us = 0;
}

static bool should_keep_speaker_route_open() {
    return bt_is_controller_connected() && volume[0] > 0.0f;
}

static void update_persistent_speaker_route() {
    if (quiet_mode_enabled) {
        return;
    }

    if (should_keep_speaker_route_open()) {
        if (!speaker_route_active) {
            bt_set_speaker_output_enabled(true);
            speaker_route_active = true;
            schedule_speaker_silence_preroll();
            audio_debug_log(
                AudioDebugSpeakerRoute,
                1,
                clamp_debug_u8(static_cast<uint32_t>(volume[0] * 100.0f)),
                quiet_mode_enabled ? 1 : 0,
                0,
                0
            );
        }
        return;
    }

    if (speaker_route_active) {
        bt_set_speaker_output_enabled(false);
        speaker_route_active = false;
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
    pkt[4] = 0b11111110;
    const uint8_t buffer_length = haptics_buffer_length;
    pkt[5] = buffer_length;
    pkt[6] = buffer_length;
    pkt[7] = buffer_length;
    pkt[8] = buffer_length;
    pkt[9] = buffer_length;
    pkt[10] = packetCounter++;
    pkt[11] = 0x10 | (1 << 7);
    pkt[12] = sizeof(state_data);
    memcpy(pkt + 13, state_data, sizeof(state_data));
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
            bt_set_speaker_output_enabled(true);
            speaker_route_active = true;
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
    return audio_silence_tail_active(time_us_32());
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

#ifdef DS5_ENABLE_AUDIO_DEBUG_REPORTS
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
#ifdef DS5_ENABLE_AUDIO_DEBUG_REPORTS
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
        audio_buf[audio_buf_pos++] = raw[i * INPUT_CHANNELS] / 32768.0f * speaker_gain;
        audio_buf[audio_buf_pos++] = raw[i * INPUT_CHANNELS + 1] / 32768.0f * speaker_gain;
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

void audio_loop() {
    if (!bt_is_controller_connected()) {
        int16_t discard[192];
        while (tud_audio_available()) {
            tud_audio_read(discard, sizeof(discard));
        }
        if (speaker_route_active || last_audio_us != 0) {
            audio_handle_controller_disconnect();
        }
        return;
    }

    if (quiet_mode_enabled) {
        int16_t discard[192];
        while (tud_audio_available()) {
            tud_audio_read(discard, sizeof(discard));
        }
        if (speaker_route_active) {
            bt_set_speaker_output_enabled(false);
            speaker_route_active = false;
        }
        return;
    }

    update_persistent_speaker_route();

    for (uint8_t i = 0; i < AUDIO_LOOP_MAX_USB_READS; i++) {
        if (!process_usb_audio_packet()) {
            break;
        }
    }
}

void audio_init() {
    critical_section_init(&audio_debug_cs);
    audio_debug_cs_ready = true;
    resampler.SetMode(true, 0, false);
    resampler.SetRates(48000, 3000);
    resampler.SetFeedMode(true);
    resampler.Prealloc(2, 24, 6);
    queue_init(&audio_fifo,sizeof(audio_raw_element),2);
    critical_section_init(&opus_cs);
    opus_cs_ready = true;
    multicore_launch_core1_with_stack(core1_entry,audio_core1_stack,sizeof(audio_core1_stack));
    audio_initialized = true;
}

static OpusEncoder *encoder;
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

    while (true) {
        static audio_raw_element audio_element{};
        queue_remove_blocking(&audio_fifo,&audio_element);

        uint32_t current_generation = audio_stream_generation;
        if (audio_element.generation != current_generation) {
            audio_stats_note_generation_drop();
            reset_core1_audio_pipeline(current_generation);
            continue;
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
        const uint32_t encode_start_us = time_us_32();
        const opus_int32 encoded_bytes = opus_encode_float(encoder,out_buf,480,encoded,sizeof(encoded));
        audio_stats_note_opus_encode(static_cast<uint32_t>(time_us_32() - encode_start_us));
        if (encoded_bytes < 0) {
            audio_debug_log(
                AudioDebugOpusFifoAddFail,
                clamp_debug_u8(queue_get_level(&audio_fifo)),
                opus_debug_level(),
                0,
                0,
                0
            );
            continue;
        }
        current_generation = audio_stream_generation;
        if (audio_element.generation != current_generation) {
            audio_stats_note_generation_drop();
            reset_core1_audio_pipeline(current_generation);
            continue;
        }
        critical_section_enter_blocking(&opus_cs);
        memcpy(opus_buf, encoded, sizeof(opus_buf));
        opus_buf_generation = audio_element.generation;
        opus_buf_valid = true;
        critical_section_exit(&opus_cs);
    }
}
