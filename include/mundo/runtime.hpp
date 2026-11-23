#pragma once

#include "mundo/world.hpp"
#include <chrono>
#include <optional>

namespace mundo {

enum class Detail { economy, balanced, ultra, automatic };
enum class Resolution { automatic, hd720, full_hd, qhd, uhd4k, uhd8k, native };
enum class AdaptivePriority { balanced, sustained, high_refresh };
enum class ThermalPressure { unknown, nominal, warm, serious, critical };
struct DevicePressure { ThermalPressure thermal{ThermalPressure::unknown}; bool low_power{},memory_pressure{}; };
DevicePressure platform_pressure();
struct DisplayCaps {
    std::uint32_t width{}, height{}; // Physical swapchain pixels, after rotation.
    std::uint32_t max_target_width{}, max_target_height{};
    std::uint64_t frame_target_budget{}; // Host allowance for live GPU render targets, in bytes.
    double refresh_hz{}; // Zero when the host cannot obtain the active refresh rate.
    DevicePressure pressure{};
    bool memory_pressure{};
};
struct VideoSettings {
    Detail detail{Detail::automatic};
    Resolution resolution{Resolution::automatic};
    std::uint32_t fps_cap{}; // Zero means the engine adds no frame-rate limit.
    AdaptivePriority priority{AdaptivePriority::balanced};
};
struct VideoPlan {
    std::uint32_t surface_width{}, surface_height{}, render_width{}, render_height{};
    bool shadows{};
};
struct FrameCost { double gpu_ms{}, cpu_ms{}, present_interval_ms{}; };
struct FrameQuality { VideoPlan video; Detail detail; };
class AdaptiveQuality {
public:
    using Clock=std::chrono::steady_clock;
    std::optional<FrameQuality> choose(const DisplayCaps&,const VideoSettings&,FrameCost,Clock::time_point now);
private:
    std::optional<Clock::time_point> last_;
    int rank_{3};
    Detail cpu_detail_limit_{Detail::ultra};
    double fast_{},slow_{},cpu_slow_{};
    std::array<double,12> display_intervals_{};
    unsigned observations_{};
    double inferred_hz_{60};
    AdaptivePriority priority_{AdaptivePriority::balanced};
};
[[nodiscard]] std::optional<VideoPlan> plan_video(const DisplayCaps&, const VideoSettings&);
[[nodiscard]] unsigned first_texture_mip(unsigned width,unsigned height,unsigned available_levels,
                                          unsigned max_dimension,std::uint64_t byte_budget,unsigned bytes_per_texel);
struct TickBatch { unsigned count{}; double interpolation{}; };
class FrameClock {
public:
    using Clock=std::chrono::steady_clock;
    static constexpr double step=1.0/60.0;
    TickBatch advance(double seconds);
    bool allow_present(Clock::time_point now,std::uint32_t cap);
    void reset() noexcept;
private:
    double accumulator_{};
    std::optional<Clock::time_point> deadline_;
    std::uint32_t last_cap_{};
};

struct Vertex { std::array<float,3> position; std::array<float,3> normal; };
struct Mesh { std::vector<Vertex> vertices; std::vector<std::uint32_t> indices; };
[[nodiscard]] Mesh primitive(Shape shape,unsigned segments=32);
[[nodiscard]] bool valid_mesh(const Mesh& mesh);
} // namespace mundo
