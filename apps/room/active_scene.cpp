#include "active_scene.hpp"
#include <algorithm>
#include <cmath>
#include <new>
#include <set>

namespace mundo::room {
namespace {
bool floor_at(const CharacterTerrain& terrain,Vec3 feet){
    bool floor=false;
    terrain.visit({{feet.x-.30,feet.y-.35,feet.z-.30},{feet.x+.30,feet.y+.35,feet.z+.30}},
        [&](const CollisionBounds& b){if(std::abs(b.high[1]-feet.y)<=.35)floor=true;});
    return floor;
}
}

void ActiveScene::install(Update& update,View& actors){
    *this=ActiveScene(radius_);
    source_=std::move(update.world);
    full_terrain_=std::move(update.terrain);
    if(!source_)return;
    actors.bind_world(*source_);
    vehicle_=update.snapshot && update.snapshot->car?update.snapshot->car->root:root_id;
    if(!update.cells || update.cells->empty() || !update.snapshot)return;
    auto top=source_->get(vehicle_);
    while(top && top->parent!=root_id)top=source_->get(top->parent);
    const auto always=top?top->id:root_id;
    try{
        const auto& rows=*update.cells;
        auto row=rows.begin();
        for(const auto& [id,node]:source_->nodes()){
            if(node.parent!=root_id)continue;
            ++root_count_;
            if(row!=rows.end() && row->root==id){
                if(id!=always)cells_[{row->x,row->z}].push_back(id);
                else global_.push_back(id);
                ++row;
            }else global_.push_back(id);
        }
        if(row==rows.end() && !cells_.empty())return;
    }catch(const std::bad_alloc&){/* The original document and its terrain are ready. */}
    cells_.clear();std::vector<EntityId>{}.swap(global_);
}

void ActiveScene::replace_region(World&& incoming,CharacterTerrain&& terrain){
    ActiveScene replacement(radius_);
    replacement.vehicle_=vehicle_;
    if(source_ && vehicle_)incoming.copy_local_pose(vehicle_,world());
    replacement.source_.emplace(std::move(incoming));
    replacement.full_terrain_.emplace(std::move(terrain));
    *this=std::move(replacement);
}

void ActiveScene::observe(Focus& track,Windows& windows,unsigned index,double x,double z,double now,bool compact){
    const Cell raw{static_cast<std::int64_t>(std::floor(x/64.+.5)),
                   static_cast<std::int64_t>(std::floor(z/64.+.5))};
    Cell next=track.center.value_or(raw);
    if(std::abs(x-64.*next.first)>40.)next.first=raw.first;
    if(std::abs(z-64.*next.second)>40.)next.second=raw.second;
    if(track.center && *track.center!=next){
        const bool adjacent=std::abs(next.first-track.center->first)<=1 && std::abs(next.second-track.center->second)<=1;
        track.previous=adjacent?track.center:std::nullopt;
        track.retain_until=now+.150;
    }
    track.center=next;
    if(now>=track.retain_until || compact)track.previous.reset();
    const auto ahead=[compact](double distance){return compact?0:distance>=20.?1:distance<=-20.?-1:0;};
    windows[index]=Window{next,ahead(x-next.first*64.),ahead(z-next.second*64.)};
    if(track.previous)windows[index+1]=Window{*track.previous};
}

bool ActiveScene::whole(double now){
    bool switched=local_.has_value();
    if(local_)source_->copy_local_pose(vehicle_,local_->world);
    if(!full_terrain_){
        try{full_terrain_.emplace(*source_,vehicle_);}
        catch(const std::bad_alloc&){
            // Discard the unusable selection. Leave controls covered until a subsequent snapshot can recover.
            local_.reset();selected_.clear();active_windows_={};retry_after_=now+1.;return true;
        }
    }
    local_.reset();selected_.clear();
    return switched;
}

bool ActiveScene::follow(const Snapshot& snapshot,unsigned seat,const View& actors,double now,bool discontinuity){
    if(!source_ || cells_.empty() || !std::isfinite(now) || now<retry_after_)return false;
    if(trim_requested_){compact_until_=now+4.;trim_requested_=false;}
    const auto player=std::find_if(snapshot.players.begin(),snapshot.players.end(),[&](const auto& p){return p.id==seat;});
    if(player==snapshot.players.end())return false;
    const auto& car=snapshot.car;
    const bool aboard=car && (car->driver==static_cast<int>(seat) || car->passenger==static_cast<int>(seat));
    const auto valid=[](double v){return std::isfinite(v) && std::abs(v)<=1e15;};
    if(!valid(player->feet.x)||!valid(player->feet.z)||(aboard && (!valid(car->x)||!valid(car->z))))
        return whole(now);
    if(discontinuity){foot_={};car_={};}
    Windows windows{};
    const bool compact=now<compact_until_;
    observe(foot_,windows,0,player->feet.x,player->feet.z,now,compact);
    if(aboard)observe(car_,windows,2,car->x,car->z,now,compact);
    else car_={};
    const auto suitable=[&](const CharacterTerrain& terrain){
        if(aboard){
            const auto* vehicle=actors.vehicles();
            return vehicle && vehicle->replica_supported(terrain,car->x,car->z,car->yaw);
        }
        return !player->grounded || floor_at(terrain,player->feet);
    };
    // A grounded pose can move within a retained window. Never keep a selection that has lost its support.
    try{
        if(windows==active_windows_ && ready()){
            if(local_ && !suitable(local_->terrain))return whole(now);
            return false;
        }
        active_windows_=windows;
        std::set<Cell> included;
        for(const auto& w:windows){
            if(!w)continue;
            const auto [cx,cz]=w->center;
            const auto left=cx-radius_,right=cx+radius_,back=cz-radius_,front=cz+radius_;
            for(auto x=left+std::min(0,w->ahead_x);x<=right+std::max(0,w->ahead_x);++x)
                for(auto z=back+std::min(0,w->ahead_z);z<=front+std::max(0,w->ahead_z);++z)
                    included.emplace(x,z);
        }
        auto roots=global_;
        for(const auto& cell:included){
            const auto bucket=cells_.find(cell);
            if(bucket!=cells_.end())roots.insert(roots.end(),bucket->second.begin(),bucket->second.end());
        }
        if(roots.size()==root_count_ || roots.empty())return whole(now);
        if(local_ && roots==selected_){
            if(!suitable(local_->terrain))return whole(now);
            return false;
        }
        std::optional<Region> next(std::in_place,source_->select_families(roots),vehicle_);
        if(next->terrain.empty() || !suitable(next->terrain)){
            next.reset();
            return whole(now);
        }
        next->world.copy_local_pose(vehicle_,world());
        local_=std::move(next);
        full_terrain_.reset();
        selected_=std::move(roots);
        return true;
    }catch(const std::bad_alloc&){
        active_windows_={};
        retry_after_=now+1.;
        return whole(now);
    }
}

void ActiveScene::reduce_memory(){
    trim_requested_=true;
    foot_.previous.reset();car_.previous.reset();
}
void ActiveScene::suspend(){
    if(local_){
        source_->copy_local_pose(vehicle_,local_->world);
        local_.reset();
    }
    std::vector<EntityId>{}.swap(selected_);
    foot_={};car_={};active_windows_={};retry_after_=0.;
}
}
