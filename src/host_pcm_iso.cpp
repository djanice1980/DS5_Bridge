#include "host_pcm_iso.h"

#ifdef ENABLE_COMPANION

#include "tusb.h"
#include "device/usbd_pvt.h"
#include "hardware/sync.h"
#include <cstring>

#define HOST_PCM_ISO_QUEUE_DEPTH 64
#define HOST_PCM_ISO_START_DEPTH 8

struct HostPcmIsoPacket {
    int16_t samples[HOST_PCM_ISO_FRAMES_PER_PACKET * HOST_PCM_ISO_CHANNELS];
};

static HostPcmIsoPacket host_pcm_iso_queue[HOST_PCM_ISO_QUEUE_DEPTH]{};
static int16_t host_pcm_iso_pending[HOST_PCM_ISO_FRAMES_PER_PACKET * HOST_PCM_ISO_CHANNELS]{};
static uint8_t host_pcm_iso_queue_head = 0;
static uint8_t host_pcm_iso_queue_tail = 0;
static uint8_t host_pcm_iso_queue_count = 0;
static uint16_t host_pcm_iso_pending_frames = 0;
static uint16_t host_pcm_iso_tx_sequence = 0;
static uint32_t host_pcm_iso_drops = 0;
static uint8_t host_pcm_iso_rhport = 0;
static uint8_t host_pcm_iso_ep_in = 0;
static bool host_pcm_iso_configured = false;
static bool host_pcm_iso_enabled = false;
static bool host_pcm_iso_streaming = false;
static CFG_TUD_MEM_ALIGN uint8_t host_pcm_iso_tx_buffer[HOST_PCM_ISO_PACKET_BYTES];

static void host_pcm_iso_clear_locked() {
    host_pcm_iso_queue_head = 0;
    host_pcm_iso_queue_tail = 0;
    host_pcm_iso_queue_count = 0;
    host_pcm_iso_pending_frames = 0;
    host_pcm_iso_tx_sequence = 0;
    host_pcm_iso_streaming = false;
}

static void host_pcm_iso_enqueue_locked(int16_t const *samples) {
    if (host_pcm_iso_queue_count >= HOST_PCM_ISO_QUEUE_DEPTH) {
        host_pcm_iso_queue_head = static_cast<uint8_t>((host_pcm_iso_queue_head + 1) % HOST_PCM_ISO_QUEUE_DEPTH);
        host_pcm_iso_queue_count--;
        host_pcm_iso_drops++;
    }

    HostPcmIsoPacket &packet = host_pcm_iso_queue[host_pcm_iso_queue_tail];
    memcpy(packet.samples, samples, sizeof(packet.samples));
    host_pcm_iso_queue_tail = static_cast<uint8_t>((host_pcm_iso_queue_tail + 1) % HOST_PCM_ISO_QUEUE_DEPTH);
    host_pcm_iso_queue_count++;
}

static bool host_pcm_iso_pop_locked(int16_t *destination) {
    if (!host_pcm_iso_streaming) {
        if (host_pcm_iso_queue_count < HOST_PCM_ISO_START_DEPTH) {
            memset(destination, 0, HOST_PCM_ISO_PAYLOAD_BYTES);
            return false;
        }
        host_pcm_iso_streaming = true;
    }

    if (host_pcm_iso_queue_count == 0) {
        host_pcm_iso_streaming = false;
        memset(destination, 0, HOST_PCM_ISO_PAYLOAD_BYTES);
        return false;
    }

    HostPcmIsoPacket &packet = host_pcm_iso_queue[host_pcm_iso_queue_head];
    memcpy(destination, packet.samples, sizeof(packet.samples));
    host_pcm_iso_queue_head = static_cast<uint8_t>((host_pcm_iso_queue_head + 1) % HOST_PCM_ISO_QUEUE_DEPTH);
    host_pcm_iso_queue_count--;
    return true;
}

static void host_pcm_iso_fill_tx_packet() {
    const uint32_t irq_state = save_and_disable_interrupts();
    const uint16_t sequence = host_pcm_iso_tx_sequence++;
    const bool had_audio = host_pcm_iso_pop_locked(
        reinterpret_cast<int16_t *>(host_pcm_iso_tx_buffer + HOST_PCM_ISO_HEADER_BYTES)
    );
    restore_interrupts(irq_state);

    host_pcm_iso_tx_buffer[0] = static_cast<uint8_t>(sequence & 0xff);
    host_pcm_iso_tx_buffer[1] = static_cast<uint8_t>((sequence >> 8) & 0xff);
    host_pcm_iso_tx_buffer[2] = HOST_PCM_ISO_FRAMES_PER_PACKET;
    host_pcm_iso_tx_buffer[3] = had_audio ? 0 : 1;
}

static bool host_pcm_iso_submit_packet(uint8_t rhport) {
    if (!host_pcm_iso_enabled || !host_pcm_iso_mounted() || !usbd_edpt_ready(rhport, host_pcm_iso_ep_in)) {
        return false;
    }

    host_pcm_iso_fill_tx_packet();
    return usbd_edpt_xfer(rhport, host_pcm_iso_ep_in, host_pcm_iso_tx_buffer, HOST_PCM_ISO_PACKET_BYTES);
}

extern "C" bool host_pcm_iso_mounted(void) {
    return host_pcm_iso_configured && host_pcm_iso_ep_in != 0;
}

extern "C" void host_pcm_iso_set_enabled(bool enabled) {
    const uint32_t irq_state = save_and_disable_interrupts();
    host_pcm_iso_enabled = enabled;
    if (!enabled) {
        host_pcm_iso_clear_locked();
    }
    restore_interrupts(irq_state);

    if (!host_pcm_iso_mounted()) {
        return;
    }

    usbd_sof_enable(host_pcm_iso_rhport, SOF_CONSUMER_USER, enabled);
    if (enabled) {
        (void)host_pcm_iso_submit_packet(host_pcm_iso_rhport);
    }
}

extern "C" void host_pcm_iso_reset_stream(void) {
    const uint32_t irq_state = save_and_disable_interrupts();
    host_pcm_iso_clear_locked();
    restore_interrupts(irq_state);
}

extern "C" bool host_pcm_iso_write(int16_t const *samples, uint16_t frames, uint32_t timestamp_us) {
    (void)timestamp_us;
    if (samples == nullptr || frames == 0 || !host_pcm_iso_enabled || !host_pcm_iso_mounted()) {
        return false;
    }

    uint16_t copied_frames = 0;
    while (copied_frames < frames) {
        const uint16_t remaining_source = static_cast<uint16_t>(frames - copied_frames);
        const uint16_t remaining_packet = static_cast<uint16_t>(HOST_PCM_ISO_FRAMES_PER_PACKET - host_pcm_iso_pending_frames);
        const uint16_t chunk_frames = remaining_source < remaining_packet ? remaining_source : remaining_packet;
        const uint16_t pending_offset = static_cast<uint16_t>(host_pcm_iso_pending_frames * HOST_PCM_ISO_CHANNELS);
        const uint16_t source_offset = static_cast<uint16_t>(copied_frames * HOST_PCM_ISO_CHANNELS);
        memcpy(
            host_pcm_iso_pending + pending_offset,
            samples + source_offset,
            chunk_frames * HOST_PCM_ISO_CHANNELS * sizeof(int16_t)
        );

        host_pcm_iso_pending_frames = static_cast<uint16_t>(host_pcm_iso_pending_frames + chunk_frames);
        copied_frames = static_cast<uint16_t>(copied_frames + chunk_frames);
        if (host_pcm_iso_pending_frames != HOST_PCM_ISO_FRAMES_PER_PACKET) {
            continue;
        }

        const uint32_t irq_state = save_and_disable_interrupts();
        host_pcm_iso_enqueue_locked(host_pcm_iso_pending);
        restore_interrupts(irq_state);
        host_pcm_iso_pending_frames = 0;
    }

    return true;
}

extern "C" uint32_t host_pcm_iso_drop_count(void) {
    return host_pcm_iso_drops;
}

static void host_pcm_iso_driver_init(void) {
    host_pcm_iso_rhport = 0;
    host_pcm_iso_ep_in = 0;
    host_pcm_iso_configured = false;
    host_pcm_iso_enabled = false;
    host_pcm_iso_reset_stream();
}

static bool host_pcm_iso_driver_deinit(void) {
    if (host_pcm_iso_configured) {
        usbd_sof_enable(host_pcm_iso_rhport, SOF_CONSUMER_USER, false);
    }
    host_pcm_iso_rhport = 0;
    host_pcm_iso_ep_in = 0;
    host_pcm_iso_configured = false;
    host_pcm_iso_enabled = false;
    host_pcm_iso_reset_stream();
    return true;
}

static void host_pcm_iso_driver_reset(uint8_t rhport) {
    usbd_sof_enable(rhport, SOF_CONSUMER_USER, false);
    host_pcm_iso_rhport = 0;
    host_pcm_iso_ep_in = 0;
    host_pcm_iso_configured = false;
    host_pcm_iso_enabled = false;
    host_pcm_iso_reset_stream();
}

static uint16_t host_pcm_iso_driver_open(uint8_t rhport, tusb_desc_interface_t const *desc_itf, uint16_t max_len) {
    if (
        desc_itf->bInterfaceClass != TUSB_CLASS_VENDOR_SPECIFIC
        || desc_itf->bInterfaceNumber != HOST_PCM_ISO_INTERFACE_NUMBER
    ) {
        return 0;
    }

    uint8_t const *desc_end = reinterpret_cast<uint8_t const *>(desc_itf) + max_len;
    uint8_t const *desc = tu_desc_next(desc_itf);
    uint16_t consumed = static_cast<uint16_t>(
        reinterpret_cast<uintptr_t>(desc) - reinterpret_cast<uintptr_t>(desc_itf)
    );

    host_pcm_iso_ep_in = 0;
    while (tu_desc_in_bounds(desc, desc_end)) {
        const uint8_t desc_type = tu_desc_type(desc);
        if (desc_type == TUSB_DESC_INTERFACE || desc_type == TUSB_DESC_INTERFACE_ASSOCIATION) {
            break;
        }

        if (desc_type == TUSB_DESC_ENDPOINT) {
            auto const *desc_ep = reinterpret_cast<tusb_desc_endpoint_t const *>(desc);
            if (
                desc_ep->bmAttributes.xfer == TUSB_XFER_ISOCHRONOUS
                && tu_edpt_dir(desc_ep->bEndpointAddress) == TUSB_DIR_IN
            ) {
                TU_ASSERT(usbd_edpt_iso_alloc(rhport, desc_ep->bEndpointAddress, HOST_PCM_ISO_PACKET_BYTES), 0);
                TU_ASSERT(usbd_edpt_iso_activate(rhport, desc_ep), 0);
                host_pcm_iso_ep_in = desc_ep->bEndpointAddress;
            }
        }

        desc = tu_desc_next(desc);
        consumed = static_cast<uint16_t>(
            reinterpret_cast<uintptr_t>(desc) - reinterpret_cast<uintptr_t>(desc_itf)
        );
    }

    if (host_pcm_iso_ep_in == 0) {
        return 0;
    }

    host_pcm_iso_rhport = rhport;
    host_pcm_iso_configured = true;
    host_pcm_iso_reset_stream();
    usbd_sof_enable(rhport, SOF_CONSUMER_USER, host_pcm_iso_enabled);
    if (host_pcm_iso_enabled) {
        (void)host_pcm_iso_submit_packet(rhport);
    }
    return consumed;
}

static bool host_pcm_iso_driver_control_xfer_cb(
    uint8_t rhport,
    uint8_t stage,
    tusb_control_request_t const *request
) {
    (void)rhport;
    (void)stage;
    (void)request;
    return false;
}

static bool host_pcm_iso_driver_xfer_cb(
    uint8_t rhport,
    uint8_t ep_addr,
    xfer_result_t result,
    uint32_t xferred_bytes
) {
    (void)rhport;
    (void)ep_addr;
    (void)result;
    (void)xferred_bytes;
    return true;
}

static bool host_pcm_iso_driver_xfer_isr(
    uint8_t rhport,
    uint8_t ep_addr,
    xfer_result_t result,
    uint32_t xferred_bytes
) {
    (void)result;
    (void)xferred_bytes;
    if (ep_addr != host_pcm_iso_ep_in) {
        return false;
    }

    (void)host_pcm_iso_submit_packet(rhport);
    return true;
}

static void host_pcm_iso_driver_sof(uint8_t rhport, uint32_t frame_count) {
    (void)frame_count;
    (void)host_pcm_iso_submit_packet(rhport);
}

extern "C" usbd_class_driver_t const *host_pcm_iso_usb_driver(void) {
    static usbd_class_driver_t const driver = {
        .name = "HOST_PCM_ISO",
        .init = host_pcm_iso_driver_init,
        .deinit = host_pcm_iso_driver_deinit,
        .reset = host_pcm_iso_driver_reset,
        .open = host_pcm_iso_driver_open,
        .control_xfer_cb = host_pcm_iso_driver_control_xfer_cb,
        .xfer_cb = host_pcm_iso_driver_xfer_cb,
        .xfer_isr = host_pcm_iso_driver_xfer_isr,
        .sof = host_pcm_iso_driver_sof,
    };

    return &driver;
}

#endif // ENABLE_COMPANION
