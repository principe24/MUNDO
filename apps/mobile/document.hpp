#pragma once
#include "checkpoint.hpp"
#include "mundo/project.hpp"
#include "mundo/zones.hpp"

namespace mundo::mobile {
constexpr std::size_t max_zones_bytes=32u*1024u*1024u;
constexpr std::size_t max_package_bytes=project::max_bytes;
struct PlayDocument {
    std::filesystem::path path;
    std::uint64_t key{};
    std::string project_caption;
    std::optional<project::Selection> location;
    std::vector<project::Destination> destinations;
    std::vector<project::PortalPad> portals;
    World world;
    std::optional<ZoneArchive> zones;
    std::optional<CharacterTerrain> terrain;
    CharacterController character;
    VehicleSession vehicles;
    double yaw{},pitch{};
};
// Called on an import worker against the app's private, immutable copy.
std::unique_ptr<PlayDocument> prepare_document(const std::filesystem::path&,bool restore_pose=false,
                                               std::optional<project::Selection> destination={});
}
