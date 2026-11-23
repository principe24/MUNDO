#pragma once
#include "mundo/physics.hpp"

namespace mundo {
struct BodyBinding { EntityId entity; Motion motion; };
// Each instance has its own working scene. Authoring data changes only upon an explicit export.
class Simulation {
public:
    static std::unique_ptr<Simulation> start(World scene,std::span<const BodyBinding> bodies);
    bool advance(double elapsed);
    [[nodiscard]] const World& scene() const noexcept { return scene_; }
private:
    Simulation(World scene,std::unique_ptr<PhysicsSpace> space,std::vector<EntityId> dynamic);
    World scene_;
    std::unique_ptr<PhysicsSpace> space_;
    std::vector<EntityId> dynamic_;
};
}
