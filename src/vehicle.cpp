#include "mundo/vehicle.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <numbers>
#include <utility>
#include <string_view>

namespace mundo {
namespace {
constexpr double tolerance=.035;
constexpr double step=1./90;
constexpr std::array<std::string_view,4> wheels{"Rueda delantera izquierda","Rueda delantera derecha",
    "Rueda trasera izquierda","Rueda trasera derecha"};

VisualKey workshop_slot(const Node& node,int& axle){
    constexpr std::array<std::string_view,4> sides{"delantera izquierda","delantera derecha",
        "trasera izquierda","trasera derecha"};
    const std::string_view name=node.name;
    axle=-1;
    if(node.shape==Shape::cylinder){
        for(int i=0;i<4;++i){
            if(name==wheels[i]){axle=i;return 42007;}
            if(name.starts_with("Llanta ")&&name.substr(7)==sides[i]){axle=i;return 42008;}
        }
    }
    if(node.shape!=Shape::box)return 0;
    if(name=="Chasis")return 42001;
    if(name=="Carrocería")return 42002;
    if(name=="Cabina")return 42003;
    if(name=="Techo")return 42004;
    if(name=="Parachoques delantero"||name=="Parachoques trasero")return 42005;
    if(name.starts_with("Luz ")&&std::find(sides.begin(),sides.end(),name.substr(4))!=sides.end())return 42006;
    return 0;
}

VisualKey bruma_slot(VisualKey workshop,int axle){
    switch(workshop){
        case 42001:return 45101;
        case 42002:return 45102;
        case 42007:return axle%2==0?45103:45104;
        case 42008:return axle%2==0?45105:45106;
        default:return 0;
    }
}

bool clear_path(const CharacterTerrain& terrain,Vec3 a,Vec3 b){
    const std::array<double,3> start{a.x,a.y,a.z},end{b.x,b.y,b.z};
    CollisionBounds region;
    constexpr double margin=.12;
    for(unsigned i=0;i<3;++i){
        region.low[i]=std::min(start[i],end[i])-margin;
        region.high[i]=std::max(start[i],end[i])+margin;
    }
    bool clear=true;
    terrain.visit(region,[&](const auto& box){
        double enter=0,leave=1;
        for(unsigned i=0;i<3;++i){
            double d=end[i]-start[i],lo=box.low[i]-margin-start[i],hi=box.high[i]+margin-start[i];
            if(std::abs(d)<1e-10){if(lo>0||hi<0)return;continue;}
            double u=lo/d,v=hi/d;
            enter=std::max(enter,std::min(u,v));leave=std::min(leave,std::max(u,v));
            if(enter>leave)return;
        }
        clear=false;
    });
    return clear;
}
}

bool VehicleSession::discover(const World& world,std::optional<EntityId> selection){
    cars_.clear();parts_.clear();active_.reset();speed_=steer_=remainder_=0;
    std::map<EntityId,std::vector<const Node*>> children;
    for(const auto& [id,node]:world.nodes())children[node.parent].push_back(&node);
    for(const auto& [id,parts]:children){
        if(selection && *selection!=root_id && *selection!=id)continue;
        auto root=world.get(id);
        if(!root||root->shape!=Shape::empty||root->visual||parts.size()<6||parts.size()>128)continue;
        std::map<std::string_view,const Node*> names;
        bool eligible=true;
        for(auto n:parts){
            if(n->visual||n->shape==Shape::empty||children.contains(n->id)||!names.emplace(n->name,n).second){eligible=false;break;}
        }
        auto shape=[&](std::string_view name,Shape type){
            auto it=names.find(name);return it!=names.end()&&it->second->shape==type;
        };
        if(!eligible||!shape("Chasis",Shape::box)||!shape("Carrocer\xc3\xad" "a",Shape::box)||
           !std::all_of(wheels.begin(),wheels.end(),[&](auto name){return shape(name,Shape::cylinder);}))continue;
        Car car;car.root=id;car.parent=world.transform_matrix(root->parent);
        auto m=world.transform_matrix(id);const auto& p=car.parent;
        if(selection && (m[5]<=0 ||
           std::max({std::abs(m[1]),std::abs(m[4]),std::abs(m[6]),std::abs(m[9])})>1e-5 ||
           m[0]*m[10]-m[2]*m[8]<=0 || std::abs(m[0]*m[8]+m[2]*m[10])>1e-4 ||
           std::max({std::abs(m[12]),std::abs(m[13]),std::abs(m[14])})>1e7))continue;
        // The parent must have an invertible upright similarity in XZ to express world yaw locally.
        if(!std::all_of(p.begin(),p.end(),[](double v){return std::isfinite(v);})||
           !(p[5]>0&&std::hypot(p[0],p[2])>1e-6)||
           std::max({std::abs(p[0]-p[10]),std::abs(p[2]+p[8]),std::abs(p[1]),std::abs(p[4]),std::abs(p[6]),std::abs(p[9])})>1e-7||
           std::abs(root->local.rotation.x)+std::abs(root->local.rotation.z)>1e-8)continue;
        car.x=m[12];car.z=m[14];car.origin=root->local.position;
        car.yaw=std::atan2(-m[8],m[10]);const double c=std::cos(car.yaw),s=std::sin(car.yaw);
        car.base=std::numeric_limits<double>::infinity();car.top=-car.base;
        for(auto n:parts){
            auto v=world.transform_matrix(n->id);
            if(!std::all_of(v.begin(),v.end(),[](double f){return std::isfinite(f)&&std::abs(f)<=1e9;})){eligible=false;break;}
            double dx=v[12]-car.x,dz=v[14]-car.z;
            double side=c*dx+s*dz,along=-s*dx+c*dz,wx=0,wz=0,wy=0;
            for(unsigned k:{0u,4u,8u}){
                wx+=.5*std::abs(c*v[k]+s*v[k+2]);wz+=.5*std::abs(-s*v[k]+c*v[k+2]);wy+=.5*std::abs(v[k+1]);
            }
            car.width=std::max(car.width,std::abs(side)+wx);car.length=std::max(car.length,std::abs(along)+wz);
            car.base=std::min(car.base,v[13]-wy);car.top=std::max(car.top,v[13]+wy);
            auto wheel=std::find(wheels.begin(),wheels.end(),n->name);
            if(wheel!=wheels.end()){
                auto i=wheel-wheels.begin();
                car.contacts[i]={side,v[13]-wy,along};
                car.radius[i]=.5*std::hypot(v[0],v[1],v[2]);
            }
        }
        car.wheelbase=std::abs(car.contacts[2].z-car.contacts[0].z);
        if(eligible&&car.width>=.4&&car.width<=4&&car.length>=1&&car.length<=8&&car.top-car.base<=5&&
           car.wheelbase>=.6&&car.wheelbase<=12&&std::all_of(car.contacts.begin(),car.contacts.end(),
           [&](Vec3 point){return std::abs(point.y-car.base)<=tolerance;})){
            const bool bruma=root->name=="Bruma \xc2\xb7 Serie 1" && parts.size()==10 &&
                std::all_of(parts.begin(),parts.end(),[](const Node* n){
                    int axle;
                    const auto workshop=workshop_slot(*n,axle);
                    return bruma_slot(workshop,axle)!=0;
                });
            if(bruma){
                // Read the canonical seat anchors through the body's complete authored transform.
                // Parent rotation/scale and floor height carry across to a moving network replica.
                const auto body=world.transform_matrix(names.at("Carrocer\xc3\xad" "a")->id);
                std::array<Vec3,2> offsets;
                constexpr double y=(.50-.745)/1.10,z=.10/3.76;
                for(unsigned i=0;i<offsets.size();++i){
                    const double x=(i==0?-.38:.38)/1.80;
                    const double dx=body[0]*x+body[4]*y+body[8]*z+body[12]-car.x;
                    const double dz=body[2]*x+body[6]*y+body[10]*z+body[14]-car.z;
                    offsets[i]={c*dx+s*dz,body[1]*x+body[5]*y+body[9]*z+body[13]-car.base,-s*dx+c*dz};
                }
                car.seat_offsets=offsets;
            }
            for(auto n:parts){
                int axle;
                if(auto workshop=workshop_slot(*n,axle)){
                    const auto slot=bruma?bruma_slot(workshop,axle):workshop;
                    parts_.emplace(n->id,Part{cars_.size(),slot,axle});
                }
            }
            cars_.push_back(car);
            if(selection)return true;
        }
    }
    return !selection || *selection==root_id;
}

bool VehicleSession::first_car_blocks(const CollisionBounds& b) const {
    if(cars_.empty())return false;
    const auto& car=cars_.front();
    if(b.low[1]>=car.top || b.high[1]<=car.base)return false;
    const double c=std::cos(car.yaw),s=std::sin(car.yaw);
    const double hx=(b.high[0]-b.low[0])*.5,hz=(b.high[2]-b.low[2])*.5;
    const double dx=b.low[0]+hx-car.x,dz=b.low[2]+hz-car.z;
    return std::abs(dx)<std::abs(c)*car.width+std::abs(s)*car.length+hx &&
           std::abs(dz)<std::abs(s)*car.width+std::abs(c)*car.length+hz &&
           std::abs(c*dx+s*dz)<car.width+std::abs(c)*hx+std::abs(s)*hz &&
           std::abs(-s*dx+c*dz)<car.length+std::abs(s)*hx+std::abs(c)*hz;
}

VisualKey VehicleSession::prepare_draw(DrawItem& item)const{
    auto it=parts_.find(item.id);
    if(it==parts_.end())return 0;
    const auto& part=it->second;
    if(part.axle<0)return part.slot;
    const auto& car=cars_[part.car];
    const double roll=car.roll[part.axle],steer=part.axle<2?car.steering:0.;
    auto& m=item.model;
    if(steer!=0){
        const double c=std::cos(steer),s=std::sin(steer);
        for(unsigned i:{0u,4u,8u}){
            const auto x=m[i],z=m[i+2];
            m[i]=static_cast<float>(c*x-s*z);m[i+2]=static_cast<float>(s*x+c*z);
        }
    }
    if(roll!=0){
        const double c=std::cos(roll),s=std::sin(roll);
        for(unsigned i=0;i<3;++i){
            const auto x=m[i],z=m[8+i];
            m[i]=static_cast<float>(c*x-s*z);m[8+i]=static_cast<float>(s*x+c*z);
        }
    }
    return part.slot;
}

bool VehicleSession::supported(const Car& car,const CharacterTerrain& terrain,double x,double z,double yaw){
    const double c=std::cos(yaw),s=std::sin(yaw),w=car.width+.04,l=car.length+.04;
    double rx=std::abs(c)*w+std::abs(s)*l,rz=std::abs(s)*w+std::abs(c)*l;
    unsigned contacts=0;bool blocked=false;
    terrain.visit({{x-rx,car.base-tolerance,z-rz},{x+rx,car.top,z+rz}},[&](const auto& b){
        if(std::abs(b.high[1]-car.base)<=tolerance){
            for(unsigned i=0;i<4;++i){
                auto p=car.contacts[i];double px=x+c*p.x-s*p.z,pz=z+s*p.x+c*p.z;
                if(px>=b.low[0]&&px<=b.high[0]&&pz>=b.low[2]&&pz<=b.high[2])contacts|=1u<<i;
            }
        }
        if(b.high[1]<=car.base+tolerance||b.low[1]>=car.top)return;
        double hx=(b.high[0]-b.low[0])*.5,hz=(b.high[2]-b.low[2])*.5;
        double dx=b.low[0]+hx-x,dz=b.low[2]+hz-z;
        if(std::abs(c*dx+s*dz)<w+std::abs(c)*hx+std::abs(s)*hz&&
           std::abs(-s*dx+c*dz)<l+std::abs(s)*hx+std::abs(c)*hz)blocked=true;
    });
    return !blocked&&contacts==15;
}
double VehicleSession::heading() const{return active_?cars_[*active_].yaw:0.;}
bool VehicleSession::replica_supported(const CharacterTerrain& terrain,double x,double z,double yaw) const{
    return active_ && supported(cars_[*active_],terrain,x,z,yaw);
}

bool VehicleSession::select_replica(EntityId root){
    // Discovery visits root IDs in ascending order.
    const auto it=std::lower_bound(cars_.begin(),cars_.end(),root,
        [](const Car& car,EntityId id){return car.root<id;});
    if(it==cars_.end()||it->root!=root)return false;
    active_=static_cast<std::size_t>(it-cars_.begin());
    return true;
}

std::optional<CollisionBounds> VehicleSession::active_bounds()const{
    if(!active_)return std::nullopt;
    const auto& car=cars_[*active_];
    const double c=std::abs(std::cos(car.yaw)),s=std::abs(std::sin(car.yaw));
    const double rx=c*car.width+s*car.length,rz=s*car.width+c*car.length;
    return CollisionBounds{{car.x-rx,car.base,car.z-rz},{car.x+rx,car.top,car.z+rz}};
}

bool VehicleSession::write_chassis(World& world,const Car& car){
    const Node* root=world.get(car.root);
    if(!root)return false;
    Node node=*root;
    const auto& p=car.parent;
    const double dx=car.x-p[12],dz=car.z-p[14],norm=p[0]*p[0]+p[2]*p[2];
    const double angle=car.yaw-std::atan2(p[2],p[0]);
    node.local.position={(p[0]*dx+p[2]*dz)/norm,car.origin.y,(-p[2]*dx+p[0]*dz)/norm};
    node.local.rotation={0,-std::sin(angle*.5),0,std::cos(angle*.5)};
    return world.edit(node);
}

bool VehicleSession::apply_replica(World& world,double x,double z,double yaw,double steer,double distance){
    if(!active_||!std::isfinite(x)||!std::isfinite(z)||!std::isfinite(yaw)||
       !std::isfinite(steer)||!std::isfinite(distance))return false;
    auto& car=cars_[*active_];
    if(x!=car.x||z!=car.z||yaw!=car.yaw){
        const double old_x=car.x,old_z=car.z,old_yaw=car.yaw;
        car.x=x;car.z=z;car.yaw=yaw;
        if(!write_chassis(world,car)){
            car.x=old_x;car.z=old_z;car.yaw=old_yaw;
            return false;
        }
    }
    car.steering=steer;
    for(std::size_t i=0;i<car.roll.size();++i)
        car.roll[i]=std::remainder(distance/std::max(.001,car.radius[i]),2*std::numbers::pi);
    return true;
}

const char* VehicleSession::interact(World& world,std::optional<CharacterTerrain>& terrain,CharacterController& person){
    if(active_){
        if(std::abs(speed_)>.2)return "Frena antes de bajar del carro.";
        const auto& car=cars_[*active_];const double c=std::cos(car.yaw),s=std::sin(car.yaw);
        CharacterTerrain parked(world);
        for(double extra:{.55,1.05,1.55}){
            double w=car.width+extra,l=car.length+extra;
            for(Vec3 offset:std::array<Vec3,4>{{{-w,0,0},{w,0,0},{0,0,-l},{0,0,l}}}){
                Vec3 feet{car.x+c*offset.x-s*offset.z,car.base,car.z+s*offset.x+c*offset.z};
                std::optional<double> floor;
                parked.visit({{feet.x,feet.y-.27,feet.z},{feet.x,feet.y+.27,feet.z}},[&](const auto& b){
                    if(std::abs(b.high[1]-feet.y)<=.27)floor=std::max(floor.value_or(b.high[1]),b.high[1]);
                });
                if(!floor)continue;
                feet.y=*floor;
                if(clear_path(*terrain,{feet.x,feet.y+.85,feet.z},{car.x,(car.base+car.top)*.5,car.z})&&person.resume_at(parked,feet)){
                    terrain=std::move(parked);active_.reset();speed_=steer_=remainder_=0;return nullptr;
                }
            }
        }
        return "Busca un espacio libre para bajar.";
    }
    Vec3 feet=person.feet();double best=1.75;std::optional<std::size_t> nearest;
    for(std::size_t i=0;i<cars_.size();++i){
        const auto& car=cars_[i];const double c=std::cos(car.yaw),s=std::sin(car.yaw),dx=feet.x-car.x,dz=feet.z-car.z;
        if(feet.y<car.base-.35||feet.y>car.top+.35)continue;
        double d=std::hypot(std::max(0.,std::abs(c*dx+s*dz)-car.width),std::max(0.,std::abs(-s*dx+c*dz)-car.length));
        if(d<best){nearest=i;best=d;}
    }
    if(!nearest)return "Camina hasta un carro del taller.";
    const auto& car=cars_[*nearest];
    CharacterTerrain road(world,car.root);
    if(!supported(car,road,car.x,car.z,car.yaw)||!clear_path(road,{feet.x,feet.y+.85,feet.z},{car.x,(car.base+car.top)*.5,car.z}))
        return "El carro necesita suelo plano y un acceso despejado.";
    terrain=std::move(road);active_=nearest;steer_=car.steering;return nullptr;
}

void VehicleSession::advance(World& world,const CharacterTerrain& road,double elapsed,double throttle,double turn,bool brake){
    if(!active_||!std::isfinite(elapsed)||!std::isfinite(throttle)||!std::isfinite(turn))return;
    auto& car=cars_[*active_];
    const double initialX=car.x,initialZ=car.z,initialYaw=car.yaw;
    throttle=std::clamp(throttle,-1.,1.);turn=std::clamp(turn,-1.,1.);
    remainder_+=std::clamp(elapsed,0.,.125);
    double travelled=0;
    while(remainder_>=step){
        remainder_-=step;steer_+=std::clamp(.47*turn-steer_,-2*step,2*step);
        if(brake||std::abs(throttle)<.04||speed_*throttle<0){
            double drag=brake||speed_*throttle<0?13:2.5;
            speed_-=std::copysign(std::min(std::abs(speed_),drag*step),speed_);
        }else speed_=std::clamp(speed_+throttle*6*step,-4.,14.);
        double travel=speed_*step,angle=travel*std::tan(steer_)/car.wheelbase;
        if(travel==0)continue;
        double x=car.x+travel*std::sin(car.yaw+.5*angle),z=car.z-travel*std::cos(car.yaw+.5*angle);
        if(supported(car,road,x,z,car.yaw+angle)){car.x=x;car.z=z;car.yaw+=angle;travelled+=travel;}else speed_=0;
    }
    car.steering=steer_;
    if(initialX==car.x&&initialZ==car.z&&initialYaw==car.yaw)return;
    if(!write_chassis(world,car)){car.x=initialX;car.z=initialZ;car.yaw=initialYaw;speed_=0;return;}
    for(std::size_t i=0;i<car.roll.size();++i)
        car.roll[i]=std::remainder(car.roll[i]+travelled/std::max(.001,car.radius[i]),2*std::numbers::pi);
}
Vec3 VehicleSession::seat_hip(bool passenger) const{
    const auto& car=cars_.at(active_.value());
    if(car.seat_offsets){
        const auto seat=(*car.seat_offsets)[passenger?1:0];
        const double c=std::cos(car.yaw),s=std::sin(car.yaw);
        return {car.x+c*seat.x-s*seat.z,car.base+seat.y,car.z+s*seat.x+c*seat.z};
    }
    const double lateral=(passenger?1.:-1.)*.36*car.width;
    return {car.x+std::cos(car.yaw)*lateral, car.base+(car.top-car.base)*.48, car.z+std::sin(car.yaw)*lateral};
}
CameraPose VehicleSession::seat_camera(const CharacterTerrain& road,double orbit,double pitch,bool chase,bool passenger,bool& show_self) const{
    auto view=camera(road,orbit,pitch,false);
    const auto hip=seat_hip(passenger);
    view.eye.x=hip.x;view.eye.z=hip.z;
    show_self=chase && follow_avatar(view,road,cars_[*active_].length+4);
    return view;
}
CameraPose VehicleSession::camera(const CharacterTerrain& road,double orbit,double pitch,bool chase)const{
    CameraPose view;const auto& car=cars_.at(active_.value());double yaw=car.yaw+orbit;
    view.eye={car.x,car.top+.36,car.z};view.forward={std::sin(yaw)*std::cos(pitch),std::sin(pitch),-std::cos(yaw)*std::cos(pitch)};
    if(chase)follow_avatar(view,road,car.length+4);
    return view;
}
}
