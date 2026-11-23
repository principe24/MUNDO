#pragma once

#include "mundo/runtime.hpp"
#include <filesystem>

namespace mundo {

enum class DeviceFamily { mobile, desktop };
enum class SettingsResult { saved, session_only, invalid, write_failed };

[[nodiscard]] DeviceFamily native_device_family() noexcept;
[[nodiscard]] VideoSettings default_video_settings(DeviceFamily family) noexcept;
// On Android the activity supplies its private files directory when opening the profile.
[[nodiscard]] std::filesystem::path default_settings_directory();

// One instance serves the in-game menu and the renderer on their owning thread.
class DeviceVideoProfile {
public:
    explicit DeviceVideoProfile(std::filesystem::path directory = default_settings_directory(),
                                DeviceFamily family = native_device_family());
    [[nodiscard]] DeviceFamily family() const noexcept { return family_; }
    [[nodiscard]] const VideoSettings& settings() const noexcept { return settings_; }
    [[nodiscard]] SettingsResult apply(const VideoSettings& settings);
    [[nodiscard]] SettingsResult restore_defaults();

private:
    DeviceFamily family_;
    VideoSettings settings_;
    std::filesystem::path file_;
};

} // namespace mundo
