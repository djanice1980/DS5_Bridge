#include <cstdint>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

constexpr uint16_t kExpectedUsbDeviceRevision = 0x0153;
constexpr uint64_t kExpectedCompanionDescriptorHash = 0x4f0540e7fbbbddcbull;

std::string read_text(std::filesystem::path const &path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("Unable to open " + path.string());
    }
    std::ostringstream stream;
    stream << input.rdbuf();
    std::string text = stream.str();
    text = std::regex_replace(text, std::regex("\r\n?"), "\n");
    return text;
}

std::string extract_between(
    std::string const &source,
    std::string const &start_marker,
    std::string const &end_marker
) {
    const auto start = source.find(start_marker);
    if (start == std::string::npos) {
        throw std::runtime_error("Missing marker: " + start_marker);
    }
    const auto end = source.find(end_marker, start);
    if (end == std::string::npos) {
        throw std::runtime_error("Missing end marker after: " + start_marker);
    }
    return source.substr(start, end - start);
}

std::string remove_comments(std::string const &text) {
    std::string output;
    output.reserve(text.size());

    bool in_line_comment = false;
    bool in_block_comment = false;
    for (std::size_t index = 0; index < text.size(); ++index) {
        const char current = text[index];
        const char next = index + 1 < text.size() ? text[index + 1] : '\0';

        if (in_line_comment) {
            if (current == '\n') {
                in_line_comment = false;
                output.push_back(current);
            }
            continue;
        }

        if (in_block_comment) {
            if (current == '*' && next == '/') {
                in_block_comment = false;
                ++index;
            }
            continue;
        }

        if (current == '/' && next == '/') {
            in_line_comment = true;
            ++index;
            continue;
        }

        if (current == '/' && next == '*') {
            in_block_comment = true;
            ++index;
            continue;
        }

        output.push_back(current);
    }

    return output;
}

std::string normalize_for_hash(std::string text) {
    text = remove_comments(text);
    text = std::regex_replace(text, std::regex(R"(\.bcdDevice\s*=\s*0x[0-9A-Fa-f]+,\s*)"), "");
    text = std::regex_replace(text, std::regex(R"(\s+)"), " ");
    return text;
}

uint64_t fnv1a_64(std::string const &text) {
    uint64_t hash = 14695981039346656037ull;
    for (unsigned char byte : text) {
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    return hash;
}

uint16_t parse_bcd_device(std::string const &source) {
    std::smatch match;
    if (!std::regex_search(source, match, std::regex(R"(\.bcdDevice\s*=\s*0x([0-9A-Fa-f]+),)"))) {
        throw std::runtime_error("Unable to find USB bcdDevice assignment");
    }
    return static_cast<uint16_t>(std::stoul(match[1].str(), nullptr, 16));
}

uint64_t companion_descriptor_hash(std::string const &source) {
    std::string material;
    material += extract_between(source, "static tusb_desc_device_t const desc_device", "\n};\nstatic tusb_desc_device_t desc_device_runtime");
    material += extract_between(source, "uint8_t descriptor_configuration[] = {", "\n};\n\n#ifdef ENABLE_COMPANION");
    material += extract_between(source, "uint8_t const desc_ms_os_20[]", "\n};\n\nTU_VERIFY_STATIC(sizeof(desc_ms_os_20)");
    material += extract_between(source, "char const *string_desc_arr[]", "\n};\n\nstatic uint16_t _desc_str");
    return fnv1a_64(normalize_for_hash(material));
}

void assert_xusb_descriptor_uses_endpoint_constants(std::string const &source) {
    const std::string block = extract_between(
        source,
        "uint8_t const xusb_gamepad_descriptor[] = {",
        "\n    };\n    TU_VERIFY_STATIC(sizeof(xusb_gamepad_descriptor)"
    );

    if (block.find("0x11, 0x21, 0x00, 0x01") == std::string::npos) {
        throw std::runtime_error("XUSB class descriptor must use the 17-byte Xbox 360 interface shape");
    }

    if (block.find("0x01, 0x25, XUSB360_EP_IN, 0x14") == std::string::npos) {
        throw std::runtime_error("XUSB class descriptor must advertise XUSB360_EP_IN");
    }

    if (block.find("0x13, XUSB360_EP_OUT, 0x08, 0x00, 0x00") == std::string::npos) {
        throw std::runtime_error("XUSB class descriptor must advertise XUSB360_EP_OUT");
    }
}

void assert_xusb_persona_strings_are_xbox_facing(std::string const &source) {
    if (source.find("#define XUSB360_VENDOR_ID 0x1209") == std::string::npos) {
        throw std::runtime_error("Xbox persona must expose a non-Sony composite-safe USB vendor ID");
    }

    if (source.find("#define XUSB360_PRODUCT_ID 0xDB05") == std::string::npos) {
        throw std::runtime_error("Xbox persona must expose a non-Sony composite-safe USB product ID");
    }

    if (source.find("#define XUSB360_USB_BCD_DEVICE 0x0156") == std::string::npos) {
        throw std::runtime_error("Xbox persona USB revision must be bumped for Windows descriptor cache separation");
    }

    if (source.find("#define XUSB360_STRING_MANUFACTURER \"Microsoft Corporation\"") == std::string::npos) {
        throw std::runtime_error("Xbox persona must expose an Xbox-facing manufacturer string");
    }

    if (source.find("#define XUSB360_STRING_PRODUCT \"Xbox 360 Controller for Windows\"") == std::string::npos) {
        throw std::runtime_error("Xbox persona must expose an Xbox-facing product string");
    }

    if (source.find("STRID_XUSB_GAMEPAD, // iInterface: Xbox 360 Controller for Windows") == std::string::npos) {
        throw std::runtime_error("Xbox persona game interface must expose an Xbox-facing interface string");
    }

    const std::string device_callback = extract_between(
        source,
        "uint8_t const *tud_descriptor_device_cb(void) {",
        "\n}\n\n//--------------------------------------------------------------------+\n// Configuration Descriptor"
    );
    if (
        device_callback.find("desc_device_runtime.idVendor = XUSB360_VENDOR_ID") == std::string::npos
        || device_callback.find("desc_device_runtime.idProduct = XUSB360_PRODUCT_ID") == std::string::npos
    ) {
        throw std::runtime_error("Xbox persona must override the runtime USB VID/PID");
    }

    const std::string string_helper = extract_between(
        source,
        "static char const *descriptor_string_for_index(uint8_t index) {",
        "\n}\n\n// Invoked when received GET STRING DESCRIPTOR request"
    );
    if (
        string_helper.find("index == STRID_MANUFACTURER && host_persona_active() == HostPersonaModeXusb360")
            == std::string::npos
        || string_helper.find("index == STRID_PRODUCT && host_persona_active() == HostPersonaModeXusb360")
            == std::string::npos
    ) {
        throw std::runtime_error("Xbox persona strings must only override manufacturer/product while Xbox mode is active");
    }
}

void assert_ds4_persona_identity_is_ds4_facing(std::string const &source) {
    if (source.find("#define DS4_VENDOR_ID 0x054C") == std::string::npos) {
        throw std::runtime_error("DS4 persona must expose Sony's DS4 USB vendor ID");
    }

    if (source.find("#define DS4_PRODUCT_ID 0x09CC") == std::string::npos) {
        throw std::runtime_error("DS4 persona must expose the DS4 v2 USB product ID");
    }

    if (source.find("#define DS4_STRING_PRODUCT \"Wireless Controller\"") == std::string::npos) {
        throw std::runtime_error("DS4 persona must expose the DS4-facing Wireless Controller product string");
    }

    if (source.find("#define DS4_HID_EP_INTERVAL 0x04") == std::string::npos) {
        throw std::runtime_error("DS4 persona must preserve the DS4-like HID endpoint interval");
    }

    if (source.find("TU_VERIFY_STATIC(sizeof(desc_hid_report_ds4) == DS4_HID_REPORT_DESC_LEN") == std::string::npos) {
        throw std::runtime_error("DS4 HID report descriptor length must be guarded");
    }

    const std::string device_callback = extract_between(
        source,
        "uint8_t const *tud_descriptor_device_cb(void) {",
        "\n}\n\n//--------------------------------------------------------------------+\n// Configuration Descriptor"
    );
    if (
        device_callback.find("host_persona_active() == HostPersonaModeDs4") == std::string::npos
        || device_callback.find("desc_device_runtime.idVendor = DS4_VENDOR_ID") == std::string::npos
        || device_callback.find("desc_device_runtime.idProduct = DS4_PRODUCT_ID") == std::string::npos
    ) {
        throw std::runtime_error("DS4 persona must override the runtime USB VID/PID");
    }

    const std::string report_callback = extract_between(
        source,
        "uint8_t const *tud_hid_descriptor_report_cb(uint8_t itf) {",
        "\n}\n\n//--------------------------------------------------------------------+\n// String Descriptors"
    );
    if (
        report_callback.find("host_persona_active() == HostPersonaModeDs4") == std::string::npos
        || report_callback.find("return desc_hid_report_ds4") == std::string::npos
    ) {
        throw std::runtime_error("DS4 persona must select the DS4 HID report descriptor");
    }
}

void assert_persona_switch_quiets_input_only(std::filesystem::path const &root) {
    const auto host_input_h = read_text(root / "src" / "host_input.h");
    const auto main_cpp = read_text(root / "src" / "main.cpp");
    const auto companion_cpp = read_text(root / "src" / "companion.cpp");
    const auto usb_cpp = read_text(root / "src" / "usb.cpp");

    if (
        host_input_h.find("void host_input_prepare_persona_switch();") == std::string::npos
        || host_input_h.find("void host_input_note_usb_mounted();") == std::string::npos
    ) {
        throw std::runtime_error("Persona switches must expose an input-only transition guard");
    }
    if (
        main_cpp.find("HOST_PERSONA_SWITCH_INPUT_FALLBACK_US") == std::string::npos
        || main_cpp.find("host_input_waiting_for_mount = true;") == std::string::npos
        || main_cpp.find("host_input_prepare_persona_switch()") == std::string::npos
        || main_cpp.find("host_input_note_usb_mounted()") == std::string::npos
        || main_cpp.find("host_input_send_report_for_persona(current_persona, neutral_state)") == std::string::npos
    ) {
        throw std::runtime_error("Persona switches must send a neutral report and quiet input until USB remount");
    }
    if (
        usb_cpp.find("#include \"host_input.h\"") == std::string::npos
        || usb_cpp.find("host_input_note_usb_mounted();") == std::string::npos
    ) {
        throw std::runtime_error("USB mount must release persona-switch input quieting");
    }

    const std::string command_block = extract_between(
        companion_cpp,
        "case CommandSetHostPersona:",
        "\n\n        case CommandSleepController:"
    );
    const auto guard_pos = command_block.find("host_input_prepare_persona_switch();");
    const auto set_pos = command_block.find("host_persona_set_active(next_persona)");
    const auto reconnect_pos = command_block.find("usb_request_reconnect();");
    if (
        guard_pos == std::string::npos
        || set_pos == std::string::npos
        || reconnect_pos == std::string::npos
        || guard_pos > set_pos
        || set_pos > reconnect_pos
    ) {
        throw std::runtime_error("Persona command order must be neutral-release, set persona, then reconnect");
    }

    const std::string interrupt_loop = extract_between(
        main_cpp,
        "void interrupt_loop() {",
        "\n}\n\nvoid on_bt_data"
    );
    if (interrupt_loop.find("host_input_quiet_active(now)") == std::string::npos) {
        throw std::runtime_error("Persona transition quieting must only silence input reports");
    }

    const std::string get_report_callback = extract_between(
        main_cpp,
        "uint16_t tud_hid_get_report_cb",
        "\n}\n\n// Invoked when received SET_REPORT"
    );
    const std::string set_report_callback = extract_between(
        main_cpp,
        "void tud_hid_set_report_cb",
        "\n}\n\nint main()"
    );
    if (
        get_report_callback.find("host_input_quiet") != std::string::npos
        || set_report_callback.find("host_input_quiet") != std::string::npos
    ) {
        throw std::runtime_error("Persona transition quieting must not block HID control callbacks");
    }

    if (
        get_report_callback.find("HostPersonaModeDs4") == std::string::npos
        || get_report_callback.find("HID_REPORT_TYPE_INPUT") == std::string::npos
        || get_report_callback.find("ds4_copy_input_report_payload") == std::string::npos
    ) {
        throw std::runtime_error("DS4 native probes must be able to GET_REPORT the current input report");
    }
}

} // namespace

int main() {
    try {
        const auto source_root = std::filesystem::path(DS5_SOURCE_ROOT);
        const auto source = read_text(source_root / "src" / "usb_descriptors.c");
        const uint16_t bcd_device = parse_bcd_device(source);
        const uint64_t descriptor_hash = companion_descriptor_hash(source);
        assert_xusb_descriptor_uses_endpoint_constants(source);
        assert_xusb_persona_strings_are_xbox_facing(source);
        assert_ds4_persona_identity_is_ds4_facing(source);
        assert_persona_switch_quiets_input_only(source_root);

        if (bcd_device != kExpectedUsbDeviceRevision) {
            std::cerr << "USB bcdDevice changed unexpectedly. Expected 0x" << std::hex
                      << kExpectedUsbDeviceRevision << ", got 0x" << bcd_device << std::dec << "\n";
            return 1;
        }

        if (descriptor_hash != kExpectedCompanionDescriptorHash) {
            std::cerr << "Companion USB descriptor fingerprint changed without updating the migration guard.\n"
                      << "If this is an intentional USB identity/interface change, bump bcdDevice so Windows "
                      << "re-enumerates the bridge cleanly, then update this expected fingerprint.\n"
                      << "Expected 0x" << std::hex << kExpectedCompanionDescriptorHash
                      << ", got 0x" << descriptor_hash << std::dec << "\n";
            return 1;
        }

        std::cout << "USB descriptor migration guard passed\n";
        return 0;
    } catch (std::exception const &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
