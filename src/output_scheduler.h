#ifndef DS5_BRIDGE_OUTPUT_SCHEDULER_H
#define DS5_BRIDGE_OUTPUT_SCHEDULER_H

#include <cstdint>

enum class OutputSchedulerChoice : uint8_t {
    None = 0,
    AudioStream,
    UrgentTransition,
    CoalescedState,
};

struct OutputSchedulerInputs {
    bool audio_available;
    bool urgent_available;
    bool coalesced_state_available;
    uint32_t audio_age_us;
    uint32_t audio_depth;
    uint32_t urgent_depth;
    uint8_t consecutive_non_audio_sends;
};

struct OutputSchedulerConfig {
    uint32_t audio_max_age_us;
    uint32_t urgent_starving_audio_depth;
    uint8_t max_consecutive_non_audio_sends;
};

OutputSchedulerChoice output_scheduler_choose_interrupt_packet(
    OutputSchedulerInputs const &inputs,
    OutputSchedulerConfig const &config
);

bool output_scheduler_urgent_is_starving_audio(
    OutputSchedulerInputs const &inputs,
    OutputSchedulerConfig const &config
);

#endif // DS5_BRIDGE_OUTPUT_SCHEDULER_H
