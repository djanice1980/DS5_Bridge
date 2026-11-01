// Compares the SRAM memory operations in src/ram_mem.c, compiled under
// renamed symbols, with the host C library for every small alignment and
// length combination, including overlapping memmove in both directions.

#include <csetjmp>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>

extern "C" {
void *ds5_ram_memcpy(void *destination, const void *source, size_t length);
void *ds5_ram_memset(void *destination, int value, size_t length);
void *ds5_ram_memmove(void *destination, const void *source, size_t length);
// Fork additions.
int ds5_ram_memcmp(const void *left, const void *right, size_t length);
void *ds5_ram_memcpy_chk(void *destination, const void *source, size_t length, size_t size);
void *ds5_ram_memset_chk(void *destination, int value, size_t length, size_t size);
}

namespace {
std::jmp_buf chk_fail_jump;
int chk_fail_calls = 0;
} // namespace

// Stands in for newlib's __chk_fail: record the trap and unwind back to the test.
extern "C" [[noreturn]] void ds5_ram_chk_fail() {
    ++chk_fail_calls;
    std::longjmp(chk_fail_jump, 1);
}

namespace {

constexpr size_t kBufferSize = 96;
constexpr size_t kMaxOffset = 8;
constexpr size_t kMaxLength = 40;

void fill_pattern(uint8_t *buffer, uint8_t seed) {
    for (size_t i = 0; i < kBufferSize; ++i) {
        buffer[i] = static_cast<uint8_t>(seed + i * 37u);
    }
}

int failures = 0;

void expect_equal(uint8_t const *actual, uint8_t const *expected, char const *operation,
                  size_t dst_offset, size_t src_offset, size_t length) {
    if (std::memcmp(actual, expected, kBufferSize) != 0) {
        std::fprintf(stderr, "%s mismatch: dst=%zu src=%zu len=%zu\n",
                     operation, dst_offset, src_offset, length);
        ++failures;
    }
}

void test_copy() {
    alignas(4) uint8_t source[kBufferSize];
    alignas(4) uint8_t actual[kBufferSize];
    alignas(4) uint8_t expected[kBufferSize];
    fill_pattern(source, 11);
    for (size_t dst_offset = 0; dst_offset < kMaxOffset; ++dst_offset) {
        for (size_t src_offset = 0; src_offset < kMaxOffset; ++src_offset) {
            for (size_t length = 0; length < kMaxLength; ++length) {
                fill_pattern(actual, 200);
                fill_pattern(expected, 200);
                void *result = ds5_ram_memcpy(actual + dst_offset, source + src_offset, length);
                std::memcpy(expected + dst_offset, source + src_offset, length);
                if (result != actual + dst_offset) {
                    std::fprintf(stderr, "memcpy returned the wrong pointer\n");
                    ++failures;
                }
                expect_equal(actual, expected, "memcpy", dst_offset, src_offset, length);
            }
        }
    }
}

void test_set() {
    alignas(4) uint8_t actual[kBufferSize];
    alignas(4) uint8_t expected[kBufferSize];
    for (size_t dst_offset = 0; dst_offset < kMaxOffset; ++dst_offset) {
        for (size_t length = 0; length < kMaxLength; ++length) {
            for (int value : {0x00, 0x5a, 0xff, 0x1a5}) {
                fill_pattern(actual, 3);
                fill_pattern(expected, 3);
                void *result = ds5_ram_memset(actual + dst_offset, value, length);
                std::memset(expected + dst_offset, value, length);
                if (result != actual + dst_offset) {
                    std::fprintf(stderr, "memset returned the wrong pointer\n");
                    ++failures;
                }
                expect_equal(actual, expected, "memset", dst_offset, 0, length);
            }
        }
    }
}

void test_move() {
    alignas(4) uint8_t actual[kBufferSize];
    alignas(4) uint8_t expected[kBufferSize];
    // Overlapping and disjoint regions inside one buffer, in both directions.
    for (size_t dst_offset = 0; dst_offset < 2 * kMaxOffset; ++dst_offset) {
        for (size_t src_offset = 0; src_offset < 2 * kMaxOffset; ++src_offset) {
            for (size_t length = 0; length < kMaxLength; ++length) {
                fill_pattern(actual, 77);
                fill_pattern(expected, 77);
                void *result = ds5_ram_memmove(actual + dst_offset, actual + src_offset, length);
                std::memmove(expected + dst_offset, expected + src_offset, length);
                if (result != actual + dst_offset) {
                    std::fprintf(stderr, "memmove returned the wrong pointer\n");
                    ++failures;
                }
                expect_equal(actual, expected, "memmove", dst_offset, src_offset, length);
            }
        }
    }
}

int sign(int value) {
    return (value > 0) - (value < 0);
}

void test_compare() {
    alignas(4) uint8_t left[kBufferSize];
    alignas(4) uint8_t right[kBufferSize];
    for (size_t offset = 0; offset < kMaxOffset; ++offset) {
        for (size_t length = 0; length < kMaxLength; ++length) {
            // Equal, then a difference at every position, in both directions (bytes above
            // 0x7f included, so a signed-char comparison would get the sign wrong).
            fill_pattern(left, 9);
            fill_pattern(right, 9);
            for (size_t diff = 0; diff <= length; ++diff) {
                for (int delta : {0, 1, -1, 0x90}) {
                    fill_pattern(right, 9);
                    if (diff < length && delta != 0) {
                        right[offset + diff] = static_cast<uint8_t>(right[offset + diff] + delta);
                    }
                    const int actual = ds5_ram_memcmp(left + offset, right + offset, length);
                    const int expected = std::memcmp(left + offset, right + offset, length);
                    if (sign(actual) != sign(expected)) {
                        std::fprintf(stderr, "memcmp sign mismatch: off=%zu len=%zu diff=%zu delta=%d\n",
                                     offset, length, diff, delta);
                        ++failures;
                    }
                }
            }
        }
    }
}

void test_checked() {
    alignas(4) uint8_t source[kBufferSize];
    alignas(4) uint8_t actual[kBufferSize];
    alignas(4) uint8_t expected[kBufferSize];
    fill_pattern(source, 41);

    // In bounds: identical to the unchecked operations, including length == size.
    for (size_t length = 0; length < kMaxLength; ++length) {
        fill_pattern(actual, 5);
        fill_pattern(expected, 5);
        ds5_ram_memcpy_chk(actual + 1, source + 3, length, length);
        std::memcpy(expected + 1, source + 3, length);
        expect_equal(actual, expected, "__memcpy_chk", 1, 3, length);
        ds5_ram_memset_chk(actual + 2, 0xa5, length, length + 4);
        std::memset(expected + 2, 0xa5, length);
        expect_equal(actual, expected, "__memset_chk", 2, 0, length);
    }

    // One byte past the destination: trap, and leave the destination untouched.
    fill_pattern(actual, 5);
    fill_pattern(expected, 5);
    const int before = chk_fail_calls;
    if (setjmp(chk_fail_jump) == 0) {
        ds5_ram_memcpy_chk(actual, source, 9, 8);
    }
    if (setjmp(chk_fail_jump) == 0) {
        ds5_ram_memset_chk(actual, 0, 9, 8);
    }
    if (chk_fail_calls != before + 2) {
        std::fprintf(stderr, "checked operations did not trap on overflow\n");
        ++failures;
    }
    expect_equal(actual, expected, "overflow trap", 0, 0, 9);
}

} // namespace

int main() {
    test_copy();
    test_set();
    test_move();
    test_compare();
    test_checked();
    if (failures != 0) {
        std::fprintf(stderr, "%d ram_mem comparisons failed\n", failures);
        return 1;
    }
    std::printf("ram_mem operations match the C library\n");
    return 0;
}
