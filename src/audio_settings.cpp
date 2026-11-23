#include "mundo/audio_settings.hpp"
#include "private_file.hpp"

#include <algorithm>
#include <fstream>

namespace mundo {
namespace {
constexpr std::array<unsigned char,8> signature{'M','A','P','R','E','F','0','1'};
using Record = std::array<unsigned char,15>;

unsigned char tag(DeviceFamily family) {return family == DeviceFamily::mobile ? 1 : 2;}

bool valid(const AudioLevels& levels) {
    return levels.volume <= 100 &&
        std::all_of(levels.groups.begin(),levels.groups.end(),[](unsigned level){return level <= 100;});
}
}
DeviceAudioProfile::DeviceAudioProfile(std::filesystem::path directory, DeviceFamily family) : family_(family) {
    if (directory.empty()) return;
    file_ = directory / (family == DeviceFamily::mobile ? "audio-mobile.v1" : "audio-pc.v1");
    Record bytes{};
    std::ifstream input(file_,std::ios::binary);
    if (!input.read(reinterpret_cast<char*>(bytes.data()),bytes.size()) ||
        input.peek() != std::char_traits<char>::eof() || input.bad() ||
        !std::equal(signature.begin(),signature.end(),bytes.begin()) ||
        bytes[8] != tag(family) || bytes[9] > 1) return;
    AudioLevels found;
    found.muted = bytes[9] != 0;
    found.volume = bytes[10];
    std::copy_n(bytes.begin()+11,found.groups.size(),found.groups.begin());
    if (valid(found)) levels_ = found;
}

SettingsResult DeviceAudioProfile::apply(const AudioLevels& levels) {
    if (!valid(levels)) return SettingsResult::invalid;
    if (!file_.empty()) {
        Record bytes{};
        std::copy(signature.begin(),signature.end(),bytes.begin());
        bytes[8] = tag(family_); bytes[9] = levels.muted; bytes[10] = static_cast<unsigned char>(levels.volume);
        std::transform(levels.groups.begin(),levels.groups.end(),bytes.begin()+11,
            [](unsigned n){return static_cast<unsigned char>(n);});
        if (!write_private_file(file_,std::as_bytes(std::span(bytes)))) return SettingsResult::write_failed;
    }
    levels_ = levels;
    return file_.empty() ? SettingsResult::session_only : SettingsResult::saved;
}
} // namespace mundo
