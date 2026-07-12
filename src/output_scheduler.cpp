#include "output_scheduler.h"

// Fair-interleave scheduler.
//
// The DualSense audio device is effectively always streaming (its channels also
// drive the grip haptics), so a naive "send audio whenever the buffer has data"
// policy lets audio win every Bluetooth slot and starves coalesced controller
// state -- adaptive-trigger effects and rumble then arrive late and feel weak.
//
// Instead we let audio win the slot by default (keeping its buffer full), but we
// guarantee a pending controller-state packet a slot once it has either yielded
// to a run of audio packets (max_consecutive_audio_sends) or simply waited too
// long (state_max_age_us). Because controller state is only pending when the
// host actually changes triggers/rumble/lightbar, steady gameplay leaves audio
// at (nearly) 100% of the link and only borrows a slot during active changes.
OutputSchedulerChoice output_scheduler_choose_interrupt_packet(
    OutputSchedulerInputs const &inputs,
    OutputSchedulerConfig const &config
) {
    // 1) Pending controller state that has waited too long takes the slot.
    const bool state_starved = inputs.coalesced_state_available
        && (
            inputs.consecutive_audio_sends >= config.max_consecutive_audio_sends
            || inputs.state_age_us >= config.state_max_age_us
        );
    if (state_starved) {
        return OutputSchedulerChoice::CoalescedState;
    }

    // 2) Otherwise keep the audio buffer full: audio wins the slot by default.
    if (inputs.audio_available) {
        return OutputSchedulerChoice::AudioStream;
    }

    // 3) No audio queued -- flush any pending controller state.
    if (inputs.coalesced_state_available) {
        return OutputSchedulerChoice::CoalescedState;
    }

    return OutputSchedulerChoice::None;
}
