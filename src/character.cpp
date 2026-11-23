#include "mundo/character.hpp"
#include <algorithm>
#include <cmath>

namespace mundo {
namespace {
using Position = std::array<double,3>;
constexpr double radius=.28, height=1.68, step_height=.26, dt=1.0/120;
CollisionBounds body(const Position& p) {
    return {{p[0]-radius,p[1],p[2]-radius},{p[0]+radius,p[1]+height,p[2]+radius}};
}
bool overlaps(const CollisionBounds& a, const CollisionBounds& b) {
    for(unsigned i=0;i<3;++i) if(a.low[i]>b.high[i] || a.high[i]<b.low[i])return false;
    return true;
}
// Sweep a single axis across the whole requested displacement, including paper-thin colliders.
double travel(const CharacterTerrain& terrain, const Position& p, unsigned axis, double delta) {
    if(delta==0)return 0;
    auto start=body(p), swept=start;
    swept.high[axis]+=std::max(0.,delta);
    swept.low[axis]+=std::min(0.,delta);
    double allowed=delta;
    terrain.visit(swept,[&](const CollisionBounds& box){
        for(unsigned i=0;i<3;++i) if(i!=axis &&
            (start.low[i]>=box.high[i]-1e-8 || start.high[i]<=box.low[i]+1e-8))return;
        if(delta>0 && start.high[axis]<=box.low[axis]+1e-8)
            allowed=std::min(allowed,std::max(0.,box.low[axis]-start.high[axis]));
        if(delta<0 && start.low[axis]>=box.high[axis]-1e-8)
            allowed=std::max(allowed,std::min(0.,box.high[axis]-start.low[axis]));
    });
    if(terrain.empty() && axis==1 && delta<0)allowed=std::max(allowed,-std::max(0.,p[1]));
    return allowed;
}
void horizontal(const CharacterTerrain& terrain, Position& p, unsigned axis, double delta, bool grounded) {
    const double normal=travel(terrain,p,axis,delta);
    if(grounded && std::abs(normal)+1e-8<std::abs(delta)){
        Position raised=p;
        raised[1]+=travel(terrain,p,1,step_height);
        const double stepped=travel(terrain,raised,axis,delta);
        if(std::abs(stepped)>std::abs(normal)+1e-8){
            raised[axis]+=stepped;
            raised[1]+=travel(terrain,raised,1,p[1]-raised[1]-.002);
            p=raised;
            return;
        }
    }
    p[axis]+=normal;
}
}

CharacterTerrain::CharacterTerrain(const World& world,EntityId excluded):boxes_(world.static_collision_bounds(excluded)){
    if(!boxes_.empty())build(0,static_cast<unsigned>(boxes_.size()));
}
unsigned CharacterTerrain::build(unsigned start,unsigned end){
    const unsigned index=static_cast<unsigned>(tree_.size());
    auto bounds=boxes_[start];
    for(unsigned i=start+1;i<end;++i)for(unsigned axis=0;axis<3;++axis){
        bounds.low[axis]=std::min(bounds.low[axis],boxes_[i].low[axis]);
        bounds.high[axis]=std::max(bounds.high[axis],boxes_[i].high[axis]);
    }
    tree_.push_back({bounds,start,end});
    if(end-start>8){
        unsigned axis=0;
        for(unsigned i=1;i<3;++i)if(bounds.high[i]-bounds.low[i]>bounds.high[axis]-bounds.low[axis])axis=i;
        unsigned mid=start+(end-start)/2;
        std::nth_element(boxes_.begin()+start,boxes_.begin()+mid,boxes_.begin()+end,[axis](auto& a,auto& b){
            return a.low[axis]+a.high[axis]<b.low[axis]+b.high[axis];
        });
        const unsigned left=build(start,mid),right=build(mid,end);
        tree_[index].left=left;tree_[index].right=right;
    }
    return index;
}
void CharacterTerrain::visit(const CollisionBounds& query,const std::function<void(const CollisionBounds&)>& fn) const{
    if(tree_.empty())return;
    // Median splits and max_entities (65,536) bound the traversal depth below 32.
    std::array<unsigned,32> stack{};
    unsigned count=1;
    while(count){
        const auto& b=tree_[stack[--count]];
        if(!overlaps(b.bounds,query))continue;
        if(b.left){stack[count++]=b.left;stack[count++]=b.right;}
        else for(unsigned i=b.start;i<b.end;++i)if(overlaps(boxes_[i],query))fn(boxes_[i]);
    }
}
double CharacterTerrain::lowest() const {return tree_.empty()?0.:tree_.front().bounds.low[1];}
void CharacterController::spawn(const CharacterTerrain& terrain,Vec3 pos){
    if(!std::isfinite(pos.x)||!std::isfinite(pos.y)||!std::isfinite(pos.z))pos={};
    Position p{pos.x,pos.y,pos.z};
    auto column=body(p);column.low[1]=-1e15;column.high[1]=1e15;
    std::vector<CollisionBounds> candidates;
    terrain.visit(column,[&](const auto& box){candidates.push_back(box);});
    if(candidates.empty() && !terrain.empty()){
        // An imported object can be narrower than the preferred camera offset.
        terrain.visit({{-1e15,-1e15,-1e15},{1e15,1e15,1e15}},[&](const auto& box){
            if(candidates.empty())candidates.push_back(box);
        });
        auto box=candidates.front();
        p={(box.low[0]+box.high[0])*.5,box.high[1],(box.low[2]+box.high[2])*.5};
        candidates.clear();column=body(p);column.low[1]=-1e15;column.high[1]=1e15;
        terrain.visit(column,[&](const auto& b){candidates.push_back(b);});
    }
    std::sort(candidates.begin(),candidates.end(),[](const auto& a,const auto& b){return a.low[1]<b.low[1];});
    std::optional<double> support;
    for(const auto& box:candidates) {
        if(box.high[1]<=p[1]) support=std::max(support.value_or(box.high[1]),box.high[1]);
    }
    p[1]=support.value_or(candidates.empty()?0.:candidates.front().high[1]);
    // Resolve overhead solids also when spawning beneath a raised platform.
    for(const auto& b:candidates)if(b.low[1]<p[1]+height && b.high[1]>p[1])p[1]=b.high[1];
    spawn_=feet_=previous_=p;
    remainder_=velocity_y_=0;grounded_=true;jump_=false;
}
bool CharacterController::start_at(const CharacterTerrain& terrain,Vec3 pos){
    auto placed=*this;
    if(!placed.resume_at(terrain,pos) || !placed.grounded_)return false;
    placed.spawn_=placed.feet_;
    *this=placed;
    return true;
}
bool CharacterController::resume_at(const CharacterTerrain& terrain,Vec3 pos){
    Position next{pos.x,pos.y,pos.z};
    for(double n:next)if(!std::isfinite(n)||std::abs(n)>1e15)return false;
    if(pos.y<terrain.lowest()-25 || (terrain.empty() && pos.y<0))return false;
    const auto occupied=body(next);
    bool clear=true;
    terrain.visit(occupied,[&](const CollisionBounds& solid){
        for(unsigned i=0;i<3;++i)if(occupied.low[i]>=solid.high[i]-1e-8 ||
            occupied.high[i]<=solid.low[i]+1e-8)return;
        clear=false;
    });
    if(!clear)return false;
    feet_=previous_=next;velocity_y_=remainder_=0;jump_=false;
    grounded_=travel(terrain,next,1,-.002)>-.002;
    return true;
}
void CharacterController::advance(const CharacterTerrain& terrain,double seconds,WalkInput input){
    advance_until(terrain,seconds,input,{});
}
void CharacterController::advance_until(const CharacterTerrain& terrain,double seconds,WalkInput input,
                                       const StopAfterStep& stop){
    if(!std::isfinite(seconds)||seconds<0||!std::isfinite(input.x)||!std::isfinite(input.z))return;
    remainder_+=std::min(seconds,.125);
    jump_|=input.jump_pressed;
    const double speed=(input.sprint?7.2:4.2)*dt/std::max(1.,std::hypot(input.x,input.z));
    while(remainder_>=dt){
        remainder_-=dt;previous_=feet_;
        if(jump_ && grounded_){velocity_y_=5.5;grounded_=false;}
        jump_=false;
        horizontal(terrain,feet_,0,input.x*speed,grounded_);
        horizontal(terrain,feet_,2,input.z*speed,grounded_);
        velocity_y_=std::max(-28.,velocity_y_-15*dt);
        const double wanted=velocity_y_*dt,actual=travel(terrain,feet_,1,wanted);
        feet_[1]+=actual;
        grounded_=wanted<0 && actual>wanted;
        if(actual!=wanted)velocity_y_=0;
        const bool respawned=feet_[1]<terrain.lowest()-25;
        if(respawned){feet_=previous_=spawn_;velocity_y_=0;grounded_=true;}
        if(stop && stop(*this,respawned)){previous_=feet_;remainder_=0;break;}
    }
}
Vec3 CharacterController::eye() const{
    const double t=remainder_/dt;
    return {std::lerp(previous_[0],feet_[0],t),std::lerp(previous_[1],feet_[1],t)+1.58,
            std::lerp(previous_[2],feet_[2],t)};
}
}
