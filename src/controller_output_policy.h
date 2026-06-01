#ifndef DS5_BRIDGE_CONTROLLER_OUTPUT_POLICY_H
#define DS5_BRIDGE_CONTROLLER_OUTPUT_POLICY_H

#include <cstdint>

void controller_output_policy_set_classic_rumble_gain(uint16_t gain_percent);
uint16_t controller_output_policy_classic_rumble_gain();
uint8_t controller_output_policy_scale_classic_rumble_byte(uint8_t value);
bool controller_output_policy_apply_classic_rumble_gain_payload(uint8_t *payload, uint16_t len);
bool controller_output_policy_sanitize_host_speaker_amp_payload(uint8_t *payload, uint16_t len);
bool controller_output_policy_sanitize_host_speaker_amp_report(uint8_t *report, uint16_t len);
bool controller_output_policy_sanitize_host_mic_payload(uint8_t *payload, uint16_t len);
bool controller_output_policy_sanitize_host_mic_report(uint8_t *report, uint16_t len);
bool controller_output_policy_sanitize_host_lightbar_payload(
    uint8_t *payload,
    uint16_t len,
    bool lightbar_override
);
bool controller_output_policy_host_output_clears_leds(uint8_t const *payload, uint16_t len);

#endif // DS5_BRIDGE_CONTROLLER_OUTPUT_POLICY_H
