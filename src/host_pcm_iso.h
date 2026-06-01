#ifndef DS5_BRIDGE_HOST_PCM_ISO_H
#define DS5_BRIDGE_HOST_PCM_ISO_H

#include <stdbool.h>
#include <stdint.h>

#define HOST_PCM_ISO_INTERFACE_NUMBER 0x06
#define HOST_PCM_ISO_EP_IN 0x89
#define HOST_PCM_ISO_CHANNELS 2
#define HOST_PCM_ISO_BYTES_PER_SAMPLE 2
#define HOST_PCM_ISO_FRAMES_PER_PACKET 48
#define HOST_PCM_ISO_HEADER_BYTES 4
#define HOST_PCM_ISO_PAYLOAD_BYTES (HOST_PCM_ISO_FRAMES_PER_PACKET * HOST_PCM_ISO_CHANNELS * HOST_PCM_ISO_BYTES_PER_SAMPLE)
#define HOST_PCM_ISO_PACKET_BYTES (HOST_PCM_ISO_HEADER_BYTES + HOST_PCM_ISO_PAYLOAD_BYTES)

#ifdef __cplusplus
extern "C" {
#endif

bool host_pcm_iso_mounted(void);
void host_pcm_iso_set_enabled(bool enabled);
void host_pcm_iso_reset_stream(void);
bool host_pcm_iso_write(int16_t const *samples, uint16_t frames, uint32_t timestamp_us);
uint32_t host_pcm_iso_drop_count(void);

#ifdef __cplusplus
}
#endif

#endif // DS5_BRIDGE_HOST_PCM_ISO_H
