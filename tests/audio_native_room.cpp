// Linux test adapter: the production native room client talks to the production
// host on loopback. Only HTTP transport and the physical audio device are substituted.
#include "audio_transfer.hpp"
#include "mundo/document_digest.hpp"
#include <array>
#include <atomic>
#include <cmath>
#include <curl/curl.h>
#include <iostream>
#include <thread>

using namespace mundo;
namespace {
using namespace std::chrono_literals;
enum class Mode { normal, corrupt, legacy, project };
Mode mode{};
std::atomic<unsigned> clip_calls{}, info_calls{};

struct Transfer {
    room::Response reply;
    std::size_t limit;
    room::CancelToken stop;
};
std::size_t receive(char* ptr, std::size_t size, std::size_t count, void* context) {
    auto& t = *static_cast<Transfer*>(context);
    const auto n = size*count;
    if (t.stop.stop_requested() || n > t.limit - t.reply.body.size()) return 0;
    const auto* begin = reinterpret_cast<std::byte*>(ptr);
    t.reply.body.insert(t.reply.body.end(), begin, begin+n);
    return n;
}
int run() {
    std::string link;
    std::getline(std::cin, link);
    const std::wstring wide(link.begin(),link.end());
    auto invitation = room::parse_invitation(wide);
    if (!invitation || invitation->host != L"127.0.0.1" || invitation->tls) return 1;
    room::Client client;
    if (!client.start(wide)) return 2;
    audio::Mixer mixer;
    mixer.set_group_volume(audio::Group::ambiente, 0);
    mixer.set_group_volume(audio::Group::efectos, 0);
    bool world = false;
    unsigned after_download = 0;
    bool first_room_heard = false;
    std::string heard_key;
    const auto until = std::chrono::steady_clock::now() + 8s;
    while(std::chrono::steady_clock::now() < until) {
        auto update = client.poll();
        if (update.phase == room::Phase::ended) {std::cerr << update.message << '\n'; return 3;}
        if (update.world) {
            mixer.reset();
            world = mixer.set_world(*update.world) && room::required_clips(*update.world).size() == 1;
            if (!world) return 4;
            mixer.set_listener({0,1.6,-6.2}, 0);
        }
        if (update.region) mixer.set_world(update.region->world);
        if (update.world || update.region) update.confirm_install();
        for(const auto& clip : update.audio_clips) {
            const auto data = std::span(reinterpret_cast<const std::uint8_t*>(clip.bytes.data()), clip.bytes.size());
            auto sample = audio::decode_clip(clip.key, data);
            if (!world || !sample || !mixer.set_clip(clip.key, sample) || (mode != Mode::normal && mode != Mode::project)) return 5;
            std::array<float,8192> out{};
            mixer.render(out);
            if (!std::any_of(out.begin(),out.end(),[](float v){return std::abs(v) > .05f;})) return 6;
            if (mode == Mode::project) {
                const bool destination = update.title == "Biblioteca";
                const auto signal = out.back();
                if (!first_room_heard) {
                    if (destination || signal <= .05f) return 11;
                    first_room_heard = true;
                    heard_key = clip.key;
                    continue;
                }
                if (!destination || signal >= -.05f || clip.key == heard_key || info_calls != 2) return 12;
            }
            client.leave();
            return 0;
        }
        if (world && update.snapshot && info_calls > 0 && (clip_calls > 0 || mode == Mode::legacy)) {
            ++after_download;
            if (after_download >= 10 && (mode == Mode::corrupt || mode == Mode::legacy)) {
                std::array<float,512> out{};
                mixer.render(out);
                if (std::any_of(out.begin(),out.end(),[](float v){return v != 0;})) return 7;
                client.leave();
                return 0;
            }
        }
        if (world) client.input(first_room_heard ? 1 : 0,0,false,false);
        std::this_thread::sleep_for(8ms);
    }
    return 8;
}
}
namespace mundo::room {
bool matches_digest(std::span<const std::byte> bytes,std::string_view hex) {
    return matches_document_digest(bytes,hex);
}
std::optional<std::string> new_proof(){ return std::string(48,'b'); }
struct Http::Impl { Invitation invite; std::string proof; };
Http::Http(const Invitation& invite,std::string proof):impl_(std::make_unique<Impl>(Impl{invite,std::move(proof)})){}
Http::~Http() = default;
Response Http::post(std::string_view action,std::string_view json,std::size_t limit,CancelToken stop,ScenePresence presence) {
    if(stop.stop_requested() || impl_->invite.host != L"127.0.0.1") return {};
    if(action == "audio-info") { ++info_calls; if(mode == Mode::legacy) return {404,{}}; }
    if(action == "audio") ++clip_calls;
    const auto& wide = impl_->invite.origin;
    const std::string origin(wide.begin(),wide.end());
    const std::string url = origin + "/room/" + std::string(action);
    auto* curl = curl_easy_init();
    if(!curl) return {};
    curl_slist* headers = nullptr;
    auto header = [&](const std::string& text){headers=curl_slist_append(headers,text.c_str());};
    header("Content-Type: application/json");header("Origin: "+origin);
    const auto mime = (action=="meeting" || action=="audio-info") ? "text/plain" :
        action=="audio" ? "audio/wav" :
        (action=="route" || room_fragment_limit(action)) ? "application/octet-stream" : "application/vnd.mundo.room-v3";
    header(std::string("Accept: ")+mime);
    header("X-Invite: "+impl_->invite.token);header("X-Seat: "+impl_->proof);
    for(auto name: {"X-Mundo-Travel: 1","X-Mundo-Circuit: 1","X-Mundo-Splits: 1","X-Mundo-Npcs: 1","X-Mundo-Race-Start: 1"})header(name);
    if(auto value = scene_header(presence))header(std::string("X-Mundo-Scene: ")+value);
    Transfer t{{},limit,stop};
    curl_easy_setopt(curl,CURLOPT_URL,url.c_str()); curl_easy_setopt(curl,CURLOPT_PROXY,"");
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,headers); curl_easy_setopt(curl,CURLOPT_POSTFIELDS,json.data());
    curl_easy_setopt(curl,CURLOPT_POSTFIELDSIZE,static_cast<long>(json.size()));
    curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L); curl_easy_setopt(curl,CURLOPT_TIMEOUT_MS,1500L);
    curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,receive);curl_easy_setopt(curl,CURLOPT_WRITEDATA,&t);
    const auto result = curl_easy_perform(curl);
    long status{};curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status);
    curl_easy_cleanup(curl);curl_slist_free_all(headers);
    t.reply.status = static_cast<unsigned>(status);
    // Small error replies need not fit the successful wire frame's byte budget.
    if(status != 200) return {static_cast<unsigned>(status),{}};
    if(result != CURLE_OK) return {};
    if(mode == Mode::corrupt && action == "audio" && !t.reply.body.empty()) t.reply.body.back() ^= std::byte{1};
    return std::move(t.reply);
}
}
int main(int argc, char** argv) {
    if(argc != 2) return 9;
    const std::string arg(argv[1]);
    mode = arg=="normal"?Mode::normal:arg=="corrupt"?Mode::corrupt:arg=="project"?Mode::project:Mode::legacy;
    if(curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return 10;
    const int result = run();
    curl_global_cleanup();
    if(result) std::cerr << "Native room audio test (" << arg << ") failed at " << result <<
        ", info=" << info_calls << ", requests=" << clip_calls << '\n';
    return result;
}
