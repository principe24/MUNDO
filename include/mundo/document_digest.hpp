#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <string_view>

namespace mundo {
[[nodiscard]] std::string document_digest(std::span<const std::byte> bytes);
[[nodiscard]] bool matches_document_digest(std::span<const std::byte> bytes, std::string_view hex);
}
