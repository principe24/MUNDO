#include "audio_transfer.hpp"
#include "mundo/document_digest.hpp"
#include <atomic>
#include <array>
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace std::chrono_literals;
using namespace mundo::room;
namespace {
const std::array<std::vector<std::byte>,2> payloads {
    std::vector<std::byte>(68, std::byte{17}), std::vector<std::byte>(80, std::byte{23})
};
const std::array<std::string,2> hashes{mundo::document_digest(payloads[0]), mundo::document_digest(payloads[1])};
const std::array<std::string,2> keys{"s"+hashes[0].substr(0,16),"s"+hashes[1].substr(0,16)};
std::atomic<unsigned> manifests{}, first{}, second{};
std::atomic<bool> blocked{}, cancelled{};
void check(bool ok,const char* what) { if (!ok) throw std::runtime_error(what); }
std::vector<std::byte> bytes(std::string_view text) {
    auto raw=std::as_bytes(std::span(text));
    return {raw.begin(),raw.end()};
}
void reset_counts(){ manifests=0; first=0; second=0; blocked=false; cancelled=false; }

using Clock = AudioTransfer::Clock;
// Poll at the given simulated monotonic times. Short real yields let the asynchronous
// production worker finish while a test can cover a seven-second backoff immediately.
std::vector<std::string> drain(AudioTransfer& transfer, Clock::time_point start) {
    std::vector<std::string> delivered;
    const auto deadline=Clock::now()+5s;
    for (unsigned i=0;transfer.pending();++i) {
        check(Clock::now()<deadline,"worker never completed");
        for (auto& clip : transfer.poll(start + 200ms*i)) {
            check((clip.key==keys[0] && clip.bytes==payloads[0]) ||
                  (clip.key==keys[1] && clip.bytes==payloads[1]),"corrupt payload escaped");
            delivered.push_back(clip.key);
        }
        std::this_thread::sleep_for(1ms);
    }
    return delivered;
}
}
namespace mundo::room {
struct Http::Impl {};
Http::Http(const Invitation&,std::string) : impl_(std::make_unique<Impl>()) {}
Http::~Http() = default;
bool matches_digest(std::span<const std::byte> data,std::string_view hex){return matches_document_digest(data,hex);}
Response Http::post(std::string_view action,std::string_view json,std::size_t limit,CancelToken stop,ScenePresence) {
    const auto mode=[&](std::string_view name){return json.find(name)!=json.npos;};
    if (action=="audio-info") {
        const unsigned attempt=++manifests;
        if (mode("manifest_transient") && attempt==1) return {503,{}};
        if (mode("forever")) return {429,{}};
        if (mode("denied")) return {403,{}};
        if (mode("empty")) return {204,{}};
        if (mode("wait")) {
            blocked=true;
            const auto timeout=Clock::now()+2s;
            while (!stop.stop_requested() && Clock::now()<timeout) std::this_thread::sleep_for(1ms);
            cancelled=stop.stop_requested();
        }
        return {200,bytes(std::string(32,'a')+"\n"+hashes[0]+"\n"+hashes[1]+"\n")};
    }
    check(action=="audio","unexpected test HTTP operation");
    const unsigned index=mode(keys[0])?0:1;
    const auto attempt=index==0 ? ++first : ++second;
    if (mode("partial") && index==1 && attempt<=2) return {attempt==1 ? 429u : 503u,{}};
    if (mode("corrupt") && index==0) return {200,payloads[1]};
    if (mode("manifest_transient") && attempt==1) return {0,{}};
    check(limit>=payloads[index].size(),"request size too small");
    return {200,payloads[index]};
}
}

int main() {
    try {
        const auto both=std::vector<std::string>{keys[0],keys[1]};
        const auto now=Clock::now();
        Invitation invite;
        for (auto mode : {"partial","manifest_transient","denied","empty","forever","corrupt"}) {
            AudioTransfer transfer; reset_counts();
            transfer.select(invite,"proof",mode,both);
            const auto delivered=drain(transfer,now);
            if (mode==std::string_view("partial")) {
                check(delivered==both && manifests==3 && first==1 && second==3,"partial retry duplicated or lost a clip");
            } else if (mode==std::string_view("manifest_transient")) {
                check(delivered==both && manifests==4 && first==2 && second==2,"retry after 503 and lost transport");
            } else if (mode==std::string_view("corrupt")) {
                check(delivered==std::vector<std::string>{keys[1]} && manifests==1 && first==1 && second==1,
                      "bad digest retried or blocked another clip");
            } else {
                check(delivered.empty() && first==0 && second==0,"unexpected publication");
                check(manifests==(mode==std::string_view("forever")?4u:1u),"terminal/attempt limit");
            }
        }
        for (bool reopen : {false,true}) {
            AudioTransfer transfer; reset_counts();
            transfer.select(invite,"old","wait",both);
            transfer.poll(now);
            const auto timeout=Clock::now()+2s;
            while (!blocked && Clock::now()<timeout) std::this_thread::sleep_for(1ms);
            check(blocked,"old worker never entered");
            auto next=reopen ? std::vector<std::string>{keys[1]} : std::vector<std::string>{};
            transfer.select(invite,"new","replacement",next);
            check(drain(transfer,now)==next && cancelled && first==0,"stale result after leave/replacement");
        }
        std::cout<<"Partial delivery, 429/503, lost transport, denial, digest rejection, retry cap and in-flight replacement passed.\n";
    } catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
