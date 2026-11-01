# Verify that the linked firmware keeps its steady-state paths in RP2350 SRAM and leaves
# enough heap for codec and resampler startup. Catches section-name or toolchain drift
# that would silently put a hot path back behind the XIP cache.
#
# Structure ported from upstream 2.0's cmake/verify_core1_sram.cmake (51de2da, 17fbaba);
# the symbol list is the fork's own. Whole-object relocation already fails the build if a
# listed object keeps any flash code, so this checks the per-function relocations and one
# or more representatives from each relocated group. tools/sram-flash-calls.py lists the
# calls that still leave SRAM.

foreach(required_value NM ELF MIN_HEAP_BYTES KNOWN_STARTUP_HEAP_BYTES)
    if(NOT DEFINED ${required_value})
        message(FATAL_ERROR "verify_sram_runtime: missing required -D${required_value}")
    endif()
endforeach()

execute_process(
        COMMAND "${NM}" --format=posix "${ELF}"
        RESULT_VARIABLE result
        OUTPUT_VARIABLE symbol_table
        ERROR_VARIABLE symbol_error
)
if(NOT result EQUAL 0)
    message(FATAL_ERROR "verify_sram_runtime: nm failed (rc=${result}): ${symbol_error}")
endif()

set(required_sram_symbols
        # Firmware runtime objects: main loop, input, output, audio, telemetry.
        "main"
        "_Z10on_bt_data12CHANNEL_TYPEPht"
        "_Z14interrupt_loopv"
        "_Z26host_input_report_completev"
        "tud_hid_report_complete_cb"
        "tud_hid_set_report_cb"
        "_Z11usb_pm_pollv"
        "_Z29watchdog_telemetry_note_phase21WatchdogMainLoopPhase"
        "_Z36controller_output_submit_usb_payloadPKht"
        "_Z26bt_write_classified_outputPht"
        "_Z21bt_write_audio_streamPht"
        "_Z10audio_loopv"
        "_ZL11core1_entryv"
        "host_persona_active"
        "host_persona_descriptors_verified"
        # Codec and resampler.
        "opus_encode_float"
        "opus_decode"
        "_ZN13WDL_Resampler11ResampleOutEPfiii"
        "_ZN13WDL_Resampler15ResamplePrepareEiiPPf"
        "__wrap_tonality_analysis_init"
        "__wrap_tonality_analysis_reset"
        "__wrap_tonality_get_info"
        # Core 1's double-precision math reached from the SRAM Opus codec.
        "__wrap_cos"
        "__wrap_sin"
        "__wrap_exp"
        "__wrap_log"
        "__wrap_atan2"
        "__wrap_acos"
        "__wrap_sqrt"
        "__wrap_floor"
        "__wrap___aeabi_dadd"
        "__wrap___aeabi_dsub"
        "__wrap___aeabi_dmul"
        "__wrap___aeabi_ddiv"
        "__wrap___aeabi_d2f"
        "__wrap___aeabi_d2iz"
        "__wrap___aeabi_dcmplt"
        "__wrap___aeabi_dcmpgt"
        # src/ram_mem.c replaces newlib's flash-backed memory operations.
        "memcpy"
        "memset"
        "memmove"
        "memcmp"
        "__memcpy_chk"
        "__memset_chk"
        # Read-only data the per-packet paths read.
        "crc32_lookup_table"
        # Per-function SDK relocations.
        "irq_set_enabled"
        "clock_get_hz"
        # BTstack.
        "hci_run"
        "packet_handler"
        "hci_dump_packet"
        "l2cap_run"
        "l2cap_send"
        "btstack_linked_list_iterator_next"
        "btstack_run_loop_async_context_get_time_ms"
        # CYW43 radio driver.
        "cyw43_poll_func"
        "cyw43_arch_poll"
        "cyw43_ll_sdpcm_poll_device"
        "cyw43_ll_process_packets"
        "cyw43_spi_transfer"
        "cyw43_bluetooth_hci_read"
        "cybt_hci_read"
        "hci_transport_cyw43_send_packet"
        # TinyUSB device stack.
        "tud_task_ext"
        "usbd_edpt_xfer"
        "tud_control_xfer"
        "dcd_rp2040_irq"
        "tud_audio_n_read"
        "tud_hid_n_report"
        # SDK timing, queues, GPIO, watchdog and sync.
        "time_us_64"
        "queue_try_add"
        "queue_try_remove"
        "gpio_set_function"
        "watchdog_update"
        "mutex_enter_blocking"
)
if(COMPANION_ENABLED)
    list(APPEND required_sram_symbols
            "_Z14companion_loopv"
            "_Z35companion_process_controller_reportPht"
            "host_bridge_companion_only"
    )
endif()

# RP2350 SRAM spans [0x20000000, 0x20082000).
set(rp2350_sram_start 536870912)
set(rp2350_sram_end 537403392)

foreach(symbol ${required_sram_symbols})
    string(REGEX REPLACE "([.$])" "[\\1]" escaped_symbol "${symbol}")
    string(REGEX MATCH "(^|\n)${escaped_symbol} [A-Za-z] ([0-9A-Fa-f]+)" symbol_match "${symbol_table}")
    if(NOT symbol_match)
        message(FATAL_ERROR "verify_sram_runtime: missing linked symbol '${symbol}'")
    endif()
    math(EXPR symbol_address "0x${CMAKE_MATCH_2}")
    if(symbol_address LESS ${rp2350_sram_start} OR NOT symbol_address LESS ${rp2350_sram_end})
        message(FATAL_ERROR "verify_sram_runtime: '${symbol}' linked outside SRAM at 0x${CMAKE_MATCH_2}")
    endif()

    # GCC can split a guarded function and move most of its body into a .part/.constprop/.isra
    # clone, which keeps its own section and can land in flash while the named entry point
    # stays in SRAM. Cold partitions are exempt: they hold the paths the compiler expects
    # never to run.
    string(REGEX MATCHALL
            "(^|\n)${escaped_symbol}[.](part|constprop|isra)[.][0-9]+[^ \n]* [A-Za-z] [0-9A-Fa-f]+"
            clone_matches
            "${symbol_table}"
    )
    foreach(clone_match IN LISTS clone_matches)
        if(clone_match MATCHES "[.]cold[ .]")
            continue()
        endif()
        string(REGEX MATCH "([0-9A-Fa-f]+)$" clone_address_match "${clone_match}")
        math(EXPR clone_address "0x${CMAKE_MATCH_1}")
        if(clone_address LESS ${rp2350_sram_start} OR NOT clone_address LESS ${rp2350_sram_end})
            string(STRIP "${clone_match}" clone_match)
            message(FATAL_ERROR "verify_sram_runtime: clone of '${symbol}' linked outside SRAM: ${clone_match}")
        endif()
    endforeach()
endforeach()

string(REGEX MATCH "(^|\n)end [A-Za-z] ([0-9A-Fa-f]+)" heap_start_match "${symbol_table}")
if(NOT heap_start_match)
    message(FATAL_ERROR "verify_sram_runtime: missing linked heap start symbol 'end'")
endif()
set(heap_start_address "0x${CMAKE_MATCH_2}")

string(REGEX MATCH "(^|\n)__HeapLimit [A-Za-z] ([0-9A-Fa-f]+)" heap_limit_match "${symbol_table}")
if(NOT heap_limit_match)
    message(FATAL_ERROR "verify_sram_runtime: missing linked symbol '__HeapLimit'")
endif()
set(heap_limit_address "0x${CMAKE_MATCH_2}")

math(EXPR runtime_heap_bytes "${heap_limit_address} - ${heap_start_address}")
math(EXPR post_startup_heap_bytes "${runtime_heap_bytes} - ${KNOWN_STARTUP_HEAP_BYTES}")
if(runtime_heap_bytes LESS MIN_HEAP_BYTES)
    message(FATAL_ERROR
            "verify_sram_runtime: runtime heap ${runtime_heap_bytes} bytes is below the required ${MIN_HEAP_BYTES} bytes (end=${heap_start_address}, limit=${heap_limit_address})"
    )
endif()

list(LENGTH required_sram_symbols checked_symbols)
message(STATUS
        "Verified ${checked_symbols} steady-state symbols in SRAM, ${runtime_heap_bytes} bytes startup heap, ${post_startup_heap_bytes} bytes post-startup headroom"
)
