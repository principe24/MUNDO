#pragma once

#include "mundo/audio.hpp"
#include <algorithm>
#include <chrono>
#include <memory>
#include <mutex>

namespace mundo::room {
inline constexpr unsigned audio_sample_rate = 48000;
using RenderAudio = void (*)(void*, std::span<float>) noexcept;

// Destroying the device flushes queued output and joins any active callbacks.
class AudioDevice {
public:
    virtual ~AudioDevice() = default;
    virtual bool healthy() const noexcept = 0;
};

std::unique_ptr<AudioDevice> open_audio_device(void* owner, RenderAudio render);

class PlaybackAudio {
public:
    ~PlaybackAudio() { suspend(); }
    bool has_sources() const noexcept { return enabled_; }

    void install(const World& world, bool new_session) {
        const auto scene = audio::read_scene(world);
        if (new_session || !scene || scene->count == 0) suspend();
        std::lock_guard guard(mutex_);
        if (new_session || !scene) {
            mixer_.reset();
        }
        enabled_ = scene && mixer_.set_scene(*scene) && mixer_.has_sources();
    }

    // Validate and decode outside the mixer's short control-thread critical section.
    bool install_clip(std::string_view key, std::span<const std::byte> data) {
        if (!enabled_) return false;
        const auto* bytes = reinterpret_cast<const std::uint8_t*>(data.data());
        auto clip = audio::decode_clip(key, {bytes, data.size()});
        if (!clip) return false;
        std::lock_guard guard(mutex_);
        return mixer_.set_clip(key, std::move(clip));
    }

    // Called on the owning game thread, only after an admitted local player has a pose.
    void frame(Vec3 feet, double yaw) {
        if (!enabled_) return;
        {
            std::lock_guard guard(mutex_);
            mixer_.set_listener(feet, yaw);
        }
        if (device_ && device_->healthy()) return;
        device_.reset();
        const auto now = Clock::now();
        if (now < retry_at_) return;
        retry_at_ = now + std::chrono::seconds(3);
        device_ = open_audio_device(this, render);
    }

    void suspend() {
        device_.reset();
        retry_at_ = {};
    }

private:
    using Clock = std::chrono::steady_clock;
    audio::Mixer mixer_{audio_sample_rate};
    std::mutex mutex_;
    std::unique_ptr<AudioDevice> device_;
    Clock::time_point retry_at_{};
    bool enabled_{};

    static void render(void* owner, std::span<float> output) noexcept {
        auto& self = *static_cast<PlaybackAudio*>(owner);
        std::unique_lock guard(self.mutex_, std::try_to_lock);
        if (guard.owns_lock()) self.mixer_.render(output);
        else std::fill(output.begin(), output.end(), 0.f);
    }
};
} // namespace mundo::room
