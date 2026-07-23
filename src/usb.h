//
// Created by awalol on 2026/3/4.
// Modified for DS5 Bridge companion firmware and app integration.
//

#ifndef DS5_BRIDGE_USB_H
#define DS5_BRIDGE_USB_H

// Boot/no-companion default for the companion speaker volume scale (0-1).
// Must be 1.0: when no companion app ever connects (e.g. Windows hosts running
// the firmware standalone), this default is permanent -- the old 0.30 left the
// speaker at 30% volume with no way to raise it. Hosts and the controller
// already have their own volume controls; the firmware should not pre-attenuate.
#define DEFAULT_COMPANION_SPEAKER_GAIN 1.0f

extern uint8_t mute[2]; // 0: speaker/LED fallback, 1: mic/idle-disconnect fallback
extern float volume[2]; // 0: companion speaker gain, 1: haptics gain
extern uint8_t usb_host_volume_percent[3]; // Speaker, mic, raw line capture.
extern uint8_t usb_host_mute[3]; // Speaker, mic, raw line capture.
extern uint32_t usb_host_volume_set_count[3];
extern float usb_host_speaker_gain; // Host UAC speaker volume as linear gain.

void usb_device_stack_init_disconnected();
#ifdef DS5_PAIRING_DIAG
void usb_diag_force_connect();
#endif
uint8_t usb_hid_polling_rate_mode();
bool usb_set_hid_polling_rate_mode(uint8_t mode);
void usb_request_reconnect();
void usb_note_hid_output();
bool usb_host_hid_output_recent();
void usb_pm_poll();
void usb_set_suspend_disconnect_enabled(bool enabled);
bool usb_suspend_disconnect_enabled();
bool usb_host_suspended_active();
bool usb_speaker_streaming_active();
bool usb_mic_streaming_active();
bool usb_line_streaming_active();
void usb_handle_controller_transport_disconnect();
void usb_handle_controller_transport_ready();
void usb_wake_host_if_suspended();
void usb_set_wake_on_connect(bool enabled);

#endif //DS5_BRIDGE_USB_H
