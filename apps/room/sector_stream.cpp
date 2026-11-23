#include "sector_stream.hpp"
#include "mundo/vehicle.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <new>
#include <set>

namespace mundo::room {
namespace {
constexpr std::size_t header=80, row_size=48, page_size=1024*1024;
std::uint32_t u32(std::span<const std::byte> data,std::size_t at){
    std::uint32_t value{};
    for(unsigned i=0;i<4;++i)value|=std::to_integer<std::uint32_t>(data[at+i])<<(8*i);
    return value;
}
std::int32_t i32(std::span<const std::byte> data,std::size_t at){return std::bit_cast<std::int32_t>(u32(data,at));}
bool magic(std::span<const std::byte> data,std::string_view expected){
    return data.size()>=expected.size() &&
        std::equal(expected.begin(),expected.end(),data.begin(),[](char a,std::byte b){return b==static_cast<std::byte>(a);});
}
std::string hex(std::span<const std::byte> bytes){
    return hex_text({reinterpret_cast<const unsigned char*>(bytes.data()),bytes.size()});
}
using Cell=std::pair<std::int32_t,std::int32_t>;

bool inside(std::int32_t x,std::int32_t z,std::int32_t center_x,std::int32_t center_z,unsigned radius){
    return std::abs(std::int64_t(x)-center_x)<=radius && std::abs(std::int64_t(z)-center_z)<=radius;
}
std::size_t row_limit(bool mobile,bool ahead){
    return ahead ? (mobile?5u:9u) : (mobile?10u:26u);
}
bool valid_window(const SectorWindow& plan,std::optional<Cell> base){
    if(plan.radius!=1 && plan.radius!=2)return false;
    const bool mobile=plan.radius==1;
    const std::size_t limit=base ? (mobile?page_size/2:2*page_size) : (mobile?4:8)*page_size;
    if(plan.revision.size()!=64 || plan.token.size()!=32 || plan.full_bytes<128u*1024u || plan.full_bytes>max_world_bytes ||
       plan.rows.empty() || plan.rows.size()>row_limit(mobile,base.has_value()))return false;
    if(base && ahead_stage(base->first,base->second,plan.x,plan.z,plan.x,plan.z)!=AheadStage::target)return false;
    std::size_t total=0,nodes=0;
    std::set<std::pair<std::int32_t,std::int32_t>> cells;
    std::set<std::string_view> hashes;
    for(std::size_t slot=0;slot<plan.rows.size();++slot){
        const auto& row=plan.rows[slot];
        if(row.bytes<24 || row.bytes>limit-total || row.nodes>max_entities-nodes ||
           row.nodes>(row.bytes-24)/119 || row.hash.size()!=64 || !hashes.insert(row.hash).second)return false;
        total+=row.bytes;nodes+=row.nodes;
        if(slot==0 && !base){
            if(row.x!=0 || row.z!=0)return false;
        }else if(!row.nodes || !inside(row.x,row.z,plan.x,plan.z,plan.radius) ||
                 (base && inside(row.x,row.z,base->first,base->second,plan.radius)) ||
                 !cells.emplace(row.x,row.z).second)return false;
    }
    return nodes>0 && nodes<=(plan.full_bytes-24)/119;
}
bool valid_page(std::span<const std::byte> page,std::size_t total,std::size_t offset){
    if(page.size()<16 || !magic(page,"MWC1") || offset>=total || offset%page_size)return false;
    const auto length=std::min(page_size,total-offset);
    return page.size()==16+length && u32(page,4)==total && u32(page,8)==offset && u32(page,12)==length;
}
std::optional<SectorWindow> read_window(std::span<const std::byte> frame,std::string_view revision,
                                       bool mobile,std::optional<Cell> base){
    if(frame.size()<header || !magic(frame,base?"MAH1":"MSP1"))return {};
    const auto count=u32(frame,4);
    if(!count || count>row_limit(mobile,base.has_value()) || frame.size()!=header+count*row_size ||
       u32(frame,16)!=(mobile?1u:2u) || std::any_of(frame.begin()+72,frame.begin()+80,[](auto v){return v!=std::byte{};}))return {};
    try{
        SectorWindow plan{i32(frame,8),i32(frame,12),u32(frame,16),u32(frame,20),
                        hex(frame.subspan(24,32)),hex(frame.subspan(56,16)),{}};
        if(plan.revision!=revision)return {};
        plan.rows.reserve(count);
        for(std::size_t at=header;at<frame.size();at+=row_size)
            plan.rows.push_back({i32(frame,at),i32(frame,at+4),u32(frame,at+8),u32(frame,at+12),hex(frame.subspan(at+16,32))});
        if(!valid_window(plan,base))return {};
        return plan;
    }catch(const std::bad_alloc&){return {};}
}

SectorBlob download_blob(const SectorRow& row,std::size_t slot,const SectorPageFetch& fetch,CancelToken stop){
    if(stop.stop_requested())return {};
    auto transfer=std::make_shared<std::vector<std::byte>>();
    transfer->reserve(row.bytes);
    while(transfer->size()<row.bytes){
        if(stop.stop_requested())return {};
        const auto frame=fetch(slot,transfer->size());
        if(stop.stop_requested() || !frame || !valid_page(*frame,row.bytes,transfer->size()))return {};
        transfer->insert(transfer->end(),frame->begin()+16,frame->end());
    }
    if(stop.stop_requested() || !matches_digest(*transfer,row.hash) || stop.stop_requested())return {};
    return transfer;
}
}

AheadStage ahead_stage(std::int32_t base_x,std::int32_t base_z,std::int32_t target_x,
                       std::int32_t target_z,std::int32_t x,std::int32_t z) noexcept{
    if((base_x==target_x && base_z==target_z) || !inside(target_x,target_z,base_x,base_z,1))
        return AheadStage::outside;
    if(x==target_x && z==target_z)return AheadStage::target;
    if(target_x!=base_x && target_z!=base_z){
        if(x==target_x && z==base_z)return AheadStage::via_x;
        if(x==base_x && z==target_z)return AheadStage::via_z;
    }
    return AheadStage::outside;
}

std::optional<SectorPlan> read_sector_plan(std::span<const std::byte> frame,std::string_view revision,bool mobile){
    auto window=read_window(frame,revision,mobile,{});
    if(!window)return {};
    return SectorPlan{std::move(*window)};
}
std::optional<AheadPlan> read_ahead_plan(std::span<const std::byte> frame,std::string_view revision,bool mobile,
                                        std::int32_t base_x,std::int32_t base_z){
    auto window=read_window(frame,revision,mobile,Cell{base_x,base_z});
    if(!window)return {};
    return AheadPlan{std::move(*window),base_x,base_z};
}

std::shared_ptr<const AheadCache> prefetch_ahead(const AheadPlan& hint,const SectorPageFetch& fetch,
                                                CancelToken stop,const AheadProgress& publish){
    try{
        const auto& window=hint.window;
        if(stop.stop_requested() || !valid_window(window,Cell{hint.base_x,hint.base_z}))return {};
        auto cache=std::make_shared<AheadCache>();
        cache->revision_=window.revision;
        cache->token_=window.token;
        cache->base_x_=hint.base_x;cache->base_z_=hint.base_z;
        cache->x_=window.x;cache->z_=window.z;
        cache->radius_=window.radius;cache->full_bytes_=window.full_bytes;
        for(std::size_t slot=0;slot<window.rows.size();++slot){
            const auto& row=window.rows[slot];
            auto blob=download_blob(row,slot,fetch,stop);
            if(!blob || stop.stop_requested())return {};
            // Speculative bytes only. World decoding and family bounds belong to the confirmed plan.
            // Bits refer to the original MAH1 order, which can differ from MSP1 order.
            const auto bit=static_cast<std::uint16_t>(1u<<slot);
            cache->pieces_.emplace(row.hash,AheadCache::Piece{row.x,row.z,row.nodes,bit,std::move(blob)});
            cache->verified_mask_|=bit;
            // The worker can take the last finished row while another page request is in flight.
            // Only the small metadata map is copied. Each digest has one immutable byte buffer.
            if(publish){
                publish(cache);
                if(slot+1<window.rows.size())cache=std::make_shared<AheadCache>(*cache);
            }
        }
        return cache;
    }catch(const std::bad_alloc&){return {};}
}

std::optional<World> assemble_sector(const SectorPlan& plan,SectorCache& cache,const SectorPageFetch& fetch,
                                    CancelToken stop,const AheadCache* ahead,std::uint16_t* used){
    if(used)*used=0;
    try{
        std::uint16_t used_rows{};
        if(stop.stop_requested() || !valid_window(plan,{}))return {};
        const bool match_ahead=ahead && ahead->revision_==plan.revision && ahead->radius_==plan.radius &&
            ahead->full_bytes_==plan.full_bytes &&
            ahead_stage(ahead->base_x_,ahead->base_z_,ahead->x_,ahead->z_,plan.x,plan.z)!=AheadStage::outside;
        // References may overlap the previous revision-local window. Publish the cache only after complete assembly.
        SectorCache next_cache;
        next_cache.revision_=plan.revision;
        if(match_ahead)next_cache.ahead_token_=ahead->token_;
        std::optional<EntityId> next_id;
        std::vector<World> parts;
        parts.reserve(plan.rows.size());
        std::vector<EntityId> globals;
        for(std::size_t slot=0;slot<plan.rows.size();++slot){
            if(stop.stop_requested())return {};
            const auto& row=plan.rows[slot];
            SectorBlob blob;
            std::uint16_t cached_bit{}, origin_bit{};
            if(cache.revision_==plan.revision){
                const auto cached=cache.blobs_.find(row.hash);
                if(cached!=cache.blobs_.end() && cached->second.bytes->size()==row.bytes){
                    blob=cached->second.bytes;
                    if(match_ahead && cache.ahead_token_==ahead->token_)cached_bit=cached->second.ahead_bit;
                }
            }
            if(slot!=0 && match_ahead && (!blob || cached_bit)){
                const auto it=ahead->pieces_.find(row.hash);
                if(it!=ahead->pieces_.end()){
                    const auto& piece=it->second;
                    if(piece.x==row.x && piece.z==row.z && piece.nodes==row.nodes &&
                       piece.blob->size()==row.bytes && (!blob || cached_bit==piece.slot_bit)){
                        if(!blob)blob=piece.blob;
                        // The previous window may never have reached the render thread.
                        // Its verified origin survives; only installation assigns a stage.
                        origin_bit=piece.slot_bit;
                        used_rows|=origin_bit;
                    }
                }
            }
            if(!blob)blob=download_blob(row,slot,fetch,stop);
            if(!blob || stop.stop_requested())return {};
            auto part=decode(*blob);
            if(!part || part->nodes().size()!=row.nodes || (next_id && *next_id!=part->next_id()))return {};
            next_id=part->next_id();
            for(const auto& [id,node]:part->nodes()){
                if(node.parent==root_id){
                    if(slot==0)globals.push_back(id);
                    else if(!part->family_fits_cell(id,row.x,row.z))return {};
                }
            }
            parts.push_back(std::move(*part));
            next_cache.blobs_.emplace(row.hash,SectorCache::CachedBlob{std::move(blob),origin_bit});
        }
        if(stop.stop_requested() || !next_id)return {};
        auto world=World::merge_documents(std::move(parts));
        if(!world || !std::binary_search(globals.begin(),globals.end(),world->first_solid_family()) || stop.stop_requested())return {};
        cache=std::move(next_cache);
        // The caller carries these bits with the candidate until its installation succeeds.
        if(used)*used=used_rows;
        return world;
    }catch(const std::bad_alloc&){cache.clear();return {};}
}

bool sector_supports(const World& world,const CharacterTerrain& terrain,const Snapshot& snapshot,unsigned seat) try {
    const auto local=std::find_if(snapshot.players.begin(),snapshot.players.end(),[&](const auto& p){return p.id==seat;});
    if(terrain.empty() || local==snapshot.players.end())return false;
    if(const auto& car=snapshot.car){
        if(!world.get(car->root))return false;
        if(car->driver==static_cast<int>(seat) || car->passenger==static_cast<int>(seat)){
            VehicleSession vehicle;
            return vehicle.discover(world,car->root) && vehicle.select_replica(car->root) &&
                   vehicle.replica_supported(terrain,car->x,car->z,car->yaw);
        }
    }
    if(!local->grounded)return true;
    bool supported=false;
    const auto p=local->feet;
    terrain.visit({{p.x-.30,p.y-.35,p.z-.30},{p.x+.30,p.y+.35,p.z+.30}},
        [&](const auto& solid){if(std::abs(solid.high[1]-p.y)<=.35)supported=true;});
    return supported;
}catch(const std::bad_alloc&){return false;}
}
