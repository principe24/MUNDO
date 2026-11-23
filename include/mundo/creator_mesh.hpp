#pragma once

#include "mundo/appearance.hpp"

#include <optional>
#include <span>

namespace mundo {

inline constexpr std::size_t creator_mesh_header_bytes = 40;
inline constexpr std::size_t creator_mesh_vertex_bytes = 24;
inline constexpr std::size_t max_creator_triangles = 60'000;
inline constexpr std::size_t max_creator_mesh_bytes =
    creator_mesh_header_bytes + max_creator_triangles * 3 * (creator_mesh_vertex_bytes + sizeof(std::uint32_t));

// Geometry is normalized to a one-unit box. World nodes retain their own
// material and use dimensions as their scale, so one catalog mesh can serve
// instances with different colors and transforms.
struct CreatorMesh {
    ArtLevel level;
    std::array<double, 3> dimensions{};
    CollisionBounds local_bounds{}; // Metres around the instance origin.
};

[[nodiscard]] bool is_creator_visual(VisualKey key) noexcept;
[[nodiscard]] std::optional<CreatorMesh> read_creator_mesh(std::span<const std::byte> bytes);

} // namespace mundo
