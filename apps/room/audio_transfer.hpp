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

struct ClipBatch {
    std::vector<RoomAudioClip> clips;
    std::vector<std::string> retry;
};

inline bool transient_audio_status(unsigned status) {
    return status == 0 || status == 408 || status == 429 || status == 500 ||
           status == 502 || status == 503 || status == 504;
}

inline ClipBatch download_clips(Http& http, const std::string& revision,
        const std::vector<std::string>& keys, std::size_t remaining_bytes, CancelToken stop) {
    ClipBatch batch;
    if (stop.stop_requested() || keys.empty()) return batch;
    const std::string fields = "{\"revision\":\"" + revision + "\"";
    const auto info = http.post("audio-info", fields + "}", audio_info_reply_limit, stop);
    if (transient_audio_status(info.status)) return {{}, keys};
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
    bool defer_remaining = false;
    for (const auto& [key, digest] : entries) {
        if (stop.stop_requested()) return {};
        if (std::find(keys.begin(), keys.end(), key) == keys.end()) continue;
        if (remaining_bytes < 46) break; // minimum canonical WAV is 44 bytes plus one PCM frame
        if (defer_remaining) { batch.retry.push_back(key); continue; }
        const auto body = fields + ",\"lease\":\"" + lease + "\",\"key\":\"" + key + "\"}";
        auto reply = http.post("audio", body, std::min(audio_clip_reply_limit, remaining_bytes), stop);
        if (stop.stop_requested() || reply.status == 401 || reply.status == 403 || reply.status == 409) return {};
        if (transient_audio_status(reply.status)) {
            defer_remaining = true;
            batch.retry.push_back(key);
            continue;
        }
        if (reply.status != 200 || reply.body.size() > audio_clip_reply_limit || reply.body.size() > remaining_bytes ||
                !matches_digest(reply.body, digest)) continue;
        remaining_bytes -= reply.body.size();
        batch.clips.push_back({key, std::move(reply.body)});
    }
    return batch;
}

// Owned by the room's network worker. A single optional fetch can run alongside
// heartbeats; replacing a world cancels its work before admitting a new result.
class AudioTransfer {
public:
    ~AudioTransfer() { cancel_.request_stop(); }

    void select(const Invitation& invite, const std::string& proof, const std::string& revision,
                std::vector<std::string> keys) {
        cancel_.request_stop();
        job_.reset();
        attempts_ = 0;
        remaining_bytes_ = 8 * 1024 * 1024;
        retry_at_ = {};
        if (!keys.empty()) job_.emplace(Job{invite, proof, revision, std::move(keys)});
    }

    [[nodiscard]] bool pending() const noexcept { return job_.has_value() || current_.valid(); }
    using Clock = std::chrono::steady_clock;
    std::vector<RoomAudioClip> poll(Clock::time_point now = Clock::now()) {
        if (current_.valid()) {
            if (current_.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return {};
            auto batch = current_.get();
            if (!cancel_.stop_requested() && job_) {
                for (const auto& clip : batch.clips) remaining_bytes_ -= clip.bytes.size();
                job_->keys = std::move(batch.retry);
                schedule_retry(now);
                return std::move(batch.clips);
            }
        }
        if (!job_ || now < retry_at_) return {};
        cancel_ = CancelToken::tracked();
        ++attempts_;
        try {
            current_ = std::async(std::launch::async, [job = *job_, limit = remaining_bytes_, stop = cancel_]() {
                try {
                    Http http(job.invite, job.proof);
                    return download_clips(http, job.revision, job.keys, limit, stop);
                } catch (const std::system_error&) {
                    return ClipBatch{{}, job.keys};
                } catch (const std::exception&) {
                    return ClipBatch{};
                }
            });
        } catch (const std::system_error&) {
            schedule_retry(now);
        }
        return {};
    }

private:
    struct Job { Invitation invite; std::string proof, revision; std::vector<std::string> keys; };
    std::optional<Job> job_;
    unsigned attempts_{};
    std::size_t remaining_bytes_{};
    Clock::time_point retry_at_{};
    CancelToken cancel_;
    std::future<ClipBatch> current_;

    void schedule_retry(Clock::time_point now) {
        // Only retry unresolved transient failures. Four attempts span at least
        // seven seconds of real time; snapshots and input never wait for the delay.
        if (job_->keys.empty() || attempts_ >= 4) job_.reset();
        else retry_at_ = now + std::chrono::seconds(1u << (attempts_ - 1));
    }
};
} // namespace mundo::room
