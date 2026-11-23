#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace mundo::room {

struct Invitation {
    std::wstring origin;
    std::wstring host;
    unsigned short port{};
    bool tls{};
    std::string token;
};

std::optional<Invitation> parse_invitation(std::wstring_view link);
bool valid_credentials(const Invitation&, std::string_view proof);
std::string hex_text(std::span<const unsigned char> bytes);
std::optional<std::string> new_proof();
bool matches_digest(std::span<const std::byte> bytes, std::string_view hex);
inline bool matches_revision(std::span<const std::byte> document, std::string_view hex) {
    return document.size()<=24u*1024u*1024u && matches_digest(document,hex);
}

// A decision on the UI thread cancels just the worker associated with that invitation.
// A default token is untracked, for the final bounded leave request.
class CancelToken {
public:
    CancelToken() = default;
    static CancelToken tracked() { return CancelToken(std::make_shared<std::atomic_bool>(false)); }
    bool stop_requested() const noexcept {
        return flag_ && flag_->load(std::memory_order_relaxed);
    }
    void request_stop() const noexcept {
        if (flag_) flag_->store(true, std::memory_order_relaxed);
    }
private:
    explicit CancelToken(std::shared_ptr<std::atomic_bool> flag) : flag_(std::move(flag)) {}
    std::shared_ptr<std::atomic_bool> flag_;
};

struct Response {
    unsigned status{};
    std::vector<std::byte> body;
};

// Fragment routes carry up to one MiB and the MWC1 frame header.
inline constexpr std::size_t world_part_reply_limit = 1024u * 1024u + 16u;
inline constexpr std::size_t entry_info_reply_size = 112;
inline constexpr std::size_t cell_index_reply_limit = 48u + 65536u * 16u;
inline constexpr std::size_t sector_plan_reply_limit = 80u + 26u * 48u;
inline constexpr std::size_t sector_ahead_reply_limit = 80u + 9u * 48u;
inline constexpr std::size_t sector_ack_reply_limit = 0;
inline constexpr std::size_t sector_full_reply_limit = 16;

inline constexpr std::size_t audio_info_reply_limit = 33 + 16 * 65;
inline constexpr std::size_t audio_clip_reply_limit = 44 + 2 * 24000 * 16;

constexpr bool is_usage_report(std::string_view action) {
    return action == "sector-usage" || action == "sector-usage-stages";
}

// sector-full issues a binary challenge on 200 and acknowledges its return with 204.
constexpr std::optional<std::size_t> room_fragment_limit(std::string_view action) {
    if (action == "audio-info") return audio_info_reply_limit;
    if (action == "audio") return audio_clip_reply_limit;
    if (action == "entry-info") return entry_info_reply_size;
    if (action == "cell-index") return cell_index_reply_limit;
    if (action == "sector-plan") return sector_plan_reply_limit;
    if (action == "sector-ahead") return sector_ahead_reply_limit;
    if (action == "sector-ready" || is_usage_report(action)) return sector_ack_reply_limit;
    if (action == "sector-full") return sector_full_reply_limit;
    if (action == "entry-part" || action == "world-part" || action == "world-rest" ||
        action == "sector-part" || action == "sector-ahead-part")
        return world_part_reply_limit;
    return std::nullopt;
}

constexpr bool valid_room_reply_size(std::string_view action, unsigned status, std::size_t bytes) {
    return action != "sector-full" || status != 200 || bytes == sector_full_reply_limit;
}

// Optional input metadata. Older hosts ignore this header and keep the same wire format.
enum class ScenePresence { unreported, loading, ready, idle };
constexpr const char* scene_header(ScenePresence value) {
    switch (value) {
    case ScenePresence::loading: return "loading";
    case ScenePresence::ready: return "ready";
    case ScenePresence::idle: return "idle";
    default: return nullptr;
    }
}

// Own and use one instance per networking worker. A zero status means the
// endpoint or reply could not be used. HTTP rejections preserve their status.
class Http {
public:
    Http(const Invitation&, std::string proof);
    ~Http();
    Http(const Http&) = delete;
    Http& operator=(const Http&) = delete;

    Response post(std::string_view action, std::string_view json, std::size_t max_bytes,
                  CancelToken stop = {}, ScenePresence presence = ScenePresence::unreported);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace mundo::room
