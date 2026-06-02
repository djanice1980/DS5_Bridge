#ifndef DS5_BRIDGE_DUALSENSE_PERSONA_H
#define DS5_BRIDGE_DUALSENSE_PERSONA_H

#include "persona/host_persona.h"

bool dualsense_persona_encode_input(
    BridgeControllerState const &state,
    HostPersonaInputReport &report
);

#endif // DS5_BRIDGE_DUALSENSE_PERSONA_H
