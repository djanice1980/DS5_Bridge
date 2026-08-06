#ifndef DS5_BRIDGE_HOST_INPUT_H
#define DS5_BRIDGE_HOST_INPUT_H

#include <stdint.h>

void host_input_prepare_persona_switch();
void host_input_note_usb_mounted();

// Stop forwarding controller input to the host for duration_us, reporting neutral instead.
// Pass 0 to release immediately.
//
// Deliberately a LEASE rather than a toggle: the caller renews it while it needs the hold, and
// it expires on its own. A latched flag would leave the controller dead to the host if the app
// crashed or was killed while holding it, with no way back except a power cycle.
void host_input_hold_forwarding(uint32_t duration_us);

#endif // DS5_BRIDGE_HOST_INPUT_H
