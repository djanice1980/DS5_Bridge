cmake_minimum_required(VERSION 3.20)

project(ds5_bridge_firmware_tests LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(firmware_logic_tests
    firmware_logic_tests.cpp
    ../../src/dualsense_input_decoder.cpp
    ../../src/feature_report_cache.cpp
    ../../src/persona/host_persona.cpp
    ../../src/persona/dualsense_persona.cpp
    ../../src/persona/ds4_persona.cpp
    ../../src/persona/xusb360_persona.cpp
    ../../src/controller_output_policy.cpp
    ../../src/controller_output_rumble_state.cpp
    ../../src/controller_output_state.cpp
    ../../src/controller_packet_compositor.cpp
    ../../src/haptics_test_signal.cpp
)

target_include_directories(firmware_logic_tests PRIVATE
    ../../src
)

add_executable(usb_descriptor_migration_test
    usb_descriptor_migration_test.cpp
)

target_compile_definitions(usb_descriptor_migration_test PRIVATE
    DS5_SOURCE_ROOT="${CMAKE_CURRENT_LIST_DIR}/../.."
)

if(MSVC)
    target_compile_options(firmware_logic_tests PRIVATE /W4)
else()
    target_compile_options(firmware_logic_tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()
add_test(NAME firmware_logic_tests COMMAND firmware_logic_tests)
add_test(NAME usb_descriptor_migration_test COMMAND usb_descriptor_migration_test)

add_executable(bootloader_maintenance_test
    bootloader_maintenance_test.cpp
    ../../src/bootloader_maintenance.cpp
)
target_include_directories(bootloader_maintenance_test PRIVATE ../../src)
add_test(NAME bootloader_maintenance_test COMMAND bootloader_maintenance_test)

add_executable(controller_input_delivery_test
    controller_input_delivery_test.cpp
    ../../src/dualsense_input_decoder.cpp
    ../../src/persona/dualsense_persona.cpp
)
target_include_directories(controller_input_delivery_test PRIVATE ../../src)
add_test(NAME controller_input_delivery_test COMMAND controller_input_delivery_test)

# Opus section classification and final-map placement guard (ported from upstream 2.0, 75cc3d6).
add_test(NAME opus_section_placement_test COMMAND ${CMAKE_COMMAND}
    -DOUTPUT_DIR=${CMAKE_CURRENT_BINARY_DIR}/opus-section-placement-test
    -P ${CMAKE_CURRENT_LIST_DIR}/opus_section_placement_test.cmake)

# The production SRAM memory operations, compiled under renamed symbols so they can be
# compared with the host C library. (Ported from upstream 2.0, 51de2da.)
add_library(ds5_ram_mem STATIC ../../src/ram_mem.c)
target_include_directories(ds5_ram_mem PRIVATE stubs/ram_mem)
target_compile_definitions(ds5_ram_mem PRIVATE
    memcpy=ds5_ram_memcpy
    memset=ds5_ram_memset
    memmove=ds5_ram_memmove
    memcmp=ds5_ram_memcmp
    __memcpy_chk=ds5_ram_memcpy_chk
    __memset_chk=ds5_ram_memset_chk
    __chk_fail=ds5_ram_chk_fail
)
add_executable(ram_mem_test ram_mem_test.cpp)
target_link_libraries(ram_mem_test PRIVATE ds5_ram_mem)
add_test(NAME ram_mem_test COMMAND ram_mem_test)

add_executable(bounded_containers_test bounded_containers_test.cpp)
target_include_directories(bounded_containers_test PRIVATE ../../src)
add_test(NAME bounded_containers_test COMMAND bounded_containers_test)

add_executable(home_chord_gate_test home_chord_gate_test.cpp)
target_include_directories(home_chord_gate_test PRIVATE ../../src)
add_test(NAME home_chord_gate_test COMMAND home_chord_gate_test)
