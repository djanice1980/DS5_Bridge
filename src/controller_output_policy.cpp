#include "controller_output_policy.h"

#include "dualsense_output.h"

using namespace ds5::output;

namespace {

uint16_t classic_rumble_gain_percent = 100;

} // namespace

void controller_output_policy_set_classic_rumble_gain(uint16_t gain_percent) {
    classic_rumble_gain_percent = gain_percent > 500 ? 500 : gain_percent;
}

uint16_t controller_output_policy_classic_rumble_gain() {
    return classic_rumble_gain_percent;
}

uint8_t controller_output_policy_scale_classic_rumble_byte(uint8_t value) {
    const uint32_t scaled = static_cast<uint32_t>(value) * classic_rumble_gain_percent;
    return static_cast<uint8_t>(scaled >= 25500 ? 255 : (scaled + 50) / 100);
}

bool controller_output_policy_apply_classic_rumble_gain_payload(uint8_t *payload, uint16_t len) {
    if (payload == nullptr || len <= kMotorLeftOffset) {
        return false;
    }

    const uint8_t flag0 = payload[kValidFlag0Offset];
    const uint8_t flag2 = len > kValidFlag2Offset ? payload[kValidFlag2Offset] : 0;
    const bool has_rumble = (flag0 & (
        kFlag0CompatibleVibration
        | kFlag0HapticsSelect
    )) != 0 || (flag2 & kFlag2CompatibleVibration2) != 0;
    if (!has_rumble) {
        return false;
    }

    const uint8_t right = payload[kMotorRightOffset];
    const uint8_t left = payload[kMotorLeftOffset];
    payload[kMotorRightOffset] = controller_output_policy_scale_classic_rumble_byte(right);
    payload[kMotorLeftOffset] = controller_output_policy_scale_classic_rumble_byte(left);
    return payload[kMotorRightOffset] != right || payload[kMotorLeftOffset] != left;
}

bool controller_output_policy_sanitize_host_speaker_amp_payload(uint8_t *payload, uint16_t len) {
    if (payload == nullptr || len < kCommonPayloadSize) {
        return false;
    }

    bool changed = false;

    const uint8_t original_flag0 = payload[kValidFlag0Offset];
    const uint8_t original_flag1 = payload[kValidFlag1Offset];
    const uint8_t next_flag0 = original_flag0 & static_cast<uint8_t>(~(
        kFlag0SpeakerVolumeEnable | kFlag0AudioControlEnable
    ));
    if (payload[kValidFlag0Offset] != next_flag0) {
        payload[kValidFlag0Offset] = next_flag0;
        changed = true;
    }

    const uint8_t next_flag1 = original_flag1 & static_cast<uint8_t>(~kFlag1AudioControl2Enable);
    if (payload[kValidFlag1Offset] != next_flag1) {
        payload[kValidFlag1Offset] = next_flag1;
        changed = true;
    }

    if (original_flag0 & (kFlag0SpeakerVolumeEnable | kFlag0AudioControlEnable)) {
        if (payload[kHeadphoneVolumeOffset] != 0) {
            payload[kHeadphoneVolumeOffset] = 0;
            changed = true;
        }
        if (payload[kSpeakerVolumeOffset] != 0) {
            payload[kSpeakerVolumeOffset] = 0;
            changed = true;
        }
    }
    if (original_flag0 & kFlag0AudioControlEnable) {
        if (payload[kAudioControlOffset] != 0) {
            payload[kAudioControlOffset] = 0;
            changed = true;
        }
    }
    if (original_flag1 & kFlag1AudioControl2Enable) {
        if (payload[kAudioControl2Offset] != 0) {
            payload[kAudioControl2Offset] = 0;
            changed = true;
        }
    }

    return changed;
}

bool controller_output_policy_sanitize_host_speaker_amp_report(uint8_t *report, uint16_t len) {
    uint8_t *payload = nullptr;
    uint16_t payload_len = 0;
    if (!bt_report_payload(report, len, payload, payload_len)) {
        return false;
    }
    if (report[0] != kBtOutputReportId || report[2] != kBtOutputTag) {
        return false;
    }

    return controller_output_policy_sanitize_host_speaker_amp_payload(payload, payload_len);
}

bool controller_output_policy_sanitize_host_mic_payload(uint8_t *payload, uint16_t len) {
    if (payload == nullptr || len < kCommonPayloadSize) {
        return false;
    }

    bool changed = false;
    const uint8_t original_flag0 = payload[kValidFlag0Offset];
    const uint8_t original_flag1 = payload[kValidFlag1Offset];
    const uint8_t next_flag0 = original_flag0 & static_cast<uint8_t>(~kFlag0MicVolumeEnable);
    uint8_t next_flag1 = original_flag1 & static_cast<uint8_t>(~kFlag1MicMuteLedControlEnable);
    const bool original_power_save_control = (original_flag1 & kFlag1PowerSaveControlEnable) != 0;
    const uint8_t next_power_save_control = original_power_save_control
        ? static_cast<uint8_t>(payload[kPowerSaveControlOffset] & ~kPowerSaveControlMicMute)
        : payload[kPowerSaveControlOffset];
    if (original_power_save_control && next_power_save_control == 0) {
        next_flag1 &= static_cast<uint8_t>(~kFlag1PowerSaveControlEnable);
    }

    if (payload[kValidFlag0Offset] != next_flag0) {
        payload[kValidFlag0Offset] = next_flag0;
        changed = true;
    }
    if (payload[kValidFlag1Offset] != next_flag1) {
        payload[kValidFlag1Offset] = next_flag1;
        changed = true;
    }
    if ((original_flag0 & kFlag0MicVolumeEnable) && payload[kMicVolumeOffset] != 0) {
        payload[kMicVolumeOffset] = 0;
        changed = true;
    }
    if ((original_flag1 & kFlag1MicMuteLedControlEnable) && payload[kMuteLedOffset] != 0) {
        payload[kMuteLedOffset] = 0;
        changed = true;
    }
    if (original_power_save_control && payload[kPowerSaveControlOffset] != next_power_save_control) {
        payload[kPowerSaveControlOffset] = next_power_save_control;
        changed = true;
    }

    return changed;
}

bool controller_output_policy_sanitize_host_mic_report(uint8_t *report, uint16_t len) {
    uint8_t *payload = nullptr;
    uint16_t payload_len = 0;
    if (!bt_report_payload(report, len, payload, payload_len)) {
        return false;
    }
    if (report[0] != kBtOutputReportId || report[2] != kBtOutputTag) {
        return false;
    }

    return controller_output_policy_sanitize_host_mic_payload(payload, payload_len);
}

bool controller_output_policy_sanitize_host_lightbar_payload(
    uint8_t *payload,
    uint16_t len,
    bool lightbar_override
) {
    bool changed = false;

    if (lightbar_override && len > kValidFlag1Offset) {
        const uint8_t sanitized = payload[kValidFlag1Offset] & static_cast<uint8_t>(~kHostLedControlMask);
        if (payload[kValidFlag1Offset] != sanitized) {
            payload[kValidFlag1Offset] = sanitized;
            changed = true;
        }
    }

    if (lightbar_override && len > kValidFlag2Offset) {
        const uint8_t sanitized = payload[kValidFlag2Offset] & static_cast<uint8_t>(~kHostLightbarSetupMask);
        if (payload[kValidFlag2Offset] != sanitized) {
            payload[kValidFlag2Offset] = sanitized;
            changed = true;
        }
    }

    return changed;
}

bool controller_output_policy_host_output_clears_leds(uint8_t const *payload, uint16_t len) {
    if (payload == nullptr || len <= kValidFlag1Offset) {
        return false;
    }

    const uint8_t led_flags = payload[kValidFlag1Offset] & kHostLedControlMask;
    if (led_flags == 0) {
        return false;
    }

    const bool releases_leds = (payload[kValidFlag1Offset] & kFlag1ReleaseLeds) != 0;
    const bool clears_player_indicator = (payload[kValidFlag1Offset] & kFlag1PlayerIndicatorControlEnable) != 0
        && len > kPlayerLedsOffset
        && payload[kPlayerLedsOffset] == 0;
    const bool clears_lightbar = (payload[kValidFlag1Offset] & kFlag1LightbarControlEnable) != 0
        && len > kLightbarBlueOffset
        && payload[kLightbarRedOffset] == 0
        && payload[kLightbarGreenOffset] == 0
        && payload[kLightbarBlueOffset] == 0;

    return releases_leds || clears_player_indicator || clears_lightbar;
}
