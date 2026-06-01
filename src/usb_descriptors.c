/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2023 HiFiPhile
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

#include "bsp/board_api.h"
#include "tusb.h"
#include "debug_config.h"
#include "host_bridge.h"
#include "host_pcm_iso.h"

extern uint8_t usb_hid_polling_interval_ms_value;
#ifdef ENABLE_COMPANION
extern uint16_t host_bridge_get_report(uint8_t report_id, uint8_t *buffer, uint16_t reqlen);
extern void host_bridge_set_report(uint8_t const *report, uint16_t len);
#endif

#define CONFIG_TOTAL_LEN_STANDARD 0x0148
#define RAW_PCM_RETURN_DESC_LEN 0x0065
#define KEYBOARD_HID_DESC_LEN 0x0019
#define VENDOR_PCM_DESC_LEN 0x0010
#define VENDOR_BRIDGE_DESC_LEN 0x0010
#define CONFIG_TOTAL_LEN_COMPANION (CONFIG_TOTAL_LEN_STANDARD - RAW_PCM_RETURN_DESC_LEN + KEYBOARD_HID_DESC_LEN + VENDOR_PCM_DESC_LEN + VENDOR_BRIDGE_DESC_LEN)
#define VENDOR_PCM_INTERFACE_NUMBER HOST_PCM_ISO_INTERFACE_NUMBER
#define VENDOR_BRIDGE_INTERFACE_NUMBER HOST_BRIDGE_INTERFACE_NUMBER
#define VENDOR_PCM_EP_IN HOST_PCM_ISO_EP_IN
#define VENDOR_BRIDGE_EP_OUT HOST_BRIDGE_EP_OUT
#define VENDOR_MS_OS_VENDOR_REQUEST 0x20
#define VENDOR_BRIDGE_CONTROL_GET_REPORT 0x31
#define VENDOR_BRIDGE_CONTROL_SET_REPORT 0x32
#define MS_OS_20_DEVICE_INTERFACE_GUID_PROPERTY_LEN 0x0084
#define MS_OS_20_BRIDGE_FUNCTION_DESC_LEN 0x00A0
#define VENDOR_MS_OS_20_DESC_LEN (0x00B2 + MS_OS_20_BRIDGE_FUNCTION_DESC_LEN)
#define BOS_TOTAL_LEN (TUD_BOS_DESC_LEN + TUD_BOS_MICROSOFT_OS_DESC_LEN)
#define KEYBOARD_HID_REPORT_DESC_LEN 0x002D

#ifdef ENABLE_COMPANION
#define GAMEPAD_INTERFACE_NUMBER 0x03
#define KEYBOARD_HID_INTERFACE_NUMBER 0x04
#else
#define GAMEPAD_INTERFACE_NUMBER 0x05
#endif

//--------------------------------------------------------------------+
// Device Descriptors
//--------------------------------------------------------------------+
static tusb_desc_device_t const desc_device =
{
    .bLength = sizeof(tusb_desc_device_t),
    .bDescriptorType = TUSB_DESC_DEVICE,
#ifdef ENABLE_COMPANION
    .bcdUSB = 0x0210,
#else
    .bcdUSB = 0x0200,
#endif

    // Use Interface Association Descriptor (IAD) for Audio
    // As required by USB Specs IAD's subclass must be common class (2) and protocol must be IAD (1)
    /*.bDeviceClass = TUSB_CLASS_MISC,
    .bDeviceSubClass = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol = MISC_PROTOCOL_IAD,*/
    .bDeviceClass = 0x00,
    .bDeviceSubClass = 0x00,
    .bDeviceProtocol = 0x00,
    .bMaxPacketSize0 = CFG_TUD_ENDPOINT0_SIZE,

    // Windows PnP identity is sensitive to VID/PID, serial presence, product
    // string, interface order/count, HID report descriptor shape, and audio
    // topology. Avoid changing these casually; stale test identities need
    // cleanup with tools/windows/clean-ds5bridge-devices.ps1.
    .idVendor = 0x054C,
#ifdef ENABLE_DSE
    .idProduct = 0x0DF2,
#else
    .idProduct = 0x0CE6,
#endif
    // v1.5 changed the interface layout enough that Windows upgrade installs
    // can keep stale v1.0.x bindings unless the USB device revision changes.
    .bcdDevice = 0x0151,

    .iManufacturer = 0x01,
    .iProduct = 0x02,
    // Keep the product name DualSense-like, but do not expose a USB serial.
    // SpecialK treats a PlayStation HID serial string as a Bluetooth identity.
    .iSerialNumber = 0x00,

    .bNumConfigurations = 0x01
};

// Invoked when received GET DEVICE DESCRIPTOR
// Application return pointer to descriptor
uint8_t const *tud_descriptor_device_cb(void) {
    return (uint8_t const *) &desc_device;
}

//--------------------------------------------------------------------+
// Configuration Descriptor
//--------------------------------------------------------------------+
uint8_t descriptor_configuration[] = {
    // --- CONFIGURATION DESCRIPTOR ---
    0x09, // bLength
    0x02, // bDescriptorType (CONFIGURATION)
#ifdef ENABLE_COMPANION
    CONFIG_TOTAL_LEN_COMPANION & 0xFF, (CONFIG_TOTAL_LEN_COMPANION >> 8) & 0xFF,
    0x07, // bNumInterfaces: 7
#else
    CONFIG_TOTAL_LEN_STANDARD & 0xFF, (CONFIG_TOTAL_LEN_STANDARD >> 8) & 0xFF, // wTotalLength: 328
    0x06, // bNumInterfaces: 6
#endif
    0x01, // bConfigurationValue: 1
    0x00, // iConfiguration: 0
    0xC0, // bmAttributes: SELF-POWERED, NO REMOTE-WAKEUP
    0xFA, // bMaxPower: 500mA (250 * 2mA)

    // --- INTERFACE DESCRIPTOR (0.0): Audio Control ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x00, // bInterfaceNumber: 0
    0x00, // bAlternateSetting: 0
    0x00, // bNumEndpoints: 0
    0x01, // bInterfaceClass: Audio (0x01)
    0x01, // bInterfaceSubClass: Audio Control (0x01)
    0x00, // bInterfaceProtocol: 0x00
    0x00, // iInterface: 0

    // Class-specific AC Interface Header Descriptor
    0x0A, // bLength: 10
    0x24, // bDescriptorType: CS_INTERFACE (0x24)
    0x01, // bDescriptorSubtype: Header (0x01)
    0x00, 0x01, // bcdADC: 1.00
    0x49, 0x00, // wTotalLength: 73 (0x0049)
    0x02, // bInCollection: 2 streaming interfaces
    0x01, // baInterfaceNr(1): Interface 1
    0x02, // baInterfaceNr(2): Interface 2

    // Input Terminal Descriptor (Terminal ID 1: USB Streaming → Output to Speaker)
    0x0C, // bLength: 12
    0x24, // bDescriptorType: CS_INTERFACE
    0x02, // bDescriptorSubtype: Input Terminal
    0x01, // bTerminalID: 1
    0x01, 0x01, // wTerminalType: USB Streaming (0x0101)
    0x06, // bAssocTerminal: 6 (paired with USB OUT terminal)
    0x04, // bNrChannels: 4
    0x33, 0x00, // wChannelConfig: L/R Front + L/R Surround (0x0033)
    0x00, // iChannelNames: 0
    0x00, // iTerminal: 0

    // Feature Unit Descriptor (Unit ID 2 ← from Terminal 1)
    0x0C, // bLength: 12
    0x24, // bDescriptorType: CS_INTERFACE
    0x06, // bDescriptorSubtype: Feature Unit
    0x02, // bUnitID: 2
    0x01, // bSourceID: 1
    0x01, // bControlSize: 1 byte per control
    0x03, // bmaControls[0]: Master – Mute, Volume
    0x00, 0x00, 0x00, 0x00, 0x00, // bmaControls[1..4]: No per-channel controls

    // Output Terminal Descriptor (Terminal ID 3: Speaker ← from Unit 2)
    0x09, // bLength: 9
    0x24, // bDescriptorType: CS_INTERFACE
    0x03, // bDescriptorSubtype: Output Terminal
    0x03, // bTerminalID: 3
    0x01, 0x03, // wTerminalType: Speaker (0x0301)
    0x04, // bAssocTerminal: 4 (paired with mic input)
    0x02, // bSourceID: 2 (Feature Unit)
    0x00, // iTerminal: 0

    // Input Terminal Descriptor (Terminal ID 4: Headset Mic)
    0x0C, // bLength: 12
    0x24, // bDescriptorType: CS_INTERFACE
    0x02, // bDescriptorSubtype: Input Terminal
    0x04, // bTerminalID: 4
    0x02, 0x04, // wTerminalType: Headset (0x0402)
    0x03, // bAssocTerminal: 3 (paired with speaker)
    0x01, // bNrChannels: 1
    0x00, 0x00, // wChannelConfig: non-predefined mono
    0x00, // iChannelNames: 0
    0x00, // iTerminal: 0

    // Feature Unit Descriptor (Unit ID 5 ← from Terminal 4)
    0x09, // bLength: 9
    0x24, // bDescriptorType: CS_INTERFACE
    0x06, // bDescriptorSubtype: Feature Unit
    0x05, // bUnitID: 5
    0x04, // bSourceID: 4
    0x01, // bControlSize: 1
    0x03, // bmaControls[0]: Master – Mute, Volume
    0x00, // bmaControls[1]: Ch1 – no controls
    0x00, // iFeature: 0

    // Output Terminal Descriptor (Terminal ID 6: USB Streaming ← from Unit 5)
    0x09, // bLength: 9
    0x24, // bDescriptorType: CS_INTERFACE
    0x03, // bDescriptorSubtype: Output Terminal
    0x06, // bTerminalID: 6
    0x01, 0x01, // wTerminalType: USB Streaming (0x0101)
    0x01, // bAssocTerminal: 1
    0x05, // bSourceID: 5
    0x00, // iTerminal: 0

    // --- INTERFACE DESCRIPTOR (1.0): Audio Streaming (OUT - Alternate 0) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x01, // bInterfaceNumber: 1
    0x00, // bAlternateSetting: 0
    0x00, // bNumEndpoints: 0
    0x01, // bInterfaceClass: Audio
    0x02, // bInterfaceSubClass: Audio Streaming
    0x00, // bInterfaceProtocol
    0x00, // iInterface

    // --- INTERFACE DESCRIPTOR (1.1): Audio Streaming (OUT - Alternate 1) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x01, // bInterfaceNumber: 1
    0x01, // bAlternateSetting: 1
    0x01, // bNumEndpoints: 1
    0x01, // bInterfaceClass: Audio
    0x02, // bInterfaceSubClass: Audio Streaming
    0x00, // bInterfaceProtocol
    0x00, // iInterface

    // AS General Descriptor (for Interface 1.1)
    0x07, // bLength: 7
    0x24, // bDescriptorType: CS_INTERFACE
    0x01, // bDescriptorSubtype: AS_GENERAL
    0x01, // bTerminalLink: connected to Terminal ID 1
    0x01, // bDelay: 1 frame
    0x01, 0x00, // wFormatTag: PCM (0x0001)

    // Format Type Descriptor (4-channel, 16-bit, 48kHz)
    0x0B, // bLength: 11
    0x24, // bDescriptorType: CS_INTERFACE
    0x02, // bDescriptorSubtype: FORMAT_TYPE
    0x01, // bFormatType: TYPE_I
    0x04, // bNrChannels: 4
    0x02, // bSubframeSize: 2 bytes/sample
    0x10, // bBitResolution: 16 bits
    0x01, // bSamFreqType: 1 discrete frequency
    0x80, 0xBB, 0x00, // tSamFreq: 48000 Hz (0x00BB80)

    // Endpoint Descriptor (Audio OUT: EP1)
    0x09, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    0x01, // bEndpointAddress: OUT EP1
    0x09, // bmAttributes: Isochronous, Adaptive
    0x88, 0x01, // wMaxPacketSize: 392 bytes
    0x01, // bInterval: 1
    0x00, // bRefresh
    0x00, // bSynchAddress

    // Class-specific Audio Streaming Endpoint Descriptor (EP1)
    0x07, // bLength
    0x25, // bDescriptorType: CS_ENDPOINT
    0x01, // bDescriptorSubtype: GENERAL
    0x00, // Attributes: No pitch/sampling freq control
    0x00, // Lock Delay Units: Undefined
    0x00, 0x00, // Lock Delay: 0

    // --- INTERFACE DESCRIPTOR (2.0): Audio Streaming IN (Alternate 0) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x02, // bInterfaceNumber: 2
    0x00, // bAlternateSetting: 0
    0x00, // bNumEndpoints: 0
    0x01, // bInterfaceClass: Audio
    0x02, // bInterfaceSubClass: Audio Streaming
    0x00, // bInterfaceProtocol
    0x00, // iInterface

    // --- INTERFACE DESCRIPTOR (2.1): Audio Streaming IN (Alternate 1) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x02, // bInterfaceNumber: 2
    0x01, // bAlternateSetting: 1
    0x01, // bNumEndpoints: 1
    0x01, // bInterfaceClass: Audio
    0x02, // bInterfaceSubClass: Audio Streaming
    0x00, // bInterfaceProtocol
    0x00, // iInterface

    // AS General Descriptor (for Interface 2.1)
    0x07, // bLength: 7
    0x24, // bDescriptorType: CS_INTERFACE
    0x01, // bDescriptorSubtype: AS_GENERAL
    0x06, // bTerminalLink: connected to Terminal ID 6
    0x01, // bDelay: 1 frame
    0x01, 0x00, // wFormatTag: PCM (0x0001)

    // Format Type Descriptor (1-channel, 16-bit mic)
    0x0B, // bLength: 11
    0x24, // bDescriptorType: CS_INTERFACE
    0x02, // bDescriptorSubtype: FORMAT_TYPE
    0x01, // bFormatType: TYPE_I
    0x01, // bNrChannels: 1
    0x02, // bSubframeSize: 2
    0x10, // bBitResolution: 16
    0x01, // bSamFreqType: 1
    CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE_TX & 0xFF,
    (CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE_TX >> 8) & 0xFF,
    (CFG_TUD_AUDIO_FUNC_1_SAMPLE_RATE_TX >> 16) & 0xFF,

    // Endpoint Descriptor (Audio IN: EP2)
    0x09, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    0x82, // bEndpointAddress: IN EP2
    0x05, // bmAttributes: Isochronous, Asynchronous
    CFG_TUD_AUDIO_FUNC_1_FORMAT_1_EP_SZ_IN & 0xFF,
    (CFG_TUD_AUDIO_FUNC_1_FORMAT_1_EP_SZ_IN >> 8) & 0xFF,
    0x01, // bInterval: 1
    0x00, // bRefresh
    0x00, // bSynchAddress

    // Class-specific Audio Streaming Endpoint Descriptor (EP2)
    0x07, // bLength
    0x25, // bDescriptorType: CS_ENDPOINT
    0x01, // bDescriptorSubtype: GENERAL
    0x00, // Attributes: No controls
    0x00, // Lock Delay Units
    0x00, 0x00, // Lock Delay

#ifndef ENABLE_COMPANION
    // --- INTERFACE DESCRIPTOR (3.0): Audio Control (Raw PCM Return) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x03, // bInterfaceNumber: 3
    0x00, // bAlternateSetting: 0
    0x00, // bNumEndpoints: 0
    0x01, // bInterfaceClass: Audio (0x01)
    0x01, // bInterfaceSubClass: Audio Control (0x01)
    0x00, // bInterfaceProtocol: 0x00
    0x04, // iInterface: DS5 Bridge Raw PCM

    // Class-specific AC Interface Header Descriptor
    0x09, // bLength: 9
    0x24, // bDescriptorType: CS_INTERFACE (0x24)
    0x01, // bDescriptorSubtype: Header (0x01)
    0x00, 0x01, // bcdADC: 1.00
    0x28, 0x00, // wTotalLength: 40 (0x0028)
    0x01, // bInCollection: 1 streaming interface
    0x04, // baInterfaceNr(1): Interface 4

    // Input Terminal Descriptor (Terminal ID 7: Raw PCM return)
    0x0C, // bLength: 12
    0x24, // bDescriptorType: CS_INTERFACE
    0x02, // bDescriptorSubtype: Input Terminal
    0x07, // bTerminalID: 7
    0x03, 0x06, // wTerminalType: Line Connector (0x0603)
    0x00, // bAssocTerminal: 0
    0x02, // bNrChannels: 2
    0x03, 0x00, // wChannelConfig: L/R Front (0x0003)
    0x00, // iChannelNames: 0
    0x04, // iTerminal: DS5 Bridge Raw PCM

    // Feature Unit Descriptor (Unit ID 8 <- from Terminal 7)
    0x0A, // bLength: 10
    0x24, // bDescriptorType: CS_INTERFACE
    0x06, // bDescriptorSubtype: Feature Unit
    0x08, // bUnitID: 8
    0x07, // bSourceID: 7
    0x01, // bControlSize: 1
    0x03, // bmaControls[0]: Master - Mute, Volume
    0x00, // bmaControls[1]: Ch1 - no controls
    0x00, // bmaControls[2]: Ch2 - no controls
    0x00, // iFeature: 0

    // Output Terminal Descriptor (Terminal ID 9: USB Streaming <- from Unit 8)
    0x09, // bLength: 9
    0x24, // bDescriptorType: CS_INTERFACE
    0x03, // bDescriptorSubtype: Output Terminal
    0x09, // bTerminalID: 9
    0x01, 0x01, // wTerminalType: USB Streaming (0x0101)
    0x00, // bAssocTerminal: 0
    0x08, // bSourceID: 8
    0x00, // iTerminal: 0

    // --- INTERFACE DESCRIPTOR (4.0): Audio Streaming IN (Raw PCM Return - Alternate 0) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x04, // bInterfaceNumber: 4
    0x00, // bAlternateSetting: 0
    0x00, // bNumEndpoints: 0
    0x01, // bInterfaceClass: Audio
    0x02, // bInterfaceSubClass: Audio Streaming
    0x00, // bInterfaceProtocol
    0x04, // iInterface: DS5 Bridge Raw PCM

    // --- INTERFACE DESCRIPTOR (4.1): Audio Streaming IN (Raw PCM Return - Alternate 1) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    0x04, // bInterfaceNumber: 4
    0x01, // bAlternateSetting: 1
    0x01, // bNumEndpoints: 1
    0x01, // bInterfaceClass: Audio
    0x02, // bInterfaceSubClass: Audio Streaming
    0x00, // bInterfaceProtocol
    0x04, // iInterface: DS5 Bridge Raw PCM

    // AS General Descriptor (for Interface 4.1)
    0x07, // bLength: 7
    0x24, // bDescriptorType: CS_INTERFACE
    0x01, // bDescriptorSubtype: AS_GENERAL
    0x09, // bTerminalLink: connected to Terminal ID 9
    0x01, // bDelay: 1 frame
    0x01, 0x00, // wFormatTag: PCM (0x0001)

    // Format Type Descriptor (2-channel, 16-bit, 48kHz)
    0x0B, // bLength: 11
    0x24, // bDescriptorType: CS_INTERFACE
    0x02, // bDescriptorSubtype: FORMAT_TYPE
    0x01, // bFormatType: TYPE_I
    0x02, // bNrChannels: 2
    0x02, // bSubframeSize: 2
    0x10, // bBitResolution: 16
    0x01, // bSamFreqType: 1
    0x80, 0xBB, 0x00, // tSamFreq: 48000 Hz

    // Endpoint Descriptor (Raw PCM Return IN: EP8)
    0x09, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    0x88, // bEndpointAddress: IN EP8
    0x05, // bmAttributes: Isochronous, Asynchronous
    0xC4, 0x00, // wMaxPacketSize: 196 bytes
    0x01, // bInterval: 1
    0x00, // bRefresh
    0x00, // bSynchAddress

    // Class-specific Audio Streaming Endpoint Descriptor (EP8)
    0x07, // bLength
    0x25, // bDescriptorType: CS_ENDPOINT
    0x01, // bDescriptorSubtype: GENERAL
    0x00, // Attributes: No controls
    0x00, // Lock Delay Units
    0x00, 0x00, // Lock Delay

    // --- INTERFACE DESCRIPTOR (5.0): HID (DualSense 5 Gamepad + Touchpad) ---
#else
    // --- INTERFACE DESCRIPTOR (3.0): HID (DualSense 5 Gamepad + Touchpad) ---
#endif
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    GAMEPAD_INTERFACE_NUMBER,
    0x00, // bAlternateSetting: 0
    0x02, // bNumEndpoints: 2 (IN + OUT)
    0x03, // bInterfaceClass: HID
    0x00, // bInterfaceSubClass: None
    0x00, // bInterfaceProtocol: None
    0x00, // iInterface

    // HID Descriptor
    0x09, // bLength: 9
    0x21, // bDescriptorType (HID)
    0x11, 0x01, // bcdHID: 1.11
    0x00, // bCountryCode: Not localized
    0x01, // bNumDescriptors: 1 report descriptor
    0x22, // bDescriptorType: Report
#ifdef ENABLE_DSE
    0x95, 0x01, // wDescriptorLength: 405 (0x0121)
#else
    0x21, 0x01, // wDescriptorLength: 289 (0x0121)
#endif

    // Endpoint Descriptor (HID IN: EP4)
    0x07, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    0x84, // bEndpointAddress: IN EP4
    0x03, // bmAttributes: Interrupt
    0x40, 0x00, // wMaxPacketSize: 64
    0x01, // bInterval: 1 (polling every 4ms -> 1ms)

    // Endpoint Descriptor (HID OUT: EP3)
    0x07, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    0x03, // bEndpointAddress: OUT EP3
    0x03, // bmAttributes: Interrupt
    0x40, 0x00, // wMaxPacketSize: 64
    0x01, // bInterval: 1 (polling every 4ms -> 1ms)

#ifdef ENABLE_COMPANION
    // --- INTERFACE DESCRIPTOR (4.0): HID (Bridge Keyboard) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    KEYBOARD_HID_INTERFACE_NUMBER,
    0x00, // bAlternateSetting: 0
    0x01, // bNumEndpoints: 1 (IN)
    0x03, // bInterfaceClass: HID
    0x01, // bInterfaceSubClass: Boot
    0x01, // bInterfaceProtocol: Keyboard
    0x06, // iInterface: DS5 Bridge Keyboard

    // HID Descriptor
    0x09, // bLength
    0x21, // bDescriptorType (HID)
    0x11, 0x01, // bcdHID: 1.11
    0x00, // bCountryCode: Not localized
    0x01, // bNumDescriptors: 1 report descriptor
    0x22, // bDescriptorType: Report
    KEYBOARD_HID_REPORT_DESC_LEN & 0xFF, (KEYBOARD_HID_REPORT_DESC_LEN >> 8) & 0xFF,

    // Endpoint Descriptor (Keyboard HID IN: EP6)
    0x07, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    0x86, // bEndpointAddress: IN EP6
    0x03, // bmAttributes: Interrupt
    0x08, 0x00, // wMaxPacketSize: 8
    0x01, // bInterval: 1

    // --- INTERFACE DESCRIPTOR (5.0): Vendor Bulk OUT (companion/control bridge) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    VENDOR_BRIDGE_INTERFACE_NUMBER,
    0x00, // bAlternateSetting
    0x01, // bNumEndpoints: Bulk OUT
    0xFF, // bInterfaceClass: Vendor Specific
    0x00, // bInterfaceSubClass
    0x00, // bInterfaceProtocol
    0x07, // iInterface: DS5 Bridge Control

    0x07, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    VENDOR_BRIDGE_EP_OUT,
    0x02, // bmAttributes: Bulk
    0x40, 0x00, // wMaxPacketSize: 64
    0x00, // bInterval: ignored for bulk

    // --- INTERFACE DESCRIPTOR (6.0): Vendor Isochronous IN (PCM mirror) ---
    0x09, // bLength
    0x04, // bDescriptorType (INTERFACE)
    VENDOR_PCM_INTERFACE_NUMBER,
    0x00, // bAlternateSetting
    0x01, // bNumEndpoints: Iso IN
    0xFF, // bInterfaceClass: Vendor Specific
    0x00, // bInterfaceSubClass
    0x00, // bInterfaceProtocol
    0x05, // iInterface: DS5 Bridge PCM Iso

    0x07, // bLength
    0x05, // bDescriptorType (ENDPOINT)
    VENDOR_PCM_EP_IN,
    0x05, // bmAttributes: Isochronous, asynchronous
    HOST_PCM_ISO_PACKET_BYTES & 0xFF, (HOST_PCM_ISO_PACKET_BYTES >> 8) & 0xFF,
    0x01, // bInterval: 1ms
#endif
};

#ifdef ENABLE_COMPANION
TU_VERIFY_STATIC(sizeof(descriptor_configuration) == CONFIG_TOTAL_LEN_COMPANION, "Incorrect companion config descriptor size");
#else
TU_VERIFY_STATIC(sizeof(descriptor_configuration) == CONFIG_TOTAL_LEN_STANDARD, "Incorrect standard config descriptor size");
#endif

// Invoked when received GET CONFIGURATION DESCRIPTOR
// Application return pointer to descriptor
// Descriptor contents must exist long enough for transfer to complete
uint8_t const *tud_descriptor_configuration_cb(uint8_t index) {
    (void) index; // for multiple configurations
    for (uint16_t offset = 0; offset + 7 <= sizeof(descriptor_configuration);) {
        uint8_t const length = descriptor_configuration[offset];
        if (length == 0 || offset + length > sizeof(descriptor_configuration)) {
            break;
        }
        if (
            length >= 7
            && descriptor_configuration[offset + 1] == TUSB_DESC_ENDPOINT
            && (descriptor_configuration[offset + 2] == 0x84 || descriptor_configuration[offset + 2] == 0x03)
        ) {
            descriptor_configuration[offset + 6] = usb_hid_polling_interval_ms_value;
        }
        offset += length;
    }
    return descriptor_configuration;
}

#ifdef ENABLE_COMPANION
//--------------------------------------------------------------------+
// BOS / Microsoft OS 2.0 descriptors for automatic WinUSB binding
//--------------------------------------------------------------------+

uint8_t const desc_bos[] = {
    TUD_BOS_DESCRIPTOR(BOS_TOTAL_LEN, 1),
    TUD_BOS_MS_OS_20_DESCRIPTOR(VENDOR_MS_OS_20_DESC_LEN, VENDOR_MS_OS_VENDOR_REQUEST)
};

uint8_t const *tud_descriptor_bos_cb(void) {
    return desc_bos;
}

uint8_t const desc_ms_os_20[] = {
    // Set header: length, type, Windows version, total length.
    U16_TO_U8S_LE(0x000A), U16_TO_U8S_LE(MS_OS_20_SET_HEADER_DESCRIPTOR),
    U32_TO_U8S_LE(0x06030000), U16_TO_U8S_LE(VENDOR_MS_OS_20_DESC_LEN),

    // Configuration subset header.
    U16_TO_U8S_LE(0x0008), U16_TO_U8S_LE(MS_OS_20_SUBSET_HEADER_CONFIGURATION),
    0, 0, U16_TO_U8S_LE(VENDOR_MS_OS_20_DESC_LEN - 0x0A),

    // Function subset header for the vendor PCM interface.
    U16_TO_U8S_LE(0x0008), U16_TO_U8S_LE(MS_OS_20_SUBSET_HEADER_FUNCTION),
    VENDOR_PCM_INTERFACE_NUMBER, 0,
    U16_TO_U8S_LE(MS_OS_20_BRIDGE_FUNCTION_DESC_LEN),

    // Compatible ID: bind this interface to WinUSB.
    U16_TO_U8S_LE(0x0014), U16_TO_U8S_LE(MS_OS_20_FEATURE_COMPATBLE_ID),
    'W', 'I', 'N', 'U', 'S', 'B', 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,

    // Registry property: DeviceInterfaceGUIDs = {D5B7C5F4-8A68-4A86-9E31-1E5FA7B1D5B0}.
    U16_TO_U8S_LE(MS_OS_20_DEVICE_INTERFACE_GUID_PROPERTY_LEN),
    U16_TO_U8S_LE(MS_OS_20_FEATURE_REG_PROPERTY),
    U16_TO_U8S_LE(0x0007), U16_TO_U8S_LE(0x002A),
    'D', 0x00, 'e', 0x00, 'v', 0x00, 'i', 0x00, 'c', 0x00,
    'e', 0x00, 'I', 0x00, 'n', 0x00, 't', 0x00, 'e', 0x00,
    'r', 0x00, 'f', 0x00, 'a', 0x00, 'c', 0x00, 'e', 0x00,
    'G', 0x00, 'U', 0x00, 'I', 0x00, 'D', 0x00, 's', 0x00,
    0x00, 0x00,
    U16_TO_U8S_LE(0x0050),
    '{', 0x00, 'D', 0x00, '5', 0x00, 'B', 0x00, '7', 0x00,
    'C', 0x00, '5', 0x00, 'F', 0x00, '4', 0x00, '-', 0x00,
    '8', 0x00, 'A', 0x00, '6', 0x00, '8', 0x00, '-', 0x00,
    '4', 0x00, 'A', 0x00, '8', 0x00, '6', 0x00, '-', 0x00,
    '9', 0x00, 'E', 0x00, '3', 0x00, '1', 0x00, '-', 0x00,
    '1', 0x00, 'E', 0x00, '5', 0x00, 'F', 0x00, 'A', 0x00,
    '7', 0x00, 'B', 0x00, '1', 0x00, 'D', 0x00, '5', 0x00,
    'B', 0x00, '0', 0x00, '}', 0x00, 0x00, 0x00, 0x00, 0x00,

    // Function subset header for the companion/control bridge interface.
    U16_TO_U8S_LE(0x0008), U16_TO_U8S_LE(MS_OS_20_SUBSET_HEADER_FUNCTION),
    VENDOR_BRIDGE_INTERFACE_NUMBER, 0,
    U16_TO_U8S_LE(MS_OS_20_BRIDGE_FUNCTION_DESC_LEN),

    // Compatible ID: bind this interface to WinUSB.
    U16_TO_U8S_LE(0x0014), U16_TO_U8S_LE(MS_OS_20_FEATURE_COMPATBLE_ID),
    'W', 'I', 'N', 'U', 'S', 'B', 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,

    // Registry property: DeviceInterfaceGUIDs = {E4C8B2A9-87F5-4C4C-9E52-2B4C1B8B4F62}.
    U16_TO_U8S_LE(MS_OS_20_DEVICE_INTERFACE_GUID_PROPERTY_LEN),
    U16_TO_U8S_LE(MS_OS_20_FEATURE_REG_PROPERTY),
    U16_TO_U8S_LE(0x0007), U16_TO_U8S_LE(0x002A),
    'D', 0x00, 'e', 0x00, 'v', 0x00, 'i', 0x00, 'c', 0x00,
    'e', 0x00, 'I', 0x00, 'n', 0x00, 't', 0x00, 'e', 0x00,
    'r', 0x00, 'f', 0x00, 'a', 0x00, 'c', 0x00, 'e', 0x00,
    'G', 0x00, 'U', 0x00, 'I', 0x00, 'D', 0x00, 's', 0x00,
    0x00, 0x00,
    U16_TO_U8S_LE(0x0050),
    '{', 0x00, 'E', 0x00, '4', 0x00, 'C', 0x00, '8', 0x00,
    'B', 0x00, '2', 0x00, 'A', 0x00, '9', 0x00, '-', 0x00,
    '8', 0x00, '7', 0x00, 'F', 0x00, '5', 0x00, '-', 0x00,
    '4', 0x00, 'C', 0x00, '4', 0x00, 'C', 0x00, '-', 0x00,
    '9', 0x00, 'E', 0x00, '5', 0x00, '2', 0x00, '-', 0x00,
    '2', 0x00, 'B', 0x00, '4', 0x00, 'C', 0x00, '1', 0x00,
    'B', 0x00, '8', 0x00, 'B', 0x00, '4', 0x00, 'F', 0x00,
    '6', 0x00, '2', 0x00, '}', 0x00, 0x00, 0x00, 0x00, 0x00
};

TU_VERIFY_STATIC(sizeof(desc_ms_os_20) == VENDOR_MS_OS_20_DESC_LEN, "Incorrect MS OS 2.0 descriptor size");

static CFG_TUD_MEM_ALIGN uint8_t vendor_bridge_control_buffer[64];
static uint16_t vendor_bridge_control_len = 0;

bool tud_vendor_control_xfer_cb(uint8_t rhport, uint8_t stage, tusb_control_request_t const *request) {
    if (request == NULL || request->bmRequestType_bit.type != TUSB_REQ_TYPE_VENDOR) {
        return false;
    }

    if (
        stage == CONTROL_STAGE_ACK
        && request->bRequest == VENDOR_BRIDGE_CONTROL_SET_REPORT
        && request->wIndex == VENDOR_BRIDGE_INTERFACE_NUMBER
        && request->bmRequestType_bit.direction == TUSB_DIR_OUT
    ) {
        host_bridge_set_report(vendor_bridge_control_buffer, vendor_bridge_control_len);
        vendor_bridge_control_len = 0;
        return true;
    }

    if (stage != CONTROL_STAGE_SETUP) {
        return true;
    }

    if (request->bRequest == VENDOR_MS_OS_VENDOR_REQUEST && request->wIndex == 7) {
        return tud_control_xfer(
            rhport,
            request,
            (void *)(uintptr_t)desc_ms_os_20,
            VENDOR_MS_OS_20_DESC_LEN
        );
    }

    if (request->wIndex != VENDOR_BRIDGE_INTERFACE_NUMBER) {
        return false;
    }

    if (
        request->bRequest == VENDOR_BRIDGE_CONTROL_GET_REPORT
        && request->bmRequestType_bit.direction == TUSB_DIR_IN
    ) {
        const uint16_t max_len = request->wLength < sizeof(vendor_bridge_control_buffer)
            ? request->wLength
            : sizeof(vendor_bridge_control_buffer);
        const uint16_t report_len = host_bridge_get_report(
            (uint8_t)(request->wValue & 0xff),
            vendor_bridge_control_buffer,
            max_len
        );
        if (report_len == 0) {
            return false;
        }
        return tud_control_xfer(rhport, request, vendor_bridge_control_buffer, report_len);
    }

    if (
        request->bRequest == VENDOR_BRIDGE_CONTROL_SET_REPORT
        && request->bmRequestType_bit.direction == TUSB_DIR_OUT
    ) {
        vendor_bridge_control_len = request->wLength < sizeof(vendor_bridge_control_buffer)
            ? request->wLength
            : sizeof(vendor_bridge_control_buffer);
        return tud_control_xfer(rhport, request, vendor_bridge_control_buffer, vendor_bridge_control_len);
    }

    return false;
}
#endif

//--------------------------------------------------------------------+
// HID Report Descriptor
//--------------------------------------------------------------------+

#ifndef ENABLE_DSE
uint8_t const desc_hid_report_ds[] = {
    0x05, 0x01, // Usage Page (Generic Desktop Ctrls)
    0x09, 0x05, // Usage (Game Pad)
    0xA1, 0x01, // Collection (Application)
    0x85, 0x01, //   Report ID (1)
    0x09, 0x30, //   Usage (X)
    0x09, 0x31, //   Usage (Y)
    0x09, 0x32, //   Usage (Z)
    0x09, 0x35, //   Usage (Rz)
    0x09, 0x33, //   Usage (Rx)
    0x09, 0x34, //   Usage (Ry)
    0x15, 0x00, //   Logical Minimum (0)
    0x26, 0xFF, 0x00, //   Logical Maximum (255)
    0x75, 0x08, //   Report Size (8)
    0x95, 0x06, //   Report Count (6)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x06, 0x00, 0xFF, //   Usage Page (Vendor Defined 0xFF00)
    0x09, 0x20, //   Usage (0x20)
    0x95, 0x01, //   Report Count (1)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x05, 0x01, //   Usage Page (Generic Desktop Ctrls)
    0x09, 0x39, //   Usage (Hat switch)
    0x15, 0x00, //   Logical Minimum (0)
    0x25, 0x07, //   Logical Maximum (7)
    0x35, 0x00, //   Physical Minimum (0)
    0x46, 0x3B, 0x01, //   Physical Maximum (315)
    0x65, 0x14, //   Unit (System: English Rotation, Length: Centimeter)
    0x75, 0x04, //   Report Size (4)
    0x95, 0x01, //   Report Count (1)
    0x81, 0x42, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,Null State)
    0x65, 0x00, //   Unit (None)
    0x05, 0x09, //   Usage Page (Button)
    0x19, 0x01, //   Usage Minimum (0x01)
    0x29, 0x0F, //   Usage Maximum (0x0F)
    0x15, 0x00, //   Logical Minimum (0)
    0x25, 0x01, //   Logical Maximum (1)
    0x75, 0x01, //   Report Size (1)
    0x95, 0x0F, //   Report Count (15)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x06, 0x00, 0xFF, //   Usage Page (Vendor Defined 0xFF00)
    0x09, 0x21, //   Usage (0x21)
    0x95, 0x0D, //   Report Count (13)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x06, 0x00, 0xFF, //   Usage Page (Vendor Defined 0xFF00)
    0x09, 0x22, //   Usage (0x22)
    0x15, 0x00, //   Logical Minimum (0)
    0x26, 0xFF, 0x00, //   Logical Maximum (255)
    0x75, 0x08, //   Report Size (8)
    0x95, 0x34, //   Report Count (52)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x85, 0x02, //   Report ID (2)
    0x09, 0x23, //   Usage (0x23)
    0x95, 0x2F, //   Report Count (47)
    0x91, 0x02, //   Output (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x05, //   Report ID (5)
    0x09, 0x33, //   Usage (0x33)
    0x95, 0x28, //   Report Count (40)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x08, //   Report ID (8)
    0x09, 0x34, //   Usage (0x34)
    0x95, 0x2F, //   Report Count (47)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x09, //   Report ID (9)
    0x09, 0x24, //   Usage (0x24)
    0x95, 0x13, //   Report Count (19)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x0A, //   Report ID (10)
    0x09, 0x25, //   Usage (0x25)
    0x95, 0x1A, //   Report Count (26)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x0B, //   Report ID (11)
    0x09, 0x41, //   Usage (0x41)
    0x95, 0x29, //   Report Count (41)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x0C, //   Report ID (12)
    0x09, 0x42, //   Usage (0x42)
    0x95, 0x29, //   Report Count (41)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x20, //   Report ID (32)
    0x09, 0x26, //   Usage (0x26)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x21, //   Report ID (33)
    0x09, 0x27, //   Usage (0x27)
    0x95, 0x04, //   Report Count (4)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x22, //   Report ID (34)
    0x09, 0x40, //   Usage (0x40)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x80, //   Report ID (-128)
    0x09, 0x28, //   Usage (0x28)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x81, //   Report ID (-127)
    0x09, 0x29, //   Usage (0x29)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x82, //   Report ID (-126)
    0x09, 0x2A, //   Usage (0x2A)
    0x95, 0x09, //   Report Count (9)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x83, //   Report ID (-125)
    0x09, 0x2B, //   Usage (0x2B)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x84, //   Report ID (-124)
    0x09, 0x2C, //   Usage (0x2C)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x85, //   Report ID (-123)
    0x09, 0x2D, //   Usage (0x2D)
    0x95, 0x02, //   Report Count (2)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xA0, //   Report ID (-96)
    0x09, 0x2E, //   Usage (0x2E)
    0x95, 0x01, //   Report Count (1)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xE0, //   Report ID (-32)
    0x09, 0x2F, //   Usage (0x2F)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF0, //   Report ID (-16)
    0x09, 0x30, //   Usage (0x30)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF1, //   Report ID (-15)
    0x09, 0x31, //   Usage (0x31)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF2, //   Report ID (-14)
    0x09, 0x32, //   Usage (0x32)
    0x95, 0x0F, //   Report Count (15)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF4, //   Report ID (-12)
    0x09, 0x35, //   Usage (0x35)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF5, //   Report ID (-11)
    0x09, 0x36, //   Usage (0x36)
    0x95, 0x03, //   Report Count (3)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0xC0, // End Collection
    // 289 bytes
};
#endif

#ifdef ENABLE_COMPANION
uint8_t const desc_hid_report_keyboard[] = {
    0x05, 0x01, // Usage Page (Generic Desktop)
    0x09, 0x06, // Usage (Keyboard)
    0xA1, 0x01, // Collection (Application)
    0x05, 0x07, //   Usage Page (Keyboard/Keypad)
    0x19, 0xE0, //   Usage Minimum (Left Control)
    0x29, 0xE7, //   Usage Maximum (Right GUI)
    0x15, 0x00, //   Logical Minimum (0)
    0x25, 0x01, //   Logical Maximum (1)
    0x75, 0x01, //   Report Size (1)
    0x95, 0x08, //   Report Count (8)
    0x81, 0x02, //   Input (Data,Var,Abs)
    0x95, 0x01, //   Report Count (1)
    0x75, 0x08, //   Report Size (8)
    0x81, 0x01, //   Input (Const,Array,Abs)
    0x95, 0x06, //   Report Count (6)
    0x75, 0x08, //   Report Size (8)
    0x15, 0x00, //   Logical Minimum (0)
    0x25, 0x73, //   Logical Maximum (F24)
    0x05, 0x07, //   Usage Page (Keyboard/Keypad)
    0x19, 0x00, //   Usage Minimum (Reserved)
    0x29, 0x73, //   Usage Maximum (F24)
    0x81, 0x00, //   Input (Data,Array,Abs)
    0xC0, // End Collection
};
#endif

#ifdef ENABLE_DSE
uint8_t const desc_hid_report_dse[] = {
    0x05, 0x01, // Usage Page (Generic Desktop Ctrls)
    0x09, 0x05, // Usage (Game Pad)
    0xA1, 0x01, // Collection (Application)
    0x85, 0x01, //   Report ID (1)
    0x09, 0x30, //   Usage (X)
    0x09, 0x31, //   Usage (Y)
    0x09, 0x32, //   Usage (Z)
    0x09, 0x35, //   Usage (Rz)
    0x09, 0x33, //   Usage (Rx)
    0x09, 0x34, //   Usage (Ry)
    0x15, 0x00, //   Logical Minimum (0)
    0x26, 0xFF, 0x00, //   Logical Maximum (255)
    0x75, 0x08, //   Report Size (8)
    0x95, 0x06, //   Report Count (6)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x06, 0x00, 0xFF, //   Usage Page (Vendor Defined 0xFF00)
    0x09, 0x20, //   Usage (0x20)
    0x95, 0x01, //   Report Count (1)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x05, 0x01, //   Usage Page (Generic Desktop Ctrls)
    0x09, 0x39, //   Usage (Hat switch)
    0x15, 0x00, //   Logical Minimum (0)
    0x25, 0x07, //   Logical Maximum (7)
    0x35, 0x00, //   Physical Minimum (0)
    0x46, 0x3B, 0x01, //   Physical Maximum (315)
    0x65, 0x14, //   Unit (System: English Rotation, Length: Centimeter)
    0x75, 0x04, //   Report Size (4)
    0x95, 0x01, //   Report Count (1)
    0x81, 0x42, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,Null State)
    0x65, 0x00, //   Unit (None)
    0x05, 0x09, //   Usage Page (Button)
    0x19, 0x01, //   Usage Minimum (0x01)
    0x29, 0x0F, //   Usage Maximum (0x0F)
    0x15, 0x00, //   Logical Minimum (0)
    0x25, 0x01, //   Logical Maximum (1)
    0x75, 0x01, //   Report Size (1)
    0x95, 0x0F, //   Report Count (15)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x06, 0x00, 0xFF, //   Usage Page (Vendor Defined 0xFF00)
    0x09, 0x21, //   Usage (0x21)
    0x95, 0x0D, //   Report Count (13)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x06, 0x00, 0xFF, //   Usage Page (Vendor Defined 0xFF00)
    0x09, 0x22, //   Usage (0x22)
    0x15, 0x00, //   Logical Minimum (0)
    0x26, 0xFF, 0x00, //   Logical Maximum (255)
    0x75, 0x08, //   Report Size (8)
    0x95, 0x34, //   Report Count (52)
    0x81, 0x02, //   Input (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position)
    0x85, 0x02, //   Report ID (2)
    0x09, 0x23, //   Usage (0x23)
    0x95, 0x3F, //   Report Count (63)
    0x91, 0x02, //   Output (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x05, //   Report ID (5)
    0x09, 0x33, //   Usage (0x33)
    0x95, 0x28, //   Report Count (40)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x08, //   Report ID (8)
    0x09, 0x34, //   Usage (0x34)
    0x95, 0x2F, //   Report Count (47)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x09, //   Report ID (9)
    0x09, 0x24, //   Usage (0x24)
    0x95, 0x13, //   Report Count (19)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x0A, //   Report ID (10)
    0x09, 0x25, //   Usage (0x25)
    0x95, 0x1A, //   Report Count (26)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x0B, //   Report ID (11)
    0x09, 0x41, //   Usage (0x41)
    0x95, 0x29, //   Report Count (41)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x0C, //   Report ID (12)
    0x09, 0x42, //   Usage (0x42)
    0x95, 0x29, //   Report Count (41)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x20, //   Report ID (32)
    0x09, 0x26, //   Usage (0x26)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x21, //   Report ID (33)
    0x09, 0x27, //   Usage (0x27)
    0x95, 0x04, //   Report Count (4)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x22, //   Report ID (34)
    0x09, 0x40, //   Usage (0x40)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x80, //   Report ID (-128)
    0x09, 0x28, //   Usage (0x28)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x81, //   Report ID (-127)
    0x09, 0x29, //   Usage (0x29)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x82, //   Report ID (-126)
    0x09, 0x2A, //   Usage (0x2A)
    0x95, 0x09, //   Report Count (9)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x83, //   Report ID (-125)
    0x09, 0x2B, //   Usage (0x2B)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x84, //   Report ID (-124)
    0x09, 0x2C, //   Usage (0x2C)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x85, //   Report ID (-123)
    0x09, 0x2D, //   Usage (0x2D)
    0x95, 0x02, //   Report Count (2)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xA0, //   Report ID (-96)
    0x09, 0x2E, //   Usage (0x2E)
    0x95, 0x01, //   Report Count (1)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xE0, //   Report ID (-32)
    0x09, 0x2F, //   Usage (0x2F)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF0, //   Report ID (-16)
    0x09, 0x30, //   Usage (0x30)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF1, //   Report ID (-15)
    0x09, 0x31, //   Usage (0x31)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF2, //   Report ID (-14)
    0x09, 0x32, //   Usage (0x32)
    0x95, 0x34, //   Report Count (52)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF4, //   Report ID (-12)
    0x09, 0x35, //   Usage (0x35)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0xF5, //   Report ID (-11)
    0x09, 0x36, //   Usage (0x36)
    0x95, 0x03, //   Report Count (3)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x60, //   Report ID (96)
    0x09, 0x41, //   Usage (0x41)
    0x95, 0x3F, //   Report Count (63)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x61, //   Report ID (97)
    0x09, 0x42, //   Usage (0x42)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x62, //   Report ID (98)
    0x09, 0x43, //   Usage (0x43)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x63, //   Report ID (99)
    0x09, 0x44, //   Usage (0x44)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x64, //   Report ID (100)
    0x09, 0x45, //   Usage (0x45)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x65, //   Report ID (101)
    0x09, 0x46, //   Usage (0x46)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x68, //   Report ID (104)
    0x09, 0x47, //   Usage (0x47)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x70, //   Report ID (112)
    0x09, 0x48, //   Usage (0x48)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x71, //   Report ID (113)
    0x09, 0x49, //   Usage (0x49)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x72, //   Report ID (114)
    0x09, 0x4A, //   Usage (0x4A)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x73, //   Report ID (115)
    0x09, 0x4B, //   Usage (0x4B)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x74, //   Report ID (116)
    0x09, 0x4C, //   Usage (0x4C)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x75, //   Report ID (117)
    0x09, 0x4D, //   Usage (0x4D)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x76, //   Report ID (118)
    0x09, 0x4E, //   Usage (0x4E)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x77, //   Report ID (119)
    0x09, 0x4F, //   Usage (0x4F)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x78, //   Report ID (120)
    0x09, 0x50, //   Usage (0x50)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x79, //   Report ID (121)
    0x09, 0x51, //   Usage (0x51)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x7A, //   Report ID (122)
    0x09, 0x52, //   Usage (0x52)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0x85, 0x7B, //   Report ID (123)
    0x09, 0x53, //   Usage (0x53)
    0xB1, 0x02, //   Feature (Data,Var,Abs,No Wrap,Linear,Preferred State,No Null Position,Non-volatile)
    0xC0, // End Collection
    // 405 bytes
};
#endif

// Invoked when received GET HID REPORT DESCRIPTOR
// Application return pointer to descriptor
// Descriptor contents must exist long enough for transfer to complete
uint8_t const *tud_hid_descriptor_report_cb(uint8_t itf) {
#ifdef ENABLE_COMPANION
    if (itf == 1) {
        return desc_hid_report_keyboard;
    }
#else
    (void) itf;
#endif
#ifdef ENABLE_DSE
    return desc_hid_report_dse;
#else
    return desc_hid_report_ds;
#endif
}

//--------------------------------------------------------------------+
// String Descriptors
//--------------------------------------------------------------------+

// String Descriptor Index
enum {
    STRID_LANGID = 0,
    STRID_MANUFACTURER,
    STRID_PRODUCT,
    STRID_SERIAL,
    STRID_RAW_PCM,
    STRID_BULK_PCM,
};

// array of pointer to string descriptors
static char const *string_desc_arr[] =
{
    (const char[]){0x09, 0x04}, // 0: is supported language is English (0x0409)
    "Sony Interactive Entertainment", // 1: Manufacturer
#ifdef ENABLE_DSE
    "DualSense Edge Wireless Controller",
#else
    "DualSense Wireless Controller", // 2: Product
#endif
    NULL, // 3: Serials will use unique ID if possible
    "DS5 Bridge Raw PCM", // 4: Raw PCM Line endpoint
    "DS5 Bridge PCM Iso", // 5: WinUSB PCM interface
    "DS5 Bridge Keyboard", // 6: Keyboard HID interface
    "DS5 Bridge Control", // 7: WinUSB companion/control interface
};

static uint16_t _desc_str[60 + 1];

// Invoked when received GET STRING DESCRIPTOR request
// Application return pointer to descriptor, whose contents must exist long enough for transfer to complete
uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void) langid;
    size_t chr_count;

    switch (index) {
        case STRID_LANGID:
            memcpy(&_desc_str[1], string_desc_arr[0], 2);
            chr_count = 1;
            break;

        case STRID_SERIAL:
            chr_count = board_usb_get_serial(_desc_str + 1, 32);
            break;

        default:
            // Note: the 0xEE index string is a Microsoft OS 1.0 Descriptors.
            // https://docs.microsoft.com/en-us/windows-hardware/drivers/usbcon/microsoft-defined-usb-descriptors

            if (!(index < sizeof(string_desc_arr) / sizeof(string_desc_arr[0]))) return NULL;

            const char *str = string_desc_arr[index];

            // Cap at max char
            chr_count = strlen(str);
            size_t const max_count = sizeof(_desc_str) / sizeof(_desc_str[0]) - 1; // -1 for string type
            if (chr_count > max_count) chr_count = max_count;

            // Convert ASCII string into UTF-16
            for (size_t i = 0; i < chr_count; i++) {
                _desc_str[1 + i] = str[i];
            }
            break;
    }

    // first byte is length (including header), second byte is string type
    _desc_str[0] = (uint16_t) ((TUSB_DESC_STRING << 8) | (2 * chr_count + 2));

    return _desc_str;
}
