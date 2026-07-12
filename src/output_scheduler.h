#ifndef DS5_BRIDGE_OUTPUT_SCHEDULER_H
#define DS5_BRIDGE_OUTPUT_SCHEDULER_H

#include <cstdint>

enum class OutputSchedulerChoice : uint8_t {
    None = 0,
    AudioStream,
    CoalescedState,
};

// Inputs describing the current output queues at the moment we must pick one
// interrupt packet to send over the Bluetooth link.
//
// consecutive_audio_sends counts how many audio packets have been sent in a row
// since the last controller-state packet. state_age_us is how long the pending
// coalesced controller state has been waiting. Together they let the scheduler
// keep the audio buffer full while still guaranteeing controller state (adaptive
// triggers, rumble, lightbar) a fair, latency-bounded share of the link.
struct OutputSchedulerInputs {
    bool audio_available;
    bool coalesced_state_available;
    uint8_t consecutive_audio_sends;
    uint32_t state_age_us;
};

// Tunable interleave policy. The firmware ships sensible defaults; the companion
// app may override these live over the vendor link so the balance can be tuned
// and tested without reflashing.
//
//   max_consecutive_audio_sends: after this many audio packets in a row, a
//       pending controller-state packet is forced out. Lower = snappier
//       triggers/rumble, higher = fuller audio buffer. Must be >= 1.
//   state_max_age_us: hard latency cap. A pending controller-state packet older
//       than this is forced out regardless of the audio run length.
struct OutputSchedulerConfig {
    uint8_t max_consecutive_audio_sends;
    uint32_t state_max_age_us;
};

OutputSchedulerChoice output_scheduler_choose_interrupt_packet(
    OutputSchedulerInputs const &inputs,
    OutputSchedulerConfig const &config
);

#endif // DS5_BRIDGE_OUTPUT_SCHEDULER_H
