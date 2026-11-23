#pragma once
#include "mundo/runtime.hpp"

namespace mundo {
struct CameraPose {
    Vec3 eye{}, forward{0,0,-1}, up{0,1,0};
    double vertical_fov{55}, near_plane{0.1}, far_plane{20'000};
};

struct ObjectCoverage { bool in_view{}; double diameter_pixels{}; };

class CameraProjection {
public:
    static std::optional<CameraProjection> from(const CameraPose&, double aspect, unsigned render_height);
    // The model is already relative to the camera, as supplied by World::visible.
    [[nodiscard]] ObjectCoverage measure(const DrawItem&) const;
    [[nodiscard]] double search_distance() const { return distance_; }
private:
    struct Plane { Vec3 normal; double offset; };
    std::array<Plane,6> planes_{};
    Vec3 forward_{}, right_{}, up_{};
    double focal_length_{}, near_{}, distance_{};
};

[[nodiscard]] Detail object_detail(double diameter_pixels, Detail ceiling, std::optional<Detail> previous);
struct SceneFrameStats {
    std::uint32_t candidates{}, in_view{}, retained_for_shadows{}, culled{};
    std::array<std::uint32_t,3> mesh_levels{}; // economy, balanced and ultra
};
} // namespace mundo
