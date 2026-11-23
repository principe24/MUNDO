#pragma once
#include "mundo/circuit.hpp"

namespace mundo::room {
inline constexpr char media_type[] = "application/vnd.mundo.room-v1";
inline constexpr char vehicle_media_type[] = "application/vnd.mundo.room-v2";
inline constexpr char passenger_media_type[] = "application/vnd.mundo.room-v3";
inline constexpr std::uint64_t max_sequence = (std::uint64_t{1} << 53) - 1;
inline constexpr std::size_t max_join_bytes = 301;
inline constexpr std::size_t max_route_bytes = 45 + max_join_bytes;
inline constexpr std::size_t circuit_trailer_bytes = 36;
inline constexpr std::size_t split_trailer_bytes = 1 + 2 * sizeof(std::uint64_t);
inline constexpr std::size_t max_base_snapshot_bytes = 156 + circuit_trailer_bytes + split_trailer_bytes;
inline constexpr std::size_t max_npcs = 8;
inline constexpr std::size_t npc_record_bytes = 41;
inline constexpr std::size_t max_snapshot_bytes = 7 + max_base_snapshot_bytes + max_npcs * npc_record_bytes;

struct Join {
    unsigned id{};
    std::string revision, name;
    std::uint64_t ack{};
    bool project{};
};
enum class TravelPhase : std::uint8_t { active, preparing, cancelled };
struct Route {
    TravelPhase phase{};
    std::uint64_t epoch{}, world{};
    EntityId root{};
    std::string lease;
    Join scene;
};
struct Pose {
    unsigned id{};
    Vec3 feet{};
    double yaw{}, vy{};
    bool grounded{};
};
enum class CarAction { none=0, enter=1, exit=2, ride=4 };

struct CarState {
    EntityId root{};
    double x{}, z{}, yaw{}, speed{}, steer{}, distance{};
    int driver{-1}, passenger{-1};
};
enum class NpcState : std::uint8_t { patrol, waiting, follow, returning, blocked, idle };
struct NpcPose {
    EntityId id{};
    Vec3 feet{};
    double yaw{};
    NpcState state{};
};
struct Snapshot {
    std::uint64_t ack{};
    std::vector<Pose> players;
    std::optional<CarState> car;
    std::optional<CourseState> course;
    std::vector<NpcPose> npcs;
};

[[nodiscard]] std::optional<Join> read_join(std::span<const std::byte> bytes);
[[nodiscard]] std::optional<Route> read_route(std::span<const std::byte> bytes);
[[nodiscard]] std::optional<Snapshot> read_snapshot(std::span<const std::byte> bytes);
// Uses the existing web command format. An empty string denotes invalid input.
[[nodiscard]] std::string input_body(std::uint64_t seq, unsigned mask, double yaw, bool jump);
[[nodiscard]] std::string input_body(std::uint64_t seq, unsigned mask, double yaw, bool jump,
                                     bool brake, CarAction action = CarAction::none);
}
