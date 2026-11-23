#include "mundo/runtime.hpp"
#include <algorithm>
#include <cmath>
#include <numbers>

namespace mundo {
namespace {
using V3=std::array<float,3>;
V3 unit(V3 a){const auto d=std::hypot(a[0],a[1],a[2]);for(auto& value:a)value/=d;return a;}
void face(Mesh& m,V3 n,V3 a,V3 b,V3 c,V3 d){
    const auto first=static_cast<std::uint32_t>(m.vertices.size());
    for(const auto& p:{a,b,c,d})m.vertices.push_back({p,n});
    for(auto i:{0u,1u,2u,0u,2u,3u})m.indices.push_back(first+i);
}
}
bool valid_mesh(const Mesh& m){
    if(m.vertices.empty()||m.vertices.size()>1'000'000||m.indices.empty()||m.indices.size()>3'000'000||m.indices.size()%3)return false;
    for(const auto& v:m.vertices){
        for(auto n:v.position)if(!std::isfinite(n)||std::abs(n)>1e8f)return false;
        for(auto n:v.normal)if(!std::isfinite(n))return false;
        const auto l=std::hypot(v.normal[0],v.normal[1],v.normal[2]);if(l<0.99f||l>1.01f)return false;
    }
    return std::all_of(m.indices.begin(),m.indices.end(),[&](auto i){return i<m.vertices.size();});
}
Mesh primitive(Shape shape,unsigned segments){
    Mesh m;const auto n=std::clamp(segments,6u,128u);
    constexpr float h=.5f;
    if(shape==Shape::box){
        face(m,{0,0,1},{-h,-h,h},{h,-h,h},{h,h,h},{-h,h,h});
        face(m,{0,0,-1},{h,-h,-h},{-h,-h,-h},{-h,h,-h},{h,h,-h});
        face(m,{1,0,0},{h,-h,h},{h,-h,-h},{h,h,-h},{h,h,h});
        face(m,{-1,0,0},{-h,-h,-h},{-h,-h,h},{-h,h,h},{-h,h,-h});
        face(m,{0,1,0},{-h,h,h},{h,h,h},{h,h,-h},{-h,h,-h});
        face(m,{0,-1,0},{-h,-h,-h},{h,-h,-h},{h,-h,h},{-h,-h,h});
    }else if(shape==Shape::cylinder){
        for(unsigned i=0;i<n;++i){
            const float a=2*std::numbers::pi_v<float>*i/n,b=2*std::numbers::pi_v<float>*(i+1)/n;
            const float x=h*std::cos(a),z=h*std::sin(a),u=h*std::cos(b),v=h*std::sin(b);
            const auto start=static_cast<std::uint32_t>(m.vertices.size());
            for(auto y:{-h,h})for(auto pair:{V3{x,y,z},V3{u,y,v}})m.vertices.push_back({pair,unit({pair[0],0,pair[2]})});
            for(auto idx:{0u,2u,1u,1u,2u,3u})m.indices.push_back(start+idx);
            for(auto sign:{-1.f,1.f}){
                const auto cap=static_cast<std::uint32_t>(m.vertices.size());
                for(V3 p:{V3{0,sign*h,0},V3{x,sign*h,z},V3{u,sign*h,v}})m.vertices.push_back({p,{0,sign,0}});
                m.indices.insert(m.indices.end(),{cap,cap+(sign>0?2u:1u),cap+(sign>0?1u:2u)});
            }
        }
    }else if(shape==Shape::sphere){
        const auto rows=std::max(3u,n/2);
        for(unsigned row=0;row<=rows;++row){
            const float phi=std::numbers::pi_v<float>*row/rows;
            for(unsigned col=0;col<=n;++col){
                const float a=2*std::numbers::pi_v<float>*col/n;
                const V3 normal{std::sin(phi)*std::cos(a),std::cos(phi),std::sin(phi)*std::sin(a)};
                m.vertices.push_back({{normal[0]*h,normal[1]*h,normal[2]*h},normal});
            }
        }
        for(unsigned row=0;row<rows;++row)for(unsigned col=0;col<n;++col){
            auto a=row*(n+1)+col,b=a+n+1;
            if(row>0)m.indices.insert(m.indices.end(),{a,a+1,b});
            if(row+1<rows)m.indices.insert(m.indices.end(),{a+1,b+1,b});
        }
    }
    return m;
}
} // namespace mundo
