#ifndef DS5_BRIDGE_CONTROLLER_PACKET_COMPOSITOR_H
#define DS5_BRIDGE_CONTROLLER_PACKET_COMPOSITOR_H

#include <cstdint>

void controller_packet_init_bt_output_report(uint8_t *report, uint8_t &sequence_counter);
void controller_packet_init_bt_output_report(uint8_t *report, int &sequence_counter);
void controller_packet_copy_audio_snapshot(uint8_t *destination, bool headset_plugged);

#endif // DS5_BRIDGE_CONTROLLER_PACKET_COMPOSITOR_H
