#include "mundo/room_view.hpp"
#include <algorithm>
#include <cmath>
#include <numbers>

namespace mundo::room {
void View::reset() { *this = View{}; }

void View::bind_world(const World& world) {
    reset();
    vehicles_.discover(world);
}

CarState View::CarTrack::sample(double now) const {
    if (duration <= 0 || now >= received + duration) return target;
    const double t = std::clamp((now - received) / duration, 0., 1.);
    auto pose = target;
    pose.x = std::lerp(start.x, target.x, t);
    pose.z = std::lerp(start.z, target.z, t);
    pose.yaw = start.yaw + t * std::remainder(target.yaw - start.yaw, 2 * std::numbers::pi);
    pose.steer = std::lerp(start.steer, target.steer, t);
    pose.distance = std::lerp(start.distance, target.distance, t);
    return pose;
}

Pose View::Track::sample(double now) const {
    if (duration <= 0 || now >= received + duration) return target;
    const double t = std::clamp((now - received) / duration, 0., 1.);
    Pose pose = start;
    pose.feet.x = std::lerp(start.feet.x, target.feet.x, t);
    pose.feet.y = std::lerp(start.feet.y, target.feet.y, t);
    pose.feet.z = std::lerp(start.feet.z, target.feet.z, t);
    const double turn = std::remainder(target.yaw - start.yaw, 2 * std::numbers::pi);
    pose.yaw = start.yaw + t * turn;
    pose.vy = std::lerp(start.vy, target.vy, t);
    pose.grounded = t < .5 ? start.grounded : target.grounded;
    return pose;
}

void View::accept(const Snapshot& snapshot, unsigned self_id, double now, bool snap_self) {
    if (self_id >= seats_.size() || !std::isfinite(now)) return;
    if (self_ == self_id && last_ack_ && snapshot.ack <= *last_ack_) return;
    std::array<const Pose*,2> received{};
    for (const auto& player : snapshot.players) {
        if (player.id >= received.size() || received[player.id]) return;
        received[player.id] = &player;
    }
    if (!received[self_id]) return;
    if (const auto& car=snapshot.car) {
        const auto present=[&](int id) {
            return id == -1 || (id >= 0 && static_cast<unsigned>(id) < received.size() && received[id]);
        };
        if (!present(car->driver) || !present(car->passenger) ||
            (car->driver >= 0 && car->driver == car->passenger)) return;
    }
    if (last_ack_ && self_ != self_id) {
        seats_ = {};
        npcs_ = {};
        car_.reset();
    }
    // Remove missing identities before reusing slots so a new actor never inherits a pose.
    for (auto& npc : npcs_) {
        if (npc.id && std::none_of(snapshot.npcs.begin(),snapshot.npcs.end(),
                                   [&](const auto& next){ return next.id==npc.id; })) npc={};
    }
    for (const auto& npc : snapshot.npcs) {
        auto slot=std::find_if(npcs_.begin(),npcs_.end(),[&](const auto& s){return s.id==npc.id;});
        if (slot==npcs_.end()) slot=std::find_if(npcs_.begin(),npcs_.end(),[](const auto& s){return !s.id;});
        if (!npc.id || slot==npcs_.end()) continue;
        auto& track=slot->track;
        const Pose next{0,npc.feet,npc.yaw,0.,true};
        const double gap=now-track.received;
        const auto& p=track.target.feet;
        if (slot->id && !snap_self && gap>0 && gap<=.45 && std::hypot(p.x-npc.feet.x,p.y-npc.feet.y,p.z-npc.feet.z)<=2.) {
            track.start=track.sample(now);
            track.duration=std::min(gap,.12);
        } else {
            track.start=next;
            track.duration=0.;
            track.avatar.reset();
            track.avatar.advance_pose(npc.feet,true,0.,0.,npc.yaw);
        }
        slot->id=npc.id;
        track.target=next;
        track.received=now;
    }
    self_ = self_id;
    last_ack_ = snapshot.ack;
    next_gate_=snapshot.course?snapshot.course->target:std::nullopt;

    const int old_passenger = car_ ? car_->target.passenger : -1;
    const int old_driver = car_ ? car_->target.driver : -1;
    if (const auto& next = snapshot.car; next && vehicles_.select_replica(next->root)) {
        CarState start = *next;
        double duration = 0.;
        if (car_ && car_->target.root == next->root) {
            const double gap = now - car_->received;
            const double moved = std::hypot(next->x - car_->target.x, next->z - car_->target.z);
            // Snap after interruptions. Never predict motion beyond a server pose.
            if (gap > 0 && gap <= .45 && moved <= 14. * gap + .9) {
                start = car_->sample(now);
                duration = std::min(gap, .12);
            }
        }
        car_ = CarTrack{start, *next, now, duration};
    } else {
        car_.reset();
    }
    const int new_passenger = car_ ? car_->target.passenger : -1;
    const int new_driver = car_ ? car_->target.driver : -1;
    for (unsigned id = 0; id < seats_.size(); ++id) {
        auto& seat = seats_[id];
        const Pose* next = received[id];
        if (!next) {
            seat.reset();
            continue;
        }
        const bool was_driving = old_driver == static_cast<int>(id);
        const bool is_driving = new_driver == static_cast<int>(id);
        if (seat && !(snap_self && id == self_id) && was_driving == is_driving && (old_passenger==static_cast<int>(id))==(new_passenger==static_cast<int>(id))) {
            const double gap = now - seat->received;
            const auto& previous = seat->target.feet;
            const double travel = std::hypot(next->feet.x - previous.x, next->feet.y - previous.y,
                                              next->feet.z - previous.z);
            // A respawn or a long interruption should never sweep the actor through the map.
            if (gap > 0 && gap <= .45 && travel <= 2.) {
                seat->start = seat->sample(now);
                seat->displayed = seat->start;
                seat->target = *next;
                seat->received = now;
                seat->duration = std::min(gap, .12);
                continue;
            }
        }
        auto& track = seat.emplace();
        track.start = track.displayed = track.target = *next;
        track.received = now;
        track.avatar.advance_pose(next->feet, next->grounded, next->vy, 0., next->yaw);
    }
}

void View::advance(World& world, double now, double dt) {
    if (!std::isfinite(now) || !std::isfinite(dt) || dt < 0) return;
    advance(now, dt);
    if (!car_) return;
    const auto pose = car_->sample(now);
    if (!vehicles_.apply_replica(world, pose.x, pose.z, pose.yaw, pose.steer, pose.distance)) {
        car_.reset();
        return;
    }
    for (int id : {pose.driver, pose.passenger}) {
        if (id >= 0 && seats_[id]) seats_[id]->avatar.sit(vehicles_.seat_hip(id == pose.passenger), pose.yaw);
    }
}

CameraPose View::vehicle_camera(const CharacterTerrain& road, double orbit, double pitch, bool third) const {
    bool show_self=false;
    return vehicle_camera(road, orbit, pitch, third, show_self);
}

CameraPose View::vehicle_camera(const CharacterTerrain& road, double orbit, double pitch, bool third, bool& show_self) const {
    show_self=false;
    return aboard() ? vehicles_.seat_camera(road, orbit, pitch, third, riding(), show_self) : CameraPose{};
}

bool View::follow_pedestrian(CameraPose& camera, const CharacterTerrain& road) const {
    const auto bounds = car_ ? vehicles_.active_bounds() : std::nullopt;
    return follow_avatar(camera, road, 3.25, bounds ? &*bounds : nullptr);
}

void View::advance(double now, double dt) {
    if (!std::isfinite(now) || !std::isfinite(dt) || dt < 0) return;
    for (auto& npc : npcs_) {
        if (!npc.id) continue;
        const auto p=npc.track.sample(now);
        npc.track.avatar.advance_pose(p.feet,true,0.,dt,p.yaw);
    }
    for (auto& seat : seats_) {
        if (!seat) continue;
        seat->displayed = seat->sample(now);
        const auto& pose = seat->displayed;
        if (!car_ || (car_->target.driver != static_cast<int>(pose.id) && car_->target.passenger != static_cast<int>(pose.id)))
            seat->avatar.advance_pose(pose.feet, pose.grounded, pose.vy, dt, pose.yaw);
    }
}

std::optional<Vec3> View::local_feet() const {
    if (const auto& seat = seats_[self_]) return seat->displayed.feet;
    return std::nullopt;
}

// Use both targets from the same authoritative snapshot. The viewing direction may
// have changed since the last network update. At yaw zero the camera faces -Z.
std::string View::car_guide(double yaw) const {
    if (!car_ || !seats_[self_] || !std::isfinite(yaw)) return {};
    const auto& feet=seats_[self_]->target.feet;
    const auto& car=car_->target;
    const bool to_gate=aboard();
    if(to_gate && !next_gate_)return {};
    const double dx=to_gate?next_gate_->x-car.x:car.x-feet.x;
    const double dz=to_gate?next_gate_->z-car.z:car.z-feet.z;
    if(to_gate)yaw=car.yaw;
    const double meters=std::hypot(dx,dz);
    if(meters<1.)return to_gate?"Puerta a menos de 1 m":"Turismo a menos de 1 m";
    const double forward = dx * std::sin(yaw) - dz * std::cos(yaw);
    const double right = dx * std::cos(yaw) + dz * std::sin(yaw);
    const char* direction = std::abs(forward) >= std::abs(right) ?
        (forward >= 0 ? "delante" : "detrás") : (right >= 0 ? "a la derecha" : "a la izquierda");
    return (to_gate?"Puerta · ":"Turismo · ") + std::to_string(std::llround(meters)) + " m · " + direction;
}

const BlockAvatar* View::local_avatar() const {
    const auto& seat = seats_[self_];
    return seat ? &seat->avatar : nullptr;
}

std::array<const BlockAvatar*,max_npcs> View::npc_avatars() const {
    std::array<const BlockAvatar*,max_npcs> result{};
    for (std::size_t i=0;i<npcs_.size();++i) if(npcs_[i].id) result[i]=&npcs_[i].track.avatar;
    return result;
}
const BlockAvatar* View::peer_avatar() const {
    const auto& seat = seats_[1 - self_];
    return seat ? &seat->avatar : nullptr;
}
}
