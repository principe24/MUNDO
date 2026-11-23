#pragma once

#include "mundo/world.hpp"
#include <array>
#include <cstdint>
#include <optional>
#include <memory>
#include <span>

namespace mundo::audio {

enum class Preset : std::uint8_t { brisa, agua, maquina, clip };
enum class Group : std::uint8_t { ambiente, efectos, musica, voces };
constexpr std::size_t max_sources = 16;
constexpr std::size_t max_clip_frames = 384000;
class DecodedClip;
using Clip = std::shared_ptr<const DecodedClip>;

// Decoding is the only way to construct clip data. Its identifier and samples
// stay bound together, so installation never rehashes a recording under a sink lock.
class DecodedClip {
public:
    [[nodiscard]] std::span<const float> samples() const noexcept { return samples_; }

private:
    friend class Mixer;
    friend Clip decode_clip(std::string_view, std::span<const std::uint8_t>);
    DecodedClip(std::uint64_t key, std::vector<float> samples);
    std::uint64_t key_;
    std::vector<float> samples_;
};
[[nodiscard]] Clip decode_clip(std::string_view key, std::span<const std::uint8_t> wav);

struct Source {
    EntityId id{};
    Preset preset{};
    Vec3 position{};
    double radius{}, volume{};
    bool spatial{true};
    double playback_rate{1};
    bool loop{true};
    Group group{Group::ambiente};
    std::uint64_t clip_key{};
};

// Fixed-size scenes can be prepared on the control thread and handed to the sink
// without keeping any references to the document or to user-provided labels.
struct Scene {
    std::array<Source, max_sources> sources{};
    std::size_t count{};
};

[[nodiscard]] std::optional<Scene> read_scene(const World&);

class Mixer {
public:
    explicit Mixer(unsigned sample_rate = 48000);
    Mixer(const Mixer&) = delete;
    Mixer& operator=(const Mixer&) = delete;

    // All calls on a single mixer must be serialized by the owner. An invalid
    // document drops the previous voices so they cannot leak into a new room.
    bool set_world(const World&);
    bool set_scene(const Scene&) noexcept;
    void set_listener(Vec3 position, double yaw) noexcept;
    void set_volume(double volume) noexcept;
    void set_group_volume(Group group, double volume) noexcept;
    bool set_clip(std::string_view key, Clip clip) noexcept;
    void clear_clips() noexcept;
    bool trigger(EntityId id) noexcept;
    void set_paused(bool paused) noexcept;
    void reset() noexcept;
    [[nodiscard]] bool has_sources() const noexcept { return count_ != 0; }

    // Interleaved floating-point stereo at the construction rate. Fills the
    // whole output, including a silent trailing value for an odd-length span.
    void render(std::span<float> interleaved) noexcept;

private:
    struct Voice {
        Source source{};
        std::uint32_t rng{};
        double phase{}, slow{}, fast{}, swell_step{}, motor_step{};
        unsigned drop_age{}, next_drop{}, attack{};
        double drop_level{}, drop_step{}, slow_coefficient{}, fast_coefficient{}, decay{};
        double left{}, right{}, aim_l{}, aim_r{}, step_l{}, step_r{};
        unsigned ramp{};
        double cursor{}, age{};
        bool started{}, finished{};
        const std::vector<float>* data{};
        double random() noexcept;
        void tick(double step) noexcept;
    };

    struct ClipEntry { std::uint64_t key{}; Clip data; };
    std::array<ClipEntry, max_sources> clips_{};
    std::array<double, 4> groups_{1, 1, 1, 1};
    unsigned rate_, ramp_samples_;
    std::array<Voice, max_sources> voices_{};
    std::size_t count_{};
    Vec3 listener_{};
    double yaw_{}, volume_{1.0};
    bool paused_{};

    void configure(Voice&) const noexcept;
    void targets(Voice&) const noexcept;
    Voice new_voice(const Source&) const noexcept;
    const std::vector<float>* find_clip(std::uint64_t) const noexcept;
    double sample(Voice&) const noexcept;
};

} // namespace mundo::audio
