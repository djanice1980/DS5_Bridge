#ifndef DS5_BRIDGE_CONTROLLER_STATE_H
#define DS5_BRIDGE_CONTROLLER_STATE_H

#include <cstdint>

constexpr uint8_t kDualSenseUsbInputReportSize = 63;

struct BridgeControllerState {
    uint8_t left_stick_x = 0x80;
    uint8_t left_stick_y = 0x80;
    uint8_t right_stick_x = 0x80;
    uint8_t right_stick_y = 0x80;
    uint8_t left_trigger = 0;
    uint8_t right_trigger = 0;

    bool dpad_up = false;
    bool dpad_down = false;
    bool dpad_left = false;
    bool dpad_right = false;

    bool square = false;
    bool cross = false;
    bool circle = false;
    bool triangle = false;
    bool l1 = false;
    bool r1 = false;
    bool l2_pressed = false;
    bool r2_pressed = false;
    bool create = false;
    bool options = false;
    bool l3 = false;
    bool r3 = false;
    bool home = false;
    bool touchpad = false;
    bool mute = false;

    bool edge_left_function = false;
    bool edge_right_function = false;
    bool edge_left_paddle = false;
    bool edge_right_paddle = false;

    uint8_t battery_percent = 0xff;
    uint8_t raw_power_state = 0;
    bool headset_plugged = false;
    bool microphone_plugged = false;
    bool microphone_muted = false;

    uint8_t dualsense_report[kDualSenseUsbInputReportSize]{};
    uint8_t dualsense_report_len = 0;
};

#endif // DS5_BRIDGE_CONTROLLER_STATE_H
