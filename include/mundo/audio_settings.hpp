#pragma once

#include "mundo/device_settings.hpp"
#include <array>

namespace mundo {
struct AudioLevels {
    bool muted{};
    unsigned volume{80};
    // In the order of audio::Group: ambiente, efectos, musica, voces.
    std::array<unsigned,4> groups{100,100,100,100};
    bool operator==(const AudioLevels&) const = default;
};

class DeviceAudioProfile {
public:
    explicit DeviceAudioProfile(std::filesystem::path directory=default_settings_directory(),
                                DeviceFamily family=native_device_family());
    [[nodiscard]] const AudioLevels& settings() const noexcept {return levels_;}
    [[nodiscard]] SettingsResult apply(const AudioLevels& levels);

private:
    std::filesystem::path file_;
    DeviceFamily family_;
    AudioLevels levels_;
};
} // namespace mundo
