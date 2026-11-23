#pragma once
#include "mundo/runtime.hpp"

namespace mundo {
struct MeshLevel { Mesh mesh; float relative_error{}; };
[[nodiscard]] std::vector<MeshLevel> cook_levels(const Mesh& source);
struct TextureInfo {
    unsigned width{},height{},levels{};
    bool needs_transcoding{};
};
[[nodiscard]] std::optional<TextureInfo> inspect_ktx2(std::span<const std::byte> file);
}
