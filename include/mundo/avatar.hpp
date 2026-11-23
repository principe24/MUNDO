#pragma once
#include "mundo/character.hpp"
#include "mundo/visibility.hpp"

namespace mundo {
enum class AvatarStyle { local, peer, npc };
// Per-player presentation state. Pose is derived from resolved movement after collisions.
class BlockAvatar {
public:
    void reset();
    void advance(const CharacterController&, double elapsed, double yaw);
    void advance_pose(Vec3 feet, bool grounded, double vertical_speed, double elapsed, double yaw);
    void sit(Vec3 hip, double yaw);
    void append(std::vector<DrawItem>& destination, Vec3 camera_origin) const;
    void append(std::vector<DrawItem>& destination, Vec3 camera_origin, AvatarStyle style) const;
private:
    Vec3 feet_{};
    double heading_{}, phase_{}, speed_{}, air_{}, upward_{};
    bool initialized_{}, seated_{};
};

// Adjust an eye-level camera to a collision-limited third person view.
// Returns false when the eye-level view should be used and the avatar hidden.
bool follow_avatar(CameraPose&, const CharacterTerrain&, double distance=3.25,
                   const CollisionBounds* moving_obstacle=nullptr);
}
