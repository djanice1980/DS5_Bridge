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

constexpr uint16_t kExpectedUsbDeviceRevision = 0x0151;
constexpr uint64_t kExpectedCompanionDescriptorHash = 0x0aafa7ebadf96bebull;

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
    material += extract_between(source, "static tusb_desc_device_t const desc_device", "\n};\n\n// Invoked");
    material += extract_between(source, "uint8_t descriptor_configuration[] = {", "\n};\n\nTU_VERIFY_STATIC");
    material += extract_between(source, "uint8_t const desc_ms_os_20[]", "\n};\n\nTU_VERIFY_STATIC(sizeof(desc_ms_os_20)");
    material += extract_between(source, "char const *string_desc_arr[]", "\n};\n\nstatic uint16_t _desc_str");
    return fnv1a_64(normalize_for_hash(material));
}

} // namespace

int main() {
    try {
        const auto source = read_text(std::filesystem::path(DS5_SOURCE_ROOT) / "src" / "usb_descriptors.c");
        const uint16_t bcd_device = parse_bcd_device(source);
        const uint64_t descriptor_hash = companion_descriptor_hash(source);

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
