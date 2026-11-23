#include "mundo/room_wire.hpp"
#include "art_wire.hpp"
#include "valid_name.hpp"
#include <bit>
#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <numbers>
#include <sstream>
#include <utility>

namespace mundo::room {
namespace {
double read_double(wire::Reader& reader) {
    return std::bit_cast<double>(reader.integer<std::uint64_t>());
}

bool usable_pose(const Pose& pose) {
    constexpr double max_coordinate = 1e15; // Native world visibility uses the same bound.
    const auto within = [](double value, double limit) { return std::abs(value) <= limit; };
    return within(pose.feet.x, max_coordinate) && within(pose.feet.y, max_coordinate) &&
           within(pose.feet.z, max_coordinate) && within(pose.yaw, std::numbers::pi + .000001) &&
           std::isfinite(pose.vy);
}
}

std::optional<Join> read_join(std::span<const std::byte> bytes) {
    if (bytes.size() < 47 || bytes.size() > max_join_bytes) return {};
    wire::Reader reader(bytes);
    Join result;
    result.project = bytes[3] == std::byte{'2'};
    if (!reader.magic(result.project ? "MWJ2" : "MWJ1")) return {};
    result.id = reader.integer<std::uint8_t>();
    result.ack = reader.integer<std::uint64_t>();
    const auto digest = reader.pop(32);
    const auto name_size = reader.integer<std::uint8_t>();
    if (!reader.good() || result.id > 1 || result.ack > max_sequence ||
        !name_size || name_size != reader.left()) return {};

    constexpr char hex[] = "0123456789abcdef";
    result.revision.reserve(64);
    for (auto octet : digest) {
        const auto value = std::to_integer<unsigned>(octet);
        result.revision.push_back(hex[value >> 4]);
        result.revision.push_back(hex[value & 15]);
    }
    const auto name = reader.pop(name_size);
    result.name.assign(reinterpret_cast<const char*>(name.data()), name.size());
    if (!valid_name(result.name, 255)) return {};
    return result;
}

std::optional<Route> read_route(std::span<const std::byte> bytes) {
    if (bytes.size() < 92 || bytes.size() > max_route_bytes) return {};
    wire::Reader reader(bytes);
    if (!reader.magic("MWT1")) return {};
    Route route;
    const auto phase = reader.integer<std::uint8_t>();
    if (phase > static_cast<unsigned>(TravelPhase::cancelled)) return {};
    route.phase = static_cast<TravelPhase>(phase);
    route.epoch = reader.integer<std::uint64_t>();
    route.world = reader.integer<std::uint64_t>();
    route.root = reader.integer<EntityId>();
    if (!route.epoch || !route.world || route.epoch > max_sequence || route.world > max_sequence) return {};
    constexpr char hex[] = "0123456789abcdef";
    for (auto byte : reader.pop(16)) {
        const auto n = std::to_integer<unsigned>(byte);
        route.lease.push_back(hex[n >> 4]);
        route.lease.push_back(hex[n & 15]);
    }
    auto scene = read_join(reader.pop(reader.left()));
    if (!scene || scene->project) return {};
    route.scene = std::move(*scene);
    return route;
}

static std::optional<Snapshot> read_base_snapshot(std::span<const std::byte> bytes) {
    if (bytes.size() < 13 || bytes.size() > max_base_snapshot_bytes) return {};
    const bool flying = bytes[3] == std::byte{'6'};
    const bool splits = flying || bytes[3] == std::byte{'5'};
    const bool circuit = splits || bytes[3] == std::byte{'4'};
    const bool version_three = circuit || bytes[3] == std::byte{'3'};
    const bool version_two = bytes[3] == std::byte{'2'};
    wire::Reader reader(bytes);
    if (!reader.magic(flying ? "MWS6" : splits ? "MWS5" : circuit ? "MWS4" : version_three ? "MWS3" : version_two ? "MWS2" : "MWS1")) return {};
    const auto count = reader.integer<std::uint8_t>();
    Snapshot result;
    result.ack = reader.integer<std::uint64_t>();
    if (!reader.good() || count < 1 || count > 2 || reader.left() < count * 42u ||
        !result.ack || result.ack > max_sequence) return {};
    result.players.reserve(count);
    std::array<bool,2> seen{};
    for (unsigned i = 0; i < count; ++i) {
        Pose pose;
        pose.id = reader.integer<std::uint8_t>();
        const auto grounded = reader.integer<std::uint8_t>();
        if (pose.id >= seen.size() || seen[pose.id] || grounded > 1) return {};
        seen[pose.id] = true;
        pose.grounded = grounded == 1;
        pose.feet = {read_double(reader),read_double(reader),read_double(reader)};
        pose.yaw = read_double(reader);
        pose.vy = read_double(reader);
        if (!usable_pose(pose)) return {};
        result.players.push_back(pose);
    }
    if (version_two || version_three) {
        const auto present = reader.integer<std::uint8_t>();
        if (present > 1) return {};
        if (present) {
            CarState car;
            car.root = reader.integer<EntityId>();
            const auto seat = reader.integer<std::uint8_t>();
            if (!car.root || (seat != 255 && (seat >= seen.size() || !seen[seat]))) return {};
            car.driver = seat == 255 ? -1 : seat;
            car.x = read_double(reader);
            car.z = read_double(reader);
            car.yaw = read_double(reader);
            car.speed = read_double(reader);
            car.steer = read_double(reader);
            car.distance = read_double(reader);
            if (!(std::abs(car.x) <= 1e15 && std::abs(car.z) <= 1e15 &&
                  std::abs(car.yaw) <= std::numbers::pi + .000001 &&
                  car.speed >= -4.000001 && car.speed <= 14.000001 &&
                  std::abs(car.steer) <= .470001 && std::abs(car.distance) <= 1e15)) return {};
            if (version_three) {
                const auto passenger = reader.integer<std::uint8_t>();
                if (passenger != 255 && (passenger >= seen.size() || !seen[passenger] || seat == passenger)) return {};
                car.passenger = passenger == 255 ? -1 : passenger;
            }
            result.car = car;
        }
    }
    if (circuit) {
        if (!result.car || reader.left() != circuit_trailer_bytes + (splits ? split_trailer_bytes : 0)) return {};
        CourseState score;
        score.run = reader.integer<std::uint64_t>();
        score.passed = reader.integer<std::uint8_t>();
        score.total = reader.integer<std::uint8_t>();
        const auto phase = reader.integer<std::uint8_t>(), has_best = reader.integer<std::uint8_t>();
        score.elapsed_ms = reader.integer<std::uint64_t>();
        const auto best = reader.integer<std::uint64_t>();
        score.next = reader.integer<EntityId>();
        if (!score.run || score.run > max_sequence || !score.total || score.total > circuit_limit ||
            score.passed > score.total || phase > 2 || has_best > 1 || (!has_best && best) ||
            score.elapsed_ms > max_sequence || best > max_sequence) return {};
        score.phase = static_cast<LapPhase>(phase);
        if (has_best) score.best_ms = best;
        const bool complete = score.phase == LapPhase::finished;
        if (complete != (score.passed == score.total) || complete != (score.next == root_id) ||
            (complete && (!score.best_ms || best > score.elapsed_ms)) ||
            (score.phase == LapPhase::ready && (score.passed || score.elapsed_ms))) return {};
        if (splits) {
            const auto flags = reader.integer<std::uint8_t>();
            const auto at = reader.integer<std::uint64_t>();
            const auto reference = reader.integer<std::uint64_t>();
            if (flags != 0 && flags != 1 && flags != 3) return {};
            if ((!(flags & 1) && at) || (!(flags & 2) && reference)) return {};
            if (flags & 1) {
                if (!score.passed || at > score.elapsed_ms || (complete && at != score.elapsed_ms)) return {};
                score.at_ms = at;
            }
            if (flags & 2) {
                if (reference > max_sequence) return {};
                score.reference_ms = reference;
            }
        }
        if (flying && (score.total < 2 || (score.passed == 0 && score.phase != LapPhase::ready) ||
            (score.passed == 1 && (score.at_ms.value_or(0) != 0 || score.reference_ms.value_or(0) != 0)))) return {};
        score.flying_start = flying;
        result.course = std::move(score);
    }
    if (!reader.good() || reader.left()) return {};
    return result;
}

std::optional<Snapshot> read_snapshot(std::span<const std::byte> bytes) {
    if (bytes.size() > max_snapshot_bytes) return {};
    wire::Reader reader(bytes);
    if (!reader.magic("MWN1")) return read_base_snapshot(bytes);
    const auto base_size = reader.integer<std::uint16_t>();
    const auto base = reader.pop(base_size);
    if (base.size() < 4 || base[3] < std::byte{'3'} || base[3] > std::byte{'6'}) return {};
    auto result = read_base_snapshot(base);
    const auto count = reader.integer<std::uint8_t>();
    if (!result || !reader.good() || !count || count > max_npcs || reader.left() != count * npc_record_bytes) return {};
    for (unsigned i = 0; i < count; ++i) {
        NpcPose npc;
        npc.id = reader.integer<EntityId>();
        npc.feet = {read_double(reader),read_double(reader),read_double(reader)};
        npc.yaw = read_double(reader);
        const auto state = reader.integer<std::uint8_t>();
        if (!npc.id || !(std::abs(npc.feet.x)<=1e12 && std::abs(npc.feet.y)<=1e12 &&
                         std::abs(npc.feet.z)<=1e12 && std::abs(npc.yaw)<=std::numbers::pi+.000001) ||
            state > static_cast<unsigned>(NpcState::idle) ||
            std::any_of(result->npcs.begin(),result->npcs.end(),[&](const auto& prior){return prior.id==npc.id;})) return {};
        npc.state = static_cast<NpcState>(state);
        result->npcs.push_back(npc);
    }
    return result;
}

std::string input_body(std::uint64_t seq, unsigned mask, double yaw, bool jump) {
    if (!seq || seq > max_sequence || mask > 31 || !std::isfinite(yaw)) return {};
    std::ostringstream json;
    json.imbue(std::locale::classic());
    json << "{\"seq\":" << seq << ",\"mask\":" << mask << ",\"yaw\":"
         << std::setprecision(std::numeric_limits<double>::max_digits10)
         << std::remainder(yaw, 2 * std::numbers::pi) << ",\"jump\":" << (jump ? "true" : "false") << '}';
    return json.str();
}
std::string input_body(std::uint64_t seq, unsigned mask, double yaw, bool jump,
                       bool brake, CarAction action) {
    auto body = input_body(seq, mask, yaw, jump);
    if (body.empty()) return {};
    body.pop_back();
    body += brake ? ",\"brake\":true" : ",\"brake\":false";
    switch (action) {
        case CarAction::none: break;
        case CarAction::enter: body += ",\"action\":\"enter\""; break;
        case CarAction::ride: body += ",\"action\":\"ride\""; break;
        case CarAction::exit: body += ",\"action\":\"exit\""; break;
        default: return {};
    }
    body += '}';
    return body;
}
}
