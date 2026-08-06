#ifndef DS5_BRIDGE_CONTROLLER_REPORT_H
#define DS5_BRIDGE_CONTROLLER_REPORT_H

#include <stddef.h>
#include <stdint.h>

void reset_controller_input_report_cache();

// Copy the cached DualSense input report the bridge last forwarded to the host. The companion
// app decodes it -- the firmware deliberately does NOT parse it into fields, because every field
// the app wants would otherwise need a firmware change and a reflash to surface.
//
// Returns the number of bytes copied. Taken under report_cs, so the caller gets one coherent
// report rather than a mix of two.
size_t controller_input_report_snapshot(uint8_t *out, size_t capacity);

#endif // DS5_BRIDGE_CONTROLLER_REPORT_H
