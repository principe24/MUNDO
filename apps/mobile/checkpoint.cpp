#include "checkpoint.hpp"
#include "../../src/private_file.hpp"
#include <algorithm>
#include <bit>
#include <cstring>
#include <cmath>
#include <fstream>
namespace mundo::mobile {
namespace {
// Last-world and pose files are private local caches. Key and checksum detect accidental mismatches.
constexpr std::uint64_t magic=0x31534f50444c574dULL;
constexpr std::size_t size=64, extended_size=152;
constexpr std::string_view location_tag="MUNLOC01";
std::vector<std::byte> read(const std::filesystem::path& file,std::size_t limit){
    std::ifstream in(file,std::ios::binary|std::ios::ate);
    const auto end=in.tellg();
    if(end<=std::streamoff(0)||end>static_cast<std::streamoff>(limit))return {};
    std::vector<std::byte> result(static_cast<std::size_t>(end));
    in.seekg(0);
    if(!in.read(reinterpret_cast<char*>(result.data()),static_cast<std::streamsize>(result.size())))return {};
    return result;
}
void put(std::span<std::byte> bytes,unsigned word,std::uint64_t value){
    for(unsigned i=0;i<8;++i)bytes[word*8+i]=std::byte((value>>(8*i))&255);
}
std::uint64_t get(std::span<const std::byte> bytes,unsigned word){
    std::uint64_t value=0;
    for(unsigned i=0;i<8;++i)value|=std::uint64_t(std::to_integer<unsigned>(bytes[word*8+i]))<<(8*i);
    return value;
}
}
std::uint64_t document_key(std::span<const std::byte> bytes){
    std::uint64_t key=14695981039346656037ULL;
    for(auto b:bytes){key^=std::to_integer<unsigned>(b);key*=1099511628211ULL;}
    return key;
}
bool store_pose(const std::filesystem::path& dir,std::uint64_t key,const SavedPose& p){
    std::vector<std::byte> bytes(p.location?extended_size:size);
    put(bytes,0,magic);put(bytes,1,key);
    unsigned word=2;
    for(double n:{p.feet.x,p.feet.y,p.feet.z,p.yaw,p.pitch})put(bytes,word++,std::bit_cast<std::uint64_t>(n));
    put(bytes,7,document_key(std::span(bytes).first(56)));
    if(p.location) {
        const auto& location=*p.location;
        if(location.index_hash.size()!=64 || !location.id || location.id>9007199254740991ULL)return false;
        std::memcpy(bytes.data()+64,location_tag.data(),8);
        std::memcpy(bytes.data()+72,location.index_hash.data(),64);
        put(bytes,17,location.id);
        put(bytes,18,document_key(std::span(bytes).first(144)));
    }
    return write_private_file(dir/"player.pose",bytes);
}
namespace {
std::vector<std::byte> pose_record(const std::filesystem::path& dir) {
    auto bytes=read(dir/"player.pose",extended_size);
    if((bytes.size()!=size && bytes.size()!=extended_size) || get(bytes,0)!=magic ||
       get(bytes,7)!=document_key(std::span(bytes).first(56)))return {};
    if(bytes.size()==extended_size &&
       (std::memcmp(bytes.data()+64,location_tag.data(),8)!=0 ||
        get(bytes,18)!=document_key(std::span(bytes).first(144))))return {};
    return bytes;
}
std::optional<project::Selection> record_location(std::span<const std::byte> bytes) {
    if(bytes.size()!=extended_size)return {};
    std::string hash(reinterpret_cast<const char*>(bytes.data()+72),64);
    const auto id=get(bytes,17);
    if(!id || id>9007199254740991ULL || !std::all_of(hash.begin(),hash.end(),[](char c){
        return (c>='0'&&c<='9') || (c>='a'&&c<='f');
    }))return {};
    return project::Selection{std::move(hash),id};
}
}
std::optional<project::Selection> read_project_location(const std::filesystem::path& dir) {
    return record_location(pose_record(dir));
}
std::optional<SavedPose> read_pose(const std::filesystem::path& dir,std::uint64_t key){
    auto bytes=pose_record(dir);
    if(bytes.empty() || get(bytes,1)!=key)return {};
    auto number=[&](unsigned i){return std::bit_cast<double>(get(bytes,i));};
    SavedPose pose{{number(2),number(3),number(4)},number(5),number(6),record_location(bytes)};
    if(!std::isfinite(pose.yaw)||!std::isfinite(pose.pitch)||std::abs(pose.pitch)>1.4)return {};
    return pose;
}
PoseWriter::PoseWriter(std::filesystem::path dir):directory_(std::move(dir)),worker_([this]{run();}){}
PoseWriter::~PoseWriter(){
    {std::lock_guard lock(mutex_);closing_=true;}
    changed_.notify_all();
    worker_.join();
}
bool PoseWriter::submit(std::uint64_t key,const SavedPose& pose,bool wait){
    std::unique_lock lock(mutex_);
    const auto ticket=++issued_;
    pending_=Entry{key,ticket,pose};
    changed_.notify_all();
    if(!wait)return true;
    changed_.wait(lock,[&]{return completed_>=ticket;});
    return ok_;
}
void PoseWriter::run(){
    std::optional<Entry> last;
    while(true){
        std::unique_lock lock(mutex_);
        changed_.wait(lock,[&]{return closing_ || pending_.has_value();});
        if(!pending_)return;
        const Entry next=*pending_;pending_.reset();lock.unlock();
        auto coords=[](const SavedPose& p){return std::array{p.feet.x,p.feet.y,p.feet.z,p.yaw,p.pitch};};
        bool ok=last && last->key==next.key && last->pose.location==next.pose.location && coords(last->pose)==coords(next.pose);
        if(!ok){
            try{ok=store_pose(directory_,next.key,next.pose);}catch(...){ok=false;}
        }
        if(ok)last=next;
        lock.lock();completed_=next.ticket;ok_=ok;
        changed_.notify_all();
    }
}

}
