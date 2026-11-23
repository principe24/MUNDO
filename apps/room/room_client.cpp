#include "room_client.hpp"
#include "room_http.hpp"
#include "sector_stream.hpp"
#include "usage_reports.hpp"
#include "mundo/vehicle.hpp"

#include <algorithm>
#include <bit>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <functional>
#include <future>
#include <list>
#include <limits>
#include <mutex>
#include <new>
#include <span>
#include <system_error>
#include <thread>
#include <utility>

namespace mundo::room {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

struct Command {
    unsigned mask{};
    double yaw{};
    bool jump{}, brake{}, meeting{};
    CarAction action{CarAction::none};
    ScenePresence presence{ScenePresence::loading};
    std::uint64_t action_epoch{};
    Clock::time_point sampled{}, action_sampled{};
};

struct Request {
    Invitation invite;
    std::string proof;
    CancelToken stop;
};

struct RouteChanged {};
struct SectorInterrupted {};
struct IncompleteSector {};
struct Failure {
    const char* message;
    bool retry{};
};

void check_admission(unsigned status, bool joining = false) {
    if (status == 403)
        throw Failure{"Esta invitación ya no es válida. Pide al anfitrión un enlace nuevo para tu plaza."};
    if (status == 410) {
        if (joining) throw Failure{"La invitación caducó. Pide al anfitrión un enlace nuevo para tu plaza."};
        throw Failure{"Tu reserva terminó. Abre de nuevo la invitación para entrar. Si caducó, pide otra al anfitrión."};
    }
}

Response checked_reply(Response reply, bool joining = false) {
    check_admission(reply.status, joining);
    switch (reply.status) {
        case 200: return reply;
        case 423: throw Failure{"El anfitrión pausó las entradas. Abre la invitación de nuevo cuando las reanude."};
        case 409: throw Failure{"La plaza o el punto de entrada están ocupados. Espera a que se liberen o pide otra plaza al anfitrión."};
        case 412: throw RouteChanged{};
        case 426: throw Failure{"Actualiza el reproductor para entrar a esta sala."};
        case 0: case 408: case 429:
            throw Failure{"La sala no responde. Se está recuperando la conexión.", true};
        default:
            if (reply.status >= 500 && reply.status < 600)
                throw Failure{"La sala no está disponible. Se está recuperando la conexión.", true};
            throw Failure{"El servidor rechazó la solicitud de la sala."};
    }
}

Response receive(Http& http, std::string_view action, std::string_view json,
                 std::size_t limit, CancelToken stop, ScenePresence presence = ScenePresence::unreported) {
    return checked_reply(http.post(action, json, limit, stop, presence), action == "join");
}

struct PendingAction {
    CarAction action;
    std::uint64_t sequence, epoch;
    Clock::time_point expires;
};

struct Meeting {
    std::string lease;
    std::uint64_t last_request{};
    bool enabled{}, returned{};
    std::string notice;
    Clock::time_point probe_at{};
};

std::string meeting_text(const Response& reply) {
    if (reply.status != 200 || reply.body.empty() || reply.body.size() > 64) return {};
    return {reinterpret_cast<const char*>(reply.body.data()), reply.body.size()};
}

bool retryable(unsigned status) {
    return status == 0 || status == 408 || status == 429 || (status >= 500 && status < 600);
}

// The reservation survives travel. Bind each operation to the world in which it was issued.
std::string route_body(std::string json, std::uint64_t epoch, std::string_view lease = {}) {
    if (!epoch) return json;
    json.pop_back();
    if (json.size() > 1) json += ',';
    json += "\"epoch\":" + std::to_string(epoch);
    if (!lease.empty()) {
        json += ",\"lease\":\"";
        json += lease;
        json += '"';
    }
    return json + '}';
}

void probe_meeting(Http& http, Meeting& meeting, CancelToken stop, std::uint64_t epoch) {
    const auto reply = http.post("meeting", route_body("{}", epoch), 64, stop);
    check_admission(reply.status);
    meeting.enabled = false;
    meeting.probe_at = retryable(reply.status) ? Clock::now() + 10s : Clock::time_point::max();
    const std::string text = meeting_text(reply);
    // Older hosts report 404. An optional route cannot make the game unplayable.
    constexpr std::size_t counter_offset = 6 + 32 + 1;
    if (text.size() <= counter_offset || !text.starts_with("ready ") || text[counter_offset - 1] != ' ') return;
    const auto lease = text.substr(6, 32);
    if (lease.find_first_not_of("0123456789abcdef") != std::string::npos) return;
    std::uint64_t last{};
    const auto* end = text.data() + text.size();
    const auto parsed = std::from_chars(text.data() + counter_offset, end, last);
    if (parsed.ec != std::errc{} || parsed.ptr != end || last > max_sequence) return;
    if (!meeting.lease.empty() && meeting.lease != lease)
        throw Failure{"Tu reserva anterior terminó. Abre de nuevo la invitación para entrar."};
    meeting.lease = lease;
    // A delayed request may have reached the host after its response was lost.
    meeting.last_request = std::max(last, meeting.last_request);
    meeting.enabled = meeting.last_request < max_sequence;
}

void request_return(Http& http, Meeting& meeting, CancelToken stop, std::uint64_t epoch) {
    if (!meeting.enabled || meeting.last_request >= max_sequence) {
        meeting.notice = "El punto de encuentro ya no está disponible.";
        return;
    }
    const auto id = ++meeting.last_request;
    const auto json = route_body("{\"lease\":\"" + meeting.lease + "\",\"request\":" + std::to_string(id) + "}", epoch);
    auto reply = http.post("meeting", json, 64, stop);
    check_admission(reply.status);
    if (retryable(reply.status) && !stop.stop_requested()) {
        // Retrieve a missing receipt only after verifying that this exact request
        // already reached the host. Never initiate an old move during reconnect.
        const auto probe = http.post("meeting", route_body("{}", epoch), 64, stop);
        check_admission(probe.status);
        const auto expected = "ready " + meeting.lease + " " + std::to_string(id);
        if (meeting_text(probe) == expected && !stop.stop_requested()) {
            reply = http.post("meeting", json, 64, stop);
            check_admission(reply.status);
        }
    }
    const auto outcome = meeting_text(reply);
    meeting.returned = outcome == "returned";
    if (meeting.returned) meeting.notice = "Volviste al punto de encuentro.";
    else if (outcome == "blocked") meeting.notice = "El punto de encuentro está ocupado. Conservas tu posición.";
    else if (outcome == "aboard") meeting.notice = "Baja del turismo para volver al punto de encuentro.";
    else if (outcome == "off") meeting.notice = "Esta sala utiliza la aparición automática.";
    else if (outcome == "stale") meeting.notice = "La solicitud ya no corresponde a tu reserva.";
    else meeting.notice = "No se pudo confirmar el regreso. La sala mostrará tu posición actual.";
    if (id == max_sequence || (!meeting.returned && outcome != "blocked" && outcome != "aboard")) {
        meeting.enabled = false;
        meeting.probe_at = (id == max_sequence || outcome == "off" || reply.status == 404)
            ? Clock::time_point::max() : Clock::now() + 10s;
    }
}

#if defined(_WIN32)
constexpr bool mobile_sectors = false;
#else
constexpr bool mobile_sectors = true;
#endif

struct SectorCursor {
    std::int32_t x{}, z{};
    unsigned radius{};
    std::string token;
    std::shared_ptr<SectorCache> cache;
    std::size_t full_bytes{};
};

struct AheadTransfer {
    std::shared_ptr<const AheadCache> cache;
    std::shared_ptr<UsageReceipt> receipt;
    std::uint64_t generation{};
    std::int32_t from_x{}, from_z{}, target_x{}, target_z{};
    AheadStage via{AheadStage::outside};
};

struct SectorScene {
    SectorCursor cursor;
    RegionUpdate region;
    CourseIndex gates;
    std::shared_ptr<RegionUsage> usage;
    std::uint64_t hint_generation{};
    AheadStage hint_stage{AheadStage::outside};
};

struct SectorReply {
    unsigned status{};
    std::optional<SectorScene> scene;
    bool offered{};
};

std::string sector_request(const std::string& revision, const Route* route, std::string fields = {}) {
    auto body = "{\"revision\":\"" + revision + "\",\"profile\":\"" + (mobile_sectors ? "mobile" : "pc") + "\"" + fields + "}";
    return route ? route_body(std::move(body), route->epoch, route->lease) : body;
}

void check_sector_status(unsigned status, const Route* route) {
    check_admission(status);
    if (status == 412 && route) throw RouteChanged{};
}

SectorReply fetch_sector(Http& http, const std::string& revision, const Route* route, EntityId car,
                         std::shared_ptr<SectorCache> cache, CancelToken stop, const AheadTransfer& hint = {}) {
    const auto reply = http.post("sector-plan", sector_request(revision, route), sector_plan_reply_limit, stop,
                                 ScenePresence::loading);
    if (stop.stop_requested()) return {};
    check_sector_status(reply.status, route);
    if (reply.status != 200) return {reply.status, {}};
    try {
        auto plan = read_sector_plan(reply.body, revision, mobile_sectors);
        if (!plan) return {200, {}, true};
        // The assembler updates its map. Share immutable blob allocations but
        // stage the mapping until the authoritative square and ready token agree.
        cache = cache ? std::make_shared<SectorCache>(*cache) : std::make_shared<SectorCache>();
        unsigned last_status = 200;
        auto page = [&](std::size_t slot, std::size_t offset) -> std::optional<std::vector<std::byte>> {
            const auto fields = ",\"token\":\"" + plan->token + "\",\"slot\":" + std::to_string(slot) +
                                ",\"offset\":" + std::to_string(offset);
            auto part = http.post("sector-part", sector_request(revision, route, fields), world_part_reply_limit,
                                  stop, ScenePresence::loading);
            if (stop.stop_requested()) return {};
            check_sector_status(part.status, route);
            last_status = part.status;
            if (part.status != 200) return {};
            return std::move(part.body);
        };
        const auto stage = hint.generation ? ahead_stage(hint.from_x,hint.from_z,hint.target_x,hint.target_z,
                                                        plan->x,plan->z) : AheadStage::outside;
        const bool matching = stage != AheadStage::outside && (stage == AheadStage::target || stage == hint.via);
        std::uint16_t used{};
        auto world = assemble_sector(*plan, *cache, page, stop, matching ? hint.cache.get() : nullptr,
                                     matching && hint.receipt ? &used : nullptr);
        if (!world || stop.stop_requested()) return {last_status, {}, true};
        if (car) {
            VehicleSession cars;
            if (!cars.discover(*world, car) || cars.first_root() != car) return {200, {}, true};
        }
        CharacterTerrain terrain(*world, car);
        auto gates = index_course(*world);
        if (terrain.empty() || !gates) return {200, {}, true};
        SectorCursor cursor{plan->x, plan->z, plan->radius, std::move(plan->token), std::move(cache), plan->full_bytes};
        std::shared_ptr<RegionUsage> claim;
        if (matching && hint.receipt) {
            try {
                claim = std::make_shared<RegionUsage>();
                claim->receipt = hint.receipt;
                claim->stage = stage;
                claim->used = used;
            } catch (const std::bad_alloc&) { /* Reporting is optional even when geometry is ready. */ }
        }
        return {200, SectorScene{std::move(cursor), {std::move(*world), std::move(terrain)},
                                 std::move(*gates), std::move(claim), matching ? hint.generation : 0, stage}, true};
    } catch (const std::bad_alloc&) {
        return {200, {}, true};
    }
}

// This task uses its own transport. The session thread continues sending input and
// observing portal votes while the next neighborhood is downloaded and decoded.
struct SectorJob {
    CancelToken stop;
    std::future<SectorReply> result;
    ~SectorJob() { stop.request_stop(); }
};

struct AheadTarget {
    std::int32_t x{}, z{};
    EntityId car{};
    bool reverse{}, driving{};
    bool operator==(const AheadTarget&) const = default;
};

struct AheadReply {
    std::shared_ptr<const AheadCache> cache;
    unsigned status{};
    bool unavailable{};
};

// Private to one task and base token. Once closed, an older worker can never
// replace a newer prediction or publish an additional file to its consumer.
class AheadMailbox {
    std::mutex mutex_;
    std::shared_ptr<const AheadCache> verified_;
    bool closed_{};
    std::shared_ptr<UsageReceipt> receipt_;
public:
    explicit AheadMailbox(std::shared_ptr<UsageReceipt> receipt) : receipt_(std::move(receipt)) {}
    void identify(const std::string& token) { if (receipt_) receipt_->begin(token); }
    void publish(std::shared_ptr<const AheadCache> rows) {
        std::lock_guard lock(mutex_);
        if (receipt_ && rows && receipt_->matches(rows->token())) receipt_->record(rows->verified_mask(),UsageReason::active);
        if (!closed_) verified_ = std::move(rows);
    }
    std::shared_ptr<const AheadCache> close() {
        std::lock_guard lock(mutex_);
        closed_ = true;
        return std::move(verified_);
    }
};

struct AheadJob {
    CancelToken stop;
    std::future<AheadReply> result;
    std::shared_ptr<AheadMailbox> mailbox;
    ~AheadJob() { stop.request_stop(); }
};

struct AheadState {
    std::optional<AheadJob> job;
    std::shared_ptr<UsageReceipt> receipt;
    std::optional<AheadTarget> target;
    std::string base_token;
    std::uint64_t generation{};
    std::int32_t from_x{}, from_z{};
    AheadStage via{AheadStage::outside};
    bool frozen{}, middle_confirmed{};
    double heading{};
    std::shared_ptr<const AheadCache> cache;
    Clock::time_point next{};
    bool unsupported{};

    void freeze() {
        if (!frozen && job && !job->stop.stop_requested()) {
            job->stop.request_stop();
            cache = job->mailbox->close();
        }
        frozen = true;
    }

    ~AheadState() { discard(); }
    void discard(UsageReason reason = UsageReason::released) {
        if (receipt) {
            receipt->record(0,reason);
            receipt.reset();
        }
        if (job) {
            job->stop.request_stop();
            if (job->mailbox) job->mailbox->close();
            if (job->result.valid() && job->result.wait_for(0ms) == std::future_status::ready) job.reset();
        }
        target.reset();
        base_token.clear();
        via = AheadStage::outside;
        frozen = middle_confirmed = false;
        cache.reset();
        // Leave an in-flight future to finish off-thread. Destroying it here
        // could stall the next input tick or an immediately required sector.
    }

    void collect() {
        if (!job || job->result.wait_for(0ms) != std::future_status::ready) return;
        const bool cancelled = job->stop.stop_requested();
        auto partial = job->mailbox->close();
        auto task = std::move(job->result);
        job.reset();
        AheadReply reply;
        try { reply = task.get(); }
        catch (const std::exception&) { /* A speculative task never changes admission. */ }
        if (!target || cancelled) return;
        if (reply.cache || partial) {
            cache = reply.cache ? std::move(reply.cache) : std::move(partial);
        } else {
            if (reply.unavailable) unsupported = true;
            next = Clock::now() + (reply.status == 204 ? 1500ms : 3500ms);
            discard();
        }
    }
};

std::optional<AheadTarget> approaching_cell(const CarState& car, const SectorCursor& base, bool driving) {
    if (!std::isfinite(car.x) || !std::isfinite(car.z) || !std::isfinite(car.yaw) ||
        !std::isfinite(car.speed) || std::abs(car.speed) < 2) return {};
    // The source must still be the centre of the confirmed window.
    if (std::floor(car.x / 64.0 + .5) != base.x || std::floor(car.z / 64.0 + .5) != base.z) return {};
    const double vx = std::sin(car.yaw) * car.speed, vz = -std::cos(car.yaw) * car.speed;
    const auto crossing = [](double position, std::int32_t cell, double velocity) {
        if (std::abs(velocity) < 1e-6) return std::numeric_limits<double>::infinity();
        const double boundary = 64.0 * cell + std::copysign(32.0, velocity);
        return std::max(0.0, (boundary - position) / velocity);
    };
    const auto tx = crossing(car.x, base.x, vx), tz = crossing(car.z, base.z, vz);
    const double first = std::min(tx, tz);
    if (first > 2.5) return {};
    const auto step = [first](double t, double velocity) -> std::int64_t {
        return t <= 2.5 && t - first <= .30 ? (velocity > 0 ? 1 : -1) : 0;
    };
    const auto x = static_cast<std::int64_t>(base.x) + step(tx, vx);
    const auto z = static_cast<std::int64_t>(base.z) + step(tz, vz);
    constexpr auto low = std::numeric_limits<std::int32_t>::min(), high = std::numeric_limits<std::int32_t>::max();
    if (x < low || x > high || z < low || z > high) return {};
    return AheadTarget{static_cast<std::int32_t>(x), static_cast<std::int32_t>(z), car.root, car.speed < 0, driving};
}

AheadReply fetch_ahead(Http& http, const std::string& revision, const Route* route, std::int32_t from_x,
                       std::int32_t from_z, std::size_t full_bytes, const AheadTarget& target, CancelToken stop,
                       AheadMailbox& mailbox) {
    if (stop.stop_requested()) return {};
    constexpr auto manifest_limit = mobile_sectors ? 80u + 5u * 48u : sector_ahead_reply_limit;
    auto response = http.post("sector-ahead", sector_request(revision, route), manifest_limit, stop);
    if (stop.stop_requested()) return {};
    if (response.status != 200) return {{}, response.status, response.status == 404 || response.status == 405};
    auto plan = read_ahead_plan(response.body, revision, mobile_sectors, from_x, from_z);
    if (!plan || plan->window.x != target.x || plan->window.z != target.z || plan->window.full_bytes != full_bytes) return {};
    mailbox.identify(plan->window.token);
    unsigned status = 200;
    const auto part = [&](std::size_t slot, std::size_t offset) -> std::optional<std::vector<std::byte>> {
        if (stop.stop_requested() || slot >= plan->window.rows.size() || offset >= plan->window.rows[slot].bytes) return {};
        const auto fields = ",\"token\":\"" + plan->window.token + "\",\"slot\":" + std::to_string(slot) +
                            ",\"offset\":" + std::to_string(offset);
        const auto limit = 16u + std::min(world_part_reply_limit - 16u, plan->window.rows[slot].bytes - offset);
        auto reply = http.post("sector-ahead-part", sector_request(revision, route, fields), limit, stop);
        status = reply.status;
        if (status != 200 || stop.stop_requested()) return {};
        return std::move(reply.body);
    };
    auto cache = prefetch_ahead(*plan, part, stop, [&](std::shared_ptr<const AheadCache> verified) {
        if (!stop.stop_requested()) mailbox.publish(std::move(verified));
    });
    if (stop.stop_requested()) return {};
    return {std::move(cache), status, false};
}

struct PreparedScene {
    Route route;
    World world;
    CharacterTerrain terrain;
    CourseIndex gates;
    std::size_t document_size;
    std::optional<SectorCursor> sector;
    bool admitted{};
};

// The worker owns a cache for this invitation only. A memory warning can drop
// its entries from a UI thread while a decoder is reading one immutable buffer.
class ProjectWorldCache {
    using Bytes = std::vector<std::byte>;
    struct Entry {
        std::uint64_t world;
        EntityId root;
        std::string revision, lease;
        std::shared_ptr<const Bytes> bytes;
        std::shared_ptr<const CellDirectory> cells;
    };
    static constexpr std::size_t max_entries = 8;
#if defined(_WIN32)
    static constexpr std::size_t budget = 32u * 1024u * 1024u;
#else
    static constexpr std::size_t budget = 8u * 1024u * 1024u;
#endif
    std::mutex mutex_;
    std::list<Entry> entries_;
    // One detached node can be promoted without allocating or copying after the host commits.
    std::list<Entry> candidate_;
    std::uint64_t candidate_epoch_{};
    std::size_t retained_{};
    std::uint64_t generation_{};
    std::uint64_t directory_generation_{};
    bool directory_active_{true};

    static bool matches(const Entry& item, const Route& route) {
        return item.world == route.world && item.root == route.root && item.revision == route.scene.revision &&
               item.lease == route.lease;
    }

    static std::size_t directory_cost(const Entry& item) {
        return item.cells ? item.cells->capacity() * sizeof(CellRoot) : 0;
    }

public:
    static bool fits(const Bytes& file) { return file.capacity() <= budget; }

    struct Lookup {
        std::shared_ptr<const Bytes> bytes;
        std::uint64_t generation;
    };

    Lookup find(const Route& route) {
        std::lock_guard lock(mutex_);
        candidate_.clear();
        const auto hit = std::find_if(entries_.begin(), entries_.end(), [&](const Entry& item) {
            return matches(item, route);
        });
        if (hit == entries_.end()) return {{}, generation_};
        return {hit->bytes, generation_};
    }

    void stage(const Route& route, Bytes&& file, std::uint64_t generation) {
        // Account for the allocation, since a legacy HTTP response can have spare capacity.
        const auto cost = file.capacity();
        if (!fits(file)) return;
        std::lock_guard lock(mutex_);
        if (generation != generation_) return;
        while (entries_.size() >= max_entries || cost > budget - retained_) {
            retained_ -= entries_.back().bytes->capacity() + directory_cost(entries_.back());
            entries_.pop_back();
        }
        try {
            candidate_.push_front({route.world, route.root, route.scene.revision, route.lease,
                                   std::make_shared<const Bytes>(std::move(file)), {}});
            candidate_epoch_ = route.epoch;
        } catch (const std::bad_alloc&) {
            // The authenticated scene already decoded. Low memory can disable reuse for this trip.
            entries_.clear();
            retained_ = 0;
        }
    }

    void finish(const Route& confirmed) {
        std::lock_guard lock(mutex_);
        if (!candidate_.empty() && candidate_epoch_ == confirmed.epoch && matches(candidate_.front(), confirmed)) {
            retained_ += candidate_.front().bytes->capacity();
            entries_.splice(entries_.begin(), candidate_);
        } else {
            candidate_.clear();
            const auto hit = std::find_if(entries_.begin(), entries_.end(), [&](const Entry& entry) {
                return matches(entry, confirmed);
            });
            if (hit != entries_.end()) entries_.splice(entries_.begin(), entries_, hit);
        }
    }

    struct DirectoryLookup {
        std::shared_ptr<const CellDirectory> cells;
        std::uint64_t generation;
        bool active;
    };

    // finish() promoted the freshly confirmed world to the front. Directories
    // never retain a decoded World or evict a cached document to make room.
    DirectoryLookup directory(const Route& confirmed) {
        std::lock_guard lock(mutex_);
        if (!directory_active_ || entries_.empty() || !matches(entries_.front(), confirmed))
            return {{}, directory_generation_, directory_active_};
        return {entries_.front().cells, directory_generation_, true};
    }

    bool directory_current(std::uint64_t generation) {
        std::lock_guard lock(mutex_);
        return directory_active_ && generation == directory_generation_;
    }

    // False means this in-flight response predates a trim or suspension and
    // should be discarded even as an optional directory for the pending scene.
    bool retain_directory(const Route& confirmed, const CellDirectory& rows, std::uint64_t generation) {
        std::lock_guard lock(mutex_);
        if (!directory_active_ || generation != directory_generation_) return false;
        if (entries_.empty()) return true;
        auto& item = entries_.front();
        if (item.cells || !matches(item, confirmed) || rows.size() > (budget - retained_) / sizeof(CellRoot)) return true;
        try {
            auto copy = std::make_shared<const CellDirectory>(rows);
            const auto cost = copy->capacity() * sizeof(CellRoot);
            if (cost > budget - retained_) return true;
            item.cells = std::move(copy);
            retained_ += cost;
        } catch (const std::bad_alloc&) {
            // The active scene still consumes its original validated directory.
        }
        return true;
    }

    void directory_foreground(bool active) {
        std::lock_guard lock(mutex_);
        directory_active_ = active;
        if (active) return;
        ++directory_generation_;
        for (auto& item : entries_) {
            retained_ -= directory_cost(item);
            item.cells.reset();
        }
    }

    void trim() {
        std::lock_guard lock(mutex_);
        ++generation_;
        ++directory_generation_;
        entries_.clear();
        candidate_.clear();
        retained_ = 0;
    }
};

// A prefix belongs to one private reservation. A project additionally identifies
// the proposed world and route epoch, even when two worlds share identical bytes.
struct Download {
    std::string revision, lease;
    std::uint64_t world{}, epoch{};
    std::size_t total{};
    std::vector<std::byte> prefix;
    bool legacy{}, ordinary_only{}, used_rest{};

    bool matches(const std::string& hash, const Route* route) const {
        return revision == hash && (route
            ? world == route->world && epoch == route->epoch && lease == route->lease
            : !epoch && !world && lease.empty());
    }
};

std::uint32_t part_field(const std::vector<std::byte>& body, std::size_t offset) {
    std::uint32_t value{};
    for (unsigned index = 0; index < 4; ++index)
        value |= std::to_integer<std::uint32_t>(body[offset + index]) << (index * 8);
    return value;
}

constexpr std::size_t part_header = 16;
constexpr std::size_t part_bytes = world_part_reply_limit - part_header;

bool valid_page(const std::vector<std::byte>& body, std::byte kind, std::size_t cap,
                std::size_t total, std::size_t offset) {
    if (body.size() < part_header || body[0] != std::byte{'M'} || body[1] != std::byte{'W'} ||
        body[2] != kind || body[3] != std::byte{'1'}) return false;
    const auto size = static_cast<std::size_t>(part_field(body, 4));
    return size >= 24 && size <= cap && (!total || size == total) && offset < size &&
        part_field(body, 8) == offset && offset % part_bytes == 0 &&
        part_field(body, 12) == std::min(part_bytes, size - offset);
}

void commit_page(std::vector<std::byte>& prefix, std::size_t& total,
                 std::size_t size, std::span<const std::byte> page) {
    if (prefix.empty()) prefix.reserve(size);
    prefix.insert(prefix.end(), page.begin(), page.end());
    total = size;
}

bool append_part(const std::vector<std::byte>& body, std::size_t cap, std::size_t& total,
                 std::vector<std::byte>& prefix) {
    if (!valid_page(body, std::byte{'C'}, cap, total, prefix.size()) ||
        body.size() - part_header != part_field(body, 12)) return false;
    commit_page(prefix, total, part_field(body, 4), std::span(body).subspan(part_header));
    return true;
}

// A reconstruction is private to one page. A broken operation must never leave
// a partial page in the contiguous prefix used to resume ordinary world-part.
bool reconstruct_page(const std::vector<std::byte>& body, const std::vector<std::byte>& basis,
                      const Download& download, std::vector<std::byte>& page) {
    constexpr std::size_t header = 24;
    if (body.size() < header || body.size() > world_part_reply_limit ||
        !valid_page(body, std::byte{'R'}, max_world_bytes, download.total, download.prefix.size())) return false;
    const auto length = part_field(body, 12);
    const auto count = part_field(body, 16);
    const auto literals = part_field(body, 20);
    if (!count || count > 4096 || literals > length ||
        body.size() - header != static_cast<std::size_t>(count) * 8 + literals) return false;
    page.reserve(length);
    std::size_t cursor = header, literal_count = 0;
    for (std::uint32_t op = 0; op < count; ++op) {
        if (body.size() - cursor < 8) return false;
        const auto source = static_cast<std::size_t>(part_field(body, cursor));
        const auto run = static_cast<std::size_t>(part_field(body, cursor + 4));
        cursor += 8;
        if (!run || run > length - page.size()) return false;
        if (source == 0xffffffffu) {
            if (run > literals - literal_count || run > body.size() - cursor) return false;
            page.insert(page.end(), body.begin() + cursor, body.begin() + cursor + run);
            literal_count += run;
            cursor += run;
        } else {
            if (source > basis.size() || run > basis.size() - source) return false;
            page.insert(page.end(), basis.begin() + source, basis.begin() + source + run);
        }
    }
    return cursor == body.size() && literal_count == literals && page.size() == length;
}

using DownloadProgress = std::function<void(std::size_t, std::size_t)>;

struct EntryDestination {
    std::string revision, lease;
    std::uint64_t epoch{}, world{};
    EntityId root{};
    bool operator==(const EntryDestination&) const = default;
};

EntryDestination scene_destination(const std::string& revision, const Route* route) {
    if (route) return {revision, route->lease, route->epoch, route->world, route->root};
    return {revision, {}, 0, 0, root_id};
}

struct FullConfirmation {
    EntryDestination destination;
    std::string token;
    unsigned renewals{};
};

// The UI can relinquish the sole retained owner even while a request is in flight.
struct EntryBasis {
    EntryDestination destination;
    std::string request_fields; // Validated revision, platform profile and exact starter SHA.
    std::vector<std::byte> bytes;
};
using BasisPtr = std::shared_ptr<const EntryBasis>;

struct EntryTransfer {
    std::optional<EntryDestination> destination;
    bool attempted{}, unsupported{};
    std::function<bool()> visible;
    std::function<void(std::optional<EntryPreview>, BasisPtr)> show;
    std::function<BasisPtr()> basis;
    std::function<void()> release_basis;

    void select(const std::string& revision, const Route* route) {
        auto next = scene_destination(revision, route);
        if (!destination || *destination != next) {
            show(std::nullopt, {});
            destination = std::move(next);
            attempted = false;
        }
    }

    // Unsupported or malformed previews leave the normal full-world route available.
    // A rejected reservation or a changed project epoch still stops the old request.
    static bool available(unsigned status, const EntryDestination& target) {
        check_admission(status);
        if (status == 412 && target.epoch != 0) throw RouteChanged{};
        return status == 200;
    }

    void fetch(Http& http, CancelToken stop) {
        if (unsupported || attempted || !destination || stop.stop_requested() || !visible()) return;
        attempted = true;
        const auto& target = *destination;
#if defined(_WIN32)
        constexpr auto profile = "pc";
        constexpr unsigned code = 2, max_slots = 26;
        constexpr std::size_t cap = 8u * 1024u * 1024u;
#else
        constexpr auto profile = "mobile";
        constexpr unsigned code = 1, max_slots = 10;
        constexpr std::size_t cap = 4u * 1024u * 1024u;
#endif
        const auto fields = "{\"revision\":\"" + target.revision + "\",\"profile\":\"" + profile + "\"";
        const auto info = http.post("entry-info", route_body(fields + "}", target.epoch, target.lease),
                                    entry_info_reply_size, stop, ScenePresence::loading);
        if (stop.stop_requested()) return;
        if (info.status == 404 || info.status == 405) unsupported = true;
        if (!available(info.status, target) || !visible()) return;
        const auto& body = info.body;
        if (body.size() != entry_info_reply_size || body[0] != std::byte{'M'} ||
            body[1] != std::byte{'E'} || body[2] != std::byte{'I'} || body[3] != std::byte{'1'}) return;
        auto total = static_cast<std::size_t>(part_field(body, 4));
        const auto slots = part_field(body, 8);
        if (total < 24 || total > cap || !slots || slots > max_slots || part_field(body, 12) != code ||
            std::any_of(body.begin() + 96, body.end(), [](auto value){ return value != std::byte{}; })) return;
        const auto hash_at = [&](std::size_t offset) {
            return hex_text({reinterpret_cast<const unsigned char*>(body.data() + offset), 32});
        };
        if (hash_at(16) != target.revision) return;
        const auto hash = hash_at(48);
        const auto coordinate = [&](std::size_t offset) {
            const auto high = static_cast<std::uint64_t>(part_field(body, offset + 4));
            return std::bit_cast<double>((high << 32) | part_field(body, offset));
        };
        const double x = coordinate(80), z = coordinate(88);
        if (!(std::abs(x) <= 1e15 && std::abs(z) <= 1e15)) return;
        std::vector<std::byte> bytes;
        while (bytes.size() < total) {
            if (stop.stop_requested() || !visible()) return;
            const auto query = fields + ",\"hash\":\"" + hash + "\",\"offset\":" + std::to_string(bytes.size()) + "}";
            const auto part = http.post("entry-part", route_body(query, target.epoch, target.lease),
                                        world_part_reply_limit, stop, ScenePresence::loading);
            if (stop.stop_requested() || !available(part.status, target) || !visible() ||
                !append_part(part.body, cap, total, bytes)) return;
        }
        if (!visible() || !matches_revision(bytes, hash)) return;
        auto world = decode(bytes);
        if (!world || (target.root && !world->get(target.root)) || stop.stop_requested() || !visible()) return;
        CharacterTerrain terrain(*world, target.root);
        if (terrain.empty()) return;
        auto source = std::make_shared<EntryBasis>(EntryBasis{target, fields + ",\"hash\":\"" + hash + "\"", std::move(bytes)});
        show(EntryPreview{std::move(*world), std::move(terrain), x, z, target.revision, target.epoch, target.world},
             std::move(source));
    }

    void try_fetch(Http& http, CancelToken stop) {
        try { fetch(http, stop); }
        catch (const std::bad_alloc&) { /* Release temporary preview data and continue the full download. */ }
    }
};

bool append_rest(Http& http, EntryTransfer& entry, Download& download, CancelToken stop) {
    auto source = entry.basis();
    if (!source || !entry.destination || source->destination != *entry.destination ||
        source->destination.revision != download.revision || source->destination.epoch != download.epoch ||
        source->destination.world != download.world || source->destination.lease != download.lease) return false;
    const auto request = route_body(source->request_fields + ",\"offset\":" + std::to_string(download.prefix.size()) + "}",
                                    download.epoch, download.lease);
    // The UI may drop the starter during a blocked read. Do not pin its allocation here.
    std::weak_ptr<const EntryBasis> requested = source;
    source.reset();
    const auto reply = http.post("world-rest", request, world_part_reply_limit, stop, ScenePresence::loading);
    if (stop.stop_requested() || !EntryTransfer::available(reply.status, *entry.destination)) return false;
    source = entry.basis();
    if (!source || source != requested.lock()) return false;
    const auto& body = reply.body;
    if (body.size() >= part_header && body[2] == std::byte{'C'})
        return append_part(body, max_world_bytes, download.total, download.prefix);

    std::vector<std::byte> page;
    if (!reconstruct_page(body, source->bytes, download, page) || !entry.visible()) return false;
    commit_page(download.prefix, download.total, part_field(body, 4), page);
    return true;
}

std::optional<std::vector<std::byte>> download_world(Http& http, Download& download, EntryTransfer& entry,
        const std::string& revision, const Route* route, CancelToken stop, const DownloadProgress& report) {
    if (!download.matches(revision, route)) {
        download = {};
        download.revision = revision;
        if (route) {
            download.world = route->world;
            download.epoch = route->epoch;
            download.lease = route->lease;
        }
    }

    while (!stop.stop_requested()) {
        bool accepted = false;
        if (!download.ordinary_only && !download.legacy) {
            try { accepted = append_rest(http, entry, download, stop); }
            catch (const std::bad_alloc&) { /* Release the optional starter and request the same ordinary page. */ }
            if (stop.stop_requested()) return {};
            if (accepted) download.used_rest = true;
            else {
                download.ordinary_only = true;
                entry.release_basis();
            }
        }
        if (!accepted && !download.legacy) {
            auto request = "{\"revision\":\"" + revision + "\",\"offset\":" + std::to_string(download.prefix.size()) + "}";
            auto raw = http.post("world-part", route_body(std::move(request), download.epoch, download.lease),
                                 world_part_reply_limit, stop, ScenePresence::loading);
            if (stop.stop_requested()) return {};
            if (raw.status == 404 || raw.status == 405) {
                download.legacy = true;
                download.used_rest = false;
                std::vector<std::byte>{}.swap(download.prefix);
            } else if (raw.status != 416 || !download.used_rest) {
                // A 416 after optional pages can also mean their advertised total
                // was too large. Only that case is eligible for a clean restart.
                auto reply = checked_reply(std::move(raw));
                accepted = append_part(reply.body, max_world_bytes, download.total, download.prefix);
                if (!accepted && !download.used_rest) {
                    download = {};
                    return {};
                }
            }
        }

        if (accepted) {
            report(download.prefix.size(), download.total);
            if (download.prefix.size() < download.total) continue;
        }
        entry.release_basis();
        if (download.legacy) {
            auto reply = receive(http, "world", route_body("{}", download.epoch, download.lease),
                                 max_world_bytes, stop, ScenePresence::loading);
            download.prefix = std::move(reply.body);
        }
        if (stop.stop_requested()) return {};
        if ((accepted || download.legacy) && download.prefix.size() >= 24 && matches_revision(download.prefix, revision)) {
            auto file = std::move(download.prefix);
            download = {};
            return file;
        }
        if (!download.used_rest) {
            download = {};
            return {};
        }
        // A digest mismatch (or an inconsistent full length after fallback) may
        // implicate any earlier reconstructed page. Retry once entirely from offset zero.
        download.used_rest = false;
        download.ordinary_only = true;
        download.total = 0;
        std::vector<std::byte>{}.swap(download.prefix);
    }
    return {};
}

struct Connection {
    std::optional<Join> admission;
    bool world_delivered{};
    std::optional<World> world;
    std::optional<CharacterTerrain> terrain;
    std::optional<CellDirectory> cells;
    std::optional<SectorCursor> sector;
    std::optional<SectorJob> sector_job;
    std::optional<SectorScene> offered_region;
    bool await_window{};
    std::function<CancelToken()> sector_cancel, ahead_cancel;
    std::function<bool()> ahead_allowed;
    AheadState ahead;
    std::shared_ptr<UsageSeat> usage_seat;
    std::weak_ptr<UsageReports> usage_reports;
    std::shared_ptr<RegionUsage> next_usage;
    std::optional<RegionUpdate> next_region;
    bool legacy_sector{}, sector_host{}, initial_support{}, need_admission{}, force_full{}, same_world_swap{};
    unsigned sector_conflicts{};
    Clock::time_point next_sector{};
    std::optional<FullConfirmation> full_confirmation;
    bool cell_index_unsupported{};
    std::uint64_t last_ack{}, highest_sent{};
    std::optional<PendingAction> pending;
    std::optional<EntityId> scene_car;
    Meeting meeting;
    CourseIndex gates;
    std::optional<CourseState> last_course;
    std::string lease;
    std::optional<Route> route;
    std::optional<PreparedScene> staged;
    Download download;
    EntryTransfer entry;
    DownloadProgress report;
    std::shared_ptr<ProjectWorldCache> cache = std::make_shared<ProjectWorldCache>();
    bool route_dirty{};
    std::uint64_t world_epoch() const { return route ? route->epoch : 0; }
};

bool has_complete_scene(const Connection& session, const EntryDestination& target) {
    if (!session.admission || session.admission->project != (target.epoch != 0)) return false;
    if (session.admission->project) {
        if (session.lease != target.lease) return false;
        if (session.staged) {
            const auto& staged = *session.staged;
            if (!staged.sector && staged.document_size >= 24 &&
                scene_destination(staged.route.scene.revision, &staged.route) == target) return true;
        }
        if (!session.route || scene_destination(session.route->scene.revision, &*session.route) != target) return false;
    }
    return session.need_admission && !session.sector && session.world && session.terrain &&
           session.admission->revision == target.revision;
}

// Both messages bind to the same verified complete scene; a bare POST cannot
// release the host's movement guard. Retain the token if the receipt is lost.
bool acknowledge_full(Http& http, Connection& session, const std::string& revision, const Route* route, CancelToken stop) {
    const auto target = scene_destination(revision, route);
    const auto operation = session.sector_cancel();
    auto current = [&] {
        if (stop.stop_requested()) return false;
        if (operation.stop_requested()) throw SectorInterrupted{};
        if (!has_complete_scene(session, target)) {
            session.full_confirmation.reset();
            if (route) throw RouteChanged{};
            throw Failure{"El mundo completo que se iba a confirmar ya no está preparado."};
        }
        return true;
    };
    if (!current()) return false;
    if (!session.full_confirmation || session.full_confirmation->destination != target)
        session.full_confirmation = FullConfirmation{target, {}, 0};
    auto& pending = *session.full_confirmation;
    for (;;) {
        if (!current()) return false;
        const bool confirm = !pending.token.empty();
        const auto fields = confirm ? ",\"token\":\"" + pending.token + "\"" : std::string{};
        const auto response = http.post("sector-full", sector_request(revision, route, fields),
                                        confirm ? sector_ack_reply_limit : sector_full_reply_limit,
                                        operation, ScenePresence::loading);
        if (stop.stop_requested()) return false;
        check_sector_status(response.status, route);
        if (!current()) return false;
        if (!confirm && !session.sector_host && (response.status == 404 || response.status == 405)) {
            session.legacy_sector = true;
            session.full_confirmation.reset();
            return true;
        }
        if (!confirm && response.status == 200 && response.body.size() == sector_full_reply_limit) {
            pending.token = hex_text({reinterpret_cast<const unsigned char*>(response.body.data()), response.body.size()});
            session.sector_host = true;
            continue;
        }
        if (confirm && response.status == 204) {
            session.sector_host = true;
            session.full_confirmation.reset();
            return true;
        }
        if (response.status == 409 && pending.renewals < 2) {
            ++pending.renewals;
            pending.token.clear();
            continue;
        }
        if (retryable(response.status))
            throw Failure{"Esperando la confirmación del mundo completo por el anfitrión…", true};
        throw Failure{"El anfitrión no confirmó el desafío del mundo completo."};
    }
}

bool acknowledge_sector(Http& http, Connection& session, const std::string& revision, const Route* route,
                        const SectorCursor* window, CancelToken stop) {
    if (session.legacy_sector) return true;
    if (!window) return acknowledge_full(http, session, revision, route, stop);
    session.full_confirmation.reset();
    auto query = sector_request(revision, route, ",\"token\":\"" + window->token + "\"");
    const auto reply = http.post("sector-ready", query, sector_ack_reply_limit, stop, ScenePresence::loading);
    if (stop.stop_requested()) return false;
    check_sector_status(reply.status, route);
    if (reply.status == 204) { session.sector_host = true; return true; }
    if (reply.status == 409 || reply.status == 412) return false;
    if (retryable(reply.status))
        throw Failure{"Esperando la confirmación del terreno por el anfitrión…", true};
    throw Failure{"El anfitrión no confirmó la instalación del terreno."};
}

std::optional<SectorScene> first_sector(Http& http, Connection& session, const std::string& revision,
                                        const Route* route) try {
    if (session.legacy_sector) return {};
    session.full_confirmation.reset();
    const auto cancel = session.sector_cancel();
    if (cancel.stop_requested()) throw SectorInterrupted{};
    auto result = fetch_sector(http, revision, route, route ? route->root : root_id, {}, cancel);
    if (cancel.stop_requested()) throw SectorInterrupted{};
    if (result.offered || result.status == 204) session.sector_host = true;
    if (!session.sector_host && (result.status == 404 || result.status == 405)) session.legacy_sector = true;
    return std::move(result.scene);
} catch (const std::bad_alloc&) {
    return {};
}

std::optional<CellDirectory> load_cells(Http& http, Connection& session, const World& world,
        std::size_t document_size, const std::string& revision, const Route* route, CancelToken stop) {
    // Same eligibility floor as the host's zone builder. Use exact checked document
    // bytes, independent of capacity, platform cache limits or the number of entities.
    if (document_size < 128u * 1024u || stop.stop_requested()) return {};
    try {
        std::uint64_t generation{};
        if (route) {
            const auto cached = session.cache->directory(*route);
            if (!cached.active) return {};
            generation = cached.generation;
            if (cached.cells) {
                CellDirectory rows = *cached.cells;
                if (!session.cache->directory_current(generation)) return {};
                return rows;
            }
        }
        if (session.cell_index_unsupported) return {};
        auto request = "{\"revision\":\"" + revision + "\"}";
        if (route) request = route_body(std::move(request), route->epoch, route->lease);
        const auto reply = http.post("cell-index", request, cell_index_reply_limit, stop, ScenePresence::loading);
        if (stop.stop_requested()) return {};
        check_admission(reply.status);
        if (reply.status == 412 && route) throw RouteChanged{};
        if (reply.status == 404 || reply.status == 405) session.cell_index_unsupported = true;
        if (reply.status != 200) return {};

        constexpr std::size_t header = 48, row_size = 16;
        const auto& body = reply.body;
        if (body.size() < header || body.size() > cell_index_reply_limit ||
            body[0] != std::byte{'M'} || body[1] != std::byte{'Z'} ||
            body[2] != std::byte{'I'} || body[3] != std::byte{'1'} ||
            part_field(body, 8) != 64 || part_field(body, 12) != 0 ||
            hex_text({reinterpret_cast<const unsigned char*>(body.data() + 16), 32}) != revision) return {};
        const auto count = static_cast<std::size_t>(part_field(body, 4));
        if (!count || count > max_entities || count > world.nodes().size() ||
            body.size() - header != count * row_size) return {};
        CellDirectory rows;
        rows.reserve(count);
        for (std::size_t pos = header; pos < body.size(); pos += row_size) {
            if (stop.stop_requested()) return {};
            const auto high = static_cast<EntityId>(part_field(body, pos + 4));
            const auto root = (high << 32) | part_field(body, pos);
            const auto* node = world.get(root);
            if (!node || node->parent != root_id) return {};
            rows.push_back({root, std::bit_cast<std::int32_t>(part_field(body, pos + 8)),
                                  std::bit_cast<std::int32_t>(part_field(body, pos + 12))});
        }
        std::sort(rows.begin(), rows.end(), [](const CellRoot& a, const CellRoot& b) { return a.root < b.root; });
        if (std::adjacent_find(rows.begin(), rows.end(),
            [](const CellRoot& a, const CellRoot& b) { return a.root == b.root; }) != rows.end()) return {};
        const auto anchor = world.first_solid_family();
        // Distinct top-level roots have disjoint subtrees. Visit each family at most once.
        for (const auto& row : rows) {
            if (stop.stop_requested() || row.root == anchor || !world.family_fits_cell(row.root, row.x, row.z)) return {};
        }
        if (stop.stop_requested() || (route && !session.cache->retain_directory(*route, rows, generation))) return {};
        return rows;
    } catch (const std::bad_alloc&) {
        return {}; // The authoritative world already decoded; residency is optional.
    }
}

void join_room(Http& http, Connection& session, CancelToken stop) {
    // MWJ1 has no lease field. An interrupted single-world transfer must use
    // the original authenticated seat; another join could issue a new lease.
    if (!session.admission || session.admission->project || session.download.revision.empty()) {
        auto hello = receive(http, "join", "{}", max_join_bytes, stop, ScenePresence::loading);
        auto seat = read_join(hello.body);
        if (!seat) throw Failure{"La respuesta de entrada es incompatible."};
        if (session.admission && (seat->id != session.admission->id ||
                                  seat->project != session.admission->project ||
                                  (!seat->project && seat->revision != session.admission->revision)))
            throw Failure{"La sala cambió de revisión o de asiento durante la reconexión."};
        if (seat->ack < session.last_ack || seat->ack > session.highest_sent)
            throw Failure{"El servidor ya no conserva el estado de este asiento."};

        session.last_ack = seat->ack;
        session.admission = std::move(seat);
    }
    if (session.admission->project) { session.route_dirty = true; return; }
    if (session.world_delivered || session.world || stop.stop_requested()) return;

    if (session.download.revision.empty()) {
        if (auto initial = first_sector(http, session, session.admission->revision, nullptr)) {
            session.sector = std::move(initial->cursor);
            session.world = std::move(initial->region.world);
            session.terrain = std::move(initial->region.terrain);
            session.gates = std::move(initial->gates);
            session.initial_support = true;
            session.need_admission = true;
            return;
        }
    }
    session.entry.select(session.admission->revision, nullptr);
    session.entry.try_fetch(http, stop);
    auto file = download_world(http, session.download, session.entry, session.admission->revision, nullptr, stop, session.report);
    if (stop.stop_requested()) return;
    if (!file)
        throw Failure{"El mundo recibido no coincide con la revisión de la sala."};
    const auto document_size = file->size();
    auto world = decode(*file);
    file.reset();
    if (!world) throw Failure{"El archivo de la sala no es un mundo compatible."};
    if (stop.stop_requested()) return;
    auto gates=index_course(*world);
    if (!gates) throw Failure{"La definición del circuito de la sala es inválida."};
    session.cells = load_cells(http, session, *world, document_size, session.admission->revision, nullptr, stop);
    if (stop.stop_requested()) return;
    session.gates=std::move(*gates);
    session.world = std::move(world);
    session.need_admission = !session.legacy_sector;
}

Route route_info(Http& http, Connection& session, std::string_view body, CancelToken stop) {
    auto reply = receive(http, "route", body, max_route_bytes, stop);
    auto route = read_route(reply.body);
    if (!route || route->scene.id != session.admission->id ||
        route->scene.ack < session.last_ack || route->scene.ack > session.highest_sent ||
        route->epoch < session.world_epoch())
        throw Failure{"El anfitrión devolvió un destino incompatible con esta sesión."};
    if (!session.lease.empty() && session.lease != route->lease) {
        session.cache->trim();
        throw Failure{"La reserva del jugador cambió durante el viaje."};
    }
    session.lease = route->lease;
    session.entry.select(route->scene.revision, &*route);
    return std::move(*route);
}

bool same_scene(const Route& a, const Route& b) {
    return a.world == b.world && a.scene.revision == b.scene.revision && a.root == b.root;
}

std::optional<PreparedScene> prepare_scene(Http& http, Connection& session, const Route& route, CancelToken stop,
                                           bool complete = false) {
    if (stop.stop_requested() || !session.admission->project || session.lease.empty() ||
        session.lease != route.lease) return {};
    // Only a route freshly authenticated by route_info can select cached bytes.
    auto cached = session.cache->find(route);
    std::optional<std::vector<std::byte>> file;
    if (!complete && !cached.bytes && !session.download.matches(route.scene.revision, &route)) {
        if (auto initial = first_sector(http, session, route.scene.revision, &route))
            return PreparedScene{route, std::move(initial->region.world), std::move(initial->region.terrain),
                                 std::move(initial->gates), 0, std::move(initial->cursor), false};
    }
    if (cached.bytes) {
        session.download = {};
    } else {
        session.entry.try_fetch(http, stop);
        file = download_world(http, session.download, session.entry, route.scene.revision, &route, stop, session.report);
        if (!file || stop.stop_requested()) return {};
    }
    const auto document_size = cached.bytes ? cached.bytes->size() : file->size();
    auto world = decode(cached.bytes ? *cached.bytes : *file);
    cached.bytes.reset();
    if (file && !ProjectWorldCache::fits(*file)) file.reset();
    if (!world || stop.stop_requested()) return {};
    if (route.root) {
        VehicleSession cars;
        if (!cars.discover(*world, route.root) || cars.first_root() != route.root) return {};
    }
    CharacterTerrain terrain(*world, route.root);
    auto gates=index_course(*world);
    if (!gates || stop.stop_requested()) return {};
    if (file) session.cache->stage(route, std::move(*file), cached.generation);
    return PreparedScene{route, std::move(*world), std::move(terrain), std::move(*gates), document_size};
}

bool admit_prepared(Http& http, Connection& session, const Route& route, CancelToken stop) {
    if (!session.staged || stop.stop_requested()) return false;
    if (session.staged->admitted) return true;
    auto& sector = session.staged->sector;
    if (!acknowledge_sector(http, session, route.scene.revision, &route, sector ? &*sector : nullptr, stop)) {
        if (stop.stop_requested()) return false;
        session.staged.reset();
        session.staged = prepare_scene(http, session, route, stop, true);
        if (!session.staged || !acknowledge_sector(http, session, route.scene.revision, &route, nullptr, stop)) return false;
    }
    session.staged->admitted = true;
    return true;
}

bool sync_route(Http& http, Connection& session, CancelToken stop) {
    auto route = route_info(http, session, "{}", stop);
    if (route.phase == TravelPhase::preparing) {
        if (!session.staged || session.staged->route.epoch != route.epoch ||
            !same_scene(session.staged->route, route)) {
            session.staged.reset();
            session.staged = prepare_scene(http, session, route, stop);
        }
        if (stop.stop_requested()) return false;
        const bool admitted = admit_prepared(http, session, route, stop);
        if (stop.stop_requested()) return false;
        const auto vote = admitted ? "{\"vote\":\"ready\"}" : "{\"vote\":\"failed\"}";
        route = route_info(http, session, route_body(vote, route.epoch, route.lease), stop);
        if (route.phase == TravelPhase::preparing) return false;
    }
    const bool same_world = session.route && same_scene(*session.route, route);
    const bool changed = !same_world || (session.sector_host && session.route->epoch != route.epoch);
    if (changed) {
        if (!session.staged || session.staged->route.epoch != route.epoch ||
            !same_scene(session.staged->route, route))
            session.staged = prepare_scene(http, session, route, stop);
        if (stop.stop_requested()) return false;
        if (!admit_prepared(http, session, route, stop)) throw Failure{"El mundo o el turismo recibido no coincide con la revisión de la sala."};
    }
    // Both active and cancelled descriptors identify the host's authoritative world here.
    session.cache->finish(route);
    if (changed) {
        // The host has confirmed this destination. An optional directory must not
        // delay the ready vote or consume time from the other players' travel window.
        auto cells = load_cells(http, session, session.staged->world, session.staged->document_size,
                                route.scene.revision, &route, stop);
        if (stop.stop_requested()) return false;
        session.gates=std::move(session.staged->gates);
        session.last_course.reset();
        session.sector_job.reset();
        session.offered_region.reset();
        session.await_window = false;
        session.sector = std::move(session.staged->sector);
        session.initial_support = session.sector.has_value();
        session.need_admission = false;
        session.force_full = false;
        session.sector_conflicts = 0;
        session.next_region.reset();
        session.next_usage.reset();
        session.same_world_swap = same_world && session.world_delivered;
        session.world = std::move(session.staged->world);
        session.terrain = std::move(session.staged->terrain);
        session.cells = std::move(cells);
        session.scene_car = route.root;
        session.world_delivered = false;
    }
    if (session.route && session.route->epoch != route.epoch && route.phase == TravelPhase::cancelled)
        session.meeting.notice = "El viaje se canceló. Conservas tu posición en el mundo de origen.";
    session.staged.reset();
    session.download = {};
    session.pending.reset();
    session.meeting.enabled = false;
    session.meeting.probe_at = {};
    session.admission->revision = route.scene.revision;
    session.admission->name = route.scene.name;
    session.last_ack = route.scene.ack;
    session.route = std::move(route);
    session.route_dirty = false;
    return true;
}

Snapshot exchange(Http& http, Connection& session, Command command, CancelToken stop) {
    // A join reports the highest processed sequence. Retry an unconfirmed action
    // under its original number, with neutral controls, so a delayed POST cannot
    // board twice or replay a jump. Focus changes and old intents cancel the retry.
    if (session.pending && (session.last_ack >= session.pending->sequence ||
        session.pending->epoch != command.action_epoch || Clock::now() >= session.pending->expires))
        session.pending.reset();
    std::uint64_t sequence;
    if (session.pending) {
        sequence = session.pending->sequence;
        command.mask = 0;
        command.jump = false;
        command.brake = true;
        command.action = session.pending->action;
    } else {
        if (session.highest_sent == max_sequence)
            throw Failure{"La secuencia de esta sesión se agotó."};
        sequence = ++session.highest_sent;
        if (command.action != CarAction::none)
            session.pending = PendingAction{command.action, sequence, command.action_epoch, Clock::now() + 2s};
    }
    const auto json = input_body(sequence, command.mask, command.yaw, command.jump, command.brake, command.action);
    if (json.empty()) throw Failure{"No se pudo preparar la entrada del jugador."};
    auto reply = receive(http, "input", route_body(json, session.world_epoch(), session.lease),
                         max_snapshot_bytes, stop, command.presence);
    auto snapshot = read_snapshot(reply.body);
    if (!snapshot || snapshot->ack != sequence ||
        std::none_of(snapshot->players.begin(), snapshot->players.end(),
                     [&](const Pose& pose){ return pose.id == session.admission->id; }))
        throw Failure{"El estado de jugadores recibido es incompatible."};
    const EntityId car_root = snapshot->car ? snapshot->car->root : root_id;
    if (session.scene_car && car_root != *session.scene_car)
        throw Failure{"El vehículo de la sala cambió durante la sesión."};
    if (!session.scene_car) {
        if (!session.world || (car_root && !session.world->get(car_root))) {
            if (session.sector) {
                session.scene_car = car_root;
                session.last_ack = sequence;
                session.pending.reset();
                throw IncompleteSector{};
            }
            throw Failure{"El vehículo recibido no pertenece al mundo de la sala."};
        }
        session.terrain.emplace(*session.world, car_root);
        session.scene_car = car_root;
    }
    if (!follows_course(session.last_course,snapshot->course))
        throw Failure{"El marcador no corresponde a la vuelta o a las puertas de esta revisión."};
    if (snapshot->course && !bind_course(*snapshot->course,session.gates)) {
        if (!session.sector) throw Failure{"El marcador no corresponde a las puertas de esta revisión."};
        session.last_ack = sequence;
        session.pending.reset();
        throw IncompleteSector{};
    }
    session.last_course=snapshot->course;
    session.last_ack = sequence;
    session.pending.reset();
    return std::move(*snapshot);
}

std::pair<double,double> focus_cell(const Snapshot& snapshot, unsigned seat) {
    const auto* car = snapshot.car ? &*snapshot.car : nullptr;
    if (car && (car->driver == static_cast<int>(seat) || car->passenger == static_cast<int>(seat)))
        return {std::floor(car->x / 64.0 + .5), std::floor(car->z / 64.0 + .5)};
    const auto pose = std::find_if(snapshot.players.begin(), snapshot.players.end(), [seat](const Pose& p){ return p.id == seat; });
    return {std::floor(pose->feet.x / 64.0 + .5), std::floor(pose->feet.z / 64.0 + .5)};
}

bool covers(const SectorCursor& window, std::pair<double,double> cell) {
    return std::abs(cell.first - window.x) <= window.radius && std::abs(cell.second - window.z) <= window.radius;
}

// Validate the complete, authoritative archive before asking the host to remove its
// spatial movement guard. A transient response retains the verified scene for retry.
void prepare_full_replacement(Http& http, Connection& session, CancelToken stop) {
    const auto& revision = session.admission->revision;
    const auto* route = session.route ? &*session.route : nullptr;
    session.ahead.discard();
    session.sector_job.reset();
    session.offered_region.reset();
    session.await_window = false;
    session.sector.reset();
    session.next_region.reset();
    session.next_usage.reset();
    const auto root = session.scene_car.value_or(root_id);
    std::optional<PreparedScene> project;
    std::optional<World> world;
    std::optional<CharacterTerrain> terrain;
    std::optional<CourseIndex> gates;
    if (route) {
        project = prepare_scene(http, session, *route, stop, true);
        if (project) {
            world = std::move(project->world);
            terrain = std::move(project->terrain);
            gates = std::move(project->gates);
            session.cache->finish(*route);
        }
    } else {
        auto file = download_world(http, session.download, session.entry, revision, nullptr, stop, session.report);
        if (file) world = decode(*file);
        file.reset();
        if (world) {
            if (root && !world->get(root)) throw Failure{"El turismo no pertenece al archivo completo de la sala."};
            terrain.emplace(*world, root);
            gates = index_course(*world);
        }
    }
    if (stop.stop_requested()) return;
    if (!world || !terrain || !gates) throw Failure{"El mundo completo no coincide con el destino de la sala."};
    session.same_world_swap = session.same_world_swap || session.world_delivered;
    session.world_delivered = false;
    session.world = std::move(world);
    session.terrain = std::move(terrain);
    session.gates = std::move(*gates);
    session.cells.reset();
    session.initial_support = false;
    session.need_admission = true;
    session.force_full = false;
}

// Advance speculation only from an authenticated driving snapshot. A foreground
// fetch takes at most an already-complete hint and never waits for this task.
AheadTransfer update_ahead(Connection& session, const Request& request,
        const Snapshot& snapshot, std::pair<double,double> cell, bool demand, bool dispatch) try {
    auto& ahead = session.ahead;
    ahead.collect();
    const auto& base = *session.sector;
    const auto* car = snapshot.car ? &*snapshot.car : nullptr;
    const auto seat = static_cast<int>(session.admission->id);
    if (ahead.unsupported || !car || (car->driver != seat && car->passenger != seat) ||
        !session.world_delivered || session.force_full || (session.await_window && !ahead.frozen) || !base.cache || !session.ahead_allowed()) {
        ahead.discard();
        return {};
    }
    if (!std::isfinite(car->speed) || std::abs(car->speed) < 2 || !std::isfinite(car->yaw)) {
        ahead.discard(UsageReason::changed);
        return {};
    }
    // A significant turn can invalidate a forecast even before the predicted
    // neighbour changes. The timing/diagonal calculation remains the host's.
    constexpr double cos_thirty_degrees = .8660254037844386;
    if (ahead.target) {
        if (ahead.base_token != base.token || ahead.target->car != car->root ||
            ahead.target->driving != (car->driver == seat))
            ahead.discard(UsageReason::changed);
        else if (ahead.target->reverse != (car->speed < 0) ||
                 std::cos(car->yaw - ahead.heading) < cos_thirty_degrees)
            ahead.discard(UsageReason::turned);
    }

    if (demand) {
        if (!ahead.target || !std::isfinite(cell.first) || !std::isfinite(cell.second) ||
            cell.first < std::numeric_limits<std::int32_t>::min() ||
            cell.first > std::numeric_limits<std::int32_t>::max() || cell.second < std::numeric_limits<std::int32_t>::min() ||
            cell.second > std::numeric_limits<std::int32_t>::max()) { ahead.discard(); return {}; }
        const auto stage = ahead_stage(ahead.from_x,ahead.from_z,ahead.target->x,ahead.target->z,
                                      static_cast<std::int32_t>(cell.first),static_cast<std::int32_t>(cell.second));
        if (stage == AheadStage::outside || (stage != AheadStage::target &&
            ahead.via != AheadStage::outside && ahead.via != stage)) {
            ahead.discard(UsageReason::changed);
            return {};
        }
        // Freeze once at the first real crossing. The ordinary MSP1 fetch never waits
        // for missing speculative pages. Both renewals share the same immutable allocation.
        ahead.freeze();
        if (stage != AheadStage::target) ahead.via = stage;
        if (!dispatch || (!ahead.cache && !ahead.receipt)) return {};
        auto receipt = ahead.receipt;
        if (receipt && ahead.cache && !receipt->matches(ahead.cache->token())) receipt.reset();
        return {ahead.cache,std::move(receipt),ahead.generation,ahead.from_x,ahead.from_z,
                ahead.target->x,ahead.target->z,ahead.via};
    }

    auto target = approaching_cell(*car, base, car->driver == seat);
    if (ahead.target && target && !ahead.middle_confirmed && ahead.via == AheadStage::outside) {
        const auto first_leg = ahead_stage(ahead.from_x,ahead.from_z,ahead.target->x,ahead.target->z,target->x,target->z);
        if (first_leg == AheadStage::via_x || first_leg == AheadStage::via_z) {
            // A diagonal forecast can narrow to one edge just before the crossover.
            // Keep only the bytes already verified; the authoritative first axis is still unknown.
            ahead.freeze();
            return {};
        }
    }
    if (ahead.frozen) {
        if ((!ahead.middle_confirmed && ahead.via != AheadStage::outside) ||
            !target || !ahead.target || *target != *ahead.target)
            ahead.discard(UsageReason::changed);
        return {};
    }
    if (!target || (ahead.target && *target != *ahead.target)) ahead.discard(UsageReason::changed);
    if (!target || ahead.job || ahead.cache || Clock::now() < ahead.next) return {};
    auto stop = session.ahead_cancel();
    if (stop.stop_requested()) return {};
    ++ahead.generation;
    ahead.from_x = base.x;
    ahead.from_z = base.z;
    ahead.target = target;
    ahead.base_token = base.token;
    ahead.heading = car->yaw;
    ahead.next = Clock::now() + 750ms;
    auto& job = ahead.job.emplace();
    job.stop = stop;
    if (session.usage_seat && (!session.usage_seat->unsupported || !session.usage_seat->stages_unsupported)) {
        try {
            const auto* route = session.route ? &*session.route : nullptr;
            ahead.receipt = std::make_shared<UsageReceipt>(session.usage_reports,session.usage_seat,
                sector_request(session.admission->revision,route));
        } catch (const std::bad_alloc&) { /* Accounting has its own allocation failure path. */ }
    }
    job.mailbox = std::make_shared<AheadMailbox>(ahead.receipt);
    job.result = std::async(std::launch::async,
        [invite=request.invite, proof=request.proof, revision=session.admission->revision, route=session.route,
         x=base.x, z=base.z, full_bytes=base.full_bytes, target=*target, stop, mailbox=job.mailbox]() mutable {
            try {
                Http side(invite, std::move(proof));
                return fetch_ahead(side, revision, route ? &*route : nullptr, x, z, full_bytes, target, stop, *mailbox);
            } catch (...) {
                return AheadReply{}; // Optional work cannot change room admission or movement.
            }
        });
    return {};
} catch (const std::exception&) {
    auto& ahead = session.ahead;
    if (ahead.job && !ahead.job->result.valid()) ahead.job.reset();
    ahead.discard();
    ahead.next = Clock::now() + 3500ms;
    return {};
}

void start_sector_job(Connection& session, const Request& request, AheadTransfer ahead) {
    session.full_confirmation.reset();
    auto stop = session.sector_cancel();
    if (stop.stop_requested()) return;
    try {
        auto& job = session.sector_job.emplace();
        job.stop = stop;
        auto cache = session.sector->cache;
        job.result = std::async(std::launch::async,
            [invite=request.invite, proof=request.proof, revision=session.admission->revision, route=session.route,
             car=session.scene_car.value_or(root_id), cache=std::move(cache), ahead=std::move(ahead), stop]() mutable {
                try {
                    Http side(invite, std::move(proof));
                    return fetch_sector(side, revision, route ? &*route : nullptr, car, std::move(cache), stop, ahead);
                } catch (const std::exception&) {
                    return SectorReply{}; // e.g. allocation for the optional transfer failed
                }
            });
    } catch (const std::exception&) {
        session.sector_job.reset();
        session.force_full = true;
    }
}

// Run after exchange() has authenticated the snapshot, seat, vehicle and course.
bool update_sectors(Http& http, Connection& session, const Request& request, const Snapshot& snapshot) {
    const auto seat = session.admission->id;
    const auto cell = focus_cell(snapshot, seat);
    const auto* route = session.route ? &*session.route : nullptr;
    const auto& revision = session.admission->revision;
    if (session.initial_support) {
        if (!session.world || !session.terrain || !session.sector || !covers(*session.sector, cell) ||
            !sector_supports(*session.world, *session.terrain, snapshot, seat)) {
            session.force_full = true;
            return false;
        }
    }
    if (session.need_admission) {
        if (!acknowledge_sector(http, session, revision, route, session.sector ? &*session.sector : nullptr, request.stop)) {
            session.force_full = true;
            return false;
        }
        session.need_admission = false;
    }
    session.initial_support = false;
    if (!session.sector) return true;
    if (session.next_region && (!covers(*session.sector, cell) ||
        !sector_supports(session.next_region->world, session.next_region->terrain, snapshot, seat))) {
        session.force_full = true;
        return false;
    }

    if (session.sector_job && session.sector_job->result.wait_for(0ms) == std::future_status::ready) {
        auto job = std::move(session.sector_job->result);
        const bool cancelled = session.sector_job->stop.stop_requested();
        session.sector_job.reset();
        auto reply = job.get(); // Always propagate explicit seat or route revocation.
        if (!cancelled) {
            if (reply.scene) session.offered_region = std::move(reply.scene);
            else if ((reply.status == 409 || reply.status == 429) && session.sector_conflicts++ < 2)
                session.next_sector = Clock::now() + 250ms;
            else {
                session.force_full = true;
                return false;
            }
        }
    }
    if (session.offered_region) {
        // If a response to ready was lost, retry this exact token and prepared
        // candidate. Do not substitute the previous plan or discard the new bytes.
        auto& incoming = *session.offered_region;
        if (covers(incoming.cursor, cell) && sector_supports(incoming.region.world, incoming.region.terrain, snapshot, seat) &&
            acknowledge_sector(http, session, revision, route, &incoming.cursor, request.stop)) {
            auto& forecast = session.ahead;
            if (incoming.hint_generation && forecast.target && incoming.hint_generation == forecast.generation) {
                if (incoming.hint_stage == AheadStage::target) {
                    if (incoming.usage) {
                        // The UI now owns the terminal receipt (or its release on replacement).
                        incoming.usage->release_on_drop = true;
                        forecast.receipt.reset();
                    }
                    forecast.discard();
                } else {
                    forecast.middle_confirmed = true;
                    forecast.base_token = incoming.cursor.token;
                }
            } else {
                // This mandatory job already consumed the matching files. The UI
                // may still install them even if no future prediction can use them.
                if (incoming.usage && incoming.hint_stage == AheadStage::target)
                    incoming.usage->release_on_drop = true;
                if (forecast.frozen) forecast.discard(UsageReason::changed);
            }
            session.sector = std::move(incoming.cursor);
            session.next_region = std::move(incoming.region);
            session.next_usage = std::move(incoming.usage);
            session.gates = std::move(incoming.gates);
            session.sector_conflicts = 0;
            session.await_window = false;
            session.next_sector = Clock::now() + 200ms;
        } else if (session.sector_conflicts++ < 2) {
            session.await_window = true;
            session.next_sector = Clock::now() + 250ms;
        } else {
            session.force_full = true;
        }
        session.offered_region.reset();
    }
    const bool centered = cell.first == session.sector->x && cell.second == session.sector->z;
    const bool demand = !centered || session.await_window || !session.sector->cache;
    const bool dispatch = !session.force_full && demand && !session.sector_job && Clock::now() >= session.next_sector;
    auto ahead = update_ahead(session, request, snapshot, cell, demand || session.sector_job.has_value(), dispatch);
    if (dispatch) start_sector_job(session, request, std::move(ahead));
    return !session.force_full && !session.await_window && covers(*session.sector, cell);
}

}

void Update::confirm_install() noexcept {
    if (auto receipt = std::move(usage)) receipt->installed();
}

struct Client::Impl {
    std::mutex mutex;
    std::condition_variable changed;
    std::optional<Request> queued;
    CancelToken cancel;
    std::wstring active_origin;
    std::string active_invite;
    Update display;
    Clock::time_point last_snapshot{};
    Command input;
    bool closing{}, foreground{true}, meeting_waiting{};
    std::string displayed_lease;
    std::weak_ptr<ProjectWorldCache> active_cache;
    CancelToken active_sector, active_ahead;
    bool renderer_constrained{};
    std::uint64_t ahead_pressure_epoch{};
    BasisPtr entry_basis;
    std::uint64_t ticket_counter{};
    std::uint64_t suspension_epoch{}, action_epoch{};
    std::uint64_t memory_epoch{};
    std::thread worker;
    std::shared_ptr<UsageReports> usage_reports;

    // Called under the UI mutex. Cache operations never take the UI mutex.
    void trim_world_cache_locked() {
        active_ahead.request_stop();
        active_sector.request_stop();
        entry_basis.reset();
        if (auto cache = active_cache.lock()) cache->trim();
    }

    ~Impl() {
        {
            std::lock_guard lock(mutex);
            closing = true;
            queued.reset();
            cancel.request_stop();
            trim_world_cache_locked();
        }
        changed.notify_one();
        if (worker.joinable()) worker.join();
    }

    void clear_entry() {
        entry_basis.reset();
        display.entry.reset();
        display.entry_visible = false;
    }

    void set_phase(CancelToken stop, Phase phase, const char* message, bool keep_entry = false) {
        std::lock_guard lock(mutex);
        if (stop.stop_requested()) return;
        if (!keep_entry) clear_entry();
        if (display.phase == Phase::playing && phase != Phase::playing) ++action_epoch;
        display.phase = phase;
        display.snapshot.reset();
        display.meeting_available = false;
        if (input.meeting) {
            meeting_waiting = false;
            display.meeting_notice = "Se interrumpió la solicitud antes de enviarla.";
            input.meeting = false;
        }
        input.presence = ScenePresence::loading;
        display.message = message;
        input.mask = 0;
        input.jump = false;
        input.brake = true;
        input.action = CarAction::none;
        input.sampled = {};
        if (phase == Phase::ended) {
            active_origin.clear();
            active_invite.clear();
            if (meeting_waiting) display.message += " No se pudo confirmar tu posición final.";
            display.meeting_notice.clear();
            display.meeting_returned = false;
            display.meeting_ticket = 0;
            display.world.reset();
            display.terrain.reset();
            display.cells.reset();
            display.region.reset();
            display.usage.reset();
            display.snapshot.reset();
        }
    }

    void hold_scene(CancelToken stop, bool keep_entry = false) {
        set_phase(stop, Phase::reconnecting, "Preparando el destino con el anfitrión…", keep_entry);
        std::lock_guard lock(mutex);
        if (stop.stop_requested()) return;
        displayed_lease.clear();
        display.meeting_ticket = 0;
        display.meeting_notice.clear();
        display.meeting_returned = false;
        meeting_waiting = false;
        ++action_epoch;
    }

    // Called under mutex by both the UI and the networking worker.
    void expire_snapshot() {
        if (display.phase != Phase::playing || Clock::now() - last_snapshot < 2s) return;
        display.phase = Phase::reconnecting;
        display.message = "Esperando una actualización de la sala…";
        display.meeting_available = false;
        display.snapshot.reset();
        if (input.meeting) meeting_waiting = false;
        input = {};
        input.brake = true;
        input.presence = ScenePresence::loading;
        ++action_epoch;
    }

    Command take_input() {
        std::lock_guard lock(mutex);
        expire_snapshot();
        Command latest = input;
        latest.action_epoch = action_epoch;
        input.meeting = false;
        input.jump = false;
        input.action = CarAction::none;
        const auto now = Clock::now();
        // Networking may continue while a window is minimized or its render loop stalls.
        if (latest.presence == ScenePresence::ready && now - latest.sampled > 2s)
            latest.presence = ScenePresence::idle;
        if (now - latest.action_sampled > 250ms) latest.action = CarAction::none;
        if (now - latest.sampled > 250ms) {
            latest.mask = 0;
            latest.jump = false;
            latest.brake = true;
        }
        return latest;
    }

    void publish(Connection& session, Snapshot snapshot, CancelToken stop, std::uint64_t epoch) {
        std::lock_guard lock(mutex);
        if (stop.stop_requested() || !foreground || suspension_epoch != epoch) return;
        clear_entry();
        display.seat = session.admission->id;
        display.title = session.admission->name;
        last_snapshot = Clock::now();
        display.phase = Phase::playing;
        display.message.clear();
        if (!session.world_delivered) {
            display.usage.reset();
            if (session.same_world_swap && !display.world && session.world && session.terrain) {
                display.region = RegionUpdate{std::move(*session.world), std::move(*session.terrain)};
                session.world.reset();
                session.terrain.reset();
            } else {
                display.region.reset();
                display.world = std::exchange(session.world, std::nullopt);
                display.terrain = std::exchange(session.terrain, std::nullopt);
            }
            display.cells = std::exchange(session.cells, std::nullopt);
            session.world_delivered = true;
            session.same_world_swap = false;
        }
        if (session.next_region) {
            if (display.world) {
                // A paused render loop may not have consumed its initial scene yet.
                display.world = std::move(session.next_region->world);
                display.terrain = std::move(session.next_region->terrain);
                display.cells.reset();
            } else {
                display.region = std::move(session.next_region);
            }
            display.usage = std::move(session.next_usage);
            session.next_region.reset();
        }
        if (session.meeting.enabled && displayed_lease != session.meeting.lease) {
            displayed_lease = session.meeting.lease;
            display.meeting_ticket = ++ticket_counter;
        }
        const auto seat = static_cast<int>(display.seat);
        const bool on_foot = !snapshot.car ||
            (snapshot.car->driver != seat && snapshot.car->passenger != seat);
        if (!session.meeting.notice.empty()) {
            display.meeting_notice = std::exchange(session.meeting.notice, {});
            display.meeting_returned |= std::exchange(session.meeting.returned, false);
            meeting_waiting = false;
        }
        display.meeting_available = session.meeting.enabled && on_foot && !meeting_waiting;
        display.snapshot = std::move(snapshot);
    }

    bool wait_until(CancelToken stop, Clock::time_point when, std::uint64_t epoch) {
        std::unique_lock lock(mutex);
        changed.wait_until(lock, when, [&]{ return stop.stop_requested() || suspension_epoch != epoch; });
        return stop.stop_requested();
    }

    void play(Http& http, const Request& request, const std::shared_ptr<UsageSeat>& usage_seat) {
        const auto stop = request.stop;
        std::optional<Clock::time_point> first_failure;
        auto backoff = 250ms;
        Connection session;
        session.usage_reports = usage_reports;
        session.usage_seat = usage_seat;
        {
            std::lock_guard lock(mutex);
            if (stop.stop_requested()) return;
            active_cache = session.cache;
            session.cache->directory_foreground(foreground);
        }
        std::uint64_t observed_ahead_pressure{};
        session.ahead_allowed = [&] {
            std::lock_guard lock(mutex);
            return !renderer_constrained && ahead_pressure_epoch == observed_ahead_pressure;
        };
        session.ahead_cancel = [&] {
            std::lock_guard lock(mutex);
            active_ahead.request_stop();
            active_ahead = CancelToken::tracked();
            if (!foreground || renderer_constrained || ahead_pressure_epoch != observed_ahead_pressure ||
                stop.stop_requested()) active_ahead.request_stop();
            return active_ahead;
        };
        session.sector_cancel = [&] {
            std::lock_guard lock(mutex);
            active_sector.request_stop();
            active_sector = CancelToken::tracked();
            if (!foreground || stop.stop_requested()) active_sector.request_stop();
            return active_sector;
        };
        session.report = [this, stop, &first_failure, &backoff](std::size_t received, std::size_t total) {
            // Called only by the network worker after a complete new part has been accepted.
            first_failure.reset();
            backoff = 250ms;
            std::lock_guard lock(mutex);
            if (stop.stop_requested() || !foreground ||
                (display.phase != Phase::joining && display.phase != Phase::reconnecting)) return;
            display.message = "Descargando el mundo · " + std::to_string(100ULL * received / total) + " %";
        };
        bool needs_join = true;
        std::uint64_t epoch{};
        std::uint64_t entry_memory_epoch{};
        const auto accepts_entry = [&] {
            return !stop.stop_requested() && foreground && suspension_epoch == epoch && memory_epoch == entry_memory_epoch &&
                   (display.phase == Phase::joining || display.phase == Phase::reconnecting);
        };
        session.entry.visible = [&] {
            std::lock_guard lock(mutex);
            return accepts_entry();
        };
        session.entry.basis = [&]() -> BasisPtr {
            std::lock_guard lock(mutex);
            return accepts_entry() ? entry_basis : nullptr;
        };
        session.entry.release_basis = [&] {
            std::lock_guard lock(mutex);
            if (!stop.stop_requested()) entry_basis.reset();
        };
        session.entry.show = [&](std::optional<EntryPreview> preview, BasisPtr source) {
            std::lock_guard lock(mutex);
            if (!accepts_entry()) return;
            entry_basis = std::move(source);
            display.entry_visible = preview.has_value();
            display.entry = std::move(preview);
        };
        bool paused_last_iteration = false;
        while (!stop.stop_requested()) {
            // Released/cancelled speculative futures drain off the input thread.
            // Poll even after a portal, a complete-world fallback or leaving the car.
            if (!session.sector || !session.ahead.target) session.ahead.collect();
            bool resumed, trimmed, paused, drop_ahead;
            {
                std::unique_lock lock(mutex);
                changed.wait(lock, [&]{ return foreground || stop.stop_requested() || epoch != suspension_epoch ||
                    entry_memory_epoch != memory_epoch || observed_ahead_pressure != ahead_pressure_epoch; });
                if (stop.stop_requested()) return;
                paused = !foreground;
                resumed = paused_last_iteration || epoch != suspension_epoch;
                paused_last_iteration = paused;
                epoch = suspension_epoch;
                trimmed = entry_memory_epoch != memory_epoch;
                entry_memory_epoch = memory_epoch;
                drop_ahead = observed_ahead_pressure != ahead_pressure_epoch;
                observed_ahead_pressure = ahead_pressure_epoch;
            }
            if (resumed || trimmed || drop_ahead) session.ahead.discard();
            if (resumed || trimmed) {
                session.full_confirmation.reset();
                session.sector_job.reset();
                session.offered_region.reset();
                if (session.sector) {
                    session.sector->cache.reset();
                    session.await_window = true;
                    // Force a fresh authenticated window on the next snapshot.
                    session.next_sector = {};
                    session.sector_conflicts = 0;
                }
                if (session.staged && session.staged->sector) session.staged->sector->cache.reset();
            }
            if (paused) continue;
            if (resumed) {
                // A suspended process can miss the entire lease. Probe a previously acquired
                // room with neutral input: an expired seat returns 410, even if still empty.
                if (session.world_delivered || session.world) needs_join = false;
                if (session.route) session.route_dirty = true;
                first_failure.reset();
                backoff = 250ms;
            }
            try {
                if (needs_join) {
                    join_room(http, session, stop);
                    if (stop.stop_requested()) return;
                    needs_join = false;
                    session.meeting.probe_at = {};
                }
                if (session.route_dirty) {
                    session.ahead.discard();
                    // While waiting for another player to vote, keep the same preview.
                    // A new authenticated descriptor clears it in EntryTransfer::select.
                    hold_scene(stop, true);
                    if (!sync_route(http, session, stop)) {
                        if (wait_until(stop, Clock::now() + 160ms, epoch)) return;
                        continue;
                    }
                    if (stop.stop_requested()) return;
                }
                if (session.force_full) {
                    set_phase(stop, Phase::reconnecting, "Preparando el mundo completo con el anfitrión…");
                    prepare_full_replacement(http, session, stop);
                    if (stop.stop_requested()) return;
                }
                if (session.world_delivered && Clock::now() >= session.meeting.probe_at) {
                    probe_meeting(http, session.meeting, stop, session.world_epoch());
                    if (stop.stop_requested()) return;
                }
                const auto next_tick = Clock::now() + 50ms;
                auto command = take_input();
                if (command.meeting) {
                    request_return(http, session.meeting, stop, session.world_epoch());
                    if (stop.stop_requested()) return;
                }
                if (resumed || session.need_admission || session.initial_support || !session.meeting.notice.empty()) {
                    command.mask = 0;
                    command.jump = false;
                    command.action = CarAction::none;
                    command.brake = true;
                    session.pending.reset();
                }
                const auto sent = Clock::now();
                auto snapshot = exchange(http, session, command, stop);
                if (Clock::now() - sent >= 2s)
                    throw Failure{"Esperando una actualización de la sala…",true};
                const bool present = update_sectors(http, session, request, snapshot);
                if (Clock::now() - sent >= 2s) {
                    // An idempotent ready/full acknowledgement can outlive its pose.
                    // Obtain a fresh neutral snapshot before displaying pending geometry.
                    session.initial_support = session.sector && session.world && !session.world_delivered;
                    session.ahead.discard();
                    set_phase(stop, Phase::reconnecting, "Actualizando tu posición con el anfitrión…");
                } else if (present) {
                    publish(session, std::move(snapshot), stop, epoch);
                } else {
                    set_phase(stop, Phase::reconnecting, "Preparando el terreno alrededor de tu posición…");
                }
                first_failure.reset();
                backoff = 250ms;
                if (wait_until(stop, next_tick, epoch)) return;
            } catch (const IncompleteSector&) {
                session.ahead.discard();
                session.force_full = true;
                set_phase(stop, Phase::reconnecting, "Recuperando el terreno completo de esta sala…");
                continue;
            } catch (const SectorInterrupted&) {
                session.ahead.discard();
                if (stop.stop_requested()) return;
                continue;
            } catch (const RouteChanged&) {
                session.ahead.discard();
                session.full_confirmation.reset();
                session.sector_job.reset();
                session.offered_region.reset();
                if (!session.admission || !session.admission->project)
                    throw Failure{"La sala devolvió un cambio de mundo inesperado."};
                const auto now = Clock::now();
                if (!first_failure) first_failure = now;
                if (now - *first_failure >= 45s)
                    throw Failure{"La sala no ha confirmado un destino estable. Abre la invitación de nuevo."};
                session.download = {};
                session.route_dirty = true;
                session.pending.reset();
                session.meeting.returned = false;
                session.meeting.notice.clear();
                hold_scene(stop);
                if (wait_until(stop, Clock::now() + 80ms, epoch)) return;
            } catch (const Failure& error) {
                session.ahead.discard();
                if (stop.stop_requested()) return;
                if (!error.retry) throw;
                const auto now = Clock::now();
                if (!first_failure) first_failure = now;
                if (now - *first_failure >= 45s)
                    throw Failure{"La sala sigue sin responder. Comprueba la conexión y abre la invitación de nuevo."};
                // A reconnection takes a fresh snapshot before accepting new controls.
                set_phase(stop, Phase::reconnecting, error.message);
                if (wait_until(stop, now + backoff, epoch)) return;
                backoff = std::min(backoff * 2, 4000ms);
                needs_join = true;
            }
        }
    }

    void service(Request request) {
        Http http(request.invite, request.proof);
        std::shared_ptr<UsageSeat> usage_seat;
        try {
            if (!usage_reports) usage_reports = std::make_shared<UsageReports>();
            usage_seat = std::make_shared<UsageSeat>(request.invite,request.proof);
        } catch (const std::bad_alloc&) { /* No reporting resources are required to play. */ }
        try {
            play(http, request, usage_seat);
        } catch (const Failure& error) {
            set_phase(request.stop, Phase::ended, error.message);
        } catch (const std::exception&) {
            set_phase(request.stop, Phase::ended, "No se pudo preparar la partida en red.");
        }
        // A join may have reached the server even when we missed its response.
        // Keep cleanup on the worker and use the credentials of that request alone.
        if (usage_reports && usage_seat && (!usage_seat->unsupported || !usage_seat->stages_unsupported)) {
            usage_reports->finish_seat(usage_seat,[this]{
                std::lock_guard lock(mutex);
                return closing || queued.has_value();
            });
        }
        http.post("leave", "{}", 32);
    }

    void work() {
        for (;;) {
            std::unique_lock lock(mutex);
            changed.wait(lock, [&]{ return closing || queued.has_value(); });
            if (closing) return;
            auto request = std::move(*queued);
            queued.reset();
            auto stop = request.stop;
            lock.unlock();
            try {
                service(std::move(request));
            } catch (const std::exception&) {
                set_phase(stop, Phase::ended, "No se pudo abrir la conexión de la sala.");
            }
        }
    }
};

Client::Client() : impl_(std::make_unique<Impl>()) {}
Client::~Client() = default;

bool Client::start(std::wstring_view link) {
    auto invite = parse_invitation(link);
    if (!invite) return false;
    std::lock_guard lock(impl_->mutex);
    if (invite->origin == impl_->active_origin && invite->token == impl_->active_invite)
        return true;
    auto proof = new_proof();
    if (!proof) return false;
    if (!impl_->worker.joinable()) {
        try {
            impl_->worker = std::thread(&Impl::work, impl_.get());
        } catch (const std::system_error&) {
            return false;
        }
    }
    impl_->cancel.request_stop();
    impl_->trim_world_cache_locked();
    impl_->cancel = CancelToken::tracked();
    impl_->active_origin = invite->origin;
    impl_->active_invite = invite->token;
    impl_->queued.emplace(Request{std::move(*invite), std::move(*proof), impl_->cancel});
    impl_->input = {};
    impl_->display = {};
    impl_->meeting_waiting = false;
    impl_->displayed_lease.clear();
    impl_->display.phase = Phase::joining;
    impl_->display.message = "Entrando a la sala privada…";
    impl_->changed.notify_one();
    return true;
}

void Client::leave() {
    std::lock_guard lock(impl_->mutex);
    impl_->cancel.request_stop();
    impl_->trim_world_cache_locked();
    impl_->queued.reset();
    impl_->active_origin.clear();
    impl_->active_invite.clear();
    impl_->input = {};
    impl_->display = {};
    impl_->meeting_waiting = false;
    impl_->displayed_lease.clear();
    impl_->changed.notify_one();
}

void Client::input(unsigned mask, double yaw, bool jump, bool brake) {
    std::lock_guard lock(impl_->mutex);
    impl_->expire_snapshot();
    if (impl_->display.phase != Phase::playing || !impl_->foreground) return;
    // Only called by the UI after installing the scene, terrain and first snapshot.
    impl_->input.presence = ScenePresence::ready;
    impl_->input.mask = mask & 31u;
    if (std::isfinite(yaw)) impl_->input.yaw = std::atan2(std::sin(yaw), std::cos(yaw));
    impl_->input.jump |= jump;
    impl_->input.brake = brake;
    impl_->input.sampled = Clock::now();
}

void Client::vehicle_action(CarAction action) {
    std::lock_guard lock(impl_->mutex);
    impl_->expire_snapshot();
    if (impl_->display.phase != Phase::playing || !impl_->foreground || impl_->meeting_waiting || action == CarAction::none) return;
    impl_->input.action = action;
    impl_->input.action_sampled = Clock::now();
}

bool Client::return_to_meeting(std::uint64_t expected_ticket) {
    std::lock_guard lock(impl_->mutex);
    impl_->expire_snapshot();
    auto& display = impl_->display;
    if (!impl_->foreground || display.phase != Phase::playing || !display.meeting_available ||
        (expected_ticket && expected_ticket != display.meeting_ticket) || !display.meeting_notice.empty())
        return false;
    impl_->input.meeting = true;
    impl_->input.action = CarAction::none;
    impl_->input.jump = false;
    impl_->input.brake = true;
    impl_->input.mask = 0;
    ++impl_->action_epoch;
    impl_->meeting_waiting = true;
    display.meeting_available = false;
    return true;
}

void Client::neutral() {
    std::lock_guard lock(impl_->mutex);
    impl_->input.mask = 0;
    impl_->input.jump = false;
    impl_->input.brake = true;
    impl_->input.action = CarAction::none;
    ++impl_->action_epoch;
}

void Client::trim_world_cache() {
    std::lock_guard lock(impl_->mutex);
    impl_->trim_world_cache_locked();
    ++impl_->memory_epoch;
    impl_->clear_entry();
    impl_->changed.notify_one();
}

void Client::set_active(bool foreground) {
    {
        std::lock_guard lock(impl_->mutex);
        if (impl_->foreground == foreground) return;
        impl_->foreground = foreground;
        if (auto cache = impl_->active_cache.lock()) cache->directory_foreground(foreground);
        if (!foreground) {
            impl_->active_ahead.request_stop();
            impl_->active_sector.request_stop();
            ++impl_->suspension_epoch;
            impl_->clear_entry();
            if (impl_->input.meeting) {
                impl_->meeting_waiting = false;
                impl_->display.meeting_notice = "Se canceló la solicitud al pausar la partida.";
                impl_->input.meeting = false;
            }
            impl_->display.meeting_available = false;
            impl_->input.presence = ScenePresence::idle;
            impl_->input.mask = 0;
            impl_->input.jump = false;
            impl_->input.brake = true;
            impl_->input.action = CarAction::none;
            ++impl_->action_epoch;
            impl_->input.sampled = {};
            if (impl_->display.phase == Phase::playing) {
                impl_->display.phase = Phase::reconnecting;
                impl_->display.message = "Reanudando la sala privada…";
            }
        }
    }
    impl_->changed.notify_one();
}

Update Client::poll(bool constrained) {
    std::lock_guard lock(impl_->mutex);
    if (impl_->renderer_constrained != constrained) {
        impl_->renderer_constrained = constrained;
        if (constrained) {
            ++impl_->ahead_pressure_epoch;
            impl_->active_ahead.request_stop();
        }
        impl_->changed.notify_one();
    }
    impl_->expire_snapshot();
    auto& current = impl_->display;
    if(current.phase!=Phase::playing) {
        Update waiting;
        waiting.phase=current.phase; waiting.message=current.message;
        waiting.entry_visible = current.entry_visible;
        waiting.entry = std::exchange(current.entry, std::nullopt);
        return waiting;
    }
    Update update{current.phase, current.seat, current.title, current.message,
            std::exchange(current.world, std::nullopt), std::exchange(current.terrain, std::nullopt),
            std::exchange(current.cells, std::nullopt),
            std::exchange(current.snapshot, std::nullopt), current.meeting_available, current.meeting_ticket,
            std::exchange(current.meeting_notice, {}), std::exchange(current.meeting_returned, false)};
    update.region = std::exchange(current.region, std::nullopt);
    update.usage = std::move(current.usage);
    return update;
}

}
