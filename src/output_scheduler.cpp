#include "output_scheduler.h"

bool output_scheduler_urgent_is_starving_audio(
    OutputSchedulerInputs const &inputs,
    OutputSchedulerConfig const &config
) {
    return inputs.audio_available
        && inputs.urgent_available
        && inputs.urgent_depth >= config.urgent_starving_audio_depth
        && inputs.audio_age_us >= config.audio_max_age_us;
}

OutputSchedulerChoice output_scheduler_choose_interrupt_packet(
    OutputSchedulerInputs const &inputs,
    OutputSchedulerConfig const &config
) {
    const bool non_audio_available = inputs.urgent_available || inputs.coalesced_state_available;
    const bool audio_due = inputs.audio_available
        && (
            non_audio_available
            || inputs.audio_age_us >= config.audio_max_age_us
            || inputs.audio_depth > 1
            || inputs.consecutive_non_audio_sends >= config.max_consecutive_non_audio_sends
        );

    if (audio_due) {
        return OutputSchedulerChoice::AudioStream;
    }
    if (inputs.urgent_available) {
        return OutputSchedulerChoice::UrgentTransition;
    }
    if (inputs.coalesced_state_available) {
        return OutputSchedulerChoice::CoalescedState;
    }
    if (inputs.audio_available) {
        return OutputSchedulerChoice::AudioStream;
    }
    return OutputSchedulerChoice::None;
}
