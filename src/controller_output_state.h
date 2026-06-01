#ifndef DS5_BRIDGE_CONTROLLER_OUTPUT_STATE_H
#define DS5_BRIDGE_CONTROLLER_OUTPUT_STATE_H

#include <cstdint>

void controller_output_state_reset_cached_triggers();
void controller_output_state_apply_host_payload(uint8_t const *data, uint8_t len);
void controller_output_state_set_adaptive_trigger(
    uint8_t const *right_trigger,
    bool right_valid,
    uint8_t const *left_trigger,
    bool left_valid,
    uint8_t motor_power,
    bool motor_power_valid
);
void controller_output_state_set_lightbar(uint8_t red, uint8_t green, uint8_t blue, uint8_t brightness_percent);
void controller_output_state_copy_audio_snapshot(uint8_t *destination, bool headset_plugged);
void controller_output_state_clear_zero_rumble(uint8_t *payload);
void controller_output_state_clear_triggers(uint8_t *payload);

#endif // DS5_BRIDGE_CONTROLLER_OUTPUT_STATE_H
