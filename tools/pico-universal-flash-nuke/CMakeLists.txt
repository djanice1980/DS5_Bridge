cmake_minimum_required(VERSION 3.13)

# Same toolchain shim as the top-level CMakeLists. Without it a local Windows build finds no
# prebuilt picotool, so the SDK tries to compile picotool from source -- which needs a HOST
# C++ compiler that a Pico-only toolchain install does not provide. The failure surfaces
# during the BUILD (as a nested configure error about CMAKE_CXX_COMPILER), not during
# configure, which makes it read like a broken toolchain rather than a missing hint.
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

include(${CMAKE_CURRENT_LIST_DIR}/../../pico_sdk_import.cmake)

project(ds5_bridge_pico_universal_flash_nuke C CXX ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

pico_sdk_init()

add_executable(flash_nuke
        nuke.c
        flash.c
)

target_link_libraries(flash_nuke
        pico_stdlib
        hardware_flash
)

# Dummy PICO_FLASH_SIZE_BYTES so flash_range_erase does not assert before the
# runtime JEDEC flash-size probe determines the real erase length.
target_compile_definitions(flash_nuke PRIVATE
        PICO_FLASH_SIZE_BYTES=33554432
)

# The nuke erases external flash, so it must always run from SRAM.
pico_set_binary_type(flash_nuke no_flash)

pico_add_extra_outputs(flash_nuke)
