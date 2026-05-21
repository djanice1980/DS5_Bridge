#ifndef DS5_BRIDGE_COMPANION_H
#define DS5_BRIDGE_COMPANION_H

#include <cstdint>
#include "tusb.h"

#define COMPANION_HID_INSTANCE 1
#define KEYBOARD_HID_INSTANCE 2
#define COMPANION_REPORT_STATUS 0x01
#define COMPANION_REPORT_COMMAND 0x02
#define COMPANION_REPORT_ACK 0x03
#define COMPANION_REPORT_INPUT 0x04
#define COMPANION_REPORT_AUDIO_DEBUG 0x05
#define COMPANION_REPORT_AUDIO_STATS 0x06
#define COMPANION_REPORT_HOST_AUDIO_STREAM 0x07
#define COMPANION_REPORT_HOST_AUDIO_STATUS 0x08
#define COMPANION_PAYLOAD_SIZE 63

void companion_init();
void companion_loop();
void companion_process_controller_report(uint8_t *report, uint16_t len);
void companion_update_controller_report(uint8_t const *report, uint16_t len);
void companion_note_host_output_report(uint8_t const *report, uint16_t len);
bool companion_apply_trigger_effect_intensity(uint8_t *payload, uint16_t len);
bool companion_lightbar_override_enabled();
uint16_t companion_get_report(uint8_t report_id, hid_report_type_t report_type, uint8_t *buffer, uint16_t reqlen);
void companion_set_report(uint8_t report_id, hid_report_type_t report_type, uint8_t const *buffer, uint16_t bufsize);

#endif // DS5_BRIDGE_COMPANION_H
