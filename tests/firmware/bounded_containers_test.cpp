// Ported from upstream 2.0 (a171103).
//
// Checks the fixed-capacity containers that replaced heap-backed Bluetooth
// output storage, including a differential run of the fork's queue operations
// (drop-oldest admission, in-place rewrite, coalescing) against std::deque.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <vector>

#include "bounded_containers.h"

namespace {

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            std::fprintf(stderr, "bounded container check failed at %d: %s\n", __LINE__, #condition); \
            std::exit(1); \
        } \
    } while (0)

using ds5::BoundedDeque;
using ds5::InlineBytes;

void test_inline_bytes() {
    InlineBytes<8> bytes;
    CHECK(bytes.empty() && bytes.size() == 0);
    const uint8_t source[] = {1, 2, 3, 4, 5};
    CHECK(bytes.assign(source, sizeof(source)));
    CHECK(bytes.size() == 5 && bytes[0] == 1 && bytes[4] == 5);
    CHECK(bytes.end() - bytes.begin() == 5);

    // Oversized input is rejected and leaves the buffer empty, never truncated.
    const uint8_t oversized[9] = {};
    CHECK(!bytes.assign(oversized, sizeof(oversized)));
    CHECK(bytes.empty());
    CHECK(!bytes.assign(nullptr, 1));
    CHECK(bytes.assign(nullptr, 0) && bytes.empty());

    CHECK(bytes.assign_fill(8, 0xAB));
    CHECK(bytes.size() == 8 && bytes[7] == 0xAB);
    CHECK(!bytes.assign_fill(9, 0));
    CHECK(bytes.empty());
}

void test_deque_basics_and_wraparound() {
    BoundedDeque<int, 4> deque;
    CHECK(deque.empty());
    CHECK(deque.push_back(1) && deque.push_back(2) && deque.push_back(3));
    deque.pop_front();
    deque.pop_front();
    // Wrap the ring: head is now at slot 2.
    CHECK(deque.push_back(4) && deque.push_back(5) && deque.push_back(6));
    CHECK(deque.full());
    CHECK(!deque.push_back(7));
    CHECK(!deque.push_front(0));
    CHECK(deque.front() == 3 && deque.back() == 6);

    std::vector<int> seen;
    for (int value : deque) {
        seen.push_back(value);
    }
    CHECK((seen == std::vector<int>{3, 4, 5, 6}));

    seen.clear();
    for (auto it = deque.end(); it != deque.begin();) {
        --it;
        seen.push_back(*it);
    }
    CHECK((seen == std::vector<int>{6, 5, 4, 3}));

    // Erase from the middle, the front and the back.
    auto it = deque.begin();
    ++it;
    it = deque.erase(it);
    CHECK(*it == 5);
    CHECK(deque.size() == 3);
    deque.erase(deque.begin());
    CHECK(deque.front() == 5);
    auto last = deque.begin();
    ++last;
    deque.erase(last);
    CHECK(deque.size() == 1 && deque.front() == 5 && deque.back() == 5);
    CHECK(deque.erase(deque.end()) == deque.end());

    CHECK(deque.push_front(9));
    CHECK(deque.front() == 9 && deque.back() == 5);
    deque.clear();
    CHECK(deque.empty() && deque.begin() == deque.end());
    deque.pop_front();
    CHECK(deque.empty());
}

struct Packet {
    InlineBytes<16> data;
    uint8_t target;
    uint32_t id;
};

bool same_packet(Packet const &left, Packet const &right) {
    return left.target == right.target
        && left.id == right.id
        && left.data.size() == right.data.size()
        && std::equal(left.data.begin(), left.data.end(), right.data.begin());
}

template <typename Queue>
std::vector<Packet> contents(Queue const &queue) {
    std::vector<Packet> out;
    for (auto const &packet : queue) {
        out.push_back(packet);
    }
    return out;
}

// The operations bt.cpp performs, written once and run against both containers:
// drop-oldest admission at a depth cap (urgent, audio and control queues),
// coalescing onto a queued packet for the same target (control queue), and the
// classic-rumble mirror's in-place rewrite of every queued packet.
template <typename Queue>
void admit(Queue &queue, Packet const &packet, std::size_t cap, bool coalesce) {
    if (coalesce) {
        for (auto &queued : queue) {
            if (queued.target == packet.target) {
                queued = packet;
                return;
            }
        }
    }
    while (queue.size() >= cap) {
        queue.pop_front();
    }
    queue.push_back(packet);
}

template <typename Queue>
void rewrite_all(Queue &queue, uint8_t value) {
    for (auto &packet : queue) {
        if (packet.data.size() > 1) {
            packet.data[1] = value;
        }
    }
}

void test_queue_operations_differential() {
    constexpr std::size_t kCap = 8;
    std::deque<Packet> reference;
    BoundedDeque<Packet, kCap> bounded;
    uint32_t state = 0x12345678u;
    auto next = [&]() {
        state = state * 1664525u + 1013904223u;
        return state >> 8;
    };
    for (uint32_t step = 0; step < 20000; ++step) {
        const unsigned action = next() % 10;
        Packet packet{};
        packet.target = static_cast<uint8_t>(next() % 5);
        packet.id = step;
        uint8_t bytes[16];
        const std::size_t length = next() % (sizeof(bytes) + 1);
        for (std::size_t i = 0; i < length; ++i) {
            bytes[i] = static_cast<uint8_t>(next());
        }
        CHECK(packet.data.assign(bytes, length));

        if (action < 5) {
            const bool coalesce = (next() & 1u) != 0;
            admit(reference, packet, kCap, coalesce);
            admit(bounded, packet, kCap, coalesce);
        } else if (action < 8) {
            CHECK(reference.empty() == bounded.empty());
            if (!reference.empty()) {
                CHECK(same_packet(reference.front(), bounded.front()));
                // Dequeue by copy, as the scheduler does into the send packet.
                const Packet sent = bounded.front();
                CHECK(same_packet(sent, reference.front()));
                reference.pop_front();
                bounded.pop_front();
            }
        } else if (action < 9) {
            const uint8_t value = static_cast<uint8_t>(next());
            rewrite_all(reference, value);
            rewrite_all(bounded, value);
        } else {
            reference.clear();
            bounded.clear();
        }

        CHECK(reference.size() == bounded.size());
        CHECK(bounded.size() <= kCap);
        const std::vector<Packet> expected = contents(reference);
        const std::vector<Packet> actual = contents(bounded);
        for (std::size_t i = 0; i < expected.size(); ++i) {
            CHECK(same_packet(expected[i], actual[i]));
        }
    }
}

} // namespace

int main() {
    test_inline_bytes();
    test_deque_basics_and_wraparound();
    test_queue_operations_differential();
    std::printf("Bounded container checks passed\n");
    return 0;
}
