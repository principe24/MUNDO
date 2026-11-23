// Exercises the same scene and PCM callback used by the three platform outputs.
#include "playback_audio.hpp"
#include "mundo/document_digest.hpp"
#include <array>
#include <iostream>
#include <stdexcept>
#include <vector>

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
std::vector<std::uint8_t> music_wav() {
    constexpr std::uint32_t samples=24000,data=samples*2,total=36+data;
    std::vector<std::uint8_t> bytes(44+data);
    const auto text=[&](unsigned at,const char* value,unsigned count){for(unsigned i=0;i<count;++i)bytes[at+i]=value[i];};
    const auto word=[&](unsigned at,std::uint16_t value){bytes[at]=value;bytes[at+1]=value>>8;};
    const auto dword=[&](unsigned at,std::uint32_t value){word(at,value);word(at+2,value>>16);};
    text(0,"RIFF",4);dword(4,total);text(8,"WAVEfmt ",8);dword(16,16);word(20,1);word(22,1);
    dword(24,24000);dword(28,48000);word(32,2);word(34,16);text(36,"data",4);dword(40,data);
    for(unsigned i=0;i<samples;++i)word(44+2*i,12000);
    return bytes;
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
        const std::array<std::string,4> names{"ambiente","efectos","musica","voces"};
        for(std::size_t index=0;index<names.size();++index){
            World channels;
            check(channels.create("MUNDO/Audio/v2/maquina/600/1000/2d/100/loop/"+names[index]+"/Prueba")!=0,"bus marker");
            room::PlaybackAudio playback;
            AudioLevels levels;
            levels.volume=100;
            levels.groups.fill(0);
            playback.set_levels(levels);
            playback.install(channels,true);playback.frame({},0);
            check(power()==0,"bus mute before scene installation");
            levels.groups[index]=100;
            playback.set_levels(levels);
            const double full=power();
            check(full>.001,"selected bus audible");
            levels.volume=20;
            playback.set_levels(levels);
            const double quiet=power();
            check(quiet>0 && quiet<full*.15,"master changes actual PCM energy");
            levels.muted=true;playback.set_levels(levels);
            playback.install(channels,true);playback.frame({},0);
            check(power()==0,"mute survives world replacement");
            levels.muted=false;playback.set_levels(levels);
            check(power()>0,"unmute restores requested group");
            levels.volume=0;
            check(playback.transition_levels(levels,50),"native transition accepted");
            auto block_power=[] {
                std::array<float,1024> buffer{};callback(callback_owner,buffer);
                double sum=0;for(auto sample:buffer)sum+=sample*sample;return sum;
            };
            const double fading=block_power();
            for(unsigned i=0;i<6;++i)block_power();
            const double silent=block_power();
            check(fading>silent && silent<1e-9,"native transition did not reach silence");
            levels.volume=100;
            check(!playback.transition_levels(levels,60001),"unbounded transition accepted");
            levels.groups[0]=101;
            check(!playback.transition_levels(levels,20),"invalid transition levels accepted");
        }
        {
            room::PlaybackAudio playback;
            const auto wav=music_wav();
            const auto key="s"+document_digest(std::as_bytes(std::span(wav))).substr(0,16);
            check(!playback.begin_music_stream(0)&&playback.begin_music_stream(501,3),"start long music");
            check(playback.install_music_segment(501,3,key,std::as_bytes(std::span(wav)),false),"install music segment");
            playback.frame({},0);
            check(connected&&power()>.001,"music-only room did not open output");
            playback.install(legacy,true);
            check(!connected&&!playback.has_sources(),"world switch retained streamed music");
            check(!playback.install_music_segment(501,4,key,std::as_bytes(std::span(wav)),true),"stale segment crossed world switch");
            check(!playback.cancel_music_stream(501),"stale cancellation accepted");
        }
        std::cout << "Audio room lifecycle passed with a simulated device.\n";
    } catch(const std::exception& e) {
        std::cerr << e.what() << "\n";
        return 1;
    }
}
