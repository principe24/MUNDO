#pragma once
#include "mundo/runtime.hpp"
#include <memory>

namespace mundo {
struct BodyPose { Vec3 position; Quat rotation; };
enum class Motion { fixed, dynamic };
class PhysicsSpace {
public:
    static std::unique_ptr<PhysicsSpace> create();
    ~PhysicsSpace();
    PhysicsSpace(const PhysicsSpace&)=delete;
    PhysicsSpace& operator=(const PhysicsSpace&)=delete;
    bool insert(EntityId entity,Shape shape,Vec3 dimensions,const BodyPose& world_pose,Motion motion);
    bool erase(EntityId entity);
    [[nodiscard]] std::optional<BodyPose> pose(EntityId entity) const;
    bool advance(double elapsed_seconds);
private:
    struct Impl;
    explicit PhysicsSpace(std::unique_ptr<Impl>);
    std::unique_ptr<Impl> impl_;
};
}
