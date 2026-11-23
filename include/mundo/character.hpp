#pragma once
#include "mundo/world.hpp"
#include <functional>

namespace mundo {
// Build once per static scene. Multiple controllers can share the same read-only index.
class CharacterTerrain {
public:
    explicit CharacterTerrain(const World&, EntityId excluded_subtree=root_id);
    void visit(const CollisionBounds&, const std::function<void(const CollisionBounds&)>&) const;
    double lowest() const;
    bool empty() const { return boxes_.empty(); }
private:
    struct Branch { CollisionBounds bounds; unsigned start{}, end{}, left{}, right{}; };
    unsigned build(unsigned start, unsigned end);
    std::vector<CollisionBounds> boxes_;
    std::vector<Branch> tree_;
};

struct WalkInput { double x{}, z{}; bool sprint{}, jump_pressed{}; };
class CharacterController {
public:
    void spawn(const CharacterTerrain&, Vec3 preferred_feet);
    [[nodiscard]] Vec3 feet() const { return {feet_[0],feet_[1],feet_[2]}; }
    bool start_at(const CharacterTerrain&, Vec3 verified_feet);
    bool resume_at(const CharacterTerrain&, Vec3 position);
    void advance(const CharacterTerrain&, double seconds, WalkInput world_direction);
    // Called after each collision-resolved step. Returning true stops at that pose.
    using StopAfterStep=std::function<bool(const CharacterController&,bool respawned)>;
    void advance_until(const CharacterTerrain&,double seconds,WalkInput,const StopAfterStep&);
    [[nodiscard]] Vec3 eye() const;
    [[nodiscard]] bool grounded() const { return grounded_; }
private:
    using Position = std::array<double,3>;
    Position feet_{}, previous_{}, spawn_{};
    double velocity_y_{}, remainder_{};
    bool grounded_{}, jump_{};
};
}
