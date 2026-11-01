# Generated Cmake Pico project file

cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Initialise pico_sdk from installed location
# (note this can come from environment, CMake cache etc)

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if (WIN32)
    set(USERHOME $ENV{USERPROFILE})
else ()
    set(USERHOME $ENV{HOME})
endif ()
set(sdkVersion 2.2.0)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.2.0-a4)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif ()
# ====================================================================================
option(WAVESHARE_RP2350B_PLUS_W_BUILD "Build for Waveshare RP2350B-Plus-W (USB-C, 16MB flash, RM2 wireless)" OFF)

if (WAVESHARE_RP2350B_PLUS_W_BUILD)
    set(PICO_BOARD waveshare_rp2350b_plus_w CACHE STRING "Board type")
    # Waveshare board header is not in upstream pico-sdk; ship it here and
    # tell the SDK to search this directory when resolving PICO_BOARD.
    list(APPEND PICO_BOARD_HEADER_DIRS "${CMAKE_CURRENT_SOURCE_DIR}/boards/headers")
else ()
    set(PICO_BOARD pico2_w CACHE STRING "Board type")
endif ()
message(STATUS "ds5-bridge board target -- PICO_BOARD=${PICO_BOARD}")
set(SYS_CLOCK_KHZ_VALUE 150000 CACHE STRING "RP2350 system clock in kHz")
set(CYW43_PIO_CLOCK_DIV_VALUE 2 CACHE STRING "CYW43 PIO clock divider")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(ds5-bridge C CXX ASM)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Add executable. Default name is the project name, version 0.1

add_executable(ds5-bridge
        src/usb_descriptors.c
        src/main.cpp
        src/button_functions.cpp
        src/dualsense_input_decoder.cpp
        src/feature_report_cache.cpp
        src/persona/host_persona.cpp
        src/persona/dualsense_persona.cpp
        src/persona/ds4_persona.cpp
        src/persona/xusb360_persona.cpp
        src/persona/xusb360_usb.cpp
        src/usb.cpp
        src/controller_packet_compositor.cpp
        src/controller_output_policy.cpp
        src/controller_output_rumble_state.cpp
        src/controller_output_state.cpp
        src/haptics_test_signal.cpp
        src/watchdog_telemetry.cpp
        src/panic_hook.cpp
        src/fault_hooks.cpp
        src/ram_mem.c
        src/audio.cpp
        src/bt.cpp
)

# Cockos WDLResampler
add_library(wdl_resampler STATIC
        lib/WDL/WDL/resample.cpp
)
target_include_directories(wdl_resampler PUBLIC
        lib/WDL/WDL
)

# Opus
# The DualSense speaker path encodes CELT-only frames: audio.cpp creates the
# encoder with OPUS_APPLICATION_RESTRICTED_CELT at 48 kHz stereo, 10 ms, CBR
# 160 kbps, complexity 0 -- the mode this bitrate always selected anyway. That
# application never allocates, initializes or runs the SILK encoder, and
# complexity 0 never runs the tonality analysis. The linker wrappers on
# ds5-bridge redirect those entry points so --gc-sections can discard both
# trees instead of copying them to SRAM. The stack protector is disabled: its
# canaries sat in every codec hot loop, while the hardening checks
# (OPUS_HARDENING) stay enabled. (Ported from upstream 2.0, 75cc3d6.)
set(OPUS_STACK_PROTECTOR OFF CACHE BOOL "DS5 Bridge keeps Opus hardening without stack canaries" FORCE)
set(OPUS_STACK_PROTECTOR OFF)
add_subdirectory(lib/opus)

# Keep live Opus instructions and numerical tables in SRAM. Per-function
# sections let the linker discard unused routines and tables instead of
# copying whole objects; diagnostic strings stay in flash. Archives relocated
# by older builds (whole-unit .time_critical.opus_* names) are normalized too.
add_custom_command(
        OUTPUT ${CMAKE_BINARY_DIR}/opus_ram_relocate.stamp
        COMMAND ${CMAKE_COMMAND}
                "-DARCHIVE=$<TARGET_FILE:opus>"
                "-DOBJDUMP=${CMAKE_OBJDUMP}"
                "-DOBJCOPY=${CMAKE_OBJCOPY}"
                -P "${CMAKE_SOURCE_DIR}/cmake/relocate_opus_sections.cmake"
        COMMAND ${CMAKE_COMMAND} -E touch ${CMAKE_BINARY_DIR}/opus_ram_relocate.stamp
        DEPENDS $<TARGET_FILE:opus>
                "${CMAKE_SOURCE_DIR}/cmake/relocate_opus_sections.cmake"
                "${CMAKE_SOURCE_DIR}/cmake/opus_sections.cmake"
        COMMENT "Placing Opus code/tables in SRAM and diagnostic strings in flash"
        VERBATIM
)
add_custom_target(opus_ram_relocate ALL DEPENDS ${CMAKE_BINARY_DIR}/opus_ram_relocate.stamp)
add_dependencies(ds5-bridge opus_ram_relocate)

# Opus' hardening failure path normally formats a diagnostic through fprintf.
# src/panic_hook.cpp supplies a stamped-reset implementation instead, and the
# forced include discards the message and source-path strings before they are
# emitted while the hardening checks keep running.
target_compile_definitions(opus PRIVATE OVERRIDE_celt_fatal)
target_compile_options(opus PRIVATE -O2 -ffunction-sections -fdata-sections)
target_compile_options(opus PRIVATE
        # SHELL: splits on whitespace, so quote the path (checkouts can contain spaces).
        "SHELL:-include \"${CMAKE_CURRENT_SOURCE_DIR}/cmake/opus_fatal_override.h\""
        # The rewritten celt_fatal prototype loses its parameter list in C.
        -Wno-strict-prototypes)
target_link_options(ds5-bridge PRIVATE
        "LINKER:--wrap=silk_Encode"
        "LINKER:--wrap=silk_InitEncoder"
        "LINKER:--wrap=run_analysis"
        "LINKER:--wrap=tonality_analysis_init"
        "LINKER:--wrap=tonality_analysis_reset"
        "LINKER:--wrap=tonality_get_info"
)

target_compile_options(wdl_resampler PRIVATE -fsigned-char -ffunction-sections)
add_custom_command(TARGET wdl_resampler POST_BUILD
        COMMAND ${CMAKE_OBJCOPY}
                --rename-section .text._ZN13WDL_Resampler11ResampleOutEPfiii=.time_critical.WDL_ResampleOut
                --rename-section .text._ZN13WDL_Resampler15ResamplePrepareEiiPPf=.time_critical.WDL_ResamplePrepare
                $<TARGET_FILE:wdl_resampler>
        COMMENT "Relocating WDL_Resampler hot path to .time_critical.*"
        VERBATIM
)
target_compile_options(ds5-bridge PRIVATE -fsigned-char)
target_compile_definitions(wdl_resampler PRIVATE
        WDL_RESAMPLE_TYPE=float
)
if(SYS_CLOCK_KHZ_VALUE GREATER 266000)
    set(PICO_FLASH_SPI_CLKDIV 4)
else()
    set(PICO_FLASH_SPI_CLKDIV 2)
endif()
if(TARGET bs2_default)
    target_compile_definitions(bs2_default PRIVATE
            PICO_FLASH_SPI_CLKDIV=${PICO_FLASH_SPI_CLKDIV}
    )
endif()
target_compile_definitions(ds5-bridge PRIVATE
        CYW43_LWIP=0
        PICO_EMBED_XIP_SETUP=1
        # BOOTSEL polling floats QSPI CSn briefly; flash_safe_execute() must
        # park core 1 while that happens.
        PICO_FLASH_ASSUME_CORE1_SAFE=0
        # Put TinyUSB's RP2 IRQ path (handler, buffer start and completion) in
        # SRAM; every input-report completion otherwise ran from flash.
        # (Ported from upstream 2.0, 51de2da.)
        PICO_RP2040_USB_FAST_IRQ=1
        WDL_RESAMPLE_TYPE=float
        CYW43_PIO_CLOCK_DIV_INT=${CYW43_PIO_CLOCK_DIV_VALUE}
        SYS_CLOCK_KHZ=${SYS_CLOCK_KHZ_VALUE}
        # Core 0 previously ran on the SDK's unguarded 2 KiB scratch stack and could
        # silently grow across both scratch banks toward whatever sat below. Give it the
        # final 7 KiB of the contiguous scratch banks with the ARMv8-M MSPLIM guard, so
        # an overflow faults (and resets through fault_hooks) instead of corrupting
        # memory. Core 1 keeps its dedicated guarded audio stack in main RAM. The
        # matching region layout lives in cmake/linker/memmap_ds5_core0_stack.ld.
        # (Ported from upstream 2.0, 70dc3d6.)
        PICO_STACK_SIZE=7168
        PICO_CORE1_STACK_SIZE=0
        PICO_USE_STACK_GUARDS=1
)
pico_set_linker_script(ds5-bridge ${CMAKE_CURRENT_SOURCE_DIR}/cmake/linker/memmap_ds5_core0_stack.ld)
# Kitsune Input intentionally enumerates as a stock DualSense only. Never turn
# this on: DualSense Edge USB identity/descriptors are not a supported persona.
option(ENABLE_DSE "Unsupported: do not enable DualSense Edge USB enumeration" OFF)
if(ENABLE_DSE)
    message(FATAL_ERROR "ENABLE_DSE is intentionally disabled. Kitsune Input must never enumerate as DualSense Edge.")
endif()

option(ENABLE_COMPANION "Enable the optional companion HID interface" OFF)
if(ENABLE_COMPANION)
    target_sources(ds5-bridge PRIVATE
            src/companion.cpp
            src/host_bridge.cpp
            src/usb_app_drivers.cpp
            src/bootloader_maintenance.cpp
            src/bootloader_authorization_flash.cpp
    )
    target_compile_definitions(ds5-bridge PRIVATE
            ENABLE_COMPANION
    )
    # Bootloader authorization: HMAC-SHA256 on the RP2350 SHA block, hardware RNG for
    # challenges/sequences, and a flash-backed enrollment record.
    target_link_libraries(ds5-bridge pico_sha256 pico_rand pico_flash hardware_flash)
endif()

# Run the firmware's steady-state work from SRAM, not through the 16 KB XIP cache. Code in
# flash stalls on every cache miss, and stops entirely while the firmware writes flash
# (settings, pairing keys). (Ported from upstream 2.0, 51de2da and 17fbaba, adapted to the
# fork's object set.)
#
# Per-function relocations first: they cover the few routines whose objects stay in flash,
# and they expect the original section names.
function(relocate_to_ram _suffix _renames _comment)
    add_custom_command(TARGET ds5-bridge PRE_LINK
            COMMAND ${CMAKE_COMMAND}
                    "-DOBJROOT=${CMAKE_BINARY_DIR}/CMakeFiles/ds5-bridge.dir"
                    "-DOBJCOPY=${CMAKE_OBJCOPY}"
                    "-DOBJDUMP=${CMAKE_OBJDUMP}"
                    "-DSUFFIX=${_suffix}"
                    "-DRENAMES=${_renames}"
                    -P "${CMAKE_SOURCE_DIR}/cmake/relocate_to_ram.cmake"
            COMMENT "${_comment}"
            VERBATIM
    )
endfunction()

relocate_to_ram(
        src/rp2_common/hardware_irq/irq.c.o
        ".text.irq_set_enabled=.time_critical.irq_set_enabled"
        "Relocating the IRQ enable helper to SRAM"
)
# usb_descriptors.c stays in flash (enumeration only), but these are asked on every input
# report. Found by tools/sram-flash-calls.py.
relocate_to_ram(
        src/usb_descriptors.c.o
        ".text.host_persona_descriptors_verified=.time_critical.host_persona_descriptors_verified"
        "Relocating host-persona verification to SRAM"
)
if(ENABLE_COMPANION)
    relocate_to_ram(
            src/usb_descriptors.c.o
            ".text.host_bridge_companion_only=.time_critical.host_bridge_companion_only@.text.host_bridge_set_companion_only=.time_critical.host_bridge_set_companion_only"
            "Relocating the companion-only USB mode flag to SRAM"
    )
endif()
relocate_to_ram(
        src/rp2_common/hardware_clocks/clocks.c.o
        ".text.clock_get_hz=.time_critical.clock_get_hz"
        "Relocating CYW43 bus clock query to SRAM"
)
# Core 1's double-precision math. The SRAM-resident Opus encoder calls cos per quantized band,
# exp/log/acos/atan2 and double arithmetic per frame, and floor/sqrt per sample or band in both
# codec directions. pico_double links these in flash by default, so every speaker frame left SRAM.
relocate_to_ram(
        src/rp2_common/pico_double/double_sci_m33.S.o
        ".text.__wrap_sin_cos=.time_critical.double_sin_cos@.text.drrcore=.time_critical.double_range_reduce_core@.text.rtwopi=.time_critical.double_two_over_pi@.text.dpack=.time_critical.double_pack@.text.dreduce=.time_critical.double_reduce@.text.exptab=.time_critical.double_exptab@.text.__wrap_exp=.time_critical.double_exp@.text.__wrap_log=.time_critical.double_log@.text.trigtab=.time_critical.double_trigtab@.text.__wrap_atan2=.time_critical.double_atan2"
        "Relocating Opus double sin/cos, exp, log and atan2 to SRAM"
)
relocate_to_ram(
        src/rp2_common/pico_double/double_aeabi_dcp.S.o
        ".text.__rp2350_dcp_engaged_state_save_restore=.time_critical.double_dcp_state@.text.__wrap___aeabi_dadd=.time_critical.double_add@.text.__wrap___aeabi_dsub=.time_critical.double_sub@.text.__wrap___aeabi_drsub=.time_critical.double_rsub@.text.__wrap___aeabi_dmul=.time_critical.double_mul@.text.ddiv_fast=.time_critical.double_div_fast@.text.__wrap___aeabi_ddiv=.time_critical.double_div@.text.sqrt_fast=.time_critical.double_sqrt_fast@.text.__wrap_sqrt=.time_critical.double_sqrt@.text.dclassify=.time_critical.double_classify@.text.__wrap___aeabi_d2f=.time_critical.double_to_float@.text.__wrap___aeabi_i2d=.time_critical.int_to_double@.text.double2int=.time_critical.double_to_int_impl@.text.__wrap___aeabi_d2iz=.time_critical.double_to_int@.text.__wrap___aeabi_dcmp=.time_critical.double_compare@.text.__wrap___aeabi_dcmpun=.time_critical.double_compare_unordered@.text.__wrap___aeabi_dcmpeq=.time_critical.double_compare_eq@.text.__wrap___aeabi_dcmplt=.time_critical.double_compare_lt@.text.__wrap___aeabi_dcmple=.time_critical.double_compare_le@.text.__wrap___aeabi_dcmpge=.time_critical.double_compare_ge@.text.__wrap___aeabi_dcmpgt=.time_critical.double_compare_gt"
        "Relocating Opus double arithmetic and sqrt to SRAM"
)
relocate_to_ram(
        src/rp2_common/pico_double/double_math.c.o
        ".text.__wrap_floor=.time_critical.double_floor@.text.__wrap_acos=.time_critical.double_acos"
        "Relocating Opus double floor and acos to SRAM"
)

# Whole objects whose code runs during play: the main loop and its phases, Bluetooth and USB
# glue, game output, the companion runtime, the BTstack HCI/L2CAP/run loop, the CYW43 radio
# driver, the TinyUSB device stack and the SDK timing, GPIO, PIO, watchdog and sync helpers.
# Boot, pairing (SDP), flash storage, bootloader maintenance, USB descriptors and the failure
# paths stay in flash. The script fails the build if an object is missing or keeps flash code.
function(relocate_objects_to_ram _suffixes _comment)
    add_custom_command(TARGET ds5-bridge PRE_LINK
            COMMAND ${CMAKE_COMMAND}
                    "-DOBJROOT=${CMAKE_BINARY_DIR}/CMakeFiles/ds5-bridge.dir"
                    "-DOBJCOPY=${CMAKE_OBJCOPY}"
                    "-DOBJDUMP=${CMAKE_OBJDUMP}"
                    "-DSUFFIXES=${_suffixes}"
                    -P "${CMAKE_SOURCE_DIR}/cmake/relocate_objects_to_ram.cmake"
            COMMENT "${_comment}"
            VERBATIM
    )
endfunction()

relocate_objects_to_ram(
        "src/main.cpp.o@src/bt.cpp.o@src/usb.cpp.o@src/audio.cpp.o@src/watchdog_telemetry.cpp.o@src/button_functions.cpp.o@src/dualsense_input_decoder.cpp.o@src/persona/host_persona.cpp.o@src/persona/dualsense_persona.cpp.o@src/persona/ds4_persona.cpp.o@src/persona/xusb360_persona.cpp.o@src/persona/xusb360_usb.cpp.o@src/controller_packet_compositor.cpp.o@src/controller_output_policy.cpp.o@src/controller_output_rumble_state.cpp.o@src/controller_output_state.cpp.o@src/haptics_test_signal.cpp.o"
        "Relocating the firmware's runtime objects to SRAM"
)
if(ENABLE_COMPANION)
    relocate_objects_to_ram(
            "src/companion.cpp.o@src/host_bridge.cpp.o"
            "Relocating the companion runtime objects to SRAM"
    )
endif()
# Fork additions beyond upstream's lists, all found by tools/sram-flash-calls.py on the
# per-packet path: hci_dump.c (every HCI packet), pico_util/queue.c (every audio packet, both
# cores -- the fork's audio queues are the SDK's), and usbd_control.c (control transfers,
# including the output reports Windows Steam sends as SET_REPORT).
relocate_objects_to_ram(
        "lib/btstack/src/hci.c.o@lib/btstack/src/hci_cmd.c.o@lib/btstack/src/hci_dump.c.o@lib/btstack/src/l2cap.c.o@lib/btstack/src/l2cap_signaling.c.o@lib/btstack/src/btstack_util.c.o@lib/btstack/src/btstack_run_loop.c.o@lib/btstack/src/btstack_linked_list.c.o@lib/btstack/src/btstack_memory.c.o@lib/btstack/src/btstack_memory_pool.c.o@src/rp2_common/pico_btstack/btstack_run_loop_async_context.c.o"
        "Relocating the BTstack HCI, L2CAP and run loop to SRAM"
)
relocate_objects_to_ram(
        "lib/cyw43-driver/src/cyw43_ll.c.o@lib/cyw43-driver/src/cyw43_ctrl.c.o@src/rp2_common/pico_cyw43_driver/cybt_shared_bus/cybt_shared_bus_driver.c.o@src/rp2_common/pico_cyw43_driver/cybt_shared_bus/cybt_shared_bus.c.o@src/rp2_common/pico_cyw43_driver/cyw43_bus_pio_spi.c.o@src/rp2_common/pico_cyw43_driver/btstack_hci_transport_cyw43.c.o@src/rp2_common/pico_cyw43_driver/cyw43_driver.c.o@src/rp2_common/pico_cyw43_arch/cyw43_arch.c.o@src/rp2_common/pico_cyw43_arch/cyw43_arch_poll.c.o"
        "Relocating the CYW43 radio driver to SRAM"
)
relocate_objects_to_ram(
        "lib/tinyusb/src/tusb.c.o@lib/tinyusb/src/common/tusb_fifo.c.o@lib/tinyusb/src/device/usbd.c.o@lib/tinyusb/src/device/usbd_control.c.o@lib/tinyusb/src/class/audio/audio_device.c.o@lib/tinyusb/src/class/hid/hid_device.c.o@lib/tinyusb/src/class/vendor/vendor_device.c.o@lib/tinyusb/src/portable/raspberrypi/rp2040/dcd_rp2040.c.o@lib/tinyusb/src/portable/raspberrypi/rp2040/rp2040_usb.c.o"
        "Relocating the TinyUSB device stack to SRAM"
)
relocate_objects_to_ram(
        "src/common/pico_time/time.c.o@src/common/pico_util/queue.c.o@src/rp2_common/hardware_timer/timer.c.o@src/rp2_common/hardware_gpio/gpio.c.o@src/rp2_common/hardware_pio/pio.c.o@src/rp2_common/hardware_watchdog/watchdog.c.o@src/rp2_common/pico_async_context/async_context_base.c.o@src/rp2_common/pico_async_context/async_context_poll.c.o@src/common/pico_sync/mutex.c.o@src/common/pico_sync/sem.c.o@src/common/pico_sync/critical_section.c.o@src/common/pico_sync/lock_core.c.o"
        "Relocating SDK timing, GPIO, PIO, watchdog and sync helpers to SRAM"
)

# These strong RAM-resident definitions replace newlib's flash-backed memory operations.
# Prevent the compiler from lowering their loops back into recursive calls to the functions
# being defined.
set_source_files_properties(src/ram_mem.c PROPERTIES COMPILE_OPTIONS
        "-fno-builtin;-fno-tree-loop-distribute-patterns"
)

# Diagnostics live in one place. Quick presets:
#   -DDS5_DIAGNOSTICS_PRESET=off    release default
#   -DDS5_DIAGNOSTICS_PRESET=audio  audio ring/stats reports
#   -DDS5_DIAGNOSTICS_PRESET=traces audio + trigger + feedback trace reports
#   -DDS5_DIAGNOSTICS_PRESET=all    traces + UART/BTstack logs
#   -DDS5_DIAGNOSTICS_PRESET=custom honor the legacy individual flags below
set(DS5_DIAGNOSTICS_PRESET "off" CACHE STRING "Diagnostics preset: off, audio, traces, all, custom")
set_property(CACHE DS5_DIAGNOSTICS_PRESET PROPERTY STRINGS off audio traces all custom)
option(ENABLE_DEBUG_LOGS "Enable UART stdio and verbose firmware/BTstack debug logging" OFF)
option(ENABLE_COMPANION_DEBUG "Legacy custom-mode alias for audio debug reports" OFF)
option(ENABLE_AUDIO_DEBUG_REPORTS "Legacy custom-mode companion HID audio debug ring/stats reports" OFF)
option(ENABLE_TRIGGER_TRACE_REPORTS "Legacy custom-mode companion HID adaptive trigger trace report" OFF)
option(ENABLE_FEEDBACK_TRACE_REPORTS "Legacy custom-mode companion HID rumble/haptics feedback trace report" OFF)

set(DS5_ENABLE_FIRMWARE_LOGS OFF)
set(DS5_ENABLE_AUDIO_DEBUG_REPORTS OFF)
set(DS5_ENABLE_TRIGGER_TRACE_REPORTS OFF)
set(DS5_ENABLE_FEEDBACK_TRACE_REPORTS OFF)

if(DS5_DIAGNOSTICS_PRESET STREQUAL "audio")
    set(DS5_ENABLE_AUDIO_DEBUG_REPORTS ON)
elseif(DS5_DIAGNOSTICS_PRESET STREQUAL "traces")
    set(DS5_ENABLE_AUDIO_DEBUG_REPORTS ON)
    set(DS5_ENABLE_TRIGGER_TRACE_REPORTS ON)
    set(DS5_ENABLE_FEEDBACK_TRACE_REPORTS ON)
elseif(DS5_DIAGNOSTICS_PRESET STREQUAL "all")
    set(DS5_ENABLE_FIRMWARE_LOGS ON)
    set(DS5_ENABLE_AUDIO_DEBUG_REPORTS ON)
    set(DS5_ENABLE_TRIGGER_TRACE_REPORTS ON)
    set(DS5_ENABLE_FEEDBACK_TRACE_REPORTS ON)
elseif(DS5_DIAGNOSTICS_PRESET STREQUAL "custom")
    set(DS5_ENABLE_FIRMWARE_LOGS ${ENABLE_DEBUG_LOGS})
    set(DS5_ENABLE_AUDIO_DEBUG_REPORTS ${ENABLE_AUDIO_DEBUG_REPORTS})
    set(DS5_ENABLE_TRIGGER_TRACE_REPORTS ${ENABLE_TRIGGER_TRACE_REPORTS})
    set(DS5_ENABLE_FEEDBACK_TRACE_REPORTS ${ENABLE_FEEDBACK_TRACE_REPORTS})
    if(ENABLE_COMPANION_DEBUG)
        set(DS5_ENABLE_AUDIO_DEBUG_REPORTS ON)
    endif()
elseif(NOT DS5_DIAGNOSTICS_PRESET STREQUAL "off")
    message(FATAL_ERROR "DS5_DIAGNOSTICS_PRESET must be one of: off, audio, traces, all, custom")
endif()

message(STATUS "DS5 diagnostics: preset=${DS5_DIAGNOSTICS_PRESET}; logs=${DS5_ENABLE_FIRMWARE_LOGS}; audio=${DS5_ENABLE_AUDIO_DEBUG_REPORTS}; trigger=${DS5_ENABLE_TRIGGER_TRACE_REPORTS}; feedback=${DS5_ENABLE_FEEDBACK_TRACE_REPORTS}")

if(DS5_ENABLE_FIRMWARE_LOGS)
    target_compile_definitions(ds5-bridge PRIVATE
            DS5_ENABLE_DEBUG_LOGS
            DS5_DEBUG_LOGS_ENABLED=1
    )
else()
    # Release builds have no stdio sink. The CYW43 driver's CYW43_PRINTF sites were the only
    # printf callers, several of them inside the now SRAM-resident radio driver; compiling them
    # out drops the SDK printf implementation from flash. (Ported from upstream 2.0, 75cc3d6.)
    target_compile_definitions(ds5-bridge PRIVATE PICO_CYW43_LOGGING_ENABLED=0)
endif()

if(DS5_ENABLE_AUDIO_DEBUG_REPORTS)
    target_compile_definitions(ds5-bridge PRIVATE
            DS5_AUDIO_DEBUG_ENABLED=1
    )
endif()

if(DS5_ENABLE_TRIGGER_TRACE_REPORTS)
    target_compile_definitions(ds5-bridge PRIVATE
            DS5_TRIGGER_TRACE_ENABLED=1
    )
endif()

if(DS5_ENABLE_FEEDBACK_TRACE_REPORTS)
    target_compile_definitions(ds5-bridge PRIVATE
            DS5_FEEDBACK_TRACE_ENABLED=1
    )
endif()

# Pairing diagnostics build: attach USB from boot (so the companion interface
# and DEVICE_IDENTITY breadcrumbs are readable even with no controller paired)
# and skip the reboot-on-disconnect (so the in-RAM pairing-event ring survives
# a failed pairing for readout). Never ship this.
option(DS5_PAIRING_DIAG "Diagnostic build for pairing failures (USB stays up at boot and through disconnect)" OFF)
if(DS5_PAIRING_DIAG)
    target_compile_definitions(ds5-bridge PRIVATE DS5_PAIRING_DIAG=1)
endif()

pico_set_program_name(ds5-bridge "ds5-bridge")

# THE firmware version. Every other copy derives from these three numbers: the program-info
# string below, and the kFirmware{Major,Minor,Patch} bytes companion.cpp puts in the STATUS
# report -- the bytes the app actually displays. 1.6.69 shipped with this split three ways and
# the STATUS copy still said 68, so a freshly flashed bridge reported the old version.
# tools/check-firmware-version-sync.mjs parses these set() lines and fails CI on drift.
set(DS5_BRIDGE_VERSION_MAJOR 1)
set(DS5_BRIDGE_VERSION_MINOR 6)
set(DS5_BRIDGE_VERSION_PATCH 80)
set(DS5_BRIDGE_VERSION "${DS5_BRIDGE_VERSION_MAJOR}.${DS5_BRIDGE_VERSION_MINOR}.${DS5_BRIDGE_VERSION_PATCH}")
pico_set_program_version(ds5-bridge "${DS5_BRIDGE_VERSION}")
target_compile_definitions(ds5-bridge PRIVATE
    DS5_BRIDGE_VERSION_MAJOR=${DS5_BRIDGE_VERSION_MAJOR}
    DS5_BRIDGE_VERSION_MINOR=${DS5_BRIDGE_VERSION_MINOR}
    DS5_BRIDGE_VERSION_PATCH=${DS5_BRIDGE_VERSION_PATCH}
)

if(DS5_ENABLE_FIRMWARE_LOGS)
    pico_enable_stdio_uart(ds5-bridge 1)
else()
    pico_enable_stdio_uart(ds5-bridge 0)
endif()
pico_enable_stdio_usb(ds5-bridge 0)

target_include_directories(${PROJECT_NAME} PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# Add any user requested libraries
target_link_libraries(ds5-bridge
        pico_stdlib
        pico_multicore
        hardware_watchdog
        hardware_timer
        pico_btstack_classic
        pico_cyw43_arch_poll
        pico_btstack_cyw43
        tinyusb_device
        tinyusb_board
        wdl_resampler
        opus
)

# Redirect panic() to src/panic_hook.cpp so a panic leaves a breadcrumb instead of looking
# like an ordinary main-loop stall. Applied at link time because the SDK's PICO_PANIC_FUNCTION
# define is consumed when it compiles its own panic.c, not by our target.
# The USB send-path and flash-stall wraps were removed in 1.6.67; both questions were answered
# and the send-path ones ran on every HID report and audio packet. See docs/diagnostic-scaffolding.md.
target_link_options(ds5-bridge PRIVATE
        -Wl,--wrap=panic
)

# Codec and resampler startup allocate 54,872 bytes: the restricted-CELT stereo encoder, the
# mono mic decoder and both resamplers' preallocation. This is upstream 2.0's measured figure
# (75cc3d6) for the identical configuration -- same Opus build, same create/Prealloc calls in
# audio.cpp. Keep another 8 KiB after them so a successful link cannot become an OOM boot.
set(DS5_KNOWN_STARTUP_HEAP_BYTES 54872)
set(DS5_MIN_POST_STARTUP_HEAP_BYTES 8192)
math(EXPR DS5_MIN_RUNTIME_HEAP_BYTES
        "${DS5_KNOWN_STARTUP_HEAP_BYTES} + ${DS5_MIN_POST_STARTUP_HEAP_BYTES}"
)

# Check the final image after every link: Opus code, tables and state in SRAM, diagnostic
# strings (if any survive) in flash, the steady-state paths in SRAM, and heap headroom.
add_custom_command(TARGET ds5-bridge POST_BUILD
        COMMAND ${CMAKE_COMMAND}
                "-DMAP=$<TARGET_FILE:ds5-bridge>.map"
                -P "${CMAKE_SOURCE_DIR}/cmake/verify_opus_sections.cmake"
        COMMAND ${CMAKE_COMMAND}
                "-DMAP=$<TARGET_FILE:ds5-bridge>.map"
                -P "${CMAKE_SOURCE_DIR}/cmake/verify_opus_strings.cmake"
        COMMAND ${CMAKE_COMMAND}
                "-DNM=${CMAKE_NM}"
                "-DELF=$<TARGET_FILE:ds5-bridge>"
                "-DCOMPANION_ENABLED=${ENABLE_COMPANION}"
                "-DMIN_HEAP_BYTES=${DS5_MIN_RUNTIME_HEAP_BYTES}"
                "-DKNOWN_STARTUP_HEAP_BYTES=${DS5_KNOWN_STARTUP_HEAP_BYTES}"
                -P "${CMAKE_SOURCE_DIR}/cmake/verify_sram_runtime.cmake"
        COMMENT "Verifying Opus placement, SRAM hot paths and runtime heap headroom"
        VERBATIM
)
set_property(TARGET ds5-bridge APPEND PROPERTY LINK_DEPENDS
        "${CMAKE_SOURCE_DIR}/cmake/verify_opus_sections.cmake"
        "${CMAKE_SOURCE_DIR}/cmake/opus_sections.cmake"
        "${CMAKE_SOURCE_DIR}/cmake/verify_opus_strings.cmake"
        "${CMAKE_SOURCE_DIR}/cmake/verify_sram_runtime.cmake"
)

pico_add_extra_outputs(ds5-bridge)

