#pragma once
#include "mundo/vehicle.hpp"
#include <functional>
#include <istream>
#include <stdexcept>
#include <string_view>

namespace mundo::project {
inline constexpr std::string_view signature="MUNDOPRJ";
inline constexpr std::size_t max_bytes = 64u * 1024u * 1024u;
inline constexpr std::size_t max_room_bytes = 20u + 2048u + max_world_bytes;
using DigestCheck = bool (*)(std::span<const std::byte>, std::string_view);
struct Destination {
    std::uint64_t id;
    std::string title;
};
struct Selection {
    std::string index_hash;
    std::uint64_t id;
    bool operator==(const Selection&) const = default;
};
class DestinationChanged : public std::invalid_argument {
public:
    using std::invalid_argument::invalid_argument;
};
struct PortalPad {
    EntityId tile{};
    std::uint64_t destination{};
    Vec3 top_center{};
    double half_x{}, half_z{}, cosine{}, sine{};
    bool covers(Vec3 feet) const;
};
// A fresh scene, a restored pose or dismount can start on a pad. Prime the
// crossing there and require the walker to leave before that pad can fire.
class PortalCrossing {
public:
    void prime(std::span<const PortalPad> pads,Vec3 feet,bool grounded);
    std::optional<std::uint64_t> walk(std::span<const PortalPad>,CharacterController&,const CharacterTerrain&,
                                      double seconds,WalkInput);
private:
    std::optional<std::uint64_t> enter(std::span<const PortalPad> pads,Vec3 feet,bool grounded);
    bool ready_{}, awaiting_ground_{true};
};
struct Scene {
    std::string game_name, world_title, index_hash;
    World world;
    VehicleSession vehicles;
    CharacterTerrain terrain;
    CharacterController character;
    std::vector<Destination> worlds;
    std::uint64_t id{};
    std::vector<PortalPad> portals;
};
// Takes a seekable, opened binary stream. Releases each non-starting scene before reading
// the next. Returns a fully prepared local scene or throws before the caller adopts it.
// A later trip is bound to the index of the project already open in this session.
Scene read_scene(std::istream&, DigestCheck, const std::optional<Selection>& destination = {},
                 const std::function<bool()>& cancelled = {});
// An initial open can choose a stable ID before the caller has an index hash.
// Subsequent travel should use the bound Selection overload above.
Scene read_scene_by_id(std::istream&, DigestCheck, std::uint64_t id);
}
