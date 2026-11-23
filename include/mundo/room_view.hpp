#pragma once

#include "mundo/vehicle.hpp"
#include "mundo/room_wire.hpp"
#include <array>
#include <optional>
#include <string>

namespace mundo::room {
// A presentation of the server's two seats. Both time arguments use the same monotonic clock.
class View {
public:
    void reset();
    void bind_world(const World& world);
    void accept(const Snapshot&, unsigned self_id, double now_seconds, bool snap_self = false);
    void advance(double now_seconds, double dt);
    void advance(World&, double now_seconds, double dt);
    std::optional<Vec3> local_feet() const;
    const BlockAvatar* local_avatar() const;
    const BlockAvatar* peer_avatar() const;
    std::array<const BlockAvatar*,max_npcs> npc_avatars() const;
    std::string car_guide(double look_yaw) const;
    bool has_car() const { return car_.has_value(); }
    bool occupied() const { return car_ && car_->target.driver >= 0; }
    bool driving() const { return car_ && car_->target.driver == static_cast<int>(self_); }
    bool riding() const { return car_ && car_->target.passenger == static_cast<int>(self_); }
    bool aboard() const { return driving() || riding(); }
    bool passenger_taken() const { return car_ && car_->target.passenger >= 0; }
    bool allows(CarAction action) const {
        if (!has_car()) return false;
        switch (action) {
        case CarAction::enter: return !occupied();
        case CarAction::ride: return !aboard() && !passenger_taken();
        case CarAction::exit: return aboard();
        default: return false;
        }
    }
    double car_speed() const { return car_ ? car_->target.speed : 0.; }
    double car_heading() const { return vehicles_.heading(); }
    const VehicleSession* vehicles() const { return car_ ? &vehicles_ : nullptr; }
    CameraPose vehicle_camera(const CharacterTerrain&, double orbit, double pitch, bool third, bool& show_self) const;
    CameraPose vehicle_camera(const CharacterTerrain&, double orbit, double pitch, bool third) const;
    bool follow_pedestrian(CameraPose&, const CharacterTerrain&) const;

private:
    struct Track {
        BlockAvatar avatar;
        Pose start{}, target{}, displayed{};
        double received{}, duration{};
        Pose sample(double now) const;
    };
    struct CarTrack {
        CarState start{}, target{};
        double received{}, duration{};
        CarState sample(double now) const;
    };
    std::array<std::optional<Track>,2> seats_;
    struct NpcTrack { EntityId id{}; Track track; };
    std::array<NpcTrack,max_npcs> npcs_;
    VehicleSession vehicles_;
    std::optional<CarTrack> car_;
    std::optional<Vec3> next_gate_;
    std::optional<std::uint64_t> last_ack_;
    unsigned self_{};
};
}
