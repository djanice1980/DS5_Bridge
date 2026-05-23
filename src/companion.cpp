#include "companion.h"

#include <algorithm>
#include <cstddef>
#include <cstring>

#include "audio.h"
#include "bt.h"
#include "pico/critical_section.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"
#include "usb.h"

namespace {

constexpr uint8_t kMagic[] = {'D', 'S', '5', 'B'};
constexpr uint8_t kProtocolMajor = 1;
constexpr uint8_t kProtocolMinor = 1;
constexpr uint8_t kFirmwareMajor = 1;
constexpr uint8_t kFirmwareMinor = 0;
constexpr uint8_t kFirmwarePatch = 2;
constexpr uint8_t kTriangleButtonBit = 0x80;
constexpr uint8_t kSquareButtonBit = 0x10;
constexpr uint8_t kCrossButtonBit = 0x20;
constexpr uint8_t kCircleButtonBit = 0x40;
constexpr uint8_t kL1ButtonBit = 0x01;
constexpr uint8_t kR1ButtonBit = 0x02;
constexpr uint8_t kL2ButtonBit = 0x04;
constexpr uint8_t kR2ButtonBit = 0x08;
constexpr uint8_t kCreateButtonBit = 0x10;
constexpr uint8_t kOptionsButtonBit = 0x20;
constexpr uint8_t kL3ButtonBit = 0x40;
constexpr uint8_t kR3ButtonBit = 0x80;
constexpr uint8_t kHomeButtonBit = 0x01;
constexpr uint8_t kMuteButtonBit = 0x04;
constexpr uint8_t kDpadMask = 0x0F;
constexpr uint8_t kDpadUp = 0x00;
constexpr uint8_t kDpadUpRight = 0x01;
constexpr uint8_t kDpadRight = 0x02;
constexpr uint8_t kDpadDownRight = 0x03;
constexpr uint8_t kDpadDown = 0x04;
constexpr uint8_t kDpadDownLeft = 0x05;
constexpr uint8_t kDpadLeft = 0x06;
constexpr uint8_t kDpadUpLeft = 0x07;
constexpr uint8_t kDpadNeutral = 0x08;
constexpr uint32_t kShortcutRepeatUs = 180000;
constexpr uint8_t kDefaultMuteKeyboardUsage = 0x68; // F13
constexpr uint8_t kMuteKeyboardModifierMask = 0x0F;
constexpr uint8_t kMuteKeyboardHoldFlag = 0x80;
constexpr uint32_t kKeyboardPressDurationUs = 40000;
constexpr uint32_t kMuteLedFlashDurationUs = 120000;
constexpr uint32_t kClassicRumbleTestDurationUs = 650000;
constexpr uint8_t kClassicRumbleTestAmplitude = 160;
constexpr uint32_t kAdaptiveTriggerTestDurationUs = 2500000;
constexpr uint32_t kGameTriggerUpdateRecentUs = 2000000;
#if DS5_TRIGGER_TRACE_ENABLED
constexpr uint8_t kTriggerTraceRecordSize = 38;
constexpr uint8_t kTriggerTraceRingSize = 96;
#endif
#if DS5_FEEDBACK_TRACE_ENABLED
constexpr uint8_t kFeedbackTraceRecordSize = 24;
constexpr uint8_t kFeedbackTraceRingSize = 160;
#endif
constexpr uint8_t kTriggerEffectSize = 11;
constexpr uint8_t kTriggerEffectRightOffset = 10;
constexpr uint8_t kTriggerEffectLeftOffset = 21;
constexpr uint8_t kTriggerEffectPowerOffset = 36;
constexpr uint8_t kTriggerEffectOff = 0x05;
constexpr uint8_t kTriggerEffectFeedback = 0x21;
constexpr uint8_t kTriggerEffectWeapon = 0x25;
constexpr uint8_t kTriggerEffectVibration = 0x26;
constexpr uint8_t kTriggerRightEffectFlag = 0x04;
constexpr uint8_t kTriggerLeftEffectFlag = 0x08;
constexpr uint8_t kTriggerEffectFlags = kTriggerRightEffectFlag | kTriggerLeftEffectFlag;
constexpr uint8_t kTriggerMotorPowerFlag = 0x40;
constexpr uint8_t kTriggerTestModeFeedback = 0;
constexpr uint8_t kTriggerTestModeWeapon = 1;
constexpr uint8_t kTriggerTestModeVibration = 2;
constexpr uint8_t kTriggerTargetBoth = 0;
constexpr uint8_t kTriggerTargetLeft = 1;
constexpr uint8_t kTriggerTargetRight = 2;

enum CommandId : uint8_t {
    CommandSetHapticsGain = 0x01,
    CommandSetLedEnabled = 0x02,
    CommandSetIdleDisconnectEnabled = 0x03,
    CommandTestHaptics = 0x04,
    CommandRestoreDefaults = 0x05,
    CommandSetSpeakerVolume = 0x07,
    CommandSetLightbarColor = 0x08,
    CommandSetLightbarOverride = 0x09,
    CommandSetMuteButtonAction = 0x0A,
    CommandSetHapticsBufferLength = 0x0B,
    CommandSetTriggerEffectIntensity = 0x0C,
    CommandTestAdaptiveTriggers = 0x0D,
    CommandResetAdaptiveTriggers = 0x0E,
    CommandSetUsbSuspendDisconnectEnabled = 0x0F,
    CommandSetSleepKeybindEnabled = 0x10,
    CommandSleepController = 0x11,
    CommandSetPollingRateMode = 0x12,
    CommandSetClassicRumbleGain = 0x13,
    CommandTestClassicRumble = 0x14,
    CommandSetHostAudioEnabled = 0x15,
    CommandHostAudioHeartbeat = 0x16,
    CommandStartHostAudio = 0x17,
    CommandStopHostAudio = 0x18,
    CommandSetDuplexEnabled = 0x19,
    CommandSetMicVolume = 0x1A,
    CommandSetMicMute = 0x1B,
    CommandSetIdleDisconnectTimeout = 0x1C,
    CommandSetSpeakerVolumeShortcut = 0x1D,
    CommandSetButtonRemap = 0x1E,
};

enum AckResult : uint8_t {
    AckOk = 0x00,
    AckBadMagic = 0x01,
    AckBadVersion = 0x02,
    AckBadLength = 0x03,
    AckInvalidValue = 0x04,
    AckUnknownCommand = 0x05,
    AckNotConnected = 0x06,
    AckBusy = 0x07,
};

enum MuteButtonMode : uint8_t {
    MuteButtonNormal = 0,
    MuteButtonKeyboard = 1,
    MuteButtonQuiet = 2,
};

enum ShortcutEvent : uint8_t {
    ShortcutEventControllerVolumeDown = 0x01,
    ShortcutEventControllerVolumeUp = 0x02,
    ShortcutEventSleepController = 0x03,
};

enum ShortcutSetting : uint8_t {
    ShortcutSettingSleepKeybind,
    ShortcutSettingControllerVolume,
};

enum ShortcutCombo : uint8_t {
    ShortcutComboHomeDpadUp,
    ShortcutComboHomeDpadDown,
    ShortcutComboHomeTriangle,
};

enum ShortcutTrigger : uint8_t {
    ShortcutTriggerPressed,
    ShortcutTriggerRepeat,
};

enum RemapButton : uint8_t {
    RemapL2,
    RemapL1,
    RemapCreate,
    RemapDpadUp,
    RemapDpadLeft,
    RemapDpadDown,
    RemapDpadRight,
    RemapL3,
    RemapR2,
    RemapR1,
    RemapOptions,
    RemapTriangle,
    RemapCircle,
    RemapCross,
    RemapSquare,
    RemapR3,
    RemapButtonCount,
};

struct ShortcutBinding {
    ShortcutCombo combo;
    ShortcutEvent event;
    ShortcutSetting setting;
    ShortcutTrigger trigger;
};

constexpr ShortcutBinding kShortcutBindings[] = {
    {ShortcutComboHomeDpadDown, ShortcutEventControllerVolumeDown, ShortcutSettingControllerVolume, ShortcutTriggerRepeat},
    {ShortcutComboHomeDpadUp, ShortcutEventControllerVolumeUp, ShortcutSettingControllerVolume, ShortcutTriggerRepeat},
    {ShortcutComboHomeTriangle, ShortcutEventSleepController, ShortcutSettingSleepKeybind, ShortcutTriggerPressed},
};
constexpr size_t kShortcutBindingCount = sizeof(kShortcutBindings) / sizeof(kShortcutBindings[0]);

critical_section_t companion_report_cs;
uint8_t last_controller_report[63]{};
bool have_controller_report = false;
uint16_t settings_revision = 0;
uint8_t lightbar_red = 0xff;
uint8_t lightbar_green = 0xd7;
uint8_t lightbar_blue = 0x00;
uint8_t lightbar_brightness = 100;
bool lightbar_override_enabled = false;
uint16_t host_output_report_count = 0;
uint8_t host_output_report_len = 0;
uint8_t host_output_report_id = 0;
uint8_t host_output_report_first16[16]{};
#if DS5_TRIGGER_TRACE_ENABLED
struct TriggerTraceEvent {
    uint32_t sequence;
    uint32_t timestamp_ms;
    uint8_t stage;
    uint8_t report_id;
    uint8_t length;
    uint8_t sequence_tag;
    uint8_t flag0;
    uint8_t flag1;
    uint8_t flag2;
    uint8_t motor_power;
    uint8_t decision;
    uint8_t right_trigger[kTriggerEffectSize];
    uint8_t left_trigger[kTriggerEffectSize];
};
TriggerTraceEvent trigger_trace_ring[kTriggerTraceRingSize]{};
uint32_t trigger_trace_next_sequence = 1;
uint32_t trigger_trace_read_sequence = 1;
uint16_t trigger_trace_dropped_count = 0;
uint8_t trigger_trace_count = 0;
uint8_t trigger_trace_head = 0;
#endif
#if DS5_FEEDBACK_TRACE_ENABLED
struct FeedbackTraceEvent {
    uint32_t sequence;
    uint32_t timestamp_ms;
    uint8_t stage;
    uint8_t report_id;
    uint8_t length;
    uint8_t sequence_tag;
    uint8_t decision;
    uint8_t flag0;
    uint8_t flag1;
    uint8_t flag2;
    uint8_t motor_right;
    uint8_t motor_left;
    uint8_t haptic_peak;
    uint8_t haptic_mean;
    uint8_t haptic_nonzero;
    uint8_t detail0;
    uint8_t detail1;
    uint8_t detail2;
    uint8_t detail3;
};
FeedbackTraceEvent feedback_trace_ring[kFeedbackTraceRingSize]{};
uint32_t feedback_trace_next_sequence = 1;
uint32_t feedback_trace_read_sequence = 1;
uint16_t feedback_trace_dropped_count = 0;
uint8_t feedback_trace_count = 0;
uint8_t feedback_trace_head = 0;
#endif
uint8_t mute_button_mode = MuteButtonNormal;
uint8_t mute_keyboard_usage = kDefaultMuteKeyboardUsage;
uint8_t mute_keyboard_modifiers = 0;
bool mute_button_last_pressed = false;
bool sleep_keybind_enabled = false;
bool speaker_volume_shortcut_enabled = false;
bool shortcut_binding_last_pressed[kShortcutBindingCount]{};
uint32_t shortcut_binding_last_step_us[kShortcutBindingCount]{};
uint8_t pending_shortcut_event = 0;
bool mute_keyboard_pending = false;
bool mute_keyboard_pressed = false;
uint32_t mute_keyboard_release_at_us = 0;
bool mute_led_flash_pending = false;
uint32_t mute_led_flash_until_us = 0;
bool classic_rumble_test_active = false;
uint32_t classic_rumble_test_until_us = 0;
uint8_t trigger_effect_intensity_percent = 100;
uint8_t adaptive_trigger_test_mode = kTriggerTestModeFeedback;
uint8_t adaptive_trigger_test_target = kTriggerTargetBoth;
bool adaptive_trigger_test_active = false;
uint32_t adaptive_trigger_test_until_us = 0;
uint8_t cached_game_trigger_right[kTriggerEffectSize]{};
uint8_t cached_game_trigger_left[kTriggerEffectSize]{};
bool cached_game_trigger_right_valid = false;
bool cached_game_trigger_left_valid = false;
uint8_t cached_game_trigger_motor_power = 0;
bool cached_game_trigger_motor_power_valid = false;
uint32_t last_game_trigger_update_us = 0;
uint8_t companion_mic_volume_percent = 100;
bool companion_mic_muted = false;
uint8_t button_remap[RemapButtonCount]{};

struct LastAck {
    uint8_t command_id = 0;
    uint8_t sequence = 0;
    uint8_t result = AckOk;
    uint8_t detail = 0;
};

LastAck last_ack;

void clear_cached_game_trigger_effects();

uint16_t read_u16(uint8_t const *data) {
    return static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
}

void write_u16(uint8_t *data, uint16_t value) {
    data[0] = static_cast<uint8_t>(value & 0xFF);
    data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void write_u32(uint8_t *data, uint32_t value) {
    data[0] = static_cast<uint8_t>(value & 0xFF);
    data[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
    data[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
    data[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

#if DS5_TRIGGER_TRACE_ENABLED
bool trigger_payload_from_report(
    uint8_t const *report,
    uint16_t len,
    uint8_t const *&payload,
    uint16_t &payload_len,
    uint8_t &report_id,
    uint8_t &sequence_tag
) {
    payload = nullptr;
    payload_len = 0;
    report_id = len > 0 && report != nullptr ? report[0] : 0;
    sequence_tag = 0;
    if (report == nullptr || len == 0) {
        return false;
    }

    if (report_id == 0x02 && len > 1) {
        payload = report + 1;
        payload_len = len - 1;
        return true;
    }
    if (report_id == 0x31 && len > 3 && report[2] == 0x10) {
        sequence_tag = report[1];
        payload = report + 3;
        payload_len = len - 3;
        return true;
    }
    if (report_id == 0x36 && len > 13) {
        sequence_tag = report[1];
        payload = report + 13;
        payload_len = len - 13;
        return true;
    }
    return false;
}

bool decode_trigger_trace_report(uint8_t const *report, uint16_t len, TriggerTraceEvent &event) {
    uint8_t const *payload = nullptr;
    uint16_t payload_len = 0;
    uint8_t report_id = 0;
    uint8_t sequence_tag = 0;
    if (!trigger_payload_from_report(report, len, payload, payload_len, report_id, sequence_tag)) {
        return false;
    }

    const uint8_t flag0 = payload_len > 0 ? payload[0] : 0;
    const uint8_t flag1 = payload_len > 1 ? payload[1] : 0;
    const uint8_t flag2 = payload_len > 38 ? payload[38] : 0;
    const bool has_right = (flag0 & kTriggerRightEffectFlag) != 0;
    const bool has_left = (flag0 & kTriggerLeftEffectFlag) != 0;
    const bool has_power = (flag1 & kTriggerMotorPowerFlag) != 0;
    if (!has_right && !has_left && !has_power) {
        return false;
    }

    event.report_id = report_id;
    event.length = static_cast<uint8_t>(std::min<uint16_t>(len, 255));
    event.sequence_tag = sequence_tag;
    event.flag0 = flag0;
    event.flag1 = flag1;
    event.flag2 = flag2;
    event.motor_power = payload_len > kTriggerEffectPowerOffset ? payload[kTriggerEffectPowerOffset] : 0;
    memset(event.right_trigger, 0, sizeof(event.right_trigger));
    memset(event.left_trigger, 0, sizeof(event.left_trigger));
    if (has_right && payload_len > kTriggerEffectRightOffset + kTriggerEffectSize - 1) {
        memcpy(event.right_trigger, payload + kTriggerEffectRightOffset, sizeof(event.right_trigger));
    }
    if (has_left && payload_len > kTriggerEffectLeftOffset + kTriggerEffectSize - 1) {
        memcpy(event.left_trigger, payload + kTriggerEffectLeftOffset, sizeof(event.left_trigger));
    }
    return true;
}

void append_trigger_trace_event(TriggerTraceEvent const &event) {
    trigger_trace_ring[trigger_trace_head] = event;
    trigger_trace_head = static_cast<uint8_t>((trigger_trace_head + 1) % kTriggerTraceRingSize);
    if (trigger_trace_count < kTriggerTraceRingSize) {
        trigger_trace_count++;
    } else {
        if (trigger_trace_dropped_count != 0xffff) {
            trigger_trace_dropped_count++;
        }
        const uint32_t oldest_sequence = trigger_trace_next_sequence - trigger_trace_count;
        if (trigger_trace_read_sequence < oldest_sequence) {
            trigger_trace_read_sequence = oldest_sequence;
        }
    }
}
#endif

#if DS5_FEEDBACK_TRACE_ENABLED
bool feedback_payload_from_report(
    uint8_t const *report,
    uint16_t len,
    uint8_t const *&payload,
    uint16_t &payload_len,
    uint8_t &report_id,
    uint8_t &sequence_tag
) {
    payload = nullptr;
    payload_len = 0;
    report_id = len > 0 && report != nullptr ? report[0] : 0;
    sequence_tag = 0;
    if (report == nullptr || len == 0) {
        return false;
    }

    if (report_id == 0x02 && len > 1) {
        payload = report + 1;
        payload_len = len - 1;
        return true;
    }
    if (report_id == 0x31 && len > 3 && report[2] == 0x10) {
        sequence_tag = report[1];
        payload = report + 3;
        payload_len = len - 3;
        return true;
    }
    if (report_id == 0x36 && len > 13) {
        sequence_tag = report[1];
        payload = report + 13;
        payload_len = len - 13;
        return true;
    }
    return false;
}

void fill_feedback_haptic_stats(
    uint8_t const *samples,
    uint16_t len,
    uint8_t &peak,
    uint8_t &mean,
    uint8_t &nonzero
) {
    peak = 0;
    mean = 0;
    nonzero = 0;
    if (samples == nullptr || len == 0) {
        return;
    }

    uint32_t sum = 0;
    uint16_t nz = 0;
    for (uint16_t i = 0; i < len; i++) {
        const int8_t sample = static_cast<int8_t>(samples[i]);
        const uint8_t magnitude = static_cast<uint8_t>(sample < 0 ? -static_cast<int>(sample) : sample);
        peak = std::max<uint8_t>(peak, magnitude);
        sum += magnitude;
        if (magnitude != 0) {
            nz++;
        }
    }
    mean = static_cast<uint8_t>(std::min<uint32_t>(255, (sum + (len / 2)) / len));
    nonzero = static_cast<uint8_t>(std::min<uint16_t>(255, nz));
}

bool decode_feedback_trace_report(
    uint8_t const *report,
    uint16_t len,
    FeedbackTraceEvent &event,
    bool force = false
) {
    uint8_t const *payload = nullptr;
    uint16_t payload_len = 0;
    uint8_t report_id = 0;
    uint8_t sequence_tag = 0;
    if (!feedback_payload_from_report(report, len, payload, payload_len, report_id, sequence_tag)) {
        return false;
    }

    event.report_id = report_id;
    event.length = static_cast<uint8_t>(std::min<uint16_t>(len, 255));
    event.sequence_tag = sequence_tag;
    event.flag0 = payload_len > 0 ? payload[0] : 0;
    event.flag1 = payload_len > 1 ? payload[1] : 0;
    event.flag2 = payload_len > 38 ? payload[38] : 0;
    event.motor_right = payload_len > 2 ? payload[2] : 0;
    event.motor_left = payload_len > 3 ? payload[3] : 0;

    if (report_id == 0x36) {
        const uint16_t haptic_offset = 78;
        if (len > haptic_offset) {
            fill_feedback_haptic_stats(
                report + haptic_offset,
                static_cast<uint16_t>(std::min<uint16_t>(64, len - haptic_offset)),
                event.haptic_peak,
                event.haptic_mean,
                event.haptic_nonzero
            );
        }
        return force
            || event.haptic_peak != 0
            || event.haptic_nonzero != 0
            || event.flag0 != 0
            || event.flag1 != 0
            || event.flag2 != 0
            || event.motor_right != 0
            || event.motor_left != 0;
    }

    const bool has_rumble = (event.flag0 & 0x03) != 0 || (event.flag2 & 0x04) != 0;
    if (!force && !has_rumble && event.motor_right == 0 && event.motor_left == 0) {
        return false;
    }
    return true;
}

void append_feedback_trace_event(FeedbackTraceEvent const &event) {
    feedback_trace_ring[feedback_trace_head] = event;
    feedback_trace_head = static_cast<uint8_t>((feedback_trace_head + 1) % kFeedbackTraceRingSize);
    if (feedback_trace_count < kFeedbackTraceRingSize) {
        feedback_trace_count++;
    } else {
        if (feedback_trace_dropped_count != 0xffff) {
            feedback_trace_dropped_count++;
        }
        const uint32_t oldest_sequence = feedback_trace_next_sequence - feedback_trace_count;
        if (feedback_trace_read_sequence < oldest_sequence) {
            feedback_trace_read_sequence = oldest_sequence;
        }
    }
}
#endif

uint32_t uptime_seconds() {
    return to_ms_since_boot(get_absolute_time()) / 1000;
}

void reset_button_remap() {
    for (uint8_t i = 0; i < RemapButtonCount; i++) {
        button_remap[i] = i;
    }
}

void write_magic_and_version(uint8_t *buffer) {
    memcpy(buffer, kMagic, sizeof(kMagic));
    buffer[4] = kProtocolMajor;
    buffer[5] = kProtocolMinor;
}

void set_ack(uint8_t command_id, uint8_t sequence, AckResult result, uint8_t detail = 0) {
    last_ack.command_id = command_id;
    last_ack.sequence = sequence;
    last_ack.result = result;
    last_ack.detail = detail;
}

bool has_magic(uint8_t const *buffer) {
    return memcmp(buffer, kMagic, sizeof(kMagic)) == 0;
}

bool has_supported_version(uint8_t const *buffer) {
    return buffer[4] == kProtocolMajor && buffer[5] == kProtocolMinor;
}

void set_led_enabled(bool enabled) {
    mute[0] = enabled ? 0 : 1;
    if (bt_is_controller_connected()) {
        cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, enabled);
    }
}

void set_idle_disconnect_enabled(bool enabled) {
    mute[1] = enabled ? 0 : 1;
}

void set_lightbar_color(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness) {
    lightbar_red = red;
    lightbar_green = green;
    lightbar_blue = blue;
    lightbar_brightness = std::min<uint8_t>(brightness, 100);
    if (bt_is_controller_connected()) {
        bt_set_lightbar_color(lightbar_red, lightbar_green, lightbar_blue, lightbar_brightness);
        bt_schedule_lightbar_restore(250);
    }
}

void restore_defaults() {
    volume[0] = DEFAULT_COMPANION_SPEAKER_GAIN;
    volume[1] = 1.0f;
    bt_set_classic_rumble_gain(100);
    classic_rumble_test_active = false;
    bt_set_classic_rumble_output(0, 0);
    audio_set_haptics_buffer_length(64);
    trigger_effect_intensity_percent = 100;
    adaptive_trigger_test_mode = kTriggerTestModeFeedback;
    adaptive_trigger_test_target = kTriggerTargetBoth;
    adaptive_trigger_test_active = false;
    clear_cached_game_trigger_effects();
    bt_reset_adaptive_triggers();
    mute_button_mode = MuteButtonNormal;
    mute_keyboard_usage = kDefaultMuteKeyboardUsage;
    mute_keyboard_modifiers = 0;
    mute_button_last_pressed = false;
    sleep_keybind_enabled = false;
    speaker_volume_shortcut_enabled = false;
    std::fill(shortcut_binding_last_pressed, shortcut_binding_last_pressed + kShortcutBindingCount, false);
    std::fill(shortcut_binding_last_step_us, shortcut_binding_last_step_us + kShortcutBindingCount, 0);
    pending_shortcut_event = 0;
    mute_keyboard_pending = false;
    mute_keyboard_pressed = false;
    mute_led_flash_pending = false;
    audio_set_quiet_mode(false);
    audio_host_set_duplex_requested(false);
    audio_host_set_requested(false);
    companion_mic_volume_percent = 100;
    companion_mic_muted = false;
    audio_set_mic_output_state(companion_mic_volume_percent, companion_mic_muted);
    bt_set_microphone_state(companion_mic_volume_percent, companion_mic_muted);
    reset_button_remap();
    bt_set_mute_led(false);
    lightbar_override_enabled = false;
    set_lightbar_color(0x00, 0x00, 0xff, 100);
    set_led_enabled(true);
    set_idle_disconnect_enabled(true);
    bt_set_idle_disconnect_timeout_minutes(15);
    usb_set_suspend_disconnect_enabled(true);
    usb_set_hid_polling_rate_mode(2);
}

uint8_t controller_type() {
    return bt_controller_type();
}

uint8_t firmware_flags() {
    uint8_t flags = 0;
#ifdef ENABLE_COMPANION
    flags |= 1 << 0;
#endif
#ifdef ENABLE_DSE
    flags |= 1 << 1;
#endif
    flags |= 1 << 2;
    flags |= 1 << 3;
    flags |= 1 << 4;
    flags |= 1 << 5;
    flags |= 1 << 6;
    flags |= 1 << 7;
    return flags;
}

bool valid_mute_button_action(uint16_t mode, uint8_t usage) {
    if (mode > MuteButtonQuiet) {
        return false;
    }
    if (mode == MuteButtonKeyboard && (usage == 0 || usage > 0x73)) {
        return false;
    }
    return true;
}

void set_mute_button_action(uint8_t mode, uint8_t usage, uint8_t modifiers) {
    mute_button_mode = mode;
    mute_keyboard_usage = usage == 0 ? kDefaultMuteKeyboardUsage : usage;
    mute_keyboard_modifiers = modifiers;
    mute_button_last_pressed = false;
    mute_keyboard_pending = false;
    mute_keyboard_pressed = false;
    mute_led_flash_pending = false;

    if (mute_button_mode != MuteButtonQuiet) {
        audio_set_quiet_mode(false);
        bt_set_mute_led(false);
    } else {
        bt_set_mute_led(audio_quiet_mode_enabled());
    }
}

bool mute_keyboard_hold_enabled() {
    return (mute_keyboard_modifiers & kMuteKeyboardHoldFlag) != 0;
}

void queue_mute_keyboard_press(bool hold) {
    mute_keyboard_pending = true;
    if (!hold) {
        mute_led_flash_pending = true;
        mute_led_flash_until_us = time_us_32() + kMuteLedFlashDurationUs;
    }
    bt_set_mute_led(true);
}

void queue_mute_keyboard_release() {
    if (!mute_keyboard_pending && !mute_keyboard_pressed) {
        return;
    }
    mute_keyboard_pending = false;
    mute_keyboard_pressed = true;
    mute_keyboard_release_at_us = time_us_32();
    mute_led_flash_pending = false;
    bt_set_mute_led(false);
}

void toggle_quiet_mode() {
    const bool enabled = !audio_quiet_mode_enabled();
    audio_set_quiet_mode(enabled);
    bt_set_mute_led(enabled);
}

uint8_t trigger_power_reduction(uint8_t intensity_percent) {
    if (intensity_percent >= 100) {
        return 0;
    }
    const uint8_t clamped = intensity_percent > 100 ? 100 : intensity_percent;
    const uint8_t reduction = static_cast<uint8_t>(((100 - clamped) * 8 + 50) / 100);
    return std::min<uint8_t>(reduction, 7);
}

void set_trigger_off(uint8_t *trigger) {
    memset(trigger, 0, kTriggerEffectSize);
    trigger[0] = kTriggerEffectOff;
}

bool trigger_effect_mode_active(uint8_t mode) {
    return mode != 0 && mode != kTriggerEffectOff;
}

bool trigger_effect_block_active(uint8_t const *trigger) {
    return trigger != nullptr && trigger_effect_mode_active(trigger[0]);
}

uint8_t scale_trigger_strength_code(uint8_t value, uint8_t intensity_percent) {
    const uint8_t strength = static_cast<uint8_t>((value & 0x07) + 1);
    uint8_t scaled = static_cast<uint8_t>((static_cast<uint16_t>(strength) * intensity_percent + 99) / 100);
    scaled = std::min<uint8_t>(std::max<uint8_t>(scaled, 1), 8);
    return static_cast<uint8_t>((value & 0xF8) | ((scaled - 1) & 0x07));
}

bool scale_packed_trigger_strengths(uint8_t *trigger, uint8_t intensity_percent) {
    const uint16_t active_zones = static_cast<uint16_t>(trigger[1])
        | (static_cast<uint16_t>(trigger[2]) << 8);
    uint32_t packed = static_cast<uint32_t>(trigger[3])
        | (static_cast<uint32_t>(trigger[4]) << 8)
        | (static_cast<uint32_t>(trigger[5]) << 16)
        | (static_cast<uint32_t>(trigger[6]) << 24);
    uint32_t next = packed;

    for (uint8_t zone = 0; zone < 10; zone++) {
        if ((active_zones & static_cast<uint16_t>(1 << zone)) == 0) {
            continue;
        }
        const uint8_t shift = static_cast<uint8_t>(zone * 3);
        const uint8_t value = static_cast<uint8_t>((packed >> shift) & 0x07);
        const uint8_t scaled = scale_trigger_strength_code(value, intensity_percent) & 0x07;
        next = (next & ~(0x07u << shift)) | (static_cast<uint32_t>(scaled) << shift);
    }

    if (next == packed) {
        return false;
    }

    trigger[3] = static_cast<uint8_t>(next & 0xFF);
    trigger[4] = static_cast<uint8_t>((next >> 8) & 0xFF);
    trigger[5] = static_cast<uint8_t>((next >> 16) & 0xFF);
    trigger[6] = static_cast<uint8_t>((next >> 24) & 0xFF);
    return true;
}

bool scale_trigger_effect_block(uint8_t *trigger, uint8_t intensity_percent) {
    switch (trigger[0]) {
        case kTriggerEffectFeedback:
        case kTriggerEffectVibration:
            return scale_packed_trigger_strengths(trigger, intensity_percent);
        case kTriggerEffectWeapon: {
            const uint8_t next = scale_trigger_strength_code(trigger[3], intensity_percent);
            if (next == trigger[3]) {
                return false;
            }
            trigger[3] = next;
            return true;
        }
        default:
            return false;
    }
}

bool trigger_effect_block_active(uint8_t const *payload, uint16_t len, uint8_t trigger_flags, uint8_t flag, uint8_t offset) {
    if ((trigger_flags & flag) == 0 || len <= offset) {
        return false;
    }
    return trigger_effect_mode_active(payload[offset]);
}

void clear_cached_game_trigger_effects() {
    cached_game_trigger_right_valid = false;
    cached_game_trigger_left_valid = false;
    cached_game_trigger_motor_power = 0;
    cached_game_trigger_motor_power_valid = false;
    last_game_trigger_update_us = 0;
}

bool game_trigger_update_recent() {
    return last_game_trigger_update_us != 0
        && static_cast<uint32_t>(time_us_32() - last_game_trigger_update_us) < kGameTriggerUpdateRecentUs;
}

void cache_game_trigger_effects(uint8_t const *payload, uint16_t len) {
    if (payload == nullptr || len == 0) {
        return;
    }

    const uint8_t trigger_flags = payload[0] & kTriggerEffectFlags;
    if (trigger_flags == 0) {
        return;
    }

    last_game_trigger_update_us = time_us_32();

    if (
        (trigger_flags & kTriggerRightEffectFlag)
        && len > kTriggerEffectRightOffset + kTriggerEffectSize - 1
    ) {
        memcpy(cached_game_trigger_right, payload + kTriggerEffectRightOffset, sizeof(cached_game_trigger_right));
        cached_game_trigger_right_valid = true;
    }
    if (
        (trigger_flags & kTriggerLeftEffectFlag)
        && len > kTriggerEffectLeftOffset + kTriggerEffectSize - 1
    ) {
        memcpy(cached_game_trigger_left, payload + kTriggerEffectLeftOffset, sizeof(cached_game_trigger_left));
        cached_game_trigger_left_valid = true;
    }

    cached_game_trigger_motor_power = (
        len > 1
        && len > kTriggerEffectPowerOffset
        && (payload[1] & kTriggerMotorPowerFlag) != 0
    )
        ? payload[kTriggerEffectPowerOffset]
        : 0;
    cached_game_trigger_motor_power_valid = true;
}

bool build_scaled_cached_game_trigger_effect(
    uint8_t *right_trigger,
    bool &right_valid,
    uint8_t *left_trigger,
    bool &left_valid,
    uint8_t &motor_power,
    bool &motor_power_valid
) {
    right_valid = cached_game_trigger_right_valid && right_trigger != nullptr;
    left_valid = cached_game_trigger_left_valid && left_trigger != nullptr;
    if (!right_valid && !left_valid) {
        motor_power = 0;
        motor_power_valid = false;
        return false;
    }

    if (right_valid) {
        memcpy(right_trigger, cached_game_trigger_right, kTriggerEffectSize);
    }
    if (left_valid) {
        memcpy(left_trigger, cached_game_trigger_left, kTriggerEffectSize);
    }

    motor_power = cached_game_trigger_motor_power;
    motor_power_valid = cached_game_trigger_motor_power_valid;

    if (trigger_effect_intensity_percent == 0) {
        if (right_valid && trigger_effect_block_active(right_trigger)) {
            set_trigger_off(right_trigger);
        }
        if (left_valid && trigger_effect_block_active(left_trigger)) {
            set_trigger_off(left_trigger);
        }
        motor_power = 0;
        motor_power_valid = true;
        return true;
    }

    if (trigger_effect_intensity_percent < 100) {
        if (right_valid && trigger_effect_block_active(right_trigger)) {
            scale_trigger_effect_block(right_trigger, trigger_effect_intensity_percent);
        }
        if (left_valid && trigger_effect_block_active(left_trigger)) {
            scale_trigger_effect_block(left_trigger, trigger_effect_intensity_percent);
        }
        motor_power = static_cast<uint8_t>(
            (motor_power & 0xF0) | trigger_power_reduction(trigger_effect_intensity_percent)
        );
        motor_power_valid = true;
        return true;
    }

    // Re-send an explicit zero reduction when returning to 100%, in case an
    // earlier capped report left the controller with a reduced trigger power.
    if (!motor_power_valid) {
        motor_power = 0;
    }
    motor_power_valid = true;
    return true;
}

void replay_cached_game_trigger_effect() {
    uint8_t right_trigger[kTriggerEffectSize]{};
    uint8_t left_trigger[kTriggerEffectSize]{};
    bool right_valid = false;
    bool left_valid = false;
    uint8_t motor_power = 0;
    bool motor_power_valid = false;
    if (!build_scaled_cached_game_trigger_effect(
        right_trigger,
        right_valid,
        left_trigger,
        left_valid,
        motor_power,
        motor_power_valid
    )) {
        return;
    }

    bt_replay_adaptive_trigger_effect(
        right_trigger,
        right_valid,
        left_trigger,
        left_valid,
        motor_power,
        motor_power_valid
    );
}

bool valid_trigger_test_mode(uint16_t mode) {
    return mode <= kTriggerTestModeVibration;
}

bool valid_trigger_target(uint8_t target) {
    return target <= kTriggerTargetRight;
}

bool valid_button_remap_payload(uint8_t const *payload, uint16_t len) {
    if (payload == nullptr || len < RemapButtonCount) {
        return false;
    }
    for (uint8_t i = 0; i < RemapButtonCount; i++) {
        if (payload[i] >= RemapButtonCount) {
            return false;
        }
    }
    return true;
}

bool schedule_adaptive_trigger_test(uint8_t mode, uint8_t target) {
    if (
        !bt_is_controller_connected()
        || game_trigger_update_recent()
        || adaptive_trigger_test_active
    ) {
        return false;
    }

    adaptive_trigger_test_mode = mode;
    adaptive_trigger_test_target = target;
    bt_set_adaptive_trigger_effect(adaptive_trigger_test_mode, trigger_effect_intensity_percent, adaptive_trigger_test_target);
    adaptive_trigger_test_active = trigger_effect_intensity_percent > 0;
    adaptive_trigger_test_until_us = time_us_32() + kAdaptiveTriggerTestDurationUs;
    return true;
}

bool schedule_classic_rumble_test() {
    if (
        !bt_is_controller_connected()
        || usb_host_hid_output_recent()
        || classic_rumble_test_active
    ) {
        return false;
    }

    bt_set_classic_rumble_output(kClassicRumbleTestAmplitude, kClassicRumbleTestAmplitude);
    classic_rumble_test_active = true;
    classic_rumble_test_until_us = time_us_32() + kClassicRumbleTestDurationUs;
    return true;
}

void classic_rumble_test_loop() {
    if (!classic_rumble_test_active) {
        return;
    }
    if (!bt_is_controller_connected() || static_cast<int32_t>(time_us_32() - classic_rumble_test_until_us) >= 0) {
        classic_rumble_test_active = false;
        bt_set_classic_rumble_output(0, 0);
    }
}

void reset_adaptive_trigger_test() {
    adaptive_trigger_test_active = false;
    bt_reset_adaptive_triggers();
}

void mute_keyboard_loop() {
    const uint32_t now = time_us_32();

    if (mute_led_flash_pending && static_cast<int32_t>(now - mute_led_flash_until_us) >= 0) {
        mute_led_flash_pending = false;
        if (!audio_quiet_mode_enabled()) {
            bt_set_mute_led(false);
        }
    }

    if (!tud_hid_n_ready(KEYBOARD_HID_INSTANCE)) {
        return;
    }

    if (mute_keyboard_pending) {
        uint8_t keyboard_report[8]{};
        keyboard_report[0] = mute_keyboard_modifiers & kMuteKeyboardModifierMask;
        keyboard_report[2] = mute_keyboard_usage;
        if (tud_hid_n_report(KEYBOARD_HID_INSTANCE, 0, keyboard_report, sizeof(keyboard_report))) {
            mute_keyboard_pending = false;
            mute_keyboard_pressed = true;
            mute_keyboard_release_at_us = mute_keyboard_hold_enabled() ? 0 : now + kKeyboardPressDurationUs;
        }
        return;
    }

    if (
        mute_keyboard_pressed
        && mute_keyboard_release_at_us != 0
        && static_cast<int32_t>(now - mute_keyboard_release_at_us) >= 0
    ) {
        uint8_t keyboard_report[8]{};
        if (tud_hid_n_report(KEYBOARD_HID_INSTANCE, 0, keyboard_report, sizeof(keyboard_report))) {
            mute_keyboard_pressed = false;
        }
    }
}

void adaptive_trigger_test_loop() {
    if (!adaptive_trigger_test_active) {
        return;
    }
    if (!bt_is_controller_connected()) {
        adaptive_trigger_test_active = false;
        return;
    }
    if (static_cast<int32_t>(time_us_32() - adaptive_trigger_test_until_us) >= 0) {
        reset_adaptive_trigger_test();
    }
}

void get_battery(uint8_t &battery_percent, uint8_t &raw_power_state) {
    battery_percent = 255;
    raw_power_state = 0;

    uint8_t report[63]{};
    bool has_report = false;
    critical_section_enter_blocking(&companion_report_cs);
    if (have_controller_report) {
        memcpy(report, last_controller_report, sizeof(report));
        has_report = true;
    }
    critical_section_exit(&companion_report_cs);

    if (!has_report || !bt_is_controller_connected()) {
        return;
    }

    const uint8_t battery = report[52] & 0x0F;
    raw_power_state = (report[52] >> 4) & 0x0F;
    if (raw_power_state == 0x02) {
        battery_percent = 100;
    } else if (battery <= 10) {
        battery_percent = battery * 10;
    }
}

uint16_t build_status(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    buffer[6] = bt_is_controller_connected() ? 1 : 0;
    buffer[7] = buffer[6] ? controller_type() : 0;

    uint8_t battery_percent;
    uint8_t raw_power_state;
    get_battery(battery_percent, raw_power_state);
    buffer[8] = battery_percent;
    buffer[9] = raw_power_state;
    buffer[10] = audio_recent() ? 1 : 0;
    buffer[11] = audio_haptics_ready() ? 1 : 0;
    write_u16(buffer + 12, static_cast<uint16_t>(std::clamp(volume[1], 0.0f, 2.0f) * 100.0f));
    buffer[14] = mute[0] ? 0 : 1;
    buffer[15] = mute[1] ? 0 : 1;
    write_u16(buffer + 16, settings_revision);
    buffer[18] = last_ack.result;
    buffer[19] = (audio_test_haptics_busy() ? 1 : 0)
        | (audio_test_haptics_cooldown() ? 2 : 0)
        | (usb_host_hid_output_recent() ? 4 : 0)
        | (adaptive_trigger_test_active ? 8 : 0)
        | (usb_suspend_disconnect_enabled() ? 16 : 0)
        | 32
        | (sleep_keybind_enabled ? 64 : 0)
        | 128;
    write_u32(buffer + 20, uptime_seconds());
    buffer[24] = kFirmwareMajor;
    buffer[25] = kFirmwareMinor;
    buffer[26] = kFirmwarePatch;
    buffer[27] = firmware_flags();
    write_u16(buffer + 28, static_cast<uint16_t>(std::clamp(volume[0], 0.0f, 1.0f) * 100.0f));
    buffer[30] = lightbar_red;
    buffer[31] = lightbar_green;
    buffer[32] = lightbar_blue;
    buffer[33] = lightbar_brightness;
    buffer[34] = usb_host_volume_percent[0];
    buffer[35] = usb_host_volume_percent[1];
    buffer[36] = usb_host_mute[0];
    buffer[37] = usb_host_mute[1];
    buffer[38] = host_output_report_len;
    buffer[39] = host_output_report_id;
    write_u16(buffer + 40, host_output_report_count);
    write_u16(buffer + 42, bt_idle_disconnect_timeout_minutes());
    buffer[44] = static_cast<uint8_t>(bt_get_signal_strength());
    buffer[45] = bt_has_signal_strength() ? 1 : 0;
    buffer[46] = game_trigger_update_recent() ? 1 : 0;
    buffer[58] = lightbar_override_enabled ? 1 : 0;
    buffer[59] = mute_button_mode;
    buffer[60] = mute_keyboard_usage;
    buffer[61] = mute_keyboard_modifiers;
    buffer[62] = audio_quiet_mode_enabled() ? 1 : 0;
    return COMPANION_PAYLOAD_SIZE;
}

uint16_t build_ack(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    buffer[6] = last_ack.command_id;
    buffer[7] = last_ack.sequence;
    buffer[8] = last_ack.result;
    buffer[9] = last_ack.detail;
    write_u16(buffer + 10, settings_revision);
    write_u32(buffer + 12, uptime_seconds());
    return COMPANION_PAYLOAD_SIZE;
}

uint16_t build_audio_debug(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    audio_debug_copy_report_payload(buffer + 6, COMPANION_PAYLOAD_SIZE - 6);
    return COMPANION_PAYLOAD_SIZE;
}

uint16_t build_audio_stats(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    buffer[6] = 1;

    audio_debug_stats audio_stats{};
    bt_output_debug_stats bt_stats{};
    audio_debug_get_stats(&audio_stats);
    bt_get_output_debug_stats(&bt_stats);

    uint8_t *fields = buffer + 7;
    write_u32(fields + 0, audio_stats.usb_audio_gap_max_us);
    write_u32(fields + 4, audio_stats.usb_audio_gap_over_1500_count);
    write_u32(fields + 8, audio_stats.opus_encode_max_us);
    write_u32(fields + 12, audio_stats.opus_encode_over_budget_count);
    write_u32(fields + 16, bt_stats.audio_0x36_enqueue_to_send_max_us);
    write_u32(fields + 20, bt_stats.audio_0x36_send_gap_max_us);
    write_u32(fields + 24, bt_stats.audio_0x36_late_count_over_12000_us);
    write_u32(fields + 28, bt_stats.audio_0x36_drop_oldest_count);
    write_u32(fields + 32, audio_stats.audio_generation_drop_count);
    write_u32(fields + 36, bt_stats.non_audio_reports_between_audio_max);
    write_u32(fields + 40, bt_stats.bt_audio_queue_depth_max);
    write_u32(fields + 44, bt_stats.audio_0x36_enqueued_count);
    write_u32(fields + 48, bt_stats.audio_0x36_sent_count);
    write_u32(fields + 52, bt_stats.critical_starving_audio_count);
    return COMPANION_PAYLOAD_SIZE;
}

uint16_t build_host_audio_status(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);

    audio_host_status status{};
    audio_get_host_status(&status);
    buffer[6] = status.mode;
    buffer[7] = status.fallback_reason;
    buffer[8] = status.host_requested ? 1 : 0;
    buffer[9] = status.heartbeat_healthy ? 1 : 0;
    buffer[10] = status.stream_active ? 1 : 0;
    buffer[11] = status.stream_healthy ? 1 : 0;
    buffer[12] = status.duplex_requested ? 1 : 0;
    buffer[13] = (status.duplex_active ? 0x01 : 0x00)
        | (status.headset_plugged ? 0x02 : 0x00)
        | (status.headset_audio_route ? 0x04 : 0x00)
        | (status.controller_state_ready ? 0x08 : 0x00);
    write_u16(buffer + 14, status.stream_generation);
    write_u32(buffer + 16, status.heartbeat_age_ms);
    write_u32(buffer + 20, status.frame_age_ms);
    write_u32(buffer + 24, status.host_frames_received);
    write_u32(buffer + 28, status.host_frames_dropped);
    write_u32(buffer + 32, status.mic_packets_received);
    write_u32(buffer + 36, status.mic_packets_dropped);
    write_u32(buffer + 40, status.mic_decode_success);
    write_u32(buffer + 44, status.mic_decode_fail);
    write_u32(buffer + 48, status.mic_usb_write_success);
    write_u32(buffer + 52, status.mic_usb_write_short);
    write_u16(buffer + 56, status.mic_last_decoded_samples);
    write_u16(buffer + 58, status.mic_last_written_bytes);
    write_u16(buffer + 60, status.mic_peak_permille);
    buffer[62] = status.mic_usb_streaming ? 1 : 0;
    return COMPANION_PAYLOAD_SIZE;
}

#if DS5_TRIGGER_TRACE_ENABLED
uint16_t build_trigger_trace(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    buffer[7] = kTriggerTraceRecordSize;

    critical_section_enter_blocking(&companion_report_cs);
    const uint32_t latest_sequence = trigger_trace_next_sequence > 1 ? trigger_trace_next_sequence - 1 : 0;
    write_u32(buffer + 8, latest_sequence);
    write_u16(buffer + 12, trigger_trace_dropped_count);

    const uint8_t max_records = static_cast<uint8_t>((COMPANION_PAYLOAD_SIZE - 14) / kTriggerTraceRecordSize);
    const uint32_t oldest_sequence = trigger_trace_next_sequence - trigger_trace_count;
    if (trigger_trace_read_sequence < oldest_sequence) {
        trigger_trace_read_sequence = oldest_sequence;
    }
    const uint32_t available_records = trigger_trace_next_sequence > trigger_trace_read_sequence
        ? trigger_trace_next_sequence - trigger_trace_read_sequence
        : 0;
    const uint8_t record_count = static_cast<uint8_t>(std::min<uint32_t>(max_records, available_records));
    buffer[6] = record_count;

    const uint8_t oldest_index = static_cast<uint8_t>(
        (trigger_trace_head + kTriggerTraceRingSize - trigger_trace_count) % kTriggerTraceRingSize
    );
    for (uint8_t i = 0; i < record_count; i++) {
        const uint32_t sequence = trigger_trace_read_sequence + i;
        const uint8_t ring_index = static_cast<uint8_t>(
            (oldest_index + (sequence - oldest_sequence)) % kTriggerTraceRingSize
        );
        const TriggerTraceEvent &event = trigger_trace_ring[ring_index];
        uint8_t *record = buffer + 14 + (i * kTriggerTraceRecordSize);
        write_u16(record, static_cast<uint16_t>(event.sequence & 0xffff));
        write_u32(record + 2, event.timestamp_ms);
        record[6] = event.stage;
        record[7] = event.report_id;
        record[8] = event.length;
        record[9] = event.sequence_tag;
        record[10] = event.flag0;
        record[11] = event.flag1;
        record[12] = event.flag2;
        record[13] = event.motor_power;
        record[14] = event.decision;
        memcpy(record + 15, event.right_trigger, sizeof(event.right_trigger));
        memcpy(record + 26, event.left_trigger, sizeof(event.left_trigger));
    }

    trigger_trace_read_sequence += record_count;
    critical_section_exit(&companion_report_cs);
    return COMPANION_PAYLOAD_SIZE;
}
#endif

#if DS5_FEEDBACK_TRACE_ENABLED
uint16_t build_feedback_trace(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    buffer[7] = kFeedbackTraceRecordSize;

    critical_section_enter_blocking(&companion_report_cs);
    const uint32_t latest_sequence = feedback_trace_next_sequence > 1 ? feedback_trace_next_sequence - 1 : 0;
    write_u32(buffer + 8, latest_sequence);
    write_u16(buffer + 12, feedback_trace_dropped_count);

    const uint8_t max_records = static_cast<uint8_t>((COMPANION_PAYLOAD_SIZE - 14) / kFeedbackTraceRecordSize);
    const uint32_t oldest_sequence = feedback_trace_next_sequence - feedback_trace_count;
    if (feedback_trace_read_sequence < oldest_sequence) {
        feedback_trace_read_sequence = oldest_sequence;
    }
    const uint32_t available_records = feedback_trace_next_sequence > feedback_trace_read_sequence
        ? feedback_trace_next_sequence - feedback_trace_read_sequence
        : 0;
    const uint8_t record_count = static_cast<uint8_t>(std::min<uint32_t>(max_records, available_records));
    buffer[6] = record_count;

    const uint8_t oldest_index = static_cast<uint8_t>(
        (feedback_trace_head + kFeedbackTraceRingSize - feedback_trace_count) % kFeedbackTraceRingSize
    );
    for (uint8_t i = 0; i < record_count; i++) {
        const uint32_t sequence = feedback_trace_read_sequence + i;
        const uint8_t ring_index = static_cast<uint8_t>(
            (oldest_index + (sequence - oldest_sequence)) % kFeedbackTraceRingSize
        );
        const FeedbackTraceEvent &event = feedback_trace_ring[ring_index];
        uint8_t *record = buffer + 14 + (i * kFeedbackTraceRecordSize);
        write_u16(record, static_cast<uint16_t>(event.sequence & 0xffff));
        write_u32(record + 2, event.timestamp_ms);
        record[6] = event.stage;
        record[7] = event.report_id;
        record[8] = event.length;
        record[9] = event.sequence_tag;
        record[10] = event.decision;
        record[11] = event.flag0;
        record[12] = event.flag1;
        record[13] = event.flag2;
        record[14] = event.motor_right;
        record[15] = event.motor_left;
        record[16] = event.haptic_peak;
        record[17] = event.haptic_mean;
        record[18] = event.haptic_nonzero;
        record[19] = event.detail0;
        record[20] = event.detail1;
        record[21] = event.detail2;
        record[22] = event.detail3;
    }

    feedback_trace_read_sequence += record_count;
    critical_section_exit(&companion_report_cs);
    return COMPANION_PAYLOAD_SIZE;
}
#endif

void handle_command(uint8_t const *buffer, uint16_t bufsize) {
    uint8_t command_id = 0;
    uint8_t sequence = 0;
    if (bufsize > 6) {
        command_id = buffer[6];
    }
    if (bufsize > 7) {
        sequence = buffer[7];
    }

    if (bufsize != COMPANION_PAYLOAD_SIZE) {
        set_ack(command_id, sequence, AckBadLength);
        return;
    }
    if (!has_magic(buffer)) {
        set_ack(command_id, sequence, AckBadMagic);
        return;
    }
    if (!has_supported_version(buffer)) {
        set_ack(command_id, sequence, AckBadVersion);
        return;
    }

    const uint16_t value = read_u16(buffer + 8);
    switch (command_id) {
        case CommandSetHapticsGain:
            if (value > 200) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            volume[1] = static_cast<float>(value) / 100.0f;
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetSpeakerVolume:
            if (value > 100) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            {
                const float next_volume = static_cast<float>(value) / 100.0f;
                const bool was_enabled = volume[0] > 0.0f;
                volume[0] = next_volume;
                if (was_enabled && next_volume > 0.0f) {
                    bt_refresh_speaker_output();
                }
                settings_revision++;
                set_ack(command_id, sequence, AckOk);
                return;
            }

        case CommandSetMicVolume:
            if (value > 100) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            companion_mic_volume_percent = static_cast<uint8_t>(value);
            audio_set_mic_output_state(companion_mic_volume_percent, companion_mic_muted);
            bt_set_microphone_state(companion_mic_volume_percent, companion_mic_muted);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetMicMute:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            companion_mic_muted = value == 1;
            audio_set_mic_output_state(companion_mic_volume_percent, companion_mic_muted);
            bt_set_microphone_state(companion_mic_volume_percent, companion_mic_muted);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetLightbarColor:
            if (value > 100) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            set_lightbar_color(buffer[10], buffer[11], buffer[12], static_cast<uint8_t>(value));
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetLightbarOverride:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            lightbar_override_enabled = value == 1;
            if (lightbar_override_enabled && bt_is_controller_connected()) {
                bt_set_lightbar_color(lightbar_red, lightbar_green, lightbar_blue, lightbar_brightness);
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetMuteButtonAction:
            if (!valid_mute_button_action(value, buffer[10])) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_mute_button_action(static_cast<uint8_t>(value), buffer[10], buffer[11]);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetHapticsBufferLength:
            if (value == 0 || value > 255) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            audio_set_haptics_buffer_length(static_cast<uint8_t>(value));
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetClassicRumbleGain:
            if (value > 200) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            bt_set_classic_rumble_gain(static_cast<uint8_t>(value));
            if (value == 0) {
                classic_rumble_test_active = false;
                classic_rumble_test_until_us = 0;
                bt_set_classic_rumble_output(0, 0);
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandTestClassicRumble:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            if (!schedule_classic_rumble_test()) {
                set_ack(command_id, sequence, AckBusy);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetTriggerEffectIntensity:
            if (value > 100) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            trigger_effect_intensity_percent = static_cast<uint8_t>(value);
            if (adaptive_trigger_test_active) {
                bt_set_adaptive_trigger_effect(
                    adaptive_trigger_test_mode,
                    trigger_effect_intensity_percent,
                    adaptive_trigger_test_target
                );
            } else {
                replay_cached_game_trigger_effect();
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandTestAdaptiveTriggers:
            {
            const uint8_t mode = static_cast<uint8_t>(value & 0xff);
            const uint8_t target = static_cast<uint8_t>((value >> 8) & 0xff);
            if (!valid_trigger_test_mode(mode) || !valid_trigger_target(target)) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            if (!schedule_adaptive_trigger_test(mode, target)) {
                set_ack(command_id, sequence, AckBusy);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandResetAdaptiveTriggers:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (game_trigger_update_recent()) {
                set_ack(command_id, sequence, AckBusy);
                return;
            }
            reset_adaptive_trigger_test();
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetLedEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_led_enabled(value == 1);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetIdleDisconnectEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_idle_disconnect_enabled(value == 1);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetIdleDisconnectTimeout:
            if (!bt_set_idle_disconnect_timeout_minutes(static_cast<uint16_t>(value))) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetUsbSuspendDisconnectEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            usb_set_suspend_disconnect_enabled(value == 1);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetSleepKeybindEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            sleep_keybind_enabled = value == 1;
            std::fill(shortcut_binding_last_pressed, shortcut_binding_last_pressed + kShortcutBindingCount, false);
            std::fill(shortcut_binding_last_step_us, shortcut_binding_last_step_us + kShortcutBindingCount, 0);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetSpeakerVolumeShortcut:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            speaker_volume_shortcut_enabled = value == 1;
            std::fill(shortcut_binding_last_pressed, shortcut_binding_last_pressed + kShortcutBindingCount, false);
            std::fill(shortcut_binding_last_step_us, shortcut_binding_last_step_us + kShortcutBindingCount, 0);
            pending_shortcut_event = 0;
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetButtonRemap:
            if (value != 0 || !valid_button_remap_payload(buffer + 10, bufsize - 10)) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            memcpy(button_remap, buffer + 10, RemapButtonCount);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetPollingRateMode:
            if (value > 2 || !usb_set_hid_polling_rate_mode(static_cast<uint8_t>(value))) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSleepController:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_disconnect()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandTestHaptics:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            if (!audio_schedule_test_haptics()) {
                set_ack(command_id, sequence, AckBusy);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetHostAudioEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            audio_host_set_requested(value == 1);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandHostAudioHeartbeat:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            audio_host_note_heartbeat();
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandStartHostAudio:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            audio_host_start_stream();
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandStopHostAudio:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            audio_host_stop_stream();
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetDuplexEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            audio_host_set_duplex_requested(value == 1);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandRestoreDefaults:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            restore_defaults();
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        default:
            set_ack(command_id, sequence, AckUnknownCommand);
            return;
    }
}

bool shortcut_setting_enabled(ShortcutSetting setting) {
    switch (setting) {
        case ShortcutSettingSleepKeybind:
            return sleep_keybind_enabled;
        case ShortcutSettingControllerVolume:
            return speaker_volume_shortcut_enabled;
        default:
            return false;
    }
}

bool shortcut_combo_pressed(const ShortcutBinding &binding, const uint8_t *report) {
    const bool home_pressed = (report[9] & kHomeButtonBit) != 0;
    if (!home_pressed) {
        return false;
    }

    const uint8_t dpad_direction = report[7] & kDpadMask;
    switch (binding.combo) {
        case ShortcutComboHomeDpadUp:
            return dpad_direction == kDpadUp;
        case ShortcutComboHomeDpadDown:
            return dpad_direction == kDpadDown;
        case ShortcutComboHomeTriangle:
            return (report[7] & kTriangleButtonBit) != 0;
        default:
            return false;
    }
}

void suppress_shortcut_input(const ShortcutBinding &binding, uint8_t *report) {
    report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
    switch (binding.combo) {
        case ShortcutComboHomeDpadUp:
        case ShortcutComboHomeDpadDown:
            report[7] = static_cast<uint8_t>((report[7] & ~kDpadMask) | kDpadNeutral);
            break;
        case ShortcutComboHomeTriangle:
            report[7] &= static_cast<uint8_t>(~kTriangleButtonBit);
            break;
        default:
            break;
    }
}

void process_shortcut_bindings(uint8_t *report) {
    const uint32_t now = time_us_32();
    for (size_t i = 0; i < kShortcutBindingCount; i++) {
        const ShortcutBinding &binding = kShortcutBindings[i];
        const bool pressed = shortcut_setting_enabled(binding.setting) && shortcut_combo_pressed(binding, report);
        if (pressed) {
            suppress_shortcut_input(binding, report);
            const bool should_emit = binding.trigger == ShortcutTriggerPressed
                ? !shortcut_binding_last_pressed[i]
                : (!shortcut_binding_last_pressed[i]
                    || static_cast<uint32_t>(now - shortcut_binding_last_step_us[i]) >= kShortcutRepeatUs);
            if (should_emit) {
                pending_shortcut_event = binding.event;
                shortcut_binding_last_step_us[i] = now;
            }
        } else {
            shortcut_binding_last_step_us[i] = 0;
        }
        shortcut_binding_last_pressed[i] = pressed;
    }
}

bool dpad_direction_has(uint8_t direction, RemapButton button) {
    switch (button) {
        case RemapDpadUp:
            return direction == kDpadUp || direction == kDpadUpRight || direction == kDpadUpLeft;
        case RemapDpadRight:
            return direction == kDpadRight || direction == kDpadUpRight || direction == kDpadDownRight;
        case RemapDpadDown:
            return direction == kDpadDown || direction == kDpadDownRight || direction == kDpadDownLeft;
        case RemapDpadLeft:
            return direction == kDpadLeft || direction == kDpadUpLeft || direction == kDpadDownLeft;
        default:
            return false;
    }
}

uint8_t dpad_direction_from_buttons(bool up, bool right, bool down, bool left) {
    if (up && right && !down && !left) return kDpadUpRight;
    if (right && down && !up && !left) return kDpadDownRight;
    if (down && left && !up && !right) return kDpadDownLeft;
    if (left && up && !right && !down) return kDpadUpLeft;
    if (up && !down) return kDpadUp;
    if (right && !left) return kDpadRight;
    if (down && !up) return kDpadDown;
    if (left && !right) return kDpadLeft;
    return kDpadNeutral;
}

void apply_button_remap(uint8_t *report, uint16_t len) {
    if (report == nullptr || len <= 8) {
        return;
    }

    bool source_pressed[RemapButtonCount]{};
    uint8_t source_analog[RemapButtonCount]{};
    const uint8_t dpad_direction = report[7] & kDpadMask;

    source_pressed[RemapL2] = (report[8] & kL2ButtonBit) != 0;
    source_pressed[RemapL1] = (report[8] & kL1ButtonBit) != 0;
    source_pressed[RemapCreate] = (report[8] & kCreateButtonBit) != 0;
    source_pressed[RemapDpadUp] = dpad_direction_has(dpad_direction, RemapDpadUp);
    source_pressed[RemapDpadLeft] = dpad_direction_has(dpad_direction, RemapDpadLeft);
    source_pressed[RemapDpadDown] = dpad_direction_has(dpad_direction, RemapDpadDown);
    source_pressed[RemapDpadRight] = dpad_direction_has(dpad_direction, RemapDpadRight);
    source_pressed[RemapL3] = (report[8] & kL3ButtonBit) != 0;
    source_pressed[RemapR2] = (report[8] & kR2ButtonBit) != 0;
    source_pressed[RemapR1] = (report[8] & kR1ButtonBit) != 0;
    source_pressed[RemapOptions] = (report[8] & kOptionsButtonBit) != 0;
    source_pressed[RemapTriangle] = (report[7] & kTriangleButtonBit) != 0;
    source_pressed[RemapCircle] = (report[7] & kCircleButtonBit) != 0;
    source_pressed[RemapCross] = (report[7] & kCrossButtonBit) != 0;
    source_pressed[RemapSquare] = (report[7] & kSquareButtonBit) != 0;
    source_pressed[RemapR3] = (report[8] & kR3ButtonBit) != 0;

    for (uint8_t i = 0; i < RemapButtonCount; i++) {
        source_analog[i] = source_pressed[i] ? 0xFF : 0;
    }
    source_analog[RemapL2] = report[4];
    source_analog[RemapR2] = report[5];

    bool target_pressed[RemapButtonCount]{};
    uint8_t target_analog[RemapButtonCount]{};
    for (uint8_t source = 0; source < RemapButtonCount; source++) {
        const uint8_t target = button_remap[source];
        if (source_pressed[source]) {
            target_pressed[target] = true;
        }
        target_analog[target] = std::max(target_analog[target], source_analog[source]);
    }

    report[4] = target_analog[RemapL2];
    report[5] = target_analog[RemapR2];
    report[7] &= static_cast<uint8_t>(~(kDpadMask | kSquareButtonBit | kCrossButtonBit | kCircleButtonBit | kTriangleButtonBit));
    report[7] |= dpad_direction_from_buttons(
        target_pressed[RemapDpadUp],
        target_pressed[RemapDpadRight],
        target_pressed[RemapDpadDown],
        target_pressed[RemapDpadLeft]
    );
    if (target_pressed[RemapSquare]) report[7] |= kSquareButtonBit;
    if (target_pressed[RemapCross]) report[7] |= kCrossButtonBit;
    if (target_pressed[RemapCircle]) report[7] |= kCircleButtonBit;
    if (target_pressed[RemapTriangle]) report[7] |= kTriangleButtonBit;

    report[8] = 0;
    if (target_pressed[RemapL1]) report[8] |= kL1ButtonBit;
    if (target_pressed[RemapR1]) report[8] |= kR1ButtonBit;
    if (target_pressed[RemapL2]) report[8] |= kL2ButtonBit;
    if (target_pressed[RemapR2]) report[8] |= kR2ButtonBit;
    if (target_pressed[RemapCreate]) report[8] |= kCreateButtonBit;
    if (target_pressed[RemapOptions]) report[8] |= kOptionsButtonBit;
    if (target_pressed[RemapL3]) report[8] |= kL3ButtonBit;
    if (target_pressed[RemapR3]) report[8] |= kR3ButtonBit;
}

} // namespace

void companion_init() {
    critical_section_init(&companion_report_cs);
    restore_defaults();
    set_ack(0, 0, AckOk);
}

void companion_loop() {
    if (pending_shortcut_event != 0 && tud_hid_n_ready(COMPANION_HID_INSTANCE)) {
        const uint8_t event = pending_shortcut_event;
        if (tud_hid_n_report(COMPANION_HID_INSTANCE, COMPANION_REPORT_INPUT, &event, 1)) {
            pending_shortcut_event = 0;
        }
    }
    audio_test_haptics_loop();
    classic_rumble_test_loop();
    mute_keyboard_loop();
    adaptive_trigger_test_loop();
}

void companion_process_controller_report(uint8_t *report, uint16_t len) {
    if (len <= 9) {
        return;
    }

    const bool home_pressed = (report[9] & kHomeButtonBit) != 0;
    const uint8_t dpad_direction = report[7] & kDpadMask;
    const bool dpad_pressed = dpad_direction <= 0x07;
    process_shortcut_bindings(report);
    if (home_pressed && dpad_pressed) {
        report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
    }

    const bool pressed = (report[9] & kMuteButtonBit) != 0;
    if (mute_button_mode != MuteButtonNormal) {
        report[9] &= static_cast<uint8_t>(~kMuteButtonBit);
    }

    if (pressed && !mute_button_last_pressed) {
        if (mute_button_mode == MuteButtonKeyboard) {
            queue_mute_keyboard_press(mute_keyboard_hold_enabled());
        } else if (mute_button_mode == MuteButtonQuiet) {
            toggle_quiet_mode();
        }
    } else if (!pressed && mute_button_last_pressed && mute_button_mode == MuteButtonKeyboard && mute_keyboard_hold_enabled()) {
        queue_mute_keyboard_release();
    }

    mute_button_last_pressed = pressed;
    apply_button_remap(report, len);
}

void companion_update_controller_report(uint8_t const *report, uint16_t len) {
    if (len < sizeof(last_controller_report)) {
        return;
    }

    critical_section_enter_blocking(&companion_report_cs);
    memcpy(last_controller_report, report, sizeof(last_controller_report));
    have_controller_report = true;
    critical_section_exit(&companion_report_cs);
}

void companion_note_host_output_report(uint8_t const *report, uint16_t len) {
    const uint8_t next_len = static_cast<uint8_t>(std::min<uint16_t>(len, 255));
    const uint8_t next_id = len > 0 ? report[0] : 0;
    uint8_t next_first16[16]{};
    memcpy(next_first16, report, std::min<uint16_t>(len, sizeof(next_first16)));

    if (
        host_output_report_len == next_len
        && host_output_report_id == next_id
        && memcmp(host_output_report_first16, next_first16, sizeof(next_first16)) == 0
    ) {
        return;
    }

    host_output_report_count++;
    host_output_report_len = next_len;
    host_output_report_id = next_id;
    memcpy(host_output_report_first16, next_first16, sizeof(host_output_report_first16));
}

#if DS5_TRIGGER_TRACE_ENABLED
void companion_note_trigger_trace_report(
    uint8_t stage,
    uint8_t const *report,
    uint16_t len,
    uint8_t decision
) {
    TriggerTraceEvent event{};
    if (!decode_trigger_trace_report(report, len, event)) {
        return;
    }

    critical_section_enter_blocking(&companion_report_cs);
    event.sequence = trigger_trace_next_sequence++;
    event.timestamp_ms = to_ms_since_boot(get_absolute_time());
    event.stage = stage;
    event.decision = decision;
    append_trigger_trace_event(event);
    critical_section_exit(&companion_report_cs);
}
#endif

#if DS5_FEEDBACK_TRACE_ENABLED
void companion_note_feedback_trace_report(
    uint8_t stage,
    uint8_t const *report,
    uint16_t len,
    uint8_t decision,
    uint8_t detail0,
    uint8_t detail1,
    uint8_t detail2,
    uint8_t detail3
) {
    FeedbackTraceEvent event{};
    const bool force_trace = (
        stage == CompanionFeedbackTraceBridgeOut
        || stage == CompanionFeedbackTraceDrop
    ) && ((detail3 & static_cast<uint8_t>(~0x04u)) != 0);
    if (!decode_feedback_trace_report(report, len, event, force_trace)) {
        return;
    }

    critical_section_enter_blocking(&companion_report_cs);
    event.sequence = feedback_trace_next_sequence++;
    event.timestamp_ms = to_ms_since_boot(get_absolute_time());
    event.stage = stage;
    event.decision = decision;
    event.detail0 = detail0;
    event.detail1 = detail1;
    event.detail2 = detail2;
    event.detail3 = detail3;
    append_feedback_trace_event(event);
    critical_section_exit(&companion_report_cs);
}

void companion_note_feedback_trace_samples(
    uint8_t stage,
    uint8_t const *samples,
    uint16_t len,
    uint8_t detail0,
    uint8_t detail1,
    uint8_t detail2,
    uint8_t detail3
) {
    FeedbackTraceEvent event{};
    event.report_id = 0x36;
    event.length = static_cast<uint8_t>(std::min<uint16_t>(len, 255));
    event.detail0 = detail0;
    event.detail1 = detail1;
    event.detail2 = detail2;
    event.detail3 = detail3;
    fill_feedback_haptic_stats(samples, len, event.haptic_peak, event.haptic_mean, event.haptic_nonzero);
    if (event.haptic_peak == 0 && event.haptic_nonzero == 0) {
        return;
    }

    critical_section_enter_blocking(&companion_report_cs);
    event.sequence = feedback_trace_next_sequence++;
    event.timestamp_ms = to_ms_since_boot(get_absolute_time());
    event.stage = stage;
    append_feedback_trace_event(event);
    critical_section_exit(&companion_report_cs);
}
#endif

bool companion_apply_trigger_effect_intensity(uint8_t *payload, uint16_t len) {
    if (payload == nullptr) {
        return false;
    }

    cache_game_trigger_effects(payload, len);
    if (trigger_effect_intensity_percent >= 100) {
        return false;
    }

    const uint8_t trigger_flags = len > 0 ? payload[0] & kTriggerEffectFlags : 0;
    if (trigger_flags == 0) {
        return false;
    }

    const bool right_trigger_active = trigger_effect_block_active(
        payload,
        len,
        trigger_flags,
        kTriggerRightEffectFlag,
        kTriggerEffectRightOffset
    );
    const bool left_trigger_active = trigger_effect_block_active(
        payload,
        len,
        trigger_flags,
        kTriggerLeftEffectFlag,
        kTriggerEffectLeftOffset
    );

    if (!right_trigger_active && !left_trigger_active) {
        return false;
    }

    bool changed = false;
    if (trigger_effect_intensity_percent == 0) {
        uint8_t off[kTriggerEffectSize]{};
        set_trigger_off(off);

        if (
            right_trigger_active
            && len > kTriggerEffectRightOffset + kTriggerEffectSize - 1
            && memcmp(payload + kTriggerEffectRightOffset, off, sizeof(off)) != 0
        ) {
            memcpy(payload + kTriggerEffectRightOffset, off, sizeof(off));
            changed = true;
        }
        if (
            left_trigger_active
            && len > kTriggerEffectLeftOffset + kTriggerEffectSize - 1
            && memcmp(payload + kTriggerEffectLeftOffset, off, sizeof(off)) != 0
        ) {
            memcpy(payload + kTriggerEffectLeftOffset, off, sizeof(off));
            changed = true;
        }
        return changed;
    }

    if (right_trigger_active && len > kTriggerEffectRightOffset + kTriggerEffectSize - 1) {
        changed = scale_trigger_effect_block(payload + kTriggerEffectRightOffset, trigger_effect_intensity_percent)
            || changed;
    }
    if (left_trigger_active && len > kTriggerEffectLeftOffset + kTriggerEffectSize - 1) {
        changed = scale_trigger_effect_block(payload + kTriggerEffectLeftOffset, trigger_effect_intensity_percent)
            || changed;
    }

    if (len > kTriggerEffectPowerOffset) {
        const uint8_t next_flags = payload[1] | kTriggerMotorPowerFlag;
        const uint8_t next_power = static_cast<uint8_t>(
            (payload[kTriggerEffectPowerOffset] & 0xF0) | trigger_power_reduction(trigger_effect_intensity_percent)
        );
        changed = changed || payload[1] != next_flags || payload[kTriggerEffectPowerOffset] != next_power;
        payload[1] = next_flags;
        payload[kTriggerEffectPowerOffset] = next_power;
    }
    return changed;
}

bool companion_lightbar_override_enabled() {
    return lightbar_override_enabled;
}

uint16_t companion_get_report(uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer, uint16_t reqlen) {
    if (report_type == HID_REPORT_TYPE_INPUT && report_id == COMPANION_REPORT_INPUT) {
        if (reqlen < 1) {
            return 0;
        }
        buffer[0] = 0;
        return 1;
    }

    if (report_type != HID_REPORT_TYPE_FEATURE) {
        return 0;
    }

    switch (report_id) {
        case COMPANION_REPORT_STATUS:
            return build_status(buffer, reqlen);
        case COMPANION_REPORT_ACK:
            return build_ack(buffer, reqlen);
        case COMPANION_REPORT_AUDIO_DEBUG:
            return build_audio_debug(buffer, reqlen);
        case COMPANION_REPORT_AUDIO_STATS:
            return build_audio_stats(buffer, reqlen);
        case COMPANION_REPORT_HOST_AUDIO_STATUS:
            return build_host_audio_status(buffer, reqlen);
#if DS5_TRIGGER_TRACE_ENABLED
        case COMPANION_REPORT_TRIGGER_TRACE:
            return build_trigger_trace(buffer, reqlen);
#endif
#if DS5_FEEDBACK_TRACE_ENABLED
        case COMPANION_REPORT_FEEDBACK_TRACE:
            return build_feedback_trace(buffer, reqlen);
#endif
        default:
            return 0;
    }
}

void companion_set_report(uint8_t report_id, hid_report_type_t report_type, uint8_t const *buffer, uint16_t bufsize) {
    if (report_type == HID_REPORT_TYPE_OUTPUT) {
        if (report_id == COMPANION_REPORT_HOST_AUDIO_STREAM) {
            audio_host_receive_packet(buffer, bufsize);
            return;
        }
        if (bufsize > 0 && buffer[0] == COMPANION_REPORT_HOST_AUDIO_STREAM) {
            audio_host_receive_packet(buffer + 1, bufsize - 1);
            return;
        }
        if (report_id == 0 && bufsize >= sizeof(kMagic) && has_magic(buffer)) {
            audio_host_receive_packet(buffer, bufsize);
            return;
        }
        return;
    }

    if (report_type != HID_REPORT_TYPE_FEATURE || report_id != COMPANION_REPORT_COMMAND) {
        set_ack(report_id, 0, AckUnknownCommand);
        return;
    }

    handle_command(buffer, bufsize);
}
