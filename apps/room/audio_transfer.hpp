#pragma once
#include "room_client.hpp"
#include "room_http.hpp"
#include "mundo/audio.hpp"
#include <algorithm>
#include <chrono>
#include <future>
#include <system_error>

namespace mundo::room {
inline std::vector<std::string> required_clips(const World& world) {
    std::vector<std::string> keys;
    const auto scene = audio::read_scene(world);
    if (!scene) return keys;
    for (std::size_t n = 0; n < scene->count; ++n) {
        const auto& source = scene->sources[n];
        if (source.preset != audio::Preset::clip) continue;
        static constexpr char hex[] = "0123456789abcdef";
        std::string key(17, 's');
        auto bits = source.clip_key;
        for (unsigned i = 16; i > 0; --i) { key[i] = hex[bits & 15]; bits >>= 4; }
        if (std::find(keys.begin(), keys.end(), key) == keys.end()) keys.push_back(std::move(key));
    }
    return keys;
}

inline std::vector<RoomAudioClip> download_clips(Http& http, const std::string& revision,
        const std::vector<std::string>& keys, CancelToken stop) {
    std::vector<RoomAudioClip> clips;
    if (stop.stop_requested() || keys.empty()) return clips;
    const std::string fields = "{\"revision\":\"" + revision + "\"";
    const auto info = http.post("audio-info", fields + "}", audio_info_reply_limit, stop);
    if (info.status != 200 || info.body.size() < 98 || info.body.size() > audio_info_reply_limit) return {};
    const std::string_view text(reinterpret_cast<const char*>(info.body.data()), info.body.size());
    constexpr auto hex = "0123456789abcdef";
    if (text[32] != '\n' || (text.size() - 33) % 65 || text.substr(0,32).find_first_not_of(hex) != text.npos) return {};
    const std::string lease(text.substr(0,32));
    std::vector<std::pair<std::string,std::string_view>> entries;
    for (std::size_t off = 33; off < text.size(); off += 65) {
        const auto digest = text.substr(off,64);
        if (text[off+64] != '\n' || digest.find_first_not_of(hex) != text.npos) return {};
        auto key = "s" + std::string(digest.substr(0,16));
        if (std::any_of(entries.begin(), entries.end(), [&](const auto& seen) {return seen.first == key;})) return {};
        entries.emplace_back(std::move(key),digest);
    }
    // The complete manifest must parse before a second request can spend any bandwidth.
    constexpr std::size_t bank_limit = 8 * 1024 * 1024;
    std::size_t total = 0;
    for (const auto& [key, digest] : entries) {
        if (stop.stop_requested()) return {};
        if (std::find(keys.begin(), keys.end(), key) == keys.end()) continue;
        const auto body = fields + ",\"lease\":\"" + lease + "\",\"key\":\"" + key + "\"}";
        auto reply = http.post("audio", body, std::min(audio_clip_reply_limit, bank_limit-total), stop);
        if (reply.status != 200 || stop.stop_requested()) break;
        if (reply.body.size() > audio_clip_reply_limit || reply.body.size() > bank_limit-total ||
                !matches_digest(reply.body, digest)) continue;
        total += reply.body.size();
        clips.push_back({key, std::move(reply.body)});
    }
    return clips;
}

// Owned by the room's network worker. A single optional fetch can run alongside
// heartbeats; replacing a world cancels its work before admitting a new result.
class AudioTransfer {
public:
    ~AudioTransfer() { cancel_.request_stop(); }

    void select(const Invitation& invite, const std::string& proof, const std::string& revision,
                std::vector<std::string> keys) {
        cancel_.request_stop();
        pending_.reset();
        if (!keys.empty()) pending_.emplace(Job{invite, proof, revision, std::move(keys)});
    }

    std::vector<RoomAudioClip> poll() {
        if (current_.valid()) {
            if (current_.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return {};
            auto done = current_.get();
            if (!cancel_.stop_requested()) return done;
        }
        if (!pending_) return {};
        auto job = std::move(*pending_);
        pending_.reset();
        cancel_ = CancelToken::tracked();
        try {
            current_ = std::async(std::launch::async, [job = std::move(job), stop = cancel_]() {
                try {
                    Http http(job.invite, job.proof);
                    return download_clips(http, job.revision, job.keys, stop);
                } catch (const std::exception&) {
                    return std::vector<RoomAudioClip>{};
                }
            });
        } catch(const std::system_error&) {
            // Room input stays responsive if a device cannot create an optional worker.
        }
        return {};
    }

private:
    struct Job { Invitation invite; std::string proof, revision; std::vector<std::string> keys; };
    std::optional<Job> pending_;
    CancelToken cancel_;
    std::future<std::vector<RoomAudioClip>> current_;
};
} // namespace mundo::room
