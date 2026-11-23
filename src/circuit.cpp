#include "mundo/circuit.hpp"
#include "valid_name.hpp"
#include <cmath>
#include <string_view>
#include <utility>

namespace mundo::room {
std::optional<CourseIndex> index_course(const World& world){
    constexpr std::string_view prefix="MUNDO/Circuito/v1/";
    std::array<std::optional<CircuitGate>,circuit_limit> ordered;
    for(const auto& [id,node]:world.nodes()){
        std::string_view name=node.name;
        if(node.parent!=root_id || !name.starts_with(prefix))continue;
        name.remove_prefix(prefix.size());
        if(name.size()<4 || name[0]<'0' || name[0]>'9' || name[1]<'0' || name[1]>'9' || name[2]!='/')return {};
        const unsigned slot=(name[0]-'0')*10+(name[1]-'0');
        const auto label=name.substr(3);
        const auto& t=node.local;
        if(slot==0 || slot>circuit_limit || ordered[slot-1] || node.shape!=Shape::empty || node.visual ||
           t.rotation.x!=0 || t.rotation.z!=0 || t.scale.z!=1 ||
           !(t.scale.x>=2 && t.scale.x<=48 && t.scale.y>=2 && t.scale.y<=20) ||
           !(std::abs(t.position.x)<=1e6 && std::abs(t.position.y)<=1e6 && std::abs(t.position.z)<=1e6) ||
           !valid_name(label,48) || label.front()==' ' || label.back()==' ')return {};
        ordered[slot-1]=CircuitGate{id,std::string(label),t.position};
    }
    CourseIndex index;
    for(auto& gate:ordered)if(gate)index.push_back(std::move(*gate));
    return index;
}
bool bind_course(CourseState& score,const CourseIndex& gates){
    if(score.total!=gates.size() || score.passed>gates.size())return false;
    if(score.passed==gates.size())return score.next==root_id;
    const auto& gate=gates[score.passed];
    if(gate.id!=score.next)return false;
    score.next_label=gate.label;score.target=gate.point;
    return true;
}
bool follows_course(const std::optional<CourseState>& previous,const std::optional<CourseState>& current){
    if(!previous)return true;
    if(!current || current->run<previous->run || current->total!=previous->total ||
       current->flying_start!=previous->flying_start ||
       (previous->best_ms && (!current->best_ms || *current->best_ms>*previous->best_ms)))return false;
    if(current->run!=previous->run)return true;
    if(current->passed<previous->passed || current->phase<previous->phase)return false;
    if(previous->at_ms && current->at_ms){
        if(*current->at_ms<*previous->at_ms)return false;
        if(current->passed==previous->passed && *current->at_ms!=*previous->at_ms)return false;
    }
    if(current->passed==previous->passed && previous->reference_ms && current->reference_ms &&
       current->reference_ms!=previous->reference_ms)return false;
    if(previous->phase==LapPhase::finished)return current->elapsed_ms==previous->elapsed_ms;
    // The finish is interpolated within a substep and may precede the last displayed clock reading.
    return current->phase==LapPhase::finished || current->elapsed_ms>=previous->elapsed_ms;
}
namespace {
std::string time_text(std::uint64_t ms){
    const auto seconds=(ms/1000)%60;
    const auto fraction=std::to_string(1000+ms%1000).substr(1);
    return std::to_string(ms/60000)+":"+(seconds<10?"0":"")+std::to_string(seconds)+","+fraction;
}
}
std::string course_caption(const std::optional<CourseState>& current){
    if(!current)return {};
    const auto& s=*current;
    std::string text="Vuelta "+std::to_string(s.run)+" · "+std::to_string(s.passed)+"/"+std::to_string(s.total);
    if(s.phase==LapPhase::finished)text+=" · Meta "+time_text(s.elapsed_ms);
    else if(s.flying_start && s.phase==LapPhase::ready)text+=" · Cruza "+s.next_label+" para iniciar";
    else text+=" · "+s.next_label;
    if(s.best_ms)text+=" · Mejor "+time_text(*s.best_ms);
    if(s.at_ms){
        text+=" · Puerta "+std::to_string(s.passed)+" · "+time_text(*s.at_ms);
        if(!s.reference_ms)text+=" · sin referencia";
        else if(*s.at_ms==*s.reference_ms)text+=" · igual";
        else if(*s.at_ms<*s.reference_ms)text+=" · −"+time_text(*s.reference_ms-*s.at_ms)+" de ventaja";
        else text+=" · +"+time_text(*s.at_ms-*s.reference_ms)+" de retraso";
    }
    return text;
}
}
