// Diagnostic only -- no behaviour change.
//
// With the reconnect crash fixed, the main loop survives a controller power-cycle for the
// first time, and the worst-phase tracker immediately showed something that was previously
// invisible: cyw43 jumped from 3ms to 172ms during the reconnect. That is under the 1s
// watchdog budget so it trips nothing, but a 172ms main-loop stall drops input reports.
//
// Hypothesis: BTstack stores link keys in flash (LIB_PICO_BTSTACK_FLASH_BANK=1) and its
// callbacks run inside cyw43_arch_poll(), which is precisely the phase being blamed. A
// flash erase/program parks core 1 and blocks (PICO_FLASH_ASSUME_CORE1_SAFE=0), so the
// timing would fit. That is a hypothesis, not a finding -- so measure it.
//
// Wrapped at link time, the same mechanism proven in 1.6.30. If the worst flash operation
// comes back near 172ms, the cause is confirmed; if it comes back at zero or small, the
// stall is elsewhere in the BT path and this rules flash out.

#include "pico.h"
#include "pico/time.h"

#include <cstddef>
#include <cstdint>

namespace {

uint32_t worst_flash_us = 0;
uint32_t flash_op_count = 0;

inline void note(uint32_t start_us) {
    const uint32_t elapsed = time_us_32() - start_us;
    if (elapsed > worst_flash_us) {
        worst_flash_us = elapsed;
    }
    flash_op_count++;
}

} // namespace

extern "C" {

void __real_flash_range_erase(uint32_t flash_offs, size_t count);
void __real_flash_range_program(uint32_t flash_offs, const uint8_t *data, size_t count);
int __real_flash_safe_execute(void (*func)(void *), void *param, uint32_t enter_exit_timeout_ms);

void __not_in_flash_func(__wrap_flash_range_erase)(uint32_t flash_offs, size_t count) {
    const uint32_t start = time_us_32();
    __real_flash_range_erase(flash_offs, count);
    note(start);
}

void __not_in_flash_func(__wrap_flash_range_program)(uint32_t flash_offs, const uint8_t *data, size_t count) {
    const uint32_t start = time_us_32();
    __real_flash_range_program(flash_offs, data, count);
    note(start);
}

// Measured separately from the raw operations because this is the call that parks core 1
// and waits for the lockout handshake -- the stall the main loop actually feels can be
// longer than the erase or program itself.
int __not_in_flash_func(__wrap_flash_safe_execute)(void (*func)(void *), void *param, uint32_t enter_exit_timeout_ms) {
    const uint32_t start = time_us_32();
    const int rc = __real_flash_safe_execute(func, param, enter_exit_timeout_ms);
    note(start);
    return rc;
}

void flash_probe_stats(uint32_t *worst_us, uint32_t *count) {
    if (worst_us != nullptr) {
        *worst_us = worst_flash_us;
    }
    if (count != nullptr) {
        *count = flash_op_count;
    }
}

} // extern "C"
