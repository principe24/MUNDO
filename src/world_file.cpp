#include "mundo/world.hpp"
#include <bit>
#include <algorithm>
#include <limits>
#include <type_traits>
#include <utility>

namespace mundo {
namespace {
constexpr std::array<std::byte,8> magic{std::byte{'M'},std::byte{'W'},std::byte{'E'},std::byte{'N'},std::byte{'G'},std::byte{'I'},std::byte{'E'},std::byte{0}};
template<class T> void put(std::vector<std::byte>& out,T value) {
    static_assert(std::is_unsigned_v<T>);
    for (std::size_t j=0;j<sizeof(T);++j) out.push_back(static_cast<std::byte>((value>>(j*8))&0xff));
}
struct Reader {
    std::span<const std::byte> bytes;
    bool ok{true};
    template<class T> T take() {
        static_assert(std::is_unsigned_v<T>);
        if(bytes.size()<sizeof(T)){ok=false;return 0;}
        T out{};
        for(std::size_t j=0;j<sizeof(T);++j)
            out=static_cast<T>(out | (static_cast<std::uint64_t>(std::to_integer<unsigned>(bytes[j]))<<(8*j)));
        bytes=bytes.subspan(sizeof(T));
        return out;
    }
    double f64(){return std::bit_cast<double>(take<std::uint64_t>());}
    float f32(){return std::bit_cast<float>(take<std::uint32_t>());}
};
}
std::vector<std::byte> encode(const World& world) {
    std::vector<std::byte> out(magic.begin(),magic.end());
    const std::uint32_t version=std::any_of(world.nodes().begin(),world.nodes().end(),
        [](const auto& pair){return pair.second.visual!=0;})?2:1;
    put(out,version); put(out,static_cast<std::uint32_t>(world.nodes().size())); put(out,world.next_id());
    for(const auto& [id,node]:world.nodes()){
        put(out,id);put(out,node.parent);put(out,static_cast<std::uint8_t>(node.shape));
        put(out,static_cast<std::uint8_t>(node.name.size()));
        for(unsigned char c:node.name) out.push_back(static_cast<std::byte>(c));
        auto& t=node.local;
        for(double v:{t.position.x,t.position.y,t.position.z,t.rotation.x,t.rotation.y,t.rotation.z,t.rotation.w,t.scale.x,t.scale.y,t.scale.z})
            put(out,std::bit_cast<std::uint64_t>(v));
        for(float v:node.material.linear_rgb) put(out,std::bit_cast<std::uint32_t>(v));
        put(out,std::bit_cast<std::uint32_t>(node.material.roughness));put(out,std::bit_cast<std::uint32_t>(node.material.metallic));
        if(version==2)put(out,node.visual);
    }
    return out;
}
std::optional<World> decode(std::span<const std::byte> bytes) {
    if(bytes.size()<24||bytes.size()>max_world_bytes||!std::equal(magic.begin(),magic.end(),bytes.begin())) return {};
    Reader r{bytes.subspan(magic.size())};
    const auto version=r.take<std::uint32_t>();
    if(version!=1 && version!=2)return {};
    const auto count=r.take<std::uint32_t>();const auto next=r.take<EntityId>();
    const std::size_t min_node_bytes=16+2+1+80+20+(version==2?8:0);
    if(!r.ok||count>max_entities||count>r.bytes.size()/min_node_bytes)return {};
    std::vector<Node> nodes;nodes.reserve(count);
    for(std::uint32_t i=0;i<count;++i){
        Node node{};node.id=r.take<EntityId>();node.parent=r.take<EntityId>();
        node.shape=static_cast<Shape>(r.take<std::uint8_t>());
        const auto size=r.take<std::uint8_t>();
        if(!r.ok||!size||size>95||r.bytes.size()<size)return {};
        node.name.assign(reinterpret_cast<const char*>(r.bytes.data()),size);r.bytes=r.bytes.subspan(size);
        node.local.position={r.f64(),r.f64(),r.f64()};
        node.local.rotation={r.f64(),r.f64(),r.f64(),r.f64()};
        node.local.scale={r.f64(),r.f64(),r.f64()};
        for(auto& c:node.material.linear_rgb)c=r.f32();
        node.material.roughness=r.f32();node.material.metallic=r.f32();
        if(version==2)node.visual=r.take<VisualKey>();
        if(!r.ok)return {};
        nodes.push_back(std::move(node));
    }
    if(!r.bytes.empty())return {};
    return World::restore(std::move(nodes),next);
}
} // namespace mundo
