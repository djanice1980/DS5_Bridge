cmake_minimum_required(VERSION 3.20)

project(ds5_bridge_firmware_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(firmware_logic_tests
    firmware_logic_tests.cpp
    ../../src/controller_output_policy.cpp
    ../../src/controller_output_state.cpp
    ../../src/controller_packet_compositor.cpp
    ../../src/haptics_test_signal.cpp
    ../../src/output_scheduler.cpp
)

target_include_directories(firmware_logic_tests PRIVATE
    ../../src
)

if(MSVC)
    target_compile_options(firmware_logic_tests PRIVATE /W4)
else()
    target_compile_options(firmware_logic_tests PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()
add_test(NAME firmware_logic_tests COMMAND firmware_logic_tests)
