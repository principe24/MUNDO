#pragma once
#include "room_client.hpp"
#include "mundo/room_view.hpp"
#include <array>
#include <map>
#include <utility>

namespace mundo::room {
// The full document is the recovery source. Only the resident copy is animated while paging.
class ActiveScene {
public:
    explicit ActiveScene(int radius):radius_(radius){}
    void install(Update&,View&);
    // An authenticated replacement for the same publication keeps the existing replica and camera.
    void replace_region(World&&,CharacterTerrain&&);
    // Returns true when the renderer should promptly retire mesh buffers left out of the new scene.
    bool follow(const Snapshot&,unsigned seat,const View&,double now,bool discontinuity);
    void reduce_memory();
    void suspend();
    [[nodiscard]] bool ready() const {return source_ && (local_ || full_terrain_);}
    [[nodiscard]] World& world(){return local_?local_->world:*source_;}
    [[nodiscard]] const World& world() const{return local_?local_->world:*source_;}
    [[nodiscard]] const CharacterTerrain& terrain() const{return local_?local_->terrain:*full_terrain_;}
private:
    using Cell=std::pair<std::int64_t,std::int64_t>;
    struct Window {
        Cell center;
        int ahead_x{},ahead_z{};
        bool operator==(const Window&) const=default;
    };
    struct Focus {
        std::optional<Cell> center,previous;
        double retain_until{};
    };
    using Windows=std::array<std::optional<Window>,4>; // Current and previous for feet, then vehicle.
    struct Region {
        World world;
        CharacterTerrain terrain;
        Region(World&& w, EntityId vehicle):world(std::move(w)),terrain(world,vehicle){}
    };
    void observe(Focus&,Windows&,unsigned,double x,double z,double now,bool compact);
    bool whole(double now);
    int radius_;
    std::optional<World> source_;
    std::optional<CharacterTerrain> full_terrain_;
    std::optional<Region> local_;
    std::map<Cell,std::vector<EntityId>> cells_;
    std::vector<EntityId> global_;
    std::size_t root_count_{};
    EntityId vehicle_{};
    Focus foot_,car_;
    Windows active_windows_{};
    std::vector<EntityId> selected_;
    double compact_until_{},retry_after_{};
    bool trim_requested_{};
};
}
