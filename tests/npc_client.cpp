#include "mundo/room_view.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>

using Bytes=std::vector<std::byte>;
using namespace mundo;
using namespace mundo::room;

static void check(bool value, const char* description) {
    if (!value) throw std::runtime_error(description);
}
static void integer(Bytes& out, std::uint64_t value, unsigned width) {
    for(unsigned i=0;i<width;++i) out.push_back(std::byte((value>>(i*8))&255));
}
static void magic(Bytes& out, std::string_view name){
    for(char c:name)out.push_back(std::byte(c));
}
static void number(Bytes& out,double value){integer(out,std::bit_cast<std::uint64_t>(value),8);}
static Bytes legacy(){
    Bytes out;
    magic(out,"MWS3");integer(out,1,1);integer(out,1,8);
    integer(out,0,1);integer(out,1,1);
    for(double d:{1.,2.,3.,0.,0.})number(out,d);
    integer(out,0,1);
    return out;
}
static Bytes wrap(const Bytes& base, std::vector<std::uint64_t> ids={1,UINT64_MAX}){
    Bytes out;
    magic(out,"MWN1");integer(out,base.size(),2);out.insert(out.end(),base.begin(),base.end());integer(out,ids.size(),1);
    for(auto id:ids){
        integer(out,id,8);for(double n:{1.,2.,3.,.5})number(out,n);integer(out,2,1);
    }
    return out;
}
static double first_x(const View& view){
    std::vector<DrawItem> parts;
    auto npcs=view.npc_avatars();
    check(npcs[0]!=nullptr,"missing expected NPC rig");
    npcs[0]->append(parts,{},AvatarStyle::npc);
    check(!parts.empty(),"missing articulated NPC draw items");
    return parts.front().model[12];
}
int main(int argc,char** argv){
    const auto base=legacy();
    check(read_snapshot(base)->npcs.empty(),"legacy state");
    const auto wire=wrap(base);
    auto snapshot=read_snapshot(wire);
    check(snapshot && snapshot->npcs.size()==2 && snapshot->players.size()==1 && snapshot->npcs[1].id==UINT64_MAX &&
          snapshot->npcs[0].state==NpcState::follow,"unsigned identity and state");
    for(std::size_t i=0;i<wire.size();++i)
        check(!read_snapshot(std::span(wire).first(i)),"truncated packet accepted");
    for(const auto& ids:std::vector<std::vector<std::uint64_t>>{{0},{1,1},{},{1,2,3,4,5,6,7,8,9}})
        check(!read_snapshot(wrap(base,ids)),"bad count or duplicate identity");
    check(!read_snapshot(wrap(wire)),"nested packet");
    auto invalid=wire;invalid.back()=std::byte{6};
    check(!read_snapshot(invalid),"bad state accepted");
    invalid=wire;
    const auto yaw=std::bit_cast<std::uint64_t>(std::numeric_limits<double>::infinity());
    for(unsigned i=0;i<8;++i) invalid[invalid.size()-9+i]=std::byte((yaw>>(8*i))&255);
    check(!read_snapshot(invalid),"nonfinite yaw accepted");
    invalid=wire;invalid.push_back(std::byte{0});check(!read_snapshot(invalid),"trailing bytes");
    View view;
    view.accept(*snapshot,0,1);
    check(view.peer_avatar()==nullptr && view.local_avatar()!=nullptr,"NPC took a player seat");
    const double x=first_x(view);
    snapshot->ack=2;snapshot->npcs[0].feet.x+=1.;
    view.accept(*snapshot,0,1.1);
    view.advance(1.15,.05);
    check(std::abs(first_x(view)-x-.5)<1e-4,"interpolation");
    view.advance(9.,.05);
    check(std::abs(first_x(view)-x-1)<1e-4,"extrapolation");
    snapshot->ack=3;snapshot->npcs.clear();
    view.accept(*snapshot,0,10);
    for(const auto* avatar:view.npc_avatars())check(!avatar,"removed NPC still present");
    if(argc==2){
        std::ifstream input(argv[1],std::ios::binary);
        const std::string data((std::istreambuf_iterator<char>(input)),std::istreambuf_iterator<char>());
        auto received=read_snapshot(std::as_bytes(std::span(data)));
        check(received && received->npcs.size()==1 && received->npcs[0].id==UINT64_MAX &&
              received->npcs[0].state==NpcState::patrol && received->npcs[0].feet.x==.5 &&
              received->npcs[0].feet.y==1. && received->npcs[0].feet.z==.25 && received->npcs[0].yaw==-.5,
              "real server payload incompatible");
    }
    std::cout<<"NPC frames, bounded decoding, seat isolation and presentation passed\n";
}
