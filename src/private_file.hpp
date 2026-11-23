#pragma once
#include <cstddef>
#include <filesystem>
#include <span>

namespace mundo {
enum class DocumentWrite;
// Places a complete file in an existing directory.
bool write_document_bytes(const std::filesystem::path&, std::span<const std::byte>, DocumentWrite);
// The trusted application supplies a path in its own data directory.
bool write_private_file(const std::filesystem::path&, std::span<const std::byte> bytes);
}
