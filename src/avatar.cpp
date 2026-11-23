#include "mundo/avatar.hpp"
#include <algorithm>
#include <cmath>
#include <numbers>

namespace mundo {
namespace {
using Color=std::array<float,3>;
constexpr Color local_jacket{.035f,.34f,.34f}, peer_jacket{.54f,.18f,.055f}, npc_jacket{.24f,.15f,.52f}, trousers{.035f,.07f,.14f}, skin{.63f,.34f,.18f},
                boots{.035f,.038f,.046f}, trim{.92f,.32f,.10f}, hair{.072f,.043f,.034f};
constexpr double pi=std::numbers::pi;
struct Joint { double x,y,z,angle; };
// Articulated limbs rotate around their attachment points, never around the mesh centers.
Joint offset(Joint parent,double x,double y,double z,double bend=0){
    const double c=std::cos(parent.angle),s=std::sin(parent.angle);
    return {parent.x+x,parent.y+c*y-s*z,parent.z+s*y+c*z,parent.angle+bend};
}
}
void BlockAvatar::reset(){*this=BlockAvatar{};}
void BlockAvatar::advance(const CharacterController& controller,double elapsed,double yaw){
    const auto eye=controller.eye();
    const Vec3 feet{eye.x,eye.y-1.58,eye.z};
    const double dt=std::clamp(elapsed,0.,.125);
    const double vy=dt>0?(feet.y-feet_.y)/dt:0;
    advance_pose(feet,controller.grounded(),vy,dt,yaw);
}
void BlockAvatar::advance_pose(Vec3 next,bool grounded,double vertical_speed,double elapsed,double yaw){
    if(seated_)reset();
    const double delta=std::hypot(next.x-feet_.x,next.z-feet_.z);
    const double dt=std::clamp(elapsed,0.,.125);
    if(!initialized_ || delta>2 || std::abs(next.y-feet_.y)>2){
        reset();initialized_=true; heading_=yaw;
    }else if(dt>0){
        const double mix=-std::expm1(-12*dt);
        const double speed=std::min(delta/dt,8.);
        speed_+=(speed-speed_)*mix;
        if(grounded)phase_=std::remainder(phase_+delta*(speed_>5?3.6:4.8),2*pi);
        air_+=((grounded?0.:1.)-air_)*mix;
        upward_+=(std::clamp(vertical_speed/5.5,-1.,1.)-upward_)*mix;
        const double target=delta>1e-7?std::atan2(next.x-feet_.x,feet_.z-next.z):yaw;
        heading_+=std::remainder(target-heading_,2*pi)*mix;
        heading_=std::remainder(heading_,2*pi);
    }
    feet_=next;
}
void BlockAvatar::sit(Vec3 hip,double yaw){
    feet_={hip.x,hip.y-.78,hip.z};
    heading_=yaw; speed_=air_=upward_=phase_=0;
    initialized_=seated_=true;
}
void BlockAvatar::append(std::vector<DrawItem>& out,Vec3 origin) const {
    append(out,origin,AvatarStyle::local);
}
void BlockAvatar::append(std::vector<DrawItem>& out,Vec3 origin,AvatarStyle style) const {
    if(!initialized_)return;
    const auto& jacket=style==AvatarStyle::npc?npc_jacket:(style==AvatarStyle::peer?peer_jacket:local_jacket);
    const double cy=std::cos(heading_),sy=std::sin(heading_);
    const Vec3 relative{feet_.x-origin.x,feet_.y-origin.y,feet_.z-origin.z};
    EntityId part=0;
    auto box=[&](Joint center,Vec3 scale,Color color){
        const double cx=std::cos(center.angle),sx=std::sin(center.angle);
        // Local forward is -Z; positive heading turns toward world +X.
        Matrix m{cy*scale.x,0,sy*scale.x,0,
            -sy*sx*scale.y,cx*scale.y,cy*sx*scale.y,0,
            -sy*cx*scale.z,-sx*scale.z,cy*cx*scale.z,0,
            relative.x+cy*center.x-sy*center.z,relative.y+center.y,
            relative.z+sy*center.x+cy*center.z,1};
        DrawItem item{++part,Shape::box,{color,.72f,.02f},{},0};
        std::transform(m.begin(),m.end(),item.model.begin(),[](double n){return static_cast<float>(n);});
        out.push_back(item);
    };
    const double stride=std::clamp(speed_/7.,0.,1.)*(1-air_);
    const double swing=std::sin(phase_)*stride;
    const double bob=.029*stride*std::abs(std::cos(phase_));
    Joint hip{0,.78+bob,0,0};
    auto chest=offset(hip,0,.29,0,-.10*stride);
    box(chest,{.42,.53,.25},jacket);
    box(offset(chest,0,.13,.132),{.26,.052,.018},trim);
    auto head=offset(hip,0,.70,0);
    box(head,{.32,.32,.31},skin);
    box(offset(head,0,.15,.015),{.335,.09,.33},hair);
    for(int side:{-1,1}){
        box(offset(head,.076*side,.01,-.157),{.032,.033,.012},boots);
        auto thigh=offset(hip,.112*side,0,0,seated_?1.45:.76*swing*side+air_*(side>0?.54:.18));
        box(offset(thigh,0,-.175,0),{.18,.35,.19},trousers);
        auto knee=offset(thigh,0,-.35,0,seated_?-1.5:-.75*std::max(0.,side*swing)-air_*(.5+.24*upward_));
        box(offset(knee,0,-.16,0),{.155,.32,.16},trousers);
        box(offset(knee,0,-.367,-.028),{.18,.11,.245},boots);
        auto shoulder=offset(chest,.277*side,.17,0,seated_?.55:-.86*swing*side+.58*air_);
        box(offset(shoulder,0,-.115,0),{.138,.23,.17},jacket);
        auto elbow=offset(shoulder,0,-.23,0,.18+.5*stride+.45*air_);
        box(offset(elbow,0,-.128,0),{.12,.255,.14},skin);
    }
}
bool follow_avatar(CameraPose& camera,const CharacterTerrain& terrain,double distance,
                   const CollisionBounds* moving_obstacle){
    const Vec3 pivot{camera.eye.x,camera.eye.y-.31,camera.eye.z};
    const Vec3 aim{camera.forward.x,camera.forward.y-.18,camera.forward.z};
    const double n=std::hypot(aim.x,aim.y,aim.z);
    if(!(n>0))return false;
    std::array<double,3> start{pivot.x,pivot.y,pivot.z},dir{-aim.x/n,-aim.y/n,-aim.z/n};
    double reach=distance;
    CollisionBounds swept;
    // Pad the boom sweep to keep the near plane away from nearby solid pieces.
    constexpr double padding=.19;
    for(unsigned i=0;i<3;++i){
        double end=start[i]+dir[i]*reach;
        swept.low[i]=std::min(start[i],end)-padding;swept.high[i]=std::max(start[i],end)+padding;
    }
    auto limit_reach=[&](const CollisionBounds& b){
        double enter=0,exit=reach;
        for(unsigned i=0;i<3;++i){
            double lo=b.low[i]-padding-start[i],hi=b.high[i]+padding-start[i];
            if(std::abs(dir[i])<1e-9){if(lo>0||hi<0)return;continue;}
            double t0=lo/dir[i],t1=hi/dir[i];
            if(t0>t1)std::swap(t0,t1);
            enter=std::max(enter,t0);exit=std::min(exit,t1);
            if(enter>exit)return;
        }
        reach=std::min(reach,std::max(0.,enter-.035));
    };
    terrain.visit(swept,limit_reach);
    if(moving_obstacle)limit_reach(*moving_obstacle);
    if(reach<.7)return false;
    camera.eye={pivot.x+reach*dir[0],pivot.y+reach*dir[1],pivot.z+reach*dir[2]};
    camera.forward={-dir[0],-dir[1],-dir[2]};
    return true;
}
}
