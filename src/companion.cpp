#include "companion.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstring>

#include "audio.h"
#include "bt.h"
#include "watchdog_telemetry.h"

#include "controller_output_policy.h"
#include "controller_report.h"
#include "controller_output_submit.h"
#include "dualsense_output.h"
#include "host_bridge.h"
#include "host_input.h"
#include "persona/host_persona.h"
#include "pico/critical_section.h"
#include "pico/cyw43_arch.h"
#include "pico/bootrom.h"
#include "pico/unique_id.h"
#include "pico/time.h"
#include "usb.h"

namespace {

constexpr uint8_t kMagic[] = {'D', 'S', '5', 'B'};
constexpr uint8_t kProtocolMajor = 1;
constexpr uint8_t kProtocolMinor = 17;
constexpr uint8_t kProtocolMinSupportedMinor = 7;
constexpr uint8_t kFirmwareMajor = 1;
constexpr uint8_t kFirmwareMinor = 6;
constexpr uint8_t kFirmwarePatch = 67;
constexpr uint8_t kAudioReactiveHapticsModeMask = 0x7f;
constexpr uint8_t kAudioReactiveHapticsSuppressClassicRumbleFlag = 0x80;
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
constexpr uint8_t kLeftFunctionButtonBit = 0x10;
constexpr uint8_t kRightFunctionButtonBit = 0x20;
constexpr uint8_t kLeftBackButtonBit = 0x40;
constexpr uint8_t kRightBackButtonBit = 0x80;
constexpr uint8_t kDualSenseEdgeButtonMask = kLeftFunctionButtonBit
    | kRightFunctionButtonBit
    | kLeftBackButtonBit
    | kRightBackButtonBit;
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
constexpr uint32_t kHomeChordSuppressUs = 250000;
constexpr uint32_t kHomeChordFallbackReplayUs = 80000;
constexpr uint8_t kDefaultMuteKeyboardUsage = 0x68; // F13
constexpr uint8_t kMuteKeyboardModifierMask = 0x0F;
constexpr uint8_t kMuteKeyboardChordStarterFlag = 0x10;
constexpr uint8_t kMuteKeyboardHoldFlag = 0x80;
constexpr uint32_t kKeyboardPressDurationUs = 40000;
constexpr uint32_t kMuteKeyboardChordWindowUs = 250000;
constexpr uint32_t kMuteLedFlashDurationUs = 120000;
constexpr uint32_t kClassicRumbleTestDurationUs = 650000;
constexpr uint8_t kClassicRumbleTestAmplitude = 160;
constexpr uint8_t kDefaultSpeakerOutputGain = 4;
constexpr uint32_t kAdaptiveTriggerTestDurationUs = 2500000;
constexpr uint32_t kPersistentTriggerReapplyIntervalUs = 500000;
constexpr uint32_t kGameTriggerUpdateRecentUs = 2000000;
constexpr uint16_t kMaxFeedbackGainPercent = 500;
constexpr float kMaxHapticsGain = 5.0f;
#if DS5_TRIGGER_TRACE_ENABLED
constexpr uint8_t kTriggerTraceRecordSize = 38;
constexpr uint8_t kTriggerTraceRingSize = 96;
#endif
#if DS5_FEEDBACK_TRACE_ENABLED
constexpr uint8_t kFeedbackTraceRecordSize = 24;
constexpr uint8_t kFeedbackTraceRingSize = 160;
#endif
// Both spellings of "no effect": 0x05 in the extended family, 0x00 in the simple one.
constexpr uint8_t kTriggerEffectModeOffExtended = 0x05;
constexpr uint8_t kTriggerEffectModeOffSimple = 0x00;
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
    CommandSetDuplexEnabled = 0x19,
    CommandSetMicVolume = 0x1A,
    CommandSetMicMute = 0x1B,
    CommandSetIdleDisconnectTimeout = 0x1C,
    CommandSetSpeakerVolumeShortcut = 0x1D,
    CommandSetButtonRemap = 0x1E,
    CommandPreviewAdaptiveTriggerEffect = 0x1F,
    CommandApplyAdaptiveTriggerEffect = 0x20,
    CommandSetHostPersona = 0x21,
    CommandSetAudioReactiveHaptics = 0x22,
    CommandSetChordBindings = 0x23,
    CommandSetPlayerLedEnabled = 0x24,
    CommandSetClassicRumbleV1 = 0x25,
    CommandSetSpeakerGain = 0x32,
    CommandEnterBootloader = 0x33,
    // Retired: the audio/controller interleave scheduler is gone (state always wins).
    // The id stays reserved so it is not reused, and so an older app sending it gets a
    // refusal instead of silently believing it configured something.
    CommandSetAudioInterleaveRetired = 0x34,
    // Devices tab. IDs match upstream so the protocol stays convergent.
    CommandRequestControllerScan = 0x27,
    CommandForgetControllerPairings = 0x28,
    CommandForgetControllerPairing = 0x2E,
    CommandSetWakeOnConnect = 0x35,
    // App-composed effect bytes. See bt_set_raw_adaptive_trigger_effects.
    CommandSetRawTriggerEffect = 0x36,
    // Hold input forwarding to the host. See host_input_hold_forwarding.
    CommandHoldInputForwarding = 0x37,
    // Stick deadzone: low byte left percent, high byte right percent.
    CommandSetStickDeadzone = 0x38,
    // Stick calibration: low byte op (1 begin, 2 store, 3 sample), high byte target
    // (1 centre, 2 range). TEMPORARY on its own -- see CommandSetNvsUnlocked.
    CommandStickCalibration = 0x39,
    // Unlock (value 1) or re-lock (value 0) the controller's permanent storage. This is what
    // makes a calibration survive a reset, and what can leave a controller unusable.
    CommandSetNvsUnlocked = 0x3A,
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
    // A forget refused because its durable blacklist write did not verify. Value matches
    // upstream so the protocols stay convergent.
    AckPersistenceFailed = 0x08,
};

enum MuteButtonMode : uint8_t {
    MuteButtonNormal = 0,
    MuteButtonKeyboard = 1,
    MuteButtonQuiet = 2,
    MuteButtonChord = 3,
};

enum ShortcutEvent : uint8_t {
    ShortcutEventControllerVolumeDown = 0x01,
    ShortcutEventControllerVolumeUp = 0x02,
    ShortcutEventSleepController = 0x03,
    ShortcutEventMicMuteOn = 0x04,
    ShortcutEventMicMuteOff = 0x05,
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
    RemapLb,
    RemapRb,
    RemapLfn,
    RemapRfn,
    RemapHome,
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
constexpr uint8_t kShortcutEventQueueDepth = 8;
constexpr uint8_t kDynamicShortcutEventBase = 0x20;
constexpr uint8_t kDynamicChordBindingMax = 16;
constexpr uint8_t kChordStarterHome = 1;
constexpr uint8_t kChordStarterLfn = 2;
constexpr uint8_t kChordStarterRfn = 3;
constexpr uint8_t kChordStarterMute = 4;

struct DynamicChordBinding {
    uint8_t event;
    uint8_t starter;
    RemapButton button;
    bool last_pressed;
};

struct DynamicChordProcessingResult {
    bool home_chord_consumed;
    bool mute_chord_pressed;
};

critical_section_t companion_report_cs;
uint8_t last_controller_report[63]{};
bool have_controller_report = false;
uint16_t settings_revision = 0;
uint8_t lightbar_red = 0xff;
uint8_t lightbar_green = 0xd7;
uint8_t lightbar_blue = 0x00;
uint8_t lightbar_brightness = 100;
bool lightbar_override_enabled = false;
DynamicChordBinding dynamic_chord_bindings[kDynamicChordBindingMax]{};
uint8_t dynamic_chord_binding_count = 0;
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
// The mute bit is stripped from every report before it reaches the host -- the bridge owns that
// button. So the companion input report cannot show it, and the tester would draw the mic key as
// never pressed. Latch the real state here and surface it out-of-band instead.
bool mute_button_pressed_now = false;
// Stick deadzone, as a percentage of full travel. 0 disables it entirely, which is the default:
// a deadzone hides drift, and hiding drift by default would mask the very fault the tester exists
// to find.
uint8_t stick_deadzone_left_percent = 0;
uint8_t stick_deadzone_right_percent = 0;
bool sleep_keybind_enabled = false;
bool speaker_volume_shortcut_enabled = false;
bool shortcut_binding_last_pressed[kShortcutBindingCount]{};
uint32_t shortcut_binding_last_step_us[kShortcutBindingCount]{};
bool home_chord_gate_active = false;
uint32_t home_chord_gate_until_us = 0;
uint32_t home_chord_replay_until_us = 0;
uint8_t shortcut_event_queue[kShortcutEventQueueDepth]{};
uint8_t shortcut_event_head = 0;
uint8_t shortcut_event_tail = 0;
uint8_t shortcut_event_count = 0;
bool mute_keyboard_pending = false;
bool mute_keyboard_pressed = false;
uint32_t mute_keyboard_release_at_us = 0;
bool mute_keyboard_chord_pending = false;
uint32_t mute_keyboard_chord_until_us = 0;
bool mute_led_flash_pending = false;
uint32_t mute_led_flash_until_us = 0;
bool classic_rumble_test_active = false;
uint32_t classic_rumble_test_until_us = 0;
uint8_t trigger_effect_intensity_percent = 100;
uint8_t adaptive_trigger_test_mode = kTriggerTestModeFeedback;
uint8_t adaptive_trigger_test_target = kTriggerTargetBoth;
bool adaptive_trigger_test_active = false;
uint32_t adaptive_trigger_test_until_us = 0;
struct PersistentTriggerEffect {
    bool active = false;
    uint8_t mode = kTriggerTestModeFeedback;
    uint8_t start_percent = 0;
    uint8_t wall_percent = 0;
    uint8_t force_percent = 0;
    // An app-composed effect is carried as bytes rather than as percentages, because the
    // percent form quantizes to zones and 3-bit force and cannot represent it. It lives HERE,
    // inside the persistent effect, rather than being sent around it: apply_persistent_trigger_effect
    // re-asserts on an interval, so a raw effect sent outside this struct would be silently
    // overwritten by the next re-apply.
    bool raw = false;
    uint8_t raw_bytes[kTriggerEffectSize]{};
};
PersistentTriggerEffect persistent_trigger_effect_left;
PersistentTriggerEffect persistent_trigger_effect_right;
uint32_t persistent_trigger_effect_last_apply_us = 0;
uint8_t cached_game_trigger_right[kTriggerEffectSize]{};
uint8_t cached_game_trigger_left[kTriggerEffectSize]{};
bool cached_game_trigger_right_valid = false;
bool cached_game_trigger_left_valid = false;
uint8_t cached_game_trigger_motor_power = 0;
bool cached_game_trigger_motor_power_valid = false;
bool trigger_power_reset_pending = false;
uint32_t last_game_trigger_update_us = 0;
uint8_t companion_mic_volume_percent = 100;
bool companion_mic_muted = false;
bool companion_mic_enabled = false;
uint8_t button_remap[RemapButtonCount]{};

struct LastAck {
    uint8_t command_id = 0;
    uint8_t sequence = 0;
    uint8_t result = AckOk;
    uint8_t detail = 0;
};

LastAck last_ack;

void clear_cached_game_trigger_effects();
void reset_adaptive_trigger_test();
bool persistent_trigger_effect_any_active();
void stop_classic_rumble_test();

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

uint16_t status_age_to_u16(uint32_t value) {
    if (value == 0xffffffffu) {
        return 0xffffu;
    }
    return value > 0xfffeu ? 0xfffeu : static_cast<uint16_t>(value);
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
    return buffer[4] == kProtocolMajor
        && buffer[5] >= kProtocolMinSupportedMinor
        && buffer[5] <= kProtocolMinor;
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

void clear_shortcut_events() {
    critical_section_enter_blocking(&companion_report_cs);
    shortcut_event_head = 0;
    shortcut_event_tail = 0;
    shortcut_event_count = 0;
    critical_section_exit(&companion_report_cs);
}

void set_player_led_enabled(bool enabled) {
    bt_set_player_led_enabled(enabled);
}

void clear_dynamic_chord_bindings() {
    dynamic_chord_binding_count = 0;
    memset(dynamic_chord_bindings, 0, sizeof(dynamic_chord_bindings));
}

uint8_t take_shortcut_event() {
    uint8_t event = 0;
    critical_section_enter_blocking(&companion_report_cs);
    if (shortcut_event_count > 0) {
        event = shortcut_event_queue[shortcut_event_head];
        shortcut_event_head = static_cast<uint8_t>((shortcut_event_head + 1) % kShortcutEventQueueDepth);
        shortcut_event_count--;
    }
    critical_section_exit(&companion_report_cs);
    return event;
}

void queue_shortcut_event(uint8_t event) {
    critical_section_enter_blocking(&companion_report_cs);
    if (shortcut_event_count == kShortcutEventQueueDepth) {
        shortcut_event_head = static_cast<uint8_t>((shortcut_event_head + 1) % kShortcutEventQueueDepth);
        shortcut_event_count--;
    }
    shortcut_event_queue[shortcut_event_tail] = event;
    shortcut_event_tail = static_cast<uint8_t>((shortcut_event_tail + 1) % kShortcutEventQueueDepth);
    shortcut_event_count++;
    critical_section_exit(&companion_report_cs);
}

void restore_defaults() {
    volume[0] = DEFAULT_COMPANION_SPEAKER_GAIN;
    volume[1] = 1.0f;
    bt_set_classic_rumble_gain(100);
    stop_classic_rumble_test();
    audio_set_haptics_buffer_length(64);
    trigger_effect_intensity_percent = 100;
    adaptive_trigger_test_mode = kTriggerTestModeFeedback;
    adaptive_trigger_test_target = kTriggerTargetBoth;
    adaptive_trigger_test_active = false;
    persistent_trigger_effect_left = {};
    persistent_trigger_effect_right = {};
    persistent_trigger_effect_last_apply_us = 0;
    clear_cached_game_trigger_effects();
    bt_reset_adaptive_triggers();
    mute_button_mode = MuteButtonNormal;
    mute_keyboard_usage = kDefaultMuteKeyboardUsage;
    mute_keyboard_modifiers = 0;
    mute_button_last_pressed = false;
    stick_deadzone_left_percent = 0;
    stick_deadzone_right_percent = 0;
    sleep_keybind_enabled = false;
    speaker_volume_shortcut_enabled = false;
    std::fill(shortcut_binding_last_pressed, shortcut_binding_last_pressed + kShortcutBindingCount, false);
    std::fill(shortcut_binding_last_step_us, shortcut_binding_last_step_us + kShortcutBindingCount, 0);
    home_chord_gate_active = false;
    home_chord_gate_until_us = 0;
    home_chord_replay_until_us = 0;
    clear_dynamic_chord_bindings();
    clear_shortcut_events();
    mute_keyboard_pending = false;
    mute_keyboard_pressed = false;
    mute_keyboard_chord_pending = false;
    mute_led_flash_pending = false;
    audio_set_quiet_mode(false);
    audio_set_duplex_requested(true);
    audio_set_reactive_haptics_config(
        false,
        AudioReactiveHapticsMix,
        100,
        AudioReactiveHapticsBassBalanced,
        AudioReactiveHapticsResponseBalanced,
        AudioReactiveHapticsAttackBalanced,
        AudioReactiveHapticsReleaseBalanced,
        false
    );
    companion_mic_volume_percent = 100;
    companion_mic_muted = false;
    companion_mic_enabled = true;
    audio_set_mic_mute_led_passthrough(false);
    audio_set_mic_output_state(companion_mic_volume_percent, companion_mic_muted);
    bt_set_speaker_output_gain(kDefaultSpeakerOutputGain);
    reset_button_remap();
    bt_set_mute_led(false);
    lightbar_override_enabled = false;
    set_lightbar_color(0x00, 0x00, 0xff, 100);
    set_led_enabled(true);
    set_player_led_enabled(true);
    set_idle_disconnect_enabled(true);
    bt_set_idle_disconnect_timeout_minutes(15);
    usb_set_suspend_disconnect_enabled(true);
    usb_set_hid_polling_rate_mode(2);
    if (host_persona_active() != HostPersonaModeDualSense) {
        host_input_prepare_persona_switch();
        host_persona_set_active(HostPersonaModeDualSense);
        usb_request_reconnect();
    }
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

uint8_t supported_host_persona_mask() {
    uint8_t mask = 0;
    if (host_persona_is_supported(HostPersonaModeDualSense)) {
        mask |= 1 << HostPersonaModeDualSense;
    }
    if (host_persona_is_supported(HostPersonaModeXusb360)) {
        mask |= 1 << HostPersonaModeXusb360;
    }
    if (host_persona_is_supported(HostPersonaModeDs4)) {
        mask |= 1 << HostPersonaModeDs4;
    }
    return mask;
}

bool valid_mute_button_action(uint16_t mode, uint8_t usage) {
    if (mode > MuteButtonChord) {
        return false;
    }
    if (mode == MuteButtonKeyboard && (usage == 0 || usage > 0x73)) {
        return false;
    }
    return true;
}

bool mic_mute_led_passthrough_enabled() {
    return mute_button_mode == MuteButtonNormal && companion_mic_enabled;
}

bool desired_mute_led_enabled() {
    return (mic_mute_led_passthrough_enabled() && companion_mic_muted) || audio_quiet_mode_enabled();
}

void refresh_mute_led_policy() {
    audio_set_mic_mute_led_passthrough(mic_mute_led_passthrough_enabled());
    bt_set_mute_led(desired_mute_led_enabled());
}

void set_companion_mic_muted(bool muted) {
    companion_mic_muted = muted;
    audio_set_mic_output_state(companion_mic_volume_percent, companion_mic_muted);
    refresh_mute_led_policy();
}

void toggle_companion_mic_mute() {
    if (!companion_mic_enabled) {
        refresh_mute_led_policy();
        return;
    }
    set_companion_mic_muted(!companion_mic_muted);
    queue_shortcut_event(companion_mic_muted ? ShortcutEventMicMuteOn : ShortcutEventMicMuteOff);
    settings_revision++;
}

void set_mute_button_action(uint8_t mode, uint8_t usage, uint8_t modifiers) {
    mute_button_mode = mode;
    mute_keyboard_usage = usage == 0 ? kDefaultMuteKeyboardUsage : usage;
    mute_keyboard_modifiers = modifiers;
    mute_button_last_pressed = false;
    mute_keyboard_pending = false;
    mute_keyboard_pressed = false;
    mute_keyboard_chord_pending = false;
    mute_led_flash_pending = false;

    if (mute_button_mode != MuteButtonQuiet) {
        audio_set_quiet_mode(false);
    }
    refresh_mute_led_policy();
}

bool mute_keyboard_hold_enabled() {
    return (mute_keyboard_modifiers & kMuteKeyboardHoldFlag) != 0;
}

bool mute_keyboard_chord_starter_enabled() {
    return mute_button_mode == MuteButtonKeyboard
        && (mute_keyboard_modifiers & kMuteKeyboardChordStarterFlag) != 0;
}

void begin_mute_keyboard_chord_window(uint32_t now) {
    mute_keyboard_chord_pending = true;
    mute_keyboard_chord_until_us = now + kMuteKeyboardChordWindowUs;
}

void cancel_mute_keyboard_chord_window() {
    mute_keyboard_chord_pending = false;
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
    refresh_mute_led_policy();
}

void commit_mute_keyboard_chord_window(bool hold) {
    if (!mute_keyboard_chord_pending) {
        return;
    }
    mute_keyboard_chord_pending = false;
    queue_mute_keyboard_press(hold);
}

void mute_keyboard_chord_window_loop() {
    if (
        mute_keyboard_chord_pending
        && static_cast<int32_t>(time_us_32() - mute_keyboard_chord_until_us) >= 0
    ) {
        commit_mute_keyboard_chord_window(mute_button_last_pressed && mute_keyboard_hold_enabled());
    }
}

void toggle_quiet_mode() {
    const bool enabled = !audio_quiet_mode_enabled();
    audio_set_quiet_mode(enabled);
    refresh_mute_led_policy();
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
    trigger_power_reset_pending = false;
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

    // Only an effect that actually DOES something counts as "a game is driving the triggers".
    //
    // The guard exists so a trigger test cannot fight a game mid-play. But hosts routinely
    // send output reports carrying the trigger validity bits with the effect set to OFF --
    // Windows does it while setting up audio -- and treating that as game activity made
    // schedule_adaptive_trigger_test() refuse for kGameTriggerUpdateRecentUs afterwards. The
    // symptom was that the built-in trigger tests would not engage while audio played, even
    // though nothing was competing for the triggers at all.
    const bool right_effect_active =
        (trigger_flags & kTriggerRightEffectFlag)
        && len > kTriggerEffectRightOffset
        && payload[kTriggerEffectRightOffset] != kTriggerEffectModeOffExtended
        && payload[kTriggerEffectRightOffset] != kTriggerEffectModeOffSimple;
    const bool left_effect_active =
        (trigger_flags & kTriggerLeftEffectFlag)
        && len > kTriggerEffectLeftOffset
        && payload[kTriggerEffectLeftOffset] != kTriggerEffectModeOffExtended
        && payload[kTriggerEffectLeftOffset] != kTriggerEffectModeOffSimple;
    if (right_effect_active || left_effect_active) {
        last_game_trigger_update_us = time_us_32();
    }

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

    const bool has_motor_power = (
        len > 1
        && len > kTriggerEffectPowerOffset
        && (payload[1] & kTriggerMotorPowerFlag) != 0
    );
    cached_game_trigger_motor_power = has_motor_power ? payload[kTriggerEffectPowerOffset] : 0;
    cached_game_trigger_motor_power_valid = has_motor_power;
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

    // Re-send an explicit zero reduction only when returning from a capped
    // intensity. If the game never supplied motor power, preserve that absence
    // for normal 100% forwarding so bridge output stays closer to direct USB.
    if (!motor_power_valid && trigger_power_reset_pending) {
        motor_power = 0;
        motor_power_valid = true;
    }
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

bool valid_trigger_percent(uint8_t percent) {
    return percent <= 100;
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

bool valid_chord_starter(uint8_t starter) {
    return starter >= kChordStarterHome && starter <= kChordStarterMute;
}

bool valid_chord_button(uint8_t button) {
    return button < RemapButtonCount
        && button != RemapLfn
        && button != RemapRfn
        && button != RemapHome;
}

bool reserved_edge_chord_combo(uint8_t starter, uint8_t button) {
    if (starter != kChordStarterLfn && starter != kChordStarterRfn) {
        return false;
    }
    return button == RemapTriangle
        || button == RemapCircle
        || button == RemapCross
        || button == RemapSquare;
}

bool valid_chord_bindings_payload(uint8_t const *payload, uint16_t len, uint16_t count) {
    if (count > kDynamicChordBindingMax) {
        return false;
    }
    if (count > 0 && payload == nullptr) {
        return false;
    }
    if (len < count * 3) {
        return false;
    }
    for (uint8_t i = 0; i < count; i++) {
        const uint8_t event = payload[i * 3];
        const uint8_t starter = payload[i * 3 + 1];
        const uint8_t button = payload[i * 3 + 2];
        if (
            event < kDynamicShortcutEventBase
            || event >= kDynamicShortcutEventBase + kDynamicChordBindingMax
            || !valid_chord_starter(starter)
            || !valid_chord_button(button)
            || reserved_edge_chord_combo(starter, button)
        ) {
            return false;
        }
        for (uint8_t previous = 0; previous < i; previous++) {
            if (payload[previous * 3 + 1] == starter && payload[previous * 3 + 2] == button) {
                return false;
            }
        }
    }
    return true;
}

void set_dynamic_chord_bindings(uint8_t const *payload, uint16_t count) {
    clear_dynamic_chord_bindings();
    dynamic_chord_binding_count = static_cast<uint8_t>(count);
    for (uint8_t i = 0; i < dynamic_chord_binding_count; i++) {
        dynamic_chord_bindings[i] = {
            payload[i * 3],
            payload[i * 3 + 1],
            static_cast<RemapButton>(payload[i * 3 + 2]),
            false
        };
    }
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

bool schedule_custom_adaptive_trigger_test(
    uint8_t mode,
    uint8_t target,
    uint8_t start_percent,
    uint8_t wall_percent,
    uint8_t force_percent
) {
    if (
        !bt_is_controller_connected()
        || game_trigger_update_recent()
        || adaptive_trigger_test_active
    ) {
        return false;
    }

    adaptive_trigger_test_mode = mode;
    adaptive_trigger_test_target = target;
    bt_set_custom_adaptive_trigger_effect(mode, start_percent, wall_percent, force_percent, target);
    adaptive_trigger_test_active = force_percent > 0;
    adaptive_trigger_test_until_us = time_us_32() + kAdaptiveTriggerTestDurationUs;
    return true;
}

void clear_persistent_trigger_effect() {
    persistent_trigger_effect_left = {};
    persistent_trigger_effect_right = {};
    persistent_trigger_effect_last_apply_us = 0;
}

bool persistent_trigger_effect_any_active() {
    return persistent_trigger_effect_left.active || persistent_trigger_effect_right.active;
}

bool strip_persistent_trigger_effect_fields(uint8_t *payload, uint16_t len, uint8_t trigger_flags) {
    if (payload == nullptr || len == 0 || !persistent_trigger_effect_any_active()) {
        return false;
    }

    bool changed = false;
    if (persistent_trigger_effect_right.active && (trigger_flags & kTriggerRightEffectFlag) != 0) {
        payload[0] &= static_cast<uint8_t>(~kTriggerRightEffectFlag);
        changed = true;
    }
    if (persistent_trigger_effect_left.active && (trigger_flags & kTriggerLeftEffectFlag) != 0) {
        payload[0] &= static_cast<uint8_t>(~kTriggerLeftEffectFlag);
        changed = true;
    }
    if (len > 1 && (payload[1] & kTriggerMotorPowerFlag) != 0) {
        payload[1] &= static_cast<uint8_t>(~kTriggerMotorPowerFlag);
        changed = true;
    }
    return changed;
}

void set_persistent_trigger_effect_state(
    PersistentTriggerEffect &effect,
    uint8_t mode,
    uint8_t start_percent,
    uint8_t wall_percent,
    uint8_t force_percent
) {
    effect.mode = mode;
    effect.start_percent = start_percent;
    effect.wall_percent = wall_percent;
    effect.force_percent = force_percent;
    effect.active = force_percent > 0;
    // A percent effect REPLACES an app-composed one on this trigger. Without this the stale raw
    // bytes keep winning in persistent_trigger_effect_bytes and the Lab's slider appears dead.
    effect.raw = false;
}

void set_persistent_raw_trigger_effect_state(
    PersistentTriggerEffect &effect,
    uint8_t const *bytes,
    bool active
) {
    effect.raw = true;
    effect.active = active;
    memcpy(effect.raw_bytes, bytes, kTriggerEffectSize);
}

void persistent_trigger_effect_bytes(PersistentTriggerEffect const &effect, uint8_t *out) {
    if (effect.raw) {
        memcpy(out, effect.raw_bytes, kTriggerEffectSize);
        return;
    }
    bt_encode_custom_trigger_effect(
        out,
        effect.mode,
        effect.start_percent,
        effect.wall_percent,
        effect.force_percent
    );
}

void apply_persistent_trigger_effect(bool force = false) {
    if (!persistent_trigger_effect_any_active() || !bt_is_controller_connected()) {
        return;
    }

    const uint32_t now = time_us_32();
    if (
        !force
        && persistent_trigger_effect_last_apply_us != 0
        && static_cast<uint32_t>(now - persistent_trigger_effect_last_apply_us) < kPersistentTriggerReapplyIntervalUs
    ) {
        return;
    }

    // Reduce both triggers to bytes and send down one path. A raw effect on one trigger and a
    // percent effect on the other is a legitimate state, and branching on which sender to call
    // is how that case gets dropped. The percent branch encodes to exactly the bytes
    // bt_set_custom_adaptive_trigger_effects would have sent, so this is not a behaviour change
    // for effects that were never raw.
    uint8_t right_bytes[kTriggerEffectSize]{};
    uint8_t left_bytes[kTriggerEffectSize]{};
    persistent_trigger_effect_bytes(persistent_trigger_effect_right, right_bytes);
    persistent_trigger_effect_bytes(persistent_trigger_effect_left, left_bytes);
    bt_set_raw_adaptive_trigger_effects(
        right_bytes,
        persistent_trigger_effect_right.active,
        left_bytes,
        persistent_trigger_effect_left.active
    );
    persistent_trigger_effect_last_apply_us = now;
}

bool set_persistent_trigger_effect(
    uint8_t mode,
    uint8_t target,
    uint8_t start_percent,
    uint8_t wall_percent,
    uint8_t force_percent
) {
    if (!bt_is_controller_connected()) {
        return false;
    }

    if (target == kTriggerTargetLeft || target == kTriggerTargetBoth) {
        set_persistent_trigger_effect_state(
            persistent_trigger_effect_left,
            mode,
            start_percent,
            wall_percent,
            force_percent
        );
    }
    if (target == kTriggerTargetRight || target == kTriggerTargetBoth) {
        set_persistent_trigger_effect_state(
            persistent_trigger_effect_right,
            mode,
            start_percent,
            wall_percent,
            force_percent
        );
    }
    persistent_trigger_effect_last_apply_us = 0;

    if (persistent_trigger_effect_any_active()) {
        adaptive_trigger_test_active = false;
        apply_persistent_trigger_effect(true);
    } else {
        bt_reset_adaptive_triggers();
    }
    return true;
}

// Same lifecycle as set_persistent_trigger_effect, with app-composed bytes instead of the
// percent form. "Active" is decided by the app, not inferred from a force field, because the
// force byte is at a different offset in every effect family -- guessing it here is how the
// firmware would silently disagree with what the app believes it sent.
bool set_persistent_raw_trigger_effect(
    uint8_t target,
    uint8_t const *right_bytes,
    bool right_active,
    uint8_t const *left_bytes,
    bool left_active
) {
    if (!bt_is_controller_connected()) {
        return false;
    }

    if (target == kTriggerTargetLeft || target == kTriggerTargetBoth) {
        set_persistent_raw_trigger_effect_state(persistent_trigger_effect_left, left_bytes, left_active);
    }
    if (target == kTriggerTargetRight || target == kTriggerTargetBoth) {
        set_persistent_raw_trigger_effect_state(persistent_trigger_effect_right, right_bytes, right_active);
    }
    persistent_trigger_effect_last_apply_us = 0;

    if (persistent_trigger_effect_any_active()) {
        adaptive_trigger_test_active = false;
        apply_persistent_trigger_effect(true);
    } else {
        bt_reset_adaptive_triggers();
    }
    return true;
}

void submit_classic_rumble_test_output(uint8_t right, uint8_t left) {
    if (!bt_is_controller_connected()) {
        return;
    }

    uint8_t payload[ds5::output::kCommonPayloadSize]{};
    controller_output_policy_render_classic_rumble_payload(payload, sizeof(payload), right, left);
    controller_output_submit_usb_payload(payload, sizeof(payload));
}

bool schedule_classic_rumble_test() {
    if (
        !bt_is_controller_connected()
        || classic_rumble_test_active
    ) {
        return false;
    }

    submit_classic_rumble_test_output(kClassicRumbleTestAmplitude, kClassicRumbleTestAmplitude);
    classic_rumble_test_active = true;
    classic_rumble_test_until_us = time_us_32() + kClassicRumbleTestDurationUs;
    return true;
}

void stop_classic_rumble_test() {
    classic_rumble_test_active = false;
    classic_rumble_test_until_us = 0;
    submit_classic_rumble_test_output(0, 0);
}

void classic_rumble_test_loop() {
    if (!classic_rumble_test_active) {
        return;
    }
    if (!bt_is_controller_connected() || static_cast<int32_t>(time_us_32() - classic_rumble_test_until_us) >= 0) {
        stop_classic_rumble_test();
    }
}

void reset_adaptive_trigger_test() {
    adaptive_trigger_test_active = false;
    clear_persistent_trigger_effect();
    bt_reset_adaptive_triggers();
}

void mute_keyboard_loop() {
    const uint32_t now = time_us_32();

    if (mute_led_flash_pending && static_cast<int32_t>(now - mute_led_flash_until_us) >= 0) {
        mute_led_flash_pending = false;
        refresh_mute_led_policy();
    }

    const uint8_t keyboard_hid_instance = host_persona_keyboard_hid_instance();
    if (!tud_hid_n_ready(keyboard_hid_instance)) {
        return;
    }

    if (mute_keyboard_pending) {
        uint8_t keyboard_report[8]{};
        keyboard_report[0] = mute_keyboard_modifiers & kMuteKeyboardModifierMask;
        keyboard_report[2] = mute_keyboard_usage;
        if (tud_hid_n_report(keyboard_hid_instance, 0, keyboard_report, sizeof(keyboard_report))) {
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
        if (tud_hid_n_report(keyboard_hid_instance, 0, keyboard_report, sizeof(keyboard_report))) {
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
    write_u16(buffer + 12, static_cast<uint16_t>(std::clamp(volume[1], 0.0f, kMaxHapticsGain) * 100.0f));
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
    buffer[47] = static_cast<uint8_t>(host_persona_active());
    buffer[48] = supported_host_persona_mask();
    buffer[50] = companion_mic_muted ? 1 : 0;
    // Command-link liveness. Commands reach the bridge ONLY over the bulk OUT endpoint, while
    // status reads are control transfers -- so a dead OUT endpoint looks exactly like a
    // healthy bridge that ignores every button. Zero received while the app is sending is the
    // signature. Saturating u16 because only "zero vs climbing" matters and the status report
    // has six spare bytes, not eight.
    {
        uint32_t rx_reports = 0;
        uint32_t arm_failures = 0;
        host_bridge_get_link_counters(&rx_reports, &arm_failures);
        write_u16(buffer + 51, static_cast<uint16_t>(rx_reports > 0xffffu ? 0xffffu : rx_reports));
        write_u16(buffer + 53, static_cast<uint16_t>(arm_failures > 0xffffu ? 0xffffu : arm_failures));
    }
    buffer[56] = bt_speaker_output_gain();
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

uint16_t build_device_identity(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    pico_unique_board_id_t board_id;
    pico_get_unique_board_id(&board_id);
    buffer[6] = PICO_UNIQUE_BOARD_ID_SIZE_BYTES;
    memcpy(buffer + 7, board_id.id, PICO_UNIQUE_BOARD_ID_SIZE_BYTES);
    // Connected controller identity (BT address) so the companion can bind
    // profiles to controllers. [15] = present flag, [16..21] = address.
    uint8_t controller_addr[6];
    if (bt_get_connected_controller_addr(controller_addr)) {
        buffer[15] = 1;
        memcpy(buffer + 16, controller_addr, 6);
    }
    // Watchdog telemetry from the PREVIOUS boot, so a hang is diagnosable without a UART.
    // [43] flags: bit0 = last reset was a watchdog timeout, bit1 = breadcrumb valid.
    // [44] main-loop phase that was running. [45..48] sequence. [49..52] ms since that boot.
    // [53..55] are live rather than retained: the worst phase seen since THIS boot.
    {
        WatchdogTelemetrySnapshot wdt{};
        watchdog_telemetry_snapshot(&wdt);
        buffer[43] = static_cast<uint8_t>(
            (wdt.prior_watchdog_timeout ? 0x01 : 0x00)
            | (wdt.prior_snapshot_valid ? 0x02 : 0x00)
            | (wdt.prior_watchdog_enable_timeout ? 0x04 : 0x00)
        );
        buffer[44] = wdt.prior_phase;
        write_u32(buffer + 45, wdt.prior_sequence);
        write_u32(buffer + 49, wdt.prior_phase_entered_at_ms);
        // [53] worst phase since boot, [54..55] its duration in ms (clamped). Surfaces a slow
        // phase even when it never trips the watchdog.
        uint8_t worst_phase = 0;
        uint32_t worst_us = 0;
        watchdog_telemetry_worst_phase(&worst_phase, &worst_us);
        const uint32_t worst_ms = worst_us / 1000u;
        buffer[53] = worst_phase;
        buffer[54] = static_cast<uint8_t>(worst_ms > 0xFFFFu ? 0xFFu : (worst_ms & 0xFFu));
        buffer[55] = static_cast<uint8_t>(worst_ms > 0xFFFFu ? 0xFFu : ((worst_ms >> 8) & 0xFFu));
        // [56..59] faulting data address, [60] phase the main loop was in before the fault
        // vector overwrote the phase byte. Both zero on non-fault records.
        write_u32(buffer + 56, wdt.prior_fault_address);
        buffer[60] = wdt.prior_phase_before_fault;
        // On non-fault records [56..59] used to carry flash-stall telemetry, removed in 1.6.67
        // along with the probe that measured it: link-key flash writes were ruled out as the
        // cause of the 172ms main-loop stall (worst 0ms over 829 ops), and the real cause was a
        // sleep_ms(150) re-init inside a BT callback. The bytes are now free.
        // [61..62]: high half of the faulting function's first argument. Only two payload
        // bytes remain, and the top 16 bits are what distinguish a garbage pointer
        // (0xf000....) from a valid SRAM one (0x2000....).
        buffer[61] = static_cast<uint8_t>((wdt.prior_fault_arg0 >> 16) & 0xFFu);
        buffer[62] = static_cast<uint8_t>((wdt.prior_fault_arg0 >> 24) & 0xFFu);
    }
    // Pairing breadcrumbs: [22] = event count, then {stage, status} pairs.
    // NB these are PAYLOAD offsets; in the raw feature report add 1 for the
    // report ID (count at byte 23, pairs from byte 24).
    // Stages: 1 inquiry-found, 2 inbound-during-window (stale key dropped),
    // 3 conn-complete, 4 link-key-req (1=stored/0=negative/2=stale dropped),
    // 5 ssp-confirm, 6 legacy-pin, 7 auth-complete, 8 encryption (0xEE =
    // disabled), 9 disconnect (reason), 10 l2cap-open (fires TWICE, once per
    // L2CAP channel), 11 link-key drop did not take (1=pre-connect drop missed
    // but re-drop took, 2=DB delete broken, 3=drop at link-key-req missed),
    // 12 connection-phase disagreement (high nibble = tracked phase, low nibble
    // = phase derived from the legacy booleans; 0 Listening, 1 Connecting,
    // 2 Securing, 3 HidOpening, 4 Ready, 5 Disconnecting). Any 12/xx means the
    // phase machine does NOT yet model reality and must not be depended on.
    buffer[22] = bt_copy_pairing_events(buffer + 23, 10);
    return COMPANION_PAYLOAD_SIZE;
}

uint16_t build_shortcut_event(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    buffer[0] = take_shortcut_event();
    return COMPANION_PAYLOAD_SIZE;
}

// The raw DualSense input report, unparsed. The app decodes it -- see controller_report.h for
// why the firmware deliberately does not. 55 bytes reaches the battery/status fields, which are
// the last ones of interest; the tail of the report is padding and BT CRC.
constexpr uint16_t kControllerInputHeaderSize = 8;
constexpr uint16_t kControllerInputMaxBytes = COMPANION_PAYLOAD_SIZE - kControllerInputHeaderSize;

uint16_t build_controller_input(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    // bit0 = controller connected, bit1 = mute button held. The mute bit never survives into
    // the report itself (see mute_button_pressed_now), so it rides here.
    buffer[6] = static_cast<uint8_t>(
        (bt_is_controller_connected() ? 0x01 : 0x00)
        | (mute_button_pressed_now ? 0x02 : 0x00)
    );
    const size_t copied = controller_input_report_snapshot(
        buffer + kControllerInputHeaderSize,
        kControllerInputMaxBytes
    );
    buffer[7] = static_cast<uint8_t>(copied);
    return COMPANION_PAYLOAD_SIZE;
}

/**
 * The controller's calibration status (0x83), verbatim.
 *
 * [6] = number of bytes that arrived, [7..] the payload. A length of zero means no reply has
 * been seen yet -- which the app must NOT read as success, because the whole point of this
 * report is to confirm the controller accepted a step.
 */
uint16_t build_calibration_status(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);
    const uint8_t copied = bt_stick_calibration_status(buffer + 7, COMPANION_PAYLOAD_SIZE - 7);
    buffer[6] = copied;
    // Refresh for the next read, since the reply arrives asynchronously.
    bt_request_stick_calibration_status();
    return COMPANION_PAYLOAD_SIZE;
}

#if DS5_AUDIO_DEBUG_ENABLED
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
    write_u32(fields + 52, 0);
    return COMPANION_PAYLOAD_SIZE;
}
#endif

uint16_t build_audio_status(uint8_t *buffer, uint16_t reqlen) {
    if (reqlen < COMPANION_PAYLOAD_SIZE) {
        return 0;
    }

    memset(buffer, 0, COMPANION_PAYLOAD_SIZE);
    write_magic_and_version(buffer);

    audio_status status{};
    audio_get_status(&status);
    // Mixed-report split rate. Lives here rather than in build_audio_stats because that
    // report only exists in diagnostics builds, and this ratio has to be readable on the
    // release firmware people actually run.
    bt_output_debug_stats output_stats{};
    bt_get_output_debug_stats(&output_stats);
    write_u32(buffer + 16, output_stats.mixed_0x31_split_count);
    write_u32(buffer + 20, output_stats.normal_0x31_rx_count);
    buffer[8] = (status.duplex_requested ? 0x10 : 0x00)
        | (status.duplex_active ? 0x20 : 0x00)
        | (status.controller_state_ready ? 0x40 : 0x00)
        | (status.mic_usb_streaming ? 0x80 : 0x00);
    buffer[9] = (status.headset_plugged ? 0x01 : 0x00)
        | (status.headset_audio_route ? 0x02 : 0x00);
    write_u16(buffer + 12, status_age_to_u16(0xffffffffu));
    write_u16(buffer + 14, status_age_to_u16(0xffffffffu));
    write_u32(buffer + 24, status.mic_packets_received);
    write_u32(buffer + 28, status.mic_packets_dropped);
    write_u32(buffer + 32, status.mic_decode_success);
    write_u32(buffer + 36, status.mic_decode_fail);
    write_u32(buffer + 40, status.mic_usb_write_success);
    write_u32(buffer + 44, status.mic_usb_write_short);
    write_u32(buffer + 48, status.mic_usb_conceal_count);
    write_u32(buffer + 52, status.mic_plc_count);
    write_u16(buffer + 56, status.mic_last_decoded_samples);
    write_u16(buffer + 58, status.mic_last_written_bytes);
    write_u16(buffer + 60, status.mic_peak_permille);
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
    const uint8_t protocol_minor = buffer[5];
    switch (command_id) {
        case CommandSetHapticsGain:
            if (value > kMaxFeedbackGainPercent) {
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

        case CommandSetSpeakerGain:
            if (value < 1 || value > 7) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            bt_set_speaker_output_gain(static_cast<uint8_t>(value));
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetMicVolume:
            if (value > 100) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            companion_mic_volume_percent = static_cast<uint8_t>(value);
            audio_set_mic_output_state(companion_mic_volume_percent, companion_mic_muted);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetMicMute:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_companion_mic_muted(value == 1);
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

        case CommandSetAudioInterleaveRetired:
            set_ack(command_id, sequence, AckInvalidValue);
            return;

        case CommandRequestControllerScan:
            bt_request_pairing();
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandForgetControllerPairings:
            // Can now genuinely fail: nothing is deleted unless the blacklist write verifies.
            // Reporting AckOk regardless would tell the user a controller was cleared when
            // it was not.
            if (!bt_forget_pairings()) {
                set_ack(command_id, sequence, AckPersistenceFailed);
                return;
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandForgetControllerPairing: {
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            uint8_t address[6];
            memcpy(address, buffer + 10, sizeof(address));
            bool has_address_material = false;
            for (uint8_t byte : address) {
                has_address_material = has_address_material || byte != 0;
            }
            if (!has_address_material) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_forget_pairing(address)) {
                set_ack(command_id, sequence, AckPersistenceFailed);
                return;
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;
        }

        case CommandSetWakeOnConnect:
            // Wake the host from sleep when a controller connects (USB remote wakeup).
            usb_set_wake_on_connect(value != 0);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetRawTriggerEffect:
            {
            // value low byte = target, high byte bit0/bit1 = right/left active.
            // buffer[10..20] = right effect bytes, buffer[21..31] = left effect bytes.
            const uint8_t target = static_cast<uint8_t>(value & 0xff);
            const uint8_t flags = static_cast<uint8_t>((value >> 8) & 0xff);
            if (!valid_trigger_target(target) || (flags & ~0x03u) != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            uint8_t const *right_bytes = buffer + 10;
            uint8_t const *left_bytes = buffer + 10 + kTriggerEffectSize;
            if (
                !set_persistent_raw_trigger_effect(
                    target,
                    right_bytes,
                    (flags & 0x01u) != 0,
                    left_bytes,
                    (flags & 0x02u) != 0
                )
            ) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandHoldInputForwarding:
            {
            // value = hold duration in milliseconds, 0 to release. Capped so a caller cannot
            // silence the controller indefinitely with one command; holders renew instead.
            constexpr uint16_t kMaxHoldMs = 5000;
            if (value > kMaxHoldMs) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            host_input_hold_forwarding(static_cast<uint32_t>(value) * 1000u);
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandSetStickDeadzone:
            {
            const uint8_t left = static_cast<uint8_t>(value & 0xff);
            const uint8_t right = static_cast<uint8_t>((value >> 8) & 0xff);
            // Capped well below 100: past about half travel the rescale leaves so little usable
            // range that the stick reads as broken rather than as filtered.
            constexpr uint8_t kMaxDeadzonePercent = 50;
            if (left > kMaxDeadzonePercent || right > kMaxDeadzonePercent) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            stick_deadzone_left_percent = left;
            stick_deadzone_right_percent = right;
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandStickCalibration:
            {
            const uint8_t op = static_cast<uint8_t>(value & 0xff);
            const uint8_t target = static_cast<uint8_t>((value >> 8) & 0xff);
            // Only the three documented ops and two targets. An undocumented op is not a
            // harmless no-op on a device that stores calibration data.
            if (op < 1 || op > 3 || target < 1 || target > 2) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            if (!bt_send_stick_calibration(op, target)) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            // Ask for the status straight away; the app reads it from report 0x0C.
            bt_request_stick_calibration_status();
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandSetNvsUnlocked:
            {
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            if (!bt_set_nvs_unlocked(value != 0)) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandSetClassicRumbleGain:
            if (value > kMaxFeedbackGainPercent) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            bt_set_classic_rumble_gain(value);
            if (value == 0) {
                stop_classic_rumble_test();
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandSetClassicRumbleV1:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            bt_set_classic_rumble_v1_enabled(value == 1);
            stop_classic_rumble_test();
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
            if (trigger_effect_intensity_percent < 100 && value >= 100) {
                trigger_power_reset_pending = true;
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
            if (trigger_effect_intensity_percent >= 100) {
                trigger_power_reset_pending = false;
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

        case CommandPreviewAdaptiveTriggerEffect:
            {
            const uint8_t mode = static_cast<uint8_t>(value & 0xff);
            const uint8_t target = static_cast<uint8_t>((value >> 8) & 0xff);
            const uint8_t start_percent = buffer[10];
            const uint8_t wall_percent = buffer[11];
            const uint8_t force_percent = buffer[12];
            if (
                !valid_trigger_test_mode(mode)
                || !valid_trigger_target(target)
                || !valid_trigger_percent(start_percent)
                || !valid_trigger_percent(wall_percent)
                || !valid_trigger_percent(force_percent)
            ) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!bt_is_controller_connected()) {
                set_ack(command_id, sequence, AckNotConnected);
                return;
            }
            if (!schedule_custom_adaptive_trigger_test(mode, target, start_percent, wall_percent, force_percent)) {
                set_ack(command_id, sequence, AckBusy);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            return;
            }

        case CommandApplyAdaptiveTriggerEffect:
            {
            const uint8_t mode = static_cast<uint8_t>(value & 0xff);
            const uint8_t target = static_cast<uint8_t>((value >> 8) & 0xff);
            const uint8_t start_percent = buffer[10];
            const uint8_t wall_percent = buffer[11];
            const uint8_t force_percent = buffer[12];
            if (
                !valid_trigger_test_mode(mode)
                || !valid_trigger_target(target)
                || !valid_trigger_percent(start_percent)
                || !valid_trigger_percent(wall_percent)
                || !valid_trigger_percent(force_percent)
            ) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            if (!set_persistent_trigger_effect(mode, target, start_percent, wall_percent, force_percent)) {
                set_ack(command_id, sequence, AckNotConnected);
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
            if (game_trigger_update_recent() && !persistent_trigger_effect_any_active()) {
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

        case CommandSetPlayerLedEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_player_led_enabled(value == 1);
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
            clear_shortcut_events();
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

        case CommandSetChordBindings:
            if (!valid_chord_bindings_payload(buffer + 10, bufsize - 10, value)) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_dynamic_chord_bindings(buffer + 10, value);
            clear_shortcut_events();
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

        case CommandSetHostPersona:
            if (!host_persona_is_supported(static_cast<HostPersonaMode>(value))) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            {
                const HostPersonaMode next_persona = static_cast<HostPersonaMode>(value);
                const bool changed = host_persona_active() != next_persona;
                if (changed) {
                    host_input_prepare_persona_switch();
                }
                if (!host_persona_set_active(next_persona)) {
                    set_ack(command_id, sequence, AckInvalidValue);
                    return;
                }
                settings_revision++;
                if (changed) {
                    usb_request_reconnect();
                }
                set_ack(command_id, sequence, AckOk);
                return;
            }

        case CommandSetAudioReactiveHaptics:
            {
            const bool enabled = value == 1;
            const uint8_t mode_control = buffer[10];
            const uint8_t mode = mode_control & kAudioReactiveHapticsModeMask;
            const bool suppress_classic_rumble = protocol_minor >= 9
                ? (mode_control & kAudioReactiveHapticsSuppressClassicRumbleFlag) != 0
                : enabled && mode == AudioReactiveHapticsReplace;
            if (
                value > 1
                || !audio_set_reactive_haptics_config(
                    enabled,
                    mode,
                    read_u16(buffer + 11),
                    buffer[13],
                    buffer[14],
                    protocol_minor >= 8 ? buffer[15] : AudioReactiveHapticsAttackBalanced,
                    protocol_minor >= 8 ? buffer[16] : AudioReactiveHapticsReleaseBalanced,
                    suppress_classic_rumble
                )
            ) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;
            }

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

        case CommandSetDuplexEnabled:
            if (value > 1) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            companion_mic_enabled = value == 1;
            audio_set_duplex_requested(companion_mic_enabled);
            if (!companion_mic_enabled) {
                set_companion_mic_muted(true);
            } else {
                refresh_mute_led_policy();
            }
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandRestoreDefaults:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            restore_defaults();
            usb_set_wake_on_connect(true);
            settings_revision++;
            set_ack(command_id, sequence, AckOk);
            return;

        case CommandEnterBootloader:
            if (value != 0) {
                set_ack(command_id, sequence, AckInvalidValue);
                return;
            }
            set_ack(command_id, sequence, AckOk);
            reset_usb_boot(0, 0);
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

bool time_us_reached(uint32_t now, uint32_t target) {
    return static_cast<int32_t>(now - target) >= 0;
}

bool process_shortcut_bindings(uint8_t *report) {
    const uint32_t now = time_us_32();
    bool consumed = false;
    for (size_t i = 0; i < kShortcutBindingCount; i++) {
        const ShortcutBinding &binding = kShortcutBindings[i];
        const bool pressed = shortcut_setting_enabled(binding.setting) && shortcut_combo_pressed(binding, report);
        if (pressed) {
            suppress_shortcut_input(binding, report);
            consumed = true;
            const bool should_emit = binding.trigger == ShortcutTriggerPressed
                ? !shortcut_binding_last_pressed[i]
                : (!shortcut_binding_last_pressed[i]
                    || static_cast<uint32_t>(now - shortcut_binding_last_step_us[i]) >= kShortcutRepeatUs);
            if (should_emit) {
                queue_shortcut_event(binding.event);
                shortcut_binding_last_step_us[i] = now;
            }
        } else {
            shortcut_binding_last_step_us[i] = 0;
        }
        shortcut_binding_last_pressed[i] = pressed;
    }
    return consumed;
}

bool home_chord_gate_enabled() {
    if (sleep_keybind_enabled || speaker_volume_shortcut_enabled) {
        return true;
    }
    for (uint8_t i = 0; i < dynamic_chord_binding_count; i++) {
        if (dynamic_chord_bindings[i].starter == kChordStarterHome) {
            return true;
        }
    }
    return false;
}

void clear_home_chord_gate() {
    home_chord_gate_active = false;
    home_chord_gate_until_us = 0;
    home_chord_replay_until_us = 0;
}

void apply_home_chord_gate(uint8_t *report, uint16_t len, bool physical_home_pressed, bool home_chord_consumed) {
    if (report == nullptr || len <= 9) {
        return;
    }

    if (home_chord_consumed) {
        clear_home_chord_gate();
        report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
        return;
    }

    if (!home_chord_gate_enabled()) {
        clear_home_chord_gate();
        return;
    }

    const uint32_t now = time_us_32();
    if (physical_home_pressed) {
        home_chord_replay_until_us = 0;
        if (!home_chord_gate_active) {
            home_chord_gate_active = true;
            home_chord_gate_until_us = now + kHomeChordSuppressUs;
        }
        if (!time_us_reached(now, home_chord_gate_until_us)) {
            report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
            return;
        }
        home_chord_gate_active = false;
        home_chord_gate_until_us = 0;
        return;
    }

    if (home_chord_gate_active) {
        home_chord_gate_active = false;
        home_chord_gate_until_us = 0;
        home_chord_replay_until_us = now + kHomeChordFallbackReplayUs;
    }

    if (home_chord_replay_until_us != 0 && !time_us_reached(now, home_chord_replay_until_us)) {
        report[9] |= kHomeButtonBit;
    } else {
        home_chord_replay_until_us = 0;
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

bool remap_button_pressed(uint8_t const *report, uint16_t len, RemapButton button) {
    if (report == nullptr || len <= 8) {
        return false;
    }
    const uint8_t dpad_direction = report[7] & kDpadMask;
    switch (button) {
        case RemapL2:
            return (report[8] & kL2ButtonBit) != 0 || report[4] > 0;
        case RemapL1:
            return (report[8] & kL1ButtonBit) != 0;
        case RemapCreate:
            return (report[8] & kCreateButtonBit) != 0;
        case RemapDpadUp:
        case RemapDpadLeft:
        case RemapDpadDown:
        case RemapDpadRight:
            return dpad_direction_has(dpad_direction, button);
        case RemapL3:
            return (report[8] & kL3ButtonBit) != 0;
        case RemapR2:
            return (report[8] & kR2ButtonBit) != 0 || report[5] > 0;
        case RemapR1:
            return (report[8] & kR1ButtonBit) != 0;
        case RemapOptions:
            return (report[8] & kOptionsButtonBit) != 0;
        case RemapTriangle:
            return (report[7] & kTriangleButtonBit) != 0;
        case RemapCircle:
            return (report[7] & kCircleButtonBit) != 0;
        case RemapCross:
            return (report[7] & kCrossButtonBit) != 0;
        case RemapSquare:
            return (report[7] & kSquareButtonBit) != 0;
        case RemapR3:
            return (report[8] & kR3ButtonBit) != 0;
        case RemapLb:
            return len > 9 && (report[9] & kLeftBackButtonBit) != 0;
        case RemapRb:
            return len > 9 && (report[9] & kRightBackButtonBit) != 0;
        case RemapLfn:
            return len > 9 && (report[9] & kLeftFunctionButtonBit) != 0;
        case RemapRfn:
            return len > 9 && (report[9] & kRightFunctionButtonBit) != 0;
        case RemapHome:
            return len > 9 && (report[9] & kHomeButtonBit) != 0;
        default:
            return false;
    }
}

void suppress_dpad_button(uint8_t *report, RemapButton button) {
    const uint8_t dpad_direction = report[7] & kDpadMask;
    bool up = dpad_direction_has(dpad_direction, RemapDpadUp);
    bool right = dpad_direction_has(dpad_direction, RemapDpadRight);
    bool down = dpad_direction_has(dpad_direction, RemapDpadDown);
    bool left = dpad_direction_has(dpad_direction, RemapDpadLeft);
    if (button == RemapDpadUp) up = false;
    if (button == RemapDpadRight) right = false;
    if (button == RemapDpadDown) down = false;
    if (button == RemapDpadLeft) left = false;
    report[7] = static_cast<uint8_t>(
        (report[7] & ~kDpadMask)
        | dpad_direction_from_buttons(up, right, down, left)
    );
}

void suppress_remap_button(uint8_t *report, uint16_t len, RemapButton button) {
    if (report == nullptr || len <= 8) {
        return;
    }
    switch (button) {
        case RemapL2:
            report[4] = 0;
            report[8] &= static_cast<uint8_t>(~kL2ButtonBit);
            break;
        case RemapL1:
            report[8] &= static_cast<uint8_t>(~kL1ButtonBit);
            break;
        case RemapCreate:
            report[8] &= static_cast<uint8_t>(~kCreateButtonBit);
            break;
        case RemapDpadUp:
        case RemapDpadLeft:
        case RemapDpadDown:
        case RemapDpadRight:
            suppress_dpad_button(report, button);
            break;
        case RemapL3:
            report[8] &= static_cast<uint8_t>(~kL3ButtonBit);
            break;
        case RemapR2:
            report[5] = 0;
            report[8] &= static_cast<uint8_t>(~kR2ButtonBit);
            break;
        case RemapR1:
            report[8] &= static_cast<uint8_t>(~kR1ButtonBit);
            break;
        case RemapOptions:
            report[8] &= static_cast<uint8_t>(~kOptionsButtonBit);
            break;
        case RemapTriangle:
            report[7] &= static_cast<uint8_t>(~kTriangleButtonBit);
            break;
        case RemapCircle:
            report[7] &= static_cast<uint8_t>(~kCircleButtonBit);
            break;
        case RemapCross:
            report[7] &= static_cast<uint8_t>(~kCrossButtonBit);
            break;
        case RemapSquare:
            report[7] &= static_cast<uint8_t>(~kSquareButtonBit);
            break;
        case RemapR3:
            report[8] &= static_cast<uint8_t>(~kR3ButtonBit);
            break;
        case RemapLb:
            if (len > 9) report[9] &= static_cast<uint8_t>(~kLeftBackButtonBit);
            break;
        case RemapRb:
            if (len > 9) report[9] &= static_cast<uint8_t>(~kRightBackButtonBit);
            break;
        case RemapLfn:
            if (len > 9) report[9] &= static_cast<uint8_t>(~kLeftFunctionButtonBit);
            break;
        case RemapRfn:
            if (len > 9) report[9] &= static_cast<uint8_t>(~kRightFunctionButtonBit);
            break;
        case RemapHome:
            if (len > 9) report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
            break;
        default:
            break;
    }
}

bool chord_starter_pressed(uint8_t const *report, uint16_t len, uint8_t starter) {
    if (report == nullptr || len <= 9) {
        return false;
    }
    switch (starter) {
        case kChordStarterHome:
            return (report[9] & kHomeButtonBit) != 0;
        case kChordStarterLfn:
            return (report[9] & kLeftFunctionButtonBit) != 0;
        case kChordStarterRfn:
            return (report[9] & kRightFunctionButtonBit) != 0;
        case kChordStarterMute:
            return (
                mute_button_mode == MuteButtonChord
                || (mute_keyboard_chord_starter_enabled() && mute_keyboard_chord_pending)
            ) && (report[9] & kMuteButtonBit) != 0;
        default:
            return false;
    }
}

void suppress_chord_starter(uint8_t *report, uint16_t len, uint8_t starter) {
    if (report == nullptr || len <= 9) {
        return;
    }
    switch (starter) {
        case kChordStarterHome:
            report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
            break;
        case kChordStarterLfn:
            report[9] &= static_cast<uint8_t>(~kLeftFunctionButtonBit);
            break;
        case kChordStarterRfn:
            report[9] &= static_cast<uint8_t>(~kRightFunctionButtonBit);
            break;
        case kChordStarterMute:
            report[9] &= static_cast<uint8_t>(~kMuteButtonBit);
            break;
        default:
            break;
    }
}

DynamicChordProcessingResult process_dynamic_chord_bindings(uint8_t *report, uint16_t len) {
    DynamicChordProcessingResult result{};
    if (report == nullptr || len <= 9 || dynamic_chord_binding_count == 0) {
        return result;
    }

    uint8_t source_report[63]{};
    const uint16_t source_len = std::min<uint16_t>(len, sizeof(source_report));
    memcpy(source_report, report, source_len);

    for (uint8_t i = 0; i < dynamic_chord_binding_count; i++) {
        DynamicChordBinding &binding = dynamic_chord_bindings[i];
        const bool starter_pressed = chord_starter_pressed(source_report, source_len, binding.starter);
        const bool pressed = starter_pressed
            && remap_button_pressed(source_report, source_len, binding.button);

        if (pressed) {
            suppress_remap_button(report, len, binding.button);
            suppress_chord_starter(report, len, binding.starter);
            if (binding.starter == kChordStarterHome) {
                result.home_chord_consumed = true;
            }
            if (binding.starter == kChordStarterMute) {
                result.mute_chord_pressed = true;
            }
            if (!binding.last_pressed) {
                queue_shortcut_event(binding.event);
            }
        }
        binding.last_pressed = pressed;
    }
    return result;
}

void apply_button_remap(uint8_t *report, uint16_t len) {
    if (report == nullptr || len <= 8) {
        return;
    }

    bool source_pressed[RemapButtonCount]{};
    uint8_t source_analog[RemapButtonCount]{};
    const uint8_t dpad_direction = report[7] & kDpadMask;
    const bool has_edge_buttons = len > 9;

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
    if (has_edge_buttons) {
        source_pressed[RemapLb] = (report[9] & kLeftBackButtonBit) != 0;
        source_pressed[RemapRb] = (report[9] & kRightBackButtonBit) != 0;
        source_pressed[RemapLfn] = (report[9] & kLeftFunctionButtonBit) != 0;
        source_pressed[RemapRfn] = (report[9] & kRightFunctionButtonBit) != 0;
        source_pressed[RemapHome] = (report[9] & kHomeButtonBit) != 0;
    }

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

    if (has_edge_buttons) {
        report[9] &= static_cast<uint8_t>(~kDualSenseEdgeButtonMask);
        if (target_pressed[RemapLfn]) report[9] |= kLeftFunctionButtonBit;
        if (target_pressed[RemapRfn]) report[9] |= kRightFunctionButtonBit;
        if (target_pressed[RemapLb]) report[9] |= kLeftBackButtonBit;
        if (target_pressed[RemapRb]) report[9] |= kRightBackButtonBit;
    }
    if (len > 9) {
        report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
        if (target_pressed[RemapHome]) report[9] |= kHomeButtonBit;
    }
}

} // namespace

void companion_init() {
    critical_section_init(&companion_report_cs);
    restore_defaults();
    set_ack(0, 0, AckOk);
}

void companion_loop() {
    audio_test_haptics_loop();
    classic_rumble_test_loop();
    mute_keyboard_chord_window_loop();
    mute_keyboard_loop();
    adaptive_trigger_test_loop();
    apply_persistent_trigger_effect();
}

/**
 * Apply a deadzone to one stick, in place.
 *
 * RADIAL, not per-axis. A per-axis deadzone leaves a SQUARE dead region, so a stick pushed
 * diagonally escapes it sooner than one pushed straight, and slow diagonal movement snaps onto
 * the axes as one component crosses the threshold before the other. Measuring the magnitude
 * treats every direction alike.
 *
 * Beyond the threshold the remaining travel is rescaled back to full range, so a deadzone costs
 * precision near the centre but does not cost reach at the edge -- without it, a 20% deadzone
 * would leave the stick unable to report its last 20% of travel.
 */
static void apply_stick_deadzone(uint8_t *x_byte, uint8_t *y_byte, uint8_t deadzone_percent) {
    if (deadzone_percent == 0) {
        return;
    }

    constexpr float kFullTravel = 127.0f;
    const float deadzone = (static_cast<float>(deadzone_percent) / 100.0f) * kFullTravel;
    const float x = static_cast<float>(*x_byte) - 128.0f;
    const float y = static_cast<float>(*y_byte) - 128.0f;
    const float magnitude = sqrtf((x * x) + (y * y));

    if (magnitude <= deadzone) {
        *x_byte = 128;
        *y_byte = 128;
        return;
    }

    float scaled = ((magnitude - deadzone) / (kFullTravel - deadzone)) * kFullTravel;
    if (scaled > kFullTravel) {
        scaled = kFullTravel;
    }
    const float unit_x = x / magnitude;
    const float unit_y = y / magnitude;

    const int32_t out_x = static_cast<int32_t>(lroundf(unit_x * scaled)) + 128;
    const int32_t out_y = static_cast<int32_t>(lroundf(unit_y * scaled)) + 128;
    *x_byte = static_cast<uint8_t>(out_x < 0 ? 0 : (out_x > 255 ? 255 : out_x));
    *y_byte = static_cast<uint8_t>(out_y < 0 ? 0 : (out_y > 255 ? 255 : out_y));
}

void companion_process_controller_report(uint8_t *report, uint16_t len) {
    if (len <= 9) {
        return;
    }

    // Before everything else, so any later consumer sees corrected sticks rather than raw ones.
    apply_stick_deadzone(&report[0], &report[1], stick_deadzone_left_percent);
    apply_stick_deadzone(&report[2], &report[3], stick_deadzone_right_percent);

    const bool home_pressed = (report[9] & kHomeButtonBit) != 0;
    const uint8_t dpad_direction = report[7] & kDpadMask;
    const bool dpad_pressed = dpad_direction <= 0x07;
    const bool mute_pressed = (report[9] & kMuteButtonBit) != 0;
    mute_button_pressed_now = mute_pressed;
    const uint32_t now = time_us_32();
    if (mute_pressed && !mute_button_last_pressed && mute_keyboard_chord_starter_enabled()) {
        begin_mute_keyboard_chord_window(now);
    }
    const DynamicChordProcessingResult dynamic_chord_result = process_dynamic_chord_bindings(report, len);
    if (dynamic_chord_result.mute_chord_pressed) {
        cancel_mute_keyboard_chord_window();
    }
    const bool shortcut_home_chord_consumed = process_shortcut_bindings(report);
    const bool home_chord_consumed = dynamic_chord_result.home_chord_consumed || shortcut_home_chord_consumed;
    apply_home_chord_gate(report, len, home_pressed, home_chord_consumed);
    if (home_pressed && dpad_pressed) {
        report[9] &= static_cast<uint8_t>(~kHomeButtonBit);
    }

    report[9] &= static_cast<uint8_t>(~kMuteButtonBit);

    if (mute_pressed && !mute_button_last_pressed) {
        if (mute_button_mode == MuteButtonNormal) {
            toggle_companion_mic_mute();
        } else if (mute_button_mode == MuteButtonKeyboard) {
            if (!mute_keyboard_chord_starter_enabled()) {
                queue_mute_keyboard_press(mute_keyboard_hold_enabled());
            }
        } else if (mute_button_mode == MuteButtonQuiet) {
            toggle_quiet_mode();
        }
    } else if (!mute_pressed && mute_button_last_pressed && mute_button_mode == MuteButtonKeyboard) {
        if (mute_keyboard_chord_pending) {
            commit_mute_keyboard_chord_window(false);
        } else if (mute_keyboard_hold_enabled()) {
            queue_mute_keyboard_release();
        }
    }

    mute_button_last_pressed = mute_pressed;
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
    const uint8_t original_trigger_flags = len > 0 ? payload[0] & kTriggerEffectFlags : 0;
    const bool persistentOverrideChanged = strip_persistent_trigger_effect_fields(payload, len, original_trigger_flags);
    const uint8_t trigger_flags = len > 0 ? payload[0] & kTriggerEffectFlags : 0;
    if (trigger_flags == 0) {
        return persistentOverrideChanged;
    }

    if (
        (persistent_trigger_effect_left.active && persistent_trigger_effect_right.active)
        || trigger_effect_intensity_percent >= 100
    ) {
        return persistentOverrideChanged;
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
    if (report_type != HID_REPORT_TYPE_FEATURE) {
        return 0;
    }

    switch (report_id) {
        case COMPANION_REPORT_STATUS:
            return build_status(buffer, reqlen);
        case COMPANION_REPORT_ACK:
            return build_ack(buffer, reqlen);
        case COMPANION_REPORT_INPUT:
            return build_shortcut_event(buffer, reqlen);
        case COMPANION_REPORT_CONTROLLER_INPUT:
            return build_controller_input(buffer, reqlen);
        case COMPANION_REPORT_CALIBRATION_STATUS:
            return build_calibration_status(buffer, reqlen);
#if DS5_AUDIO_DEBUG_ENABLED
        case COMPANION_REPORT_AUDIO_DEBUG:
            return build_audio_debug(buffer, reqlen);
        case COMPANION_REPORT_AUDIO_STATS:
            return build_audio_stats(buffer, reqlen);
#endif
        case COMPANION_REPORT_AUDIO_STATUS:
            return build_audio_status(buffer, reqlen);
        case COMPANION_REPORT_DEVICE_IDENTITY:
            return build_device_identity(buffer, reqlen);
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
        return;
    }

    if (report_type != HID_REPORT_TYPE_FEATURE || report_id != COMPANION_REPORT_COMMAND) {
        set_ack(report_id, 0, AckUnknownCommand);
        return;
    }

    handle_command(buffer, bufsize);
}
