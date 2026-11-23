#pragma once
#include "mundo/avatar.hpp"

namespace mundo {
// A car's mutable pose belongs to the loaded play session. The source document stays on disk.
class VehicleSession {
public:
    // With a project selection, only that car can be boarded. Zero selects the lowest eligible ID.
    bool discover(const World&, std::optional<EntityId> selection = std::nullopt);
    EntityId first_root() const { return cars_.empty() ? root_id : cars_.front().root; }
    bool first_car_blocks(const CollisionBounds& pedestrian) const;
    bool driving() const {return active_.has_value();}
    EntityId active_root() const {return active_?cars_[*active_].root:root_id;}
    Vec3 position() const {
        const auto& car=cars_.at(active_.value());return {car.x,car.base,car.z};
    }
    double heading() const;
    double speed_metres_per_second() const {return driving()?speed_:0.;}
    // Apply wheel motion to a fresh render item and return its workshop slot, if any.
    // This only reads the session; drawing cannot move collision proxies or modify the world.
    VisualKey prepare_draw(DrawItem&) const;
    // Null means that entry or exit succeeded. A failed interaction preserves the old state.
    const char* interact(World&, std::optional<CharacterTerrain>&, CharacterController&);
    void advance(World&, const CharacterTerrain&, double elapsed,double throttle,double steer,bool brake);
    CameraPose camera(const CharacterTerrain&, double orbit,double pitch,bool third_person) const;
    Vec3 seat_hip(bool passenger) const;
    CameraPose seat_camera(const CharacterTerrain&,double orbit,double pitch,bool third,bool passenger,bool& show_self) const;
    // A room selects a workshop root once. Its pose and signed wheel travel come from the host.
    bool select_replica(EntityId root);
    bool apply_replica(World&, double x,double z,double yaw,double steer,double distance);
    bool replica_supported(const CharacterTerrain&,double x,double z,double yaw) const;
    std::optional<CollisionBounds> active_bounds() const;
private:
    struct Car {
        EntityId root{};
        Matrix parent{};
        Vec3 origin{};
        double x{},z{},yaw{},width{},length{},base{},top{},wheelbase{};
        std::array<Vec3,4> contacts{};
        std::array<double,4> radius{},roll{};
        // Body-relative authored hip points, expressed along the parked car's axes.
        std::optional<std::array<Vec3,2>> seat_offsets;
        double steering{};
    };
    static bool supported(const Car&,const CharacterTerrain&,double x,double z,double yaw);
    static bool write_chassis(World&,const Car&);
    struct Part { std::size_t car; VisualKey slot; int axle; };
    std::map<EntityId,Part> parts_;
    std::vector<Car> cars_;
    std::optional<std::size_t> active_;
    double speed_{},steer_{},remainder_{};
};
}
