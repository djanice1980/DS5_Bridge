#ifndef DS5_BRIDGE_FEATURE_REPORT_CACHE_H
#define DS5_BRIDGE_FEATURE_REPORT_CACHE_H

#include <cstdint>

// Fixed-slot cache of controller feature reports, replacing the
// unordered_map<uint8_t, vector<uint8_t>> that backed it. The map allocated on every store
// and rehash -- inside the L2CAP receive callback -- and newlib's malloc on the RP2350 never
// compacts, so a long session interleaving differently-sized reports could fragment the heap
// until an allocation that should fit fails mid-session. The cache is the firmware's only
// varying-size allocator on a callback path; everything else is static, so fixing it here
// removes the fragmentation source rather than shrinking it.
//
// Capacity choices are the old behaviour made explicit: 32 slots is the cap the map already
// enforced (new ids beyond 32 were dropped), and 255 bytes is the largest payload the writer
// can receive -- the L2CAP control MTU (256) minus the 0xA3 transaction header byte.
inline constexpr uint16_t kFeatureReportCacheSlotBytes = 255;
inline constexpr uint16_t kFeatureReportCacheSlots = 32;

void feature_report_cache_clear();

// Store a payload for report_id, overwriting any previous entry. Returns false -- and stores
// nothing -- when the cache is full and the id is new, the same silent drop the map applied
// at its 32-entry cap. Payloads longer than a slot are truncated; that cannot happen at the
// current MTU, the clamp just keeps the invariant local instead of trusting the caller.
bool feature_report_cache_store(uint8_t report_id, uint8_t const *payload, uint16_t len);

// Distinct from a 0-length read on purpose: a cached-but-empty entry suppresses re-requests
// (get_feature_data treats it as cached) while still reading as absent to report consumers,
// exactly as the map's contains()/empty() split behaved.
bool feature_report_cache_contains(uint8_t report_id);

// Copy up to capacity bytes of the entry into out. Returns bytes copied; 0 when the id is not
// cached, the entry is empty, or out is null.
uint16_t feature_report_cache_read(uint8_t report_id, uint8_t *out, uint16_t capacity);

#endif // DS5_BRIDGE_FEATURE_REPORT_CACHE_H
