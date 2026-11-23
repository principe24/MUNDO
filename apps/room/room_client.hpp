#pragma once

#include "cell_directory.hpp"
#include "mundo/character.hpp"
#include "mundo/room_wire.hpp"

#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace mundo::room {

enum class Phase { offline, joining, playing, reconnecting, ended };

struct EntryPreview {
    World world;
    CharacterTerrain terrain;
    double focus_x{}, focus_z{};
    std::string revision;
    std::uint64_t epoch{}, world_id{};
};

struct RegionUpdate {
    World world;
    CharacterTerrain terrain;
};

struct RegionUsage;
struct Update {
    Phase phase{Phase::offline};
    unsigned seat{};
    std::string title;
    std::string message;
    // All scene data arrives with its first snapshot and is consumed once by poll().
    std::optional<World> world;
    std::optional<CharacterTerrain> terrain;
    std::optional<CellDirectory> cells;
    std::optional<Snapshot> snapshot;
    bool meeting_available{};
    std::uint64_t meeting_ticket{};
    // A result accompanies a position snapshot. poll() consumes these two fields once.
    std::string meeting_notice;
    bool meeting_returned{};
    // During loading, consume entry once and retain it only while entry_visible is true.
    std::optional<EntryPreview> entry;
    bool entry_visible{};
    // Replaces static scenery within the same world. Keep actors and camera state.
    std::optional<RegionUpdate> region;
    std::shared_ptr<RegionUsage> usage;
    // Called on the render thread only after the matching geometry was installed.
    void confirm_install() noexcept;
};

class Client {
public:
    Client();
    ~Client();
    Client(const Client&) = delete;
    Client& operator=(const Client&) = delete;

    bool start(std::wstring_view invitation);
    void leave();
    void input(unsigned mask, double yaw, bool jump, bool brake = false);
    void vehicle_action(CarAction action);
    bool return_to_meeting(std::uint64_t expected_ticket = 0);
    void neutral();
    // Drop reusable project bytes on memory pressure, including while the app is suspended.
    void trim_world_cache();
    // Native app lifecycle only. Menus should neutralize input without giving up heartbeats.
    void set_active(bool foreground);
    // A renderer budget transition affects only speculative driving prefetch.
    Update poll(bool renderer_constrained = false);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}
