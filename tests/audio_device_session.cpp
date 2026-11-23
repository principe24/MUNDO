// Exercises the same scene and PCM callback used by the three platform outputs.
#include "playback_audio.hpp"
#include <array>
#include <iostream>
#include <stdexcept>

using namespace mundo;
namespace {
int opens{}, closes{};
bool connected{}, fail_open{}, route_ok{};
room::RenderAudio callback{};
void* callback_owner{};

struct RecordingDevice final : room::AudioDevice {
    ~RecordingDevice() override { connected = false; ++closes; callback = nullptr; }
    bool healthy() const noexcept override { return route_ok; }
};
void check(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}
double power() {
    check(connected && callback, "no attached device");
    double sum = 0;
    std::array<float, 1024> buffer{};
    for (unsigned i = 0; i < 14; ++i) {
        callback(callback_owner, buffer);
        sum = 0;
        for (auto sample : buffer) sum += sample * sample;
    }
    return sum;
}
}
namespace mundo::room {
std::unique_ptr<AudioDevice> open_audio_device(void* owner, RenderAudio render) {
    ++opens;
    if (fail_open) return {};
    check(!connected, "overlapping playback devices");
    callback_owner = owner;
    callback = render;
    connected = route_ok = true;
    return std::make_unique<RecordingDevice>();
}
}
int main() {
    try {
        World legacy, source, malformed;
        check(source.create("MUNDO/Audio/v1/agua/600/800/Río") != 0, "source creation");
        check(malformed.create("MUNDO/Audio/v1/bad") != 0, "invalid marker setup");
        {
            room::PlaybackAudio session;
            session.install(legacy, true);
            session.frame({}, 0);
            check(opens == 0, "legacy rooms must stay device-free");
            session.install(source, true);
            check(opens == 0, "entry must not start playback before a local pose");
            session.frame({}, 0);
            check(opens == 1 && power() > 0.001, "admitted listener hears nearby source");
            session.frame({30,0,0}, 0);
            check(power() < 1e-9, "outside radius must go silent");
            session.install(source, false);
            session.frame({}, 1);
            check(opens == 1 && closes == 0 && power() > 0.001, "same revision region update reuses device");
            session.suspend(); session.suspend();
            check(!connected && opens == closes, "background/disconnect must close once");
            session.frame({}, 0);
            check(opens == 2 && power() > 0.001, "foreground resume reopens retained scene");
            session.install(malformed, false); session.frame({}, 0);
            check(!connected && opens == 2, "invalid region cannot retain old playback");
            session.install(source, true);
            fail_open = true;
            session.frame({}, 0); session.frame({}, 0);
            check(opens == 3 && !connected, "missing device must respect retry cooldown");
            fail_open = false;
            session.suspend(); session.frame({}, 0);
            check(opens == 4 && power() > 0.001, "new foreground session recovers from unavailable output");
            route_ok = false;
            session.frame({}, 0);
            check(!connected, "broken route must retire its device");
            session.suspend(); session.frame({}, 0);
            check(connected, "new route reached");
            session.install(source, true);
            check(!connected, "new room must flush queued PCM");
            session.frame({}, 0);
        }
        check(!connected && opens == closes + 1, "destruction left an output or callback alive");
        std::cout << "Audio room lifecycle passed with a simulated device.\n";
    } catch(const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
