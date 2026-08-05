#ifndef DS5_BRIDGE_HOST_BRIDGE_H
#define DS5_BRIDGE_HOST_BRIDGE_H

#include <stdbool.h>
#include <stdint.h>

#define HOST_BRIDGE_INTERFACE_NUMBER 0x05
#define HOST_BRIDGE_EP_OUT 0x07

// Companion-only ("idle") enumeration: with no controller attached the bridge presents just
// this vendor interface -- no gamepad, no audio -- so the app can always reach it while the
// host never sees a phantom controller. The interface is renumbered to 0 because a
// configuration must number its interfaces from zero, and the MS OS 2.0 descriptor keys
// WinUSB binding to that number.
#define HOST_BRIDGE_IDLE_INTERFACE_NUMBER 0x00

// A distinct product id, deliberately: the same VID/PID presenting two different interface
// layouts is the descriptor-caching hazard that docs/windows-device-cleanup.md exists to
// clean up after. Idle is genuinely not a DualSense, so it does not claim the DualSense id.
#define HOST_BRIDGE_IDLE_PRODUCT_ID 0x0CE7

#ifdef __cplusplus
extern "C" {
#endif

uint16_t host_bridge_get_report(uint8_t report_id, uint8_t *buffer, uint16_t reqlen);
void host_bridge_set_report(uint8_t const *report, uint16_t len);

// Which shape the next enumeration presents. Set BEFORE re-attaching: the descriptors are
// fetched by the host during enumeration, so changing this while attached does nothing until
// the next detach/attach cycle.
void host_bridge_set_companion_only(bool enabled);
bool host_bridge_companion_only(void);

// Re-arms the bulk OUT endpoint if nothing is pending on it. Commands from the app arrive
// only over that endpoint, so a lost arm silently swallows every command while status reads
// (control transfers) keep working and the app still looks connected.
void host_bridge_service(void);

// rx_reports: reports received from the app since boot, over EITHER inbound path (audio over
// bulk OUT, commands over control SET_REPORT). arm_failures: times the bulk endpoint could not
// be armed. Zero received while the app is sending distinguishes "the command was refused"
// from "the command never arrived" -- indistinguishable from the app side, and the difference
// between a real refusal and a dropped one.
void host_bridge_get_link_counters(uint32_t *rx_reports, uint32_t *arm_failures);

#ifdef __cplusplus
}
#endif

#endif // DS5_BRIDGE_HOST_BRIDGE_H
