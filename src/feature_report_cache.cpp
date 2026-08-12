#include "feature_report_cache.h"

#include <cstring>

namespace {

struct FeatureCacheEntry {
    uint8_t report_id;
    bool used;
    uint8_t len;
    uint8_t data[kFeatureReportCacheSlotBytes];
};

FeatureCacheEntry feature_cache[kFeatureReportCacheSlots];

FeatureCacheEntry *find_entry(uint8_t report_id) {
    for (auto &entry : feature_cache) {
        if (entry.used && entry.report_id == report_id) {
            return &entry;
        }
    }
    return nullptr;
}

} // namespace

void feature_report_cache_clear() {
    for (auto &entry : feature_cache) {
        entry.used = false;
        entry.len = 0;
    }
}

bool feature_report_cache_store(uint8_t report_id, uint8_t const *payload, uint16_t len) {
    FeatureCacheEntry *entry = find_entry(report_id);
    if (entry == nullptr) {
        for (auto &candidate : feature_cache) {
            if (!candidate.used) {
                entry = &candidate;
                break;
            }
        }
    }
    if (entry == nullptr) {
        return false; // Full and the id is new: drop, matching the old 32-entry cap.
    }

    const uint16_t stored = len < kFeatureReportCacheSlotBytes ? len : kFeatureReportCacheSlotBytes;
    if (stored > 0 && payload != nullptr) {
        memcpy(entry->data, payload, stored);
    }
    entry->report_id = report_id;
    entry->len = static_cast<uint8_t>(payload == nullptr ? 0 : stored);
    entry->used = true;
    return true;
}

bool feature_report_cache_contains(uint8_t report_id) {
    return find_entry(report_id) != nullptr;
}

uint16_t feature_report_cache_read(uint8_t report_id, uint8_t *out, uint16_t capacity) {
    FeatureCacheEntry const *entry = find_entry(report_id);
    if (entry == nullptr || out == nullptr) {
        return 0;
    }
    const uint16_t copied = entry->len < capacity ? entry->len : capacity;
    if (copied > 0) {
        memcpy(out, entry->data, copied);
    }
    return copied;
}
