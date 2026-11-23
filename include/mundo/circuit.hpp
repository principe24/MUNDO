#pragma once
#include "mundo/world.hpp"

namespace mundo::room {
inline constexpr unsigned circuit_limit=32;
struct CircuitGate {
    EntityId id{};
    std::string label;
    Vec3 point{};
};
enum class LapPhase : std::uint8_t { ready, running, finished };
struct CourseState {
    std::uint64_t run{}, elapsed_ms{};
    std::optional<std::uint64_t> best_ms;
    unsigned passed{}, total{};
    LapPhase phase{};
    EntityId next{};
    std::string next_label;
    std::optional<Vec3> target;
    // Elapsed times at the last crossed gate, in this lap and its reference lap.
    std::optional<std::uint64_t> at_ms, reference_ms;
    bool flying_start{};
};
using CourseIndex=std::vector<CircuitGate>;
std::optional<CourseIndex> index_course(const World&);
bool bind_course(CourseState&, const CourseIndex&);
bool follows_course(const std::optional<CourseState>& previous, const std::optional<CourseState>& current);
std::string course_caption(const std::optional<CourseState>&);
}
