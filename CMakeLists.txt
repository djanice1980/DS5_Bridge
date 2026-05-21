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
set(PICO_BOARD pico2_w CACHE STRING "Board type")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(ds5-bridge C CXX ASM)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Add executable. Default name is the project name, version 0.1

add_executable(ds5-bridge
        src/usb_descriptors.c
        src/main.cpp
        src/usb.cpp
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
add_subdirectory(lib/opus)

target_compile_options(wdl_resampler PRIVATE -fsigned-char)
target_compile_options(ds5-bridge PRIVATE -fsigned-char)
target_compile_definitions(wdl_resampler PRIVATE
        WDL_RESAMPLE_TYPE=float
)
target_compile_definitions(ds5-bridge PRIVATE
        CYW43_LWIP=0
        PICO_FLASH_ASSUME_CORE1_SAFE=1
        WDL_RESAMPLE_TYPE=float
        CYW43_PIO_CLOCK_DIV_INT=4
)
option(ENABLE_DSE "Enable DSE" OFF)
if(ENABLE_DSE)
    target_compile_definitions(ds5-bridge PRIVATE
            ENABLE_DSE # Use the DualSense Edge USB PID and product name.
    )
endif()

option(ENABLE_COMPANION "Enable the optional companion HID interface" OFF)
if(ENABLE_COMPANION)
    target_sources(ds5-bridge PRIVATE
            src/companion.cpp
    )
    target_compile_definitions(ds5-bridge PRIVATE
            ENABLE_COMPANION
    )
endif()

option(ENABLE_DEBUG_LOGS "Enable UART stdio and verbose firmware/BTstack debug logging" OFF)
if(ENABLE_DEBUG_LOGS)
    target_compile_definitions(ds5-bridge PRIVATE
            DS5_ENABLE_DEBUG_LOGS
    )
endif()

option(ENABLE_AUDIO_DEBUG_REPORTS "Enable the companion HID audio debug ring report" OFF)
if(ENABLE_AUDIO_DEBUG_REPORTS OR ENABLE_DEBUG_LOGS)
    target_compile_definitions(ds5-bridge PRIVATE
            DS5_ENABLE_AUDIO_DEBUG_REPORTS
    )
endif()

pico_set_program_name(ds5-bridge "ds5-bridge")
pico_set_program_version(ds5-bridge "1.0.1")

if(ENABLE_DEBUG_LOGS)
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

pico_add_extra_outputs(ds5-bridge)

