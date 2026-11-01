// Checks the transition-preserving delivery queue between the Bluetooth receive path and USB,
// and the submission rules main.cpp's on_bt_data / interrupt_loop apply around it. Uses the
// production DualSense decoder and DualSense persona encoder. The queue cases follow upstream
// 2.0's controller_input_handoff_test (ee0da45); the model cases are the fork's, whose input
// path has no receive batch but does have the tester's input hold.

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "controller_input_delivery_queue.h"
#include "dualsense_input_decoder.h"
#include "persona/dualsense_persona.h"

namespace {

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            std::fprintf(stderr, "controller input delivery check failed at %d: %s\n", __LINE__, #condition); \
            std::exit(1); \
        } \
    } while (0)

using Queue = ds5::ControllerInputDeliveryQueue<8>;
using ds5::ControllerInputPushResult;
using Report = std::array<uint8_t, kDualSenseUsbInputReportSize>;

constexpr uint8_t kCrossPressed = 0x28;  // neutral hat + Cross
constexpr uint8_t kNoButtons = 0x08;     // neutral hat

Report neutral_report() {
    Report report{};
    report[0] = report[1] = report[2] = report[3] = 0x80;
    report[7] = kNoButtons;
    report[32] = 0x80;  // both touch slots inactive
    report[36] = 0x80;
    return report;
}

BridgeControllerState decode(Report const &report) {
    BridgeControllerState state{};
    CHECK(dualsense_decode_usb_input_report(report.data(), static_cast<uint16_t>(report.size()), state));
    return state;
}

BridgeControllerState state_with(uint8_t buttons, uint8_t left_x) {
    Report report = neutral_report();
    report[7] = buttons;
    report[0] = left_x;
    return decode(report);
}

void test_queue_merges_motion_and_keeps_edges() {
    Queue queue;
    CHECK(queue.push(state_with(kNoButtons, 10)) == ControllerInputPushResult::Enqueued);
    CHECK(queue.push(state_with(kNoButtons, 20)) == ControllerInputPushResult::CoalescedContinuousState);
    CHECK(queue.push(state_with(kNoButtons, 30)) == ControllerInputPushResult::CoalescedContinuousState);
    CHECK(queue.size() == 1 && queue.front()->left_stick_x == 30);

    CHECK(queue.push(state_with(kCrossPressed, 40)) == ControllerInputPushResult::Enqueued);
    CHECK(queue.push(state_with(kCrossPressed, 50)) == ControllerInputPushResult::CoalescedContinuousState);
    CHECK(queue.push(state_with(kNoButtons, 60)) == ControllerInputPushResult::Enqueued);
    CHECK(queue.size() == 3);

    BridgeControllerState out{};
    CHECK(queue.pop_front(out) && !out.cross && out.left_stick_x == 30);
    CHECK(queue.pop_front(out) && out.cross && out.left_stick_x == 50);
    CHECK(queue.pop_front(out) && !out.cross && out.left_stick_x == 60);
    CHECK(queue.empty() && queue.front() == nullptr);
}

void test_queue_overflow_drops_the_oldest_edge() {
    Queue queue;
    for (unsigned index = 0; index < Queue::capacity(); ++index) {
        const uint8_t buttons = index % 2 == 0 ? kCrossPressed : kNoButtons;
        CHECK(queue.push(state_with(buttons, static_cast<uint8_t>(index))) == ControllerInputPushResult::Enqueued);
    }
    CHECK(queue.push(state_with(kCrossPressed, 200)) == ControllerInputPushResult::DroppedOldestTransition);
    CHECK(queue.size() == Queue::capacity());
    BridgeControllerState out{};
    CHECK(queue.pop_front(out) && out.left_stick_x == 1);
    BridgeControllerState last{};
    while (queue.pop_front(out)) {
        last = out;
    }
    CHECK(last.cross && last.left_stick_x == 200);
}

void test_touch_contacts_are_transitions() {
    Report base = neutral_report();
    Report touching = base;
    touching[32] = 0x05;  // slot 0 active, contact 5
    touching[33] = 0x10;
    Report moved = touching;
    moved[33] = 0x90;      // same contact, new coordinates
    Report new_contact = touching;
    new_contact[32] = 0x06;
    Report inactive_churn = base;
    inactive_churn[32] = 0x87;  // still inactive, stale contact ID changed

    CHECK(!ds5::controller_input_transition_equivalent(decode(base), decode(touching)));
    CHECK(ds5::controller_input_transition_equivalent(decode(touching), decode(moved)));
    CHECK(!ds5::controller_input_transition_equivalent(decode(touching), decode(new_contact)));
    CHECK(ds5::controller_input_transition_equivalent(decode(base), decode(inactive_churn)));

    Report l2_digital = base;
    l2_digital[8] = 0x04;
    Report l2_analog = base;
    l2_analog[4] = 0xff;  // analog travel alone is continuous
    CHECK(!ds5::controller_input_transition_equivalent(decode(base), decode(l2_digital)));
    CHECK(ds5::controller_input_transition_equivalent(decode(base), decode(l2_analog)));
}

void test_retry_refresh_never_crosses_an_edge() {
    Queue queue;
    BridgeControllerState retry = state_with(kCrossPressed, 10);
    CHECK(queue.refresh_retry(retry, state_with(kCrossPressed, 20)) && retry.left_stick_x == 20);
    CHECK(!queue.refresh_retry(retry, state_with(kNoButtons, 30)) && retry.cross && retry.left_stick_x == 20);
    CHECK(queue.push(state_with(kNoButtons, 30)) == ControllerInputPushResult::Enqueued);
    CHECK(!queue.refresh_retry(retry, state_with(kCrossPressed, 40)) && retry.left_stick_x == 20);
}

void test_sticks_refresh_in_both_representations() {
    BridgeControllerState pending = state_with(kCrossPressed, 10);
    pending.left_trigger = 99;
    pending.dualsense_report[4] = 99;
    Report latest_report = neutral_report();
    latest_report[0] = 240;
    latest_report[1] = 15;
    latest_report[2] = 200;
    latest_report[3] = 25;
    latest_report[4] = 7;
    const BridgeControllerState latest = decode(latest_report);

    ds5::controller_input_refresh_analog_sticks(pending, latest);
    CHECK(pending.left_stick_x == 240 && pending.left_stick_y == 15);
    CHECK(pending.right_stick_x == 200 && pending.right_stick_y == 25);
    CHECK(pending.cross && pending.left_trigger == 99);

    HostPersonaInputReport encoded{};
    CHECK(dualsense_persona_encode_input(pending, encoded));
    CHECK(encoded.bytes[0] == 240 && encoded.bytes[1] == 15 && encoded.bytes[2] == 200 && encoded.bytes[3] == 25);
    CHECK(encoded.bytes[4] == 99 && encoded.bytes[7] == kCrossPressed);
}

// on_bt_data and interrupt_loop as main.cpp implements them, over the production queue.
struct ForkInputModel {
    Queue queue;
    BridgeControllerState latest{};
    bool retry_pending = false;
    BridgeControllerState retry{};
    bool waiting_for_mount = false;
    bool dirty = false;
    bool hold = false;
    bool endpoint_free = true;
    bool accepts = true;
    std::vector<BridgeControllerState> submitted;

    void receive(Report const &report) {
        const BridgeControllerState state = decode(report);
        latest = state;
        if (waiting_for_mount) {
            dirty = true;
            return;
        }
        dirty = false;
        if (!retry_pending || !queue.refresh_retry(retry, state)) {
            (void)queue.push(state);
        }
    }

    void submit() {
        if (hold) {
            queue.clear();
            retry_pending = false;
            return;
        }
        if (!endpoint_free) {
            return;
        }
        BridgeControllerState out{};
        if (retry_pending) {
            out = retry;
            retry_pending = false;
        } else if (!queue.pop_front(out)) {
            if (!dirty) {
                return;
            }
            out = latest;
            dirty = false;
        }
        ds5::controller_input_refresh_analog_sticks(out, latest);
        if (!accepts) {
            retry = out;
            retry_pending = true;
            return;
        }
        submitted.push_back(out);
        endpoint_free = false;
    }

    // tud_hid_report_complete_cb / the XUSB IN completion: chains the next report.
    void complete() {
        endpoint_free = true;
        submit();
    }

    void drain() {
        for (int guard = 0; guard < 32 && (retry_pending || !queue.empty() || dirty); ++guard) {
            complete();
        }
    }
};

Report report_with(uint8_t buttons, uint8_t left_x) {
    Report report = neutral_report();
    report[7] = buttons;
    report[0] = left_x;
    return report;
}

void test_a_tap_inside_one_radio_burst_reaches_the_host() {
    // The defect this queue fixes: one radio poll delivered press and release back to back,
    // and the single latest-state slot kept only the release.
    ForkInputModel model;
    model.endpoint_free = false;  // the previous report is still on the wire
    model.receive(report_with(kCrossPressed, 100));
    model.receive(report_with(kNoButtons, 110));
    model.receive(report_with(kNoButtons, 120));
    model.drain();
    CHECK(model.submitted.size() == 2);
    CHECK(model.submitted[0].cross && !model.submitted[1].cross);
    // Both go out with the newest aim.
    CHECK(model.submitted[0].left_stick_x == 120 && model.submitted[1].left_stick_x == 120);
}

void test_rejected_report_goes_first_and_refreshes() {
    ForkInputModel model;
    model.accepts = false;
    model.receive(report_with(kCrossPressed, 10));
    model.submit();
    CHECK(model.retry_pending && model.submitted.empty());
    model.receive(report_with(kCrossPressed, 20));  // equivalent: refreshes the retry
    CHECK(model.queue.empty() && model.retry.left_stick_x == 20);
    model.receive(report_with(kNoButtons, 30));     // an edge: queued behind it
    model.accepts = true;
    model.drain();
    CHECK(model.submitted.size() == 2 && model.submitted[0].cross && !model.submitted[1].cross);
}

void test_hold_discards_what_arrives_while_held() {
    // The tester holds input so a PS press does not reach the host. Queued edges must not be
    // replayed when the hold lapses.
    ForkInputModel model;
    model.hold = true;
    model.receive(report_with(kCrossPressed, 10));
    model.receive(report_with(kNoButtons, 10));
    model.submit();
    CHECK(model.queue.empty() && !model.retry_pending);
    model.hold = false;
    model.drain();
    CHECK(model.submitted.empty());
    model.receive(report_with(kNoButtons, 50));
    model.drain();
    CHECK(model.submitted.size() == 1 && model.submitted[0].left_stick_x == 50);
}

void test_reenumeration_keeps_only_the_latest_state() {
    ForkInputModel model;
    model.waiting_for_mount = true;
    model.receive(report_with(kCrossPressed, 10));
    model.receive(report_with(kNoButtons, 20));
    CHECK(model.queue.empty() && model.dirty);
    model.waiting_for_mount = false;
    model.drain();
    CHECK(model.submitted.size() == 1 && !model.submitted[0].cross && model.submitted[0].left_stick_x == 20);
}

} // namespace

int main() {
    test_queue_merges_motion_and_keeps_edges();
    test_queue_overflow_drops_the_oldest_edge();
    test_touch_contacts_are_transitions();
    test_retry_refresh_never_crosses_an_edge();
    test_sticks_refresh_in_both_representations();
    test_a_tap_inside_one_radio_burst_reaches_the_host();
    test_rejected_report_goes_first_and_refreshes();
    test_hold_discards_what_arrives_while_held();
    test_reenumeration_keeps_only_the_latest_state();
    std::printf("controller input delivery tests passed\n");
    return 0;
}
