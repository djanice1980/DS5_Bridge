#include "persona/dualsense_persona.h"

#include <cstring>

bool dualsense_persona_encode_input(
    BridgeControllerState const &state,
    HostPersonaInputReport &report
) {
    if (state.dualsense_report_len != kDualSenseUsbInputReportSize) {
        return false;
    }

    report.report_id = 0x01;
    report.len = kDualSenseUsbInputReportSize;
    std::memcpy(report.bytes, state.dualsense_report, kDualSenseUsbInputReportSize);
    return true;
}
