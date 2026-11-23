#include "mundo/audio.hpp"
#include "valid_name.hpp"
#include "mundo/document_digest.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <numbers>
#include <stdexcept>
#include <limits>
#include <string_view>

namespace mundo::audio {
namespace {
constexpr std::string_view prefix = "MUNDO/Audio/v1/";
constexpr std::string_view extended_prefix = "MUNDO/Audio/v2/";

std::optional<std::uint64_t> clip_key(std::string_view text) {
    if (text.size() != 17 || text.front() != 's') return {};
    text.remove_prefix(1);
    std::uint64_t key{};
    for (char c : text) {
        if (c >= '0' && c <= '9') key = (key << 4) | (c - '0');
        else if (c >= 'a' && c <= 'f') key = (key << 4) | (c - 'a' + 10);
        else return {};
    }
    return key;
}

std::string_view field(std::string_view& name) {
    const auto end = name.find('/');
    if (end == std::string_view::npos) return {};
    const auto value = name.substr(0, end);
    name.remove_prefix(end + 1);
    return value;
}

std::optional<unsigned> decimal(std::string_view text, unsigned low, unsigned high) {
    if (text.empty() || (text.size() > 1 && text.front() == '0')) return {};
    unsigned value{};
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || value < low || value > high) return {};
    return value;
}

std::optional<Preset> preset_named(std::string_view name) {
    if (name == "brisa") return Preset::brisa;
    if (name == "agua") return Preset::agua;
    if (name == "maquina") return Preset::maquina;
    return {};
}

bool valid_label(std::string_view name) {
    if (!valid_name(name, 32)) return false;
    // Match the editor's String.trim(). Control characters are already excluded by valid_name().
    constexpr std::string_view spaces[] = {
        " ", "\u00a0", "\u1680", "\u2000", "\u2001", "\u2002", "\u2003", "\u2004",
        "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a", "\u2028",
        "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"
    };
    return std::none_of(std::begin(spaces), std::end(spaces), [=](auto s){ return name.starts_with(s) || name.ends_with(s); });
}

bool inside(Vec3 p, double limit) {
    return std::abs(p.x) <= limit && std::abs(p.y) <= limit && std::abs(p.z) <= limit;
}

bool valid(const Source& s) {
    return s.id != root_id && s.preset <= Preset::clip && s.group <= Group::voces &&
           s.playback_rate >= .25 && s.playback_rate <= 4 && inside(s.position, 1e6) &&
           s.radius >= .5 && s.radius <= 256 && s.volume >= 0 && s.volume <= 1;
}

std::optional<Source> parse(const Node& node, std::string_view name, bool extended) {
    const auto& t = node.local;
    if (node.parent != root_id || node.shape != Shape::empty || node.visual != 0 ||
        t.rotation.x != 0 || t.rotation.y != 0 || t.rotation.z != 0 || std::abs(t.rotation.w) != 1 ||
        t.scale.x != 1 || t.scale.y != 1 || t.scale.z != 1) return {};
    auto type = field(name);
    const auto key = extended ? clip_key(type) : std::nullopt;
    const auto preset = key ? Preset::clip : preset_named(type);
    const auto radius = decimal(field(name), 50, 25600);
    const auto volume = decimal(field(name), 0, 1000);
    if (!preset || !radius || !volume) return {};
    Source s{node.id, *preset, t.position, *radius / 100., *volume / 1000.};
    if (extended) {
        const auto spatial = field(name);
        const auto rate = decimal(field(name), 25, 400);
        const auto mode = field(name), group = field(name);
        if ((spatial != "2d" && spatial != "3d") || !rate || (mode != "loop" && mode != "once")) return {};
        s.spatial = spatial == "3d"; s.playback_rate = *rate / 100.; s.loop = mode == "loop";
        if (group == "efectos") s.group = Group::efectos;
        else if (group == "musica") s.group = Group::musica;
        else if (group == "voces") s.group = Group::voces;
        else if (group != "ambiente") return {};
        s.clip_key = key.value_or(0);
    }
    return valid_label(name) && valid(s) ? std::optional{s} : std::nullopt;
}
} // namespace

std::optional<Scene> read_scene(const World& world) {
    Scene scene;
    for (const auto& [id, node] : world.nodes()) {
        const std::string_view name = node.name;
        const bool extended = name.starts_with(extended_prefix);
        if (!extended && !name.starts_with(prefix)) continue;
        if (scene.count == max_sources) return {};
        const auto s = parse(node, name.substr(extended ? extended_prefix.size() : prefix.size()), extended);
        if (!s) return {};
        scene.sources[scene.count++] = *s;
    }
    if (!scene.count) return scene;
    for (const auto& [id, node] : world.nodes()) {
        if (!node.parent) continue;
        const auto end = scene.sources.begin() + scene.count;
        if (std::any_of(scene.sources.begin(), end, [&](const auto& s){ return s.id == node.parent; })) return {};
    }
    return scene;
}

bool Mixer::set_world(const World& world) {
    const auto scene = read_scene(world);
    if (!scene) {
        reset();
        return false;
    }
    return set_scene(*scene);
}

namespace {
constexpr std::size_t table_size = 2048;
const auto& sine_table() {
    static const auto values = [] {
        std::array<double, table_size + 1> table{};
        for (std::size_t i = 0; i < table.size(); ++i)
            table[i] = std::sin(2 * std::numbers::pi * i / table_size);
        return table;
    }();
    return values;
}

double sine(double phase) noexcept {
    const auto scaled = phase * table_size;
    const auto whole = static_cast<std::size_t>(scaled);
    const auto index = whole & (table_size - 1);
    const auto& table = sine_table();
    return table[index] + (table[index + 1] - table[index]) * (scaled - whole);
}

std::uint32_t seed(EntityId id) noexcept {
    char digits[24];
    const auto [end, error] = std::to_chars(digits, digits + sizeof(digits), id);
    if (error != std::errc{}) return 1;
    std::uint32_t h = 2166136261u;
    for (const char* p = digits; p != end; ++p) h = (h ^ static_cast<unsigned>(*p)) * 16777619u;
    return h == 0 ? 1u : h;
}
} // namespace

DecodedClip::DecodedClip(std::uint64_t key, std::vector<float> samples)
    : key_(key), samples_(std::move(samples)) {}

Clip decode_clip(std::string_view key, std::span<const std::uint8_t> wav) {
    const auto identity = clip_key(key);
    if (!identity || wav.size() < 46 || wav.size() > 44 + max_clip_frames * 2 || wav.size() % 2 != 0) return {};
    const auto text = std::string_view(reinterpret_cast<const char*>(wav.data()), wav.size());
    const auto word = [&](unsigned i) -> unsigned { return unsigned(wav[i]) | (unsigned(wav[i+1]) << 8); };
    const auto dword = [&](unsigned i) -> std::uint32_t { return word(i) | (std::uint32_t(word(i+2)) << 16); };
    if (text.substr(0,4) != "RIFF" || text.substr(8,8) != "WAVEfmt " || text.substr(36,4) != "data" ||
        dword(4) != wav.size()-8 || dword(16) != 16 || word(20) != 1 || word(22) != 1 ||
        dword(24) != 24000 || dword(28) != 48000 || word(32) != 2 || word(34) != 16 ||
        dword(40) != wav.size()-44 || !document_digest(std::as_bytes(wav)).starts_with(key.substr(1))) return {};
    std::vector<float> data((wav.size() - 44)/2);
    for (unsigned i = 0; i < data.size(); ++i) {
        int value = static_cast<int>(word(44+2*i));
        if (value >= 32768) value -= 65536;
        data[i] = static_cast<float>(value) / 32768.f;
    }
    return Clip(new DecodedClip(*identity, std::move(data)));
}

Mixer::Mixer(unsigned sample_rate) : rate_(sample_rate), ramp_samples_((sample_rate + 50) / 100) {
    if (rate_ < 8000 || rate_ > 192000) throw std::invalid_argument("audio sample rate");
    (void)sine_table();  // Prepare outside the real-time callback.
}

double Mixer::Voice::random() noexcept {
    auto x = rng;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    rng = x;
    return x / 4294967296.;
}

void Mixer::Voice::tick(double step) noexcept {
    phase += step;
    if (phase >= 1) phase -= 1;
}

const std::vector<float>* Mixer::find_clip(std::uint64_t key) const noexcept {
    for (const auto& entry : clips_) if (entry.data && entry.key == key) return &entry.data->samples_;
    return nullptr;
}

void Mixer::configure(Voice& v) const noexcept {
    const auto pitch = v.source.playback_rate;
    v.slow_coefficient = 1 - std::exp(-2 * std::numbers::pi * 80 * pitch / rate_);
    v.fast_coefficient = 1 - std::exp(-2 * std::numbers::pi * 1400 * pitch / rate_);
    v.decay = std::exp(-pitch / (.052 * rate_));
    v.attack = static_cast<unsigned>(std::round(.003 * rate_ / pitch));
    v.data = v.source.preset == Preset::clip ? find_clip(v.source.clip_key) : nullptr;
}

void Mixer::targets(Voice& v) const noexcept {
    const auto& s = v.source;
    const auto dx = s.position.x - listener_.x, dy = s.position.y - listener_.y, dz = s.position.z - listener_.z;
    const auto distance = std::hypot(dx, dy, dz);
    double gain = s.volume, pan = 0;
    if (s.spatial) {
        gain = 0;
        if (distance < s.radius) {
            const auto attenuation = 1 - distance / s.radius;
            gain = s.volume * (attenuation * attenuation);
            if (distance > 0)
                pan = std::clamp((dx * std::cos(yaw_) + dz * std::sin(yaw_)) / distance, -1., 1.);
        }
    }
    const auto left = gain * std::sqrt((1-pan)/2), right = gain * std::sqrt((1+pan)/2);
    if (left == v.aim_l && right == v.aim_r) return;
    v.aim_l = left; v.aim_r = right;
    v.step_l = (left - v.left)/ramp_samples_; v.step_r = (right - v.right)/ramp_samples_;
    v.ramp = ramp_samples_;
}

Mixer::Voice Mixer::new_voice(const Source& s) const noexcept {
    Voice v;
    v.source = s;
    v.rng = seed(s.id);
    v.phase = v.rng / 4294967296.;
    v.swell_step = (.14 + (v.rng % 11) * .005) / rate_;
    v.motor_step = (56. + v.rng % 12) / rate_;
    configure(v); targets(v);
    return v;
}

bool Mixer::set_scene(const Scene& scene) noexcept {
    if (scene.count > max_sources) { reset(); return false; }
    std::array<Voice, max_sources> next{};
    for (std::size_t i = 0; i < scene.count; ++i) {
        const auto& s = scene.sources[i];
        if (!valid(s) || std::any_of(next.begin(), next.begin()+i, [&](const auto& v){ return v.source.id == s.id; })) {
            reset(); return false;
        }
        const auto end = voices_.begin()+count_;
        auto old = std::find_if(voices_.begin(), end, [&](const auto& v){
            return v.source.id == s.id && v.source.preset == s.preset && v.source.clip_key == s.clip_key && v.source.loop == s.loop;
        });
        if (old == end) next[i] = new_voice(s);
        else {
            next[i] = *old;
            next[i].source = s;
            configure(next[i]); targets(next[i]);
        }
    }
    std::sort(next.begin(), next.begin()+scene.count, [](const auto& a, const auto& b){ return a.source.id < b.source.id; });
    voices_ = next; count_ = scene.count;
    return true;
}

void Mixer::set_listener(Vec3 position, double yaw) noexcept {
    if (!std::isfinite(position.x) || !std::isfinite(position.y) || !std::isfinite(position.z) || !std::isfinite(yaw)) return;
    if (listener_.x == position.x && listener_.y == position.y && listener_.z == position.z && yaw_ == yaw) return;
    listener_ = position; yaw_ = yaw;
    for (std::size_t i=0; i<count_; ++i) targets(voices_[i]);
}

void Mixer::set_volume(double volume) noexcept {
    if (volume >= 0 && volume <= 1) volume_ = volume;
}

void Mixer::set_group_volume(Group group, double volume) noexcept {
    if (group <= Group::voces && volume >= 0 && volume <= 1) groups_[static_cast<unsigned>(group)] = volume;
}

bool Mixer::set_clip(std::string_view name, Clip clip) noexcept {
    const auto key = clip_key(name);
    if (!key || !clip || clip->key_ != *key) return false;
    auto pos = std::find_if(clips_.begin(), clips_.end(), [&](const auto& e){ return e.data && e.key == *key; });
    if (pos == clips_.end()) pos = std::find_if(clips_.begin(), clips_.end(), [](const auto& e){ return !e.data; });
    if (pos == clips_.end()) return false;
    *pos = {*key, std::move(clip)};
    for (std::size_t i = 0; i < count_; ++i) {
        auto& v = voices_[i];
        if (v.source.preset != Preset::clip || v.source.clip_key != *key) continue;
        v.data = &pos->data->samples_;
        if (!v.finished && v.cursor >= v.data->size()) v.cursor = std::fmod(v.cursor, v.data->size());
    }
    return true;
}

void Mixer::clear_clips() noexcept {
    for (std::size_t i = 0; i < count_; ++i) voices_[i].data = nullptr;
    clips_ = {};
}

bool Mixer::trigger(EntityId id) noexcept {
    for (std::size_t i = 0; i < count_; ++i) {
        auto& v = voices_[i];
        if (v.source.id == id && !v.source.loop) {
            const bool was_paused = v.paused;
            v = new_voice(v.source);
            v.paused = was_paused;
            return true;
        }
    }
    return false;
}

void Mixer::set_paused(bool paused) noexcept { paused_ = paused; }

bool Mixer::set_source_paused(EntityId id, bool paused) noexcept {
    for (std::size_t i = 0; i < count_; ++i) {
        if (voices_[i].source.id == id) { voices_[i].paused = paused; return true; }
    }
    return false;
}

void Mixer::reset() noexcept {
    voices_ = {}; count_ = 0;
    clear_clips();
    listener_ = {}; yaw_ = 0;
}

double Mixer::sample(Voice& v) const noexcept {
    const double pitch = v.source.playback_rate;
    switch (v.source.preset) {
    case Preset::brisa: {
        const auto white = v.random()*2 - 1;
        v.slow += v.slow_coefficient * (white - v.slow);
        v.fast += v.fast_coefficient * (white - v.fast);
        v.tick(v.swell_step * pitch);
        return (v.fast - v.slow) * (.82 + .25 * sine(v.phase));
    }
    case Preset::agua: {
        if (v.next_drop == 0) {
            v.next_drop = static_cast<unsigned>(std::round(rate_ / pitch * (.09 + .24 * v.random())));
            v.drop_step = (620 + 650 * v.random()) / rate_;
            v.drop_level = .21 + .16 * v.random();
            v.phase = 0; v.drop_age = 0;
        }
        const auto result = v.drop_level * std::min(1., double(v.drop_age)/v.attack) * (sine(v.phase) + .16 * sine(2*v.phase));
        v.tick(v.drop_step * pitch);
        v.drop_level *= v.decay; --v.next_drop; ++v.drop_age;
        return result;
    }
    case Preset::maquina: {
        const auto result = .23*sine(v.phase)+.09*sine(2*v.phase)+.045*sine(5*v.phase);
        v.tick(v.motor_step * pitch);
        return result;
    }
    case Preset::clip: {
        const auto& data = *v.data;
        const auto i = static_cast<std::size_t>(v.cursor);
        const double first = data[i], next = i+1 < data.size() ? data[i+1] : (v.source.loop ? data[0] : first);
        const auto result = first + (next-first)*(v.cursor-i);
        v.cursor += (24000. / rate_) * pitch;
        if (v.cursor >= data.size()) {
            if (v.source.loop) v.cursor = std::fmod(v.cursor, data.size());
            else v.finished = true;
        }
        return result;
    }
    }
    return 0;
}

void Mixer::render(std::span<float> output) noexcept {
    std::fill(output.begin(), output.end(), 0.f);
    if (paused_ || !count_) return;
    const std::size_t samples = output.size() & ~std::size_t{1};
    constexpr double seconds[]{2, 1, 1.5, 0};
    for (std::size_t i = 0; i < count_; ++i) {
        auto& v = voices_[i];
        if (v.paused || (v.source.preset == Preset::clip && !v.data)) continue;
        const auto duration = seconds[static_cast<unsigned>(v.source.preset)] * rate_;
        const auto gain = groups_[static_cast<unsigned>(v.source.group)];
        for (std::size_t j = 0; j < samples && !v.finished; j += 2) {
            if (v.ramp) {
                if (--v.ramp == 0) { v.left = v.aim_l; v.right = v.aim_r; }
                else { v.left += v.step_l; v.right += v.step_r; }
            }
            if (v.left == 0 && v.right == 0 && !v.ramp && (v.source.loop || !v.started)) break;
            v.started = true;
            auto value = sample(v) * gain;
            if (!v.source.loop && duration > 0) {
                value *= std::min(1., (duration-v.age)/(.01*rate_));
                v.age += v.source.playback_rate;
                v.finished = v.age >= duration;
            }
            output[j] += value * v.left;
            output[j+1] += value * v.right;
        }
    }
    for (std::size_t i = 0; i < samples; ++i) {
        const double sample = output[i];
        output[i] = static_cast<float>(volume_ * sample / (1 + std::abs(sample)));
    }
}
} // namespace mundo::audio
