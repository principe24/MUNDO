#include "session.hpp"
#include "checkpoint.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <utility>
namespace mundo::mobile {
namespace {
#ifndef MUNDO_MOBILE_ROOMS
const unsigned char start_world[]={
#include "mobile_start_world.inc"
};
#endif
#ifdef MUNDO_OWNER_VEHICLE_ART
const unsigned char touring_art[]={
#include "mobile_touring_art.inc"
};
const unsigned char bruma_art[]={
#include "mobile_bruma_art.inc"
};
#endif
const unsigned char material[]={
#include "mobile_material.inc"
};
}
#ifdef MUNDO_MOBILE_ROOMS
Session::Session() = default;
#else
Session::Session(){
    const auto bytes=std::as_bytes(std::span(start_world));auto world=decode(bytes);
    if(!world)return;
    PlayDocument doc;doc.world=std::move(*world);doc.key=document_key(bytes);
    doc.vehicles.discover(doc.world);doc.terrain.emplace(doc.world);
    Vec3 spawn{0,.6,9};
    for(const auto& [id,node]:doc.world.nodes())if(node.parent==root_id){
        spawn={node.local.position.x,node.local.position.y+.6,node.local.position.z+9};break;
    }
    doc.character.spawn(*doc.terrain,spawn);install(doc);
}
#endif
void Session::configure_storage(const std::filesystem::path& dir){
#ifdef MUNDO_MOBILE_ROOMS
    (void)dir; // Network play never restores an offline world or a saved character position.
#else
    if(!storage_.empty()||!dir.is_absolute())return;
    pose_writer_=std::make_unique<PoseWriter>(dir);storage_=dir;
    const auto current=dir/"current.mworld";
#ifdef MUNDO_NATIVE_PROJECT_FILES
    std::array<char,8> header{};
    std::ifstream file(current,std::ios::binary);
    if(file.read(header.data(),header.size()) && std::string_view(header.data(),header.size())==project::signature) {
        try {
            restoring_project_=std::async(std::launch::async,[current]{return prepare_document(current,true);});
        } catch(const std::system_error&) {
            if(auto doc=prepare_document(current,true))install(*doc);
        }
        return;
    }
#endif
    if(auto doc=prepare_document(current,true)){install(*doc);return;}
    if(auto pose=read_pose(dir,world_key_);pose&&terrain_&&character_.resume_at(*terrain_,pose->feet)){
        local_look_.yaw=pose->yaw;local_look_.pitch=pose->pitch;
    }
#endif
}
#ifdef MUNDO_NATIVE_PROJECT_FILES
bool Session::can_travel() const {
    return location_ && destinations_.size()>1 && !restoring_project_.valid() && !in_room() && !driving();
}
bool Session::travel(const project::Selection& origin,std::uint64_t destination) {
    if(!can_travel() || *location_!=origin || destination==origin.id ||
       std::none_of(destinations_.begin(),destinations_.end(),[&](const auto& row){return row.id==destination;}))return false;
    try {
        const auto path=storage_/"current.mworld";
        const project::Selection chosen{origin.index_hash,destination};
        restoring_project_=std::async(std::launch::async,[path,chosen]{return prepare_document(path,false,chosen);});
    } catch(...) {return false;}
    restore_superseded_=false; travelling_=true; travel_notice_.clear(); pause();
    return true;
}
std::string Session::take_travel_notice() { return std::exchange(travel_notice_,std::string{}); }
void Session::finish_project_restore() {
    if(!restoring_project_.valid() || (in_room() && !travelling_) ||
       restoring_project_.wait_for(std::chrono::seconds(0))!=std::future_status::ready)return;
    auto doc=restoring_project_.get();
    const bool was_travel=std::exchange(travelling_,false);
    if(restore_superseded_)return;
    if(!was_travel) { if(doc)install(*doc); return; }
    if(!doc || !doc->location || !location_ || doc->location->index_hash!=location_->index_hash ||
       in_room() || driving()) {
        travel_notice_="Se conserva la partida. Para cambiar de mundo debes estar a pie en el mismo proyecto.";
        return;
    }
    // Persist the destination and its arrival pose together before changing the visible scene.
    if(!pose_writer_ || !pose_writer_->submit(doc->key,{doc->character.feet(),doc->yaw,doc->pitch,doc->location},true)) {
        travel_notice_="No se pudo guardar el destino. Se conserva la partida.";
        return;
    }
    install(*doc);
    travel_notice_=project_caption_;
}
#endif
bool Session::checkpoint(bool wait){
#ifdef MUNDO_NATIVE_PROJECT_FILES
    // The startup scene must not overwrite the project's last pose while it is being read.
    if(restoring_project_.valid() && !restore_superseded_ && !travelling_)return false;
#endif
    if(!pose_writer_||!terrain_)return false;
    SavedPose pose{character_.feet(),vehicles_.driving()?boarding_yaw_:local_look_.yaw,
                   vehicles_.driving()?boarding_pitch_:local_look_.pitch,{}};
#ifdef MUNDO_NATIVE_PROJECT_FILES
    pose.location=location_;
#endif
    return pose_writer_->submit(world_key_,pose,wait);
}
bool Session::adopt_document(PlayDocument& doc){
#ifdef MUNDO_MOBILE_ROOMS
    (void)doc;
    return false;
#else
    if(in_room()||storage_.empty()||doc.path.parent_path()!=storage_||
       !doc.path.filename().string().starts_with("import-")||!doc.terrain)return false;
    std::error_code error;
    std::filesystem::rename(doc.path,storage_/"current.mworld",error);
    if(error)return false;
#ifdef MUNDO_NATIVE_PROJECT_FILES
    restore_superseded_=true;
#endif
    install(doc);checkpoint();return true;
#endif
}
void Session::install(PlayDocument& doc){
#ifdef MUNDO_OWNER_VEHICLE_ART
    realistic_=false;
    if(surface_)surface_->show_owner_vehicle_art(false);
#endif
    transition_.finish();failed_=notify_error_=false;
#ifdef MUNDO_NATIVE_PROJECT_FILES
    location_=std::move(doc.location);
    destinations_=std::move(doc.destinations);
    portals_=std::move(doc.portals);
    crossing_.prime(portals_,doc.character.feet(),doc.character.grounded());
#endif
    project_caption_=std::move(doc.project_caption);
    zones_=std::move(doc.zones);world_=std::move(doc.world);world_key_=doc.key;
    terrain_=std::move(doc.terrain);vehicles_=std::move(doc.vehicles);
    character_=std::move(doc.character);avatar_.reset();
    pause();braking_=false;save_elapsed_=0;local_look_.yaw=doc.yaw;local_look_.pitch=doc.pitch;
}
bool Session::take_zone_error(){
    const bool error=notify_error_;notify_error_=false;return error;
}
bool Session::attach(void* window,GraphicsAPI backend,const std::filesystem::path& directory){
    detach();
    surface_=Surface::attach(window,backend,std::as_bytes(std::span(material)),directory);
#ifdef MUNDO_OWNER_VEHICLE_ART
    art_loaded_=false;
    if(realistic_ && surface_){
        art_loaded_=surface_->load_owner_vehicle_art(std::as_bytes(std::span(touring_art)),std::as_bytes(std::span(bruma_art)));
        if(!art_loaded_){surface_.reset();return false;}
        surface_->show_owner_vehicle_art(realistic_);
    }
#endif
    return static_cast<bool>(surface_);
}
#ifdef MUNDO_OWNER_VEHICLE_ART
#ifndef MUNDO_MOBILE_ROOMS
std::span<const std::byte> Session::practice_track(){return std::as_bytes(std::span(start_world));}
#endif
bool Session::change_vehicle_style(){
    if(!surface_)return false;
    if(!art_loaded_)art_loaded_=surface_->load_owner_vehicle_art(std::as_bytes(std::span(touring_art)),std::as_bytes(std::span(bruma_art)));
    if(!art_loaded_)return false;
    realistic_=!realistic_;surface_->show_owner_vehicle_art(realistic_);return true;
}
#endif
bool Session::driving() const{
#ifdef MUNDO_MOBILE_ROOMS
    if(room_)return room_active_ && room_->phase==room::Phase::playing && room_->scene.ready() && room_->actors.driving();
#endif
    return vehicles_.driving();
}
double Session::vehicle_speed() const{
#ifdef MUNDO_MOBILE_ROOMS
    if(room_)return driving()?room_->actors.car_speed():0.;
#endif
    return vehicles_.speed_metres_per_second();
}
const char* Session::interact(){
#ifdef MUNDO_MOBILE_ROOMS
    if(room_){
        if(!room_has_car())return "El carro no está disponible en esta sala.";
        const auto& actors=room_->actors;
        return request_seat(actors.aboard()?room::CarAction::exit:(actors.occupied()?room::CarAction::ride:room::CarAction::enter));
    }
#endif
#ifdef MUNDO_NATIVE_PROJECT_FILES
    if(travelling_)return "Espera a que termine el viaje.";
#endif
    if(!terrain_)return "Abre un mundo para conducir.";
    if(failed_||transition_.pending())return "La región no está disponible.";
    const bool aboard=vehicles_.driving();const double heading=vehicles_.heading();
    if(const char* error=vehicles_.interact(world_,terrain_,character_))return error;
#ifdef MUNDO_NATIVE_PROJECT_FILES
    if(aboard)crossing_.prime(portals_,character_.feet(),character_.grounded());
#endif
    if(!aboard){boarding_yaw_=local_look_.yaw;boarding_pitch_=local_look_.pitch;}
    local_look_.yaw=aboard?heading:0;local_look_.pitch=aboard?0:-.13;
    pause();braking_=false;avatar_.reset();checkpoint();
    return nullptr;
}
Session::Look& Session::active_look(){
#ifdef MUNDO_MOBILE_ROOMS
    if(room_)return room_->look;
#endif
    return local_look_;
}
void Session::toggle_camera(){
    auto& look=active_look();
    look.third_person=!look.third_person;
}
void Session::jump(){
#ifdef MUNDO_MOBILE_ROOMS
    if(!room_ready() || room_->actors.riding())return;
#endif
    if(driving())braking_=true;else jump_requested_=true;
}
void Session::pause(){
#ifdef MUNDO_MOBILE_ROOMS
    if(room_){connection_.neutral();room_->next_poll=0;}
#endif
    pedal_down_=braking_=false;move_.reset();look_.reset();last_frame_.reset();side_=forward_=0;jump_requested_=false;
}
void Session::detach(){
    pause();
#ifdef MUNDO_MOBILE_ROOMS
    if(room_){
        room_->audio.suspend();
        room_->presented=false;room_->entry.clear(surface_.get());room_->scene.suspend();
    }
#endif
    surface_.reset();
}
void Session::touch(long long id,int phase,double x,double y,double w,double h){
    if(phase==3){pause();return;}
    if(phase==2){
        if(move_==id){move_.reset();side_=forward_=0;}
        if(look_==id)look_.reset();
        return;
    }
#ifdef MUNDO_MOBILE_ROOMS
    if(!room_ready())return;
    if(phase==0 && x<w*.5 && room_ && room_->actors.riding())return;
#endif
    if(w<=0||h<=0)return;
    if(phase==0){
        if(x<w*.5 && !move_){braking_=false;move_=id;anchor_x_=x;anchor_y_=y;}
        else if(x>=w*.5 && !look_){look_=id;last_x_=x;last_y_=y;}
    }else if(phase==1){
        const double unit=std::min(w,h);
        if(move_==id){
            side_=(x-anchor_x_)/(unit*.15);
            forward_=(anchor_y_-y)/(unit*.15);
        }else if(look_==id){
            auto& view=active_look();
            view.yaw+=(x-last_x_)*3/unit;
            view.pitch=std::clamp(view.pitch-(y-last_y_)*3/unit,-1.4,1.4);
            last_x_=x;last_y_=y;
        }
    }
}
void Session::frame(double timestamp,double refresh){
#ifdef MUNDO_MOBILE_ROOMS
    if(!surface_ || !room_ || !room_active_ || !std::isfinite(timestamp))return;
    const double elapsed=std::clamp(timestamp-last_frame_.value_or(timestamp),0.,.125);
    last_frame_=timestamp;
    auto caps=device_caps_;caps.refresh_hz=refresh;
    draw_room(timestamp,elapsed,caps);
#else
#ifdef MUNDO_NATIVE_PROJECT_FILES
    finish_project_restore();
#endif
    if(!surface_||!terrain_||!std::isfinite(timestamp))return;
    double elapsed=std::clamp(timestamp-last_frame_.value_or(timestamp),0.,.125);
    last_frame_=timestamp;
    DisplayCaps caps;caps.refresh_hz=refresh;
    if(!in_room() && zones_&&!failed_){
        Vec3 focus=vehicles_.driving()?vehicles_.position():character_.feet();
        auto status=transition_.update(*zones_,focus,1,vehicles_.active_root(),world_,terrain_);
        if(status==ZoneTransition::Status::failed){failed_=notify_error_=true;}
        if(status!=ZoneTransition::Status::ready)elapsed=0;
    }
    if(failed_)elapsed=0;
#ifdef MUNDO_NATIVE_PROJECT_FILES
    if(travelling_)elapsed=0;
#endif
    if(vehicles_.driving()){
        if(elapsed>0)vehicles_.advance(world_,*terrain_,elapsed,forward_,side_,braking_||pedal_down_);
        auto camera=vehicles_.camera(*terrain_,local_look_.yaw,local_look_.pitch,local_look_.third_person);
        surface_->frame_with_avatar(world_,camera,caps,nullptr,&vehicles_);return;
    }
    const double sy=std::sin(local_look_.yaw),cy=std::cos(local_look_.yaw),cp=std::cos(local_look_.pitch);
    const WalkInput input{sy*forward_+cy*side_,-cy*forward_+sy*side_,std::hypot(side_,forward_)>1.2,jump_requested_};
    if(elapsed>0){
#ifdef MUNDO_NATIVE_PROJECT_FILES
        if(!portals_.empty() && can_travel()){
            const auto target=crossing_.walk(portals_,character_,*terrain_,elapsed,input);
            if(target && !travel(*location_,*target))travel_notice_="No se pudo iniciar el viaje. Se conserva la partida.";
        }else
#endif
        { character_.advance(*terrain_,elapsed,input); }
    }
    jump_requested_=false;
    save_elapsed_+=elapsed;
    if(save_elapsed_>=15){save_elapsed_=0;checkpoint(false);}
    CameraPose camera;camera.eye=character_.eye();camera.forward={sy*cp,std::sin(local_look_.pitch),-cy*cp};
    avatar_.advance(character_,elapsed,local_look_.yaw);
    const bool visible=local_look_.third_person && follow_avatar(camera,*terrain_);
    surface_->frame_with_avatar(world_,camera,caps,visible?&avatar_:nullptr,&vehicles_);
#endif
}
VideoSettings Session::settings()const{return surface_?surface_->video_profile().settings():default_video_settings(DeviceFamily::mobile);}
std::string Session::video_dimensions() const {
    const auto quality=surface_?surface_->requested_quality():std::nullopt;
    if(!quality)return "Dimensiones disponibles después del primer cuadro.";
    const auto& v=quality->video;
    return "Superficie "+std::to_string(v.surface_width)+" × "+std::to_string(v.surface_height)+
        " px · Render interno solicitado "+std::to_string(v.render_width)+" × "+std::to_string(v.render_height)+" px.";
}
bool Session::video(unsigned resolution,unsigned fps){
    if(!surface_ || resolution>static_cast<unsigned>(Resolution::native)||fps>10000)return false;
    auto value=settings(); value.resolution=static_cast<Resolution>(resolution);value.fps_cap=fps;
    const auto status=surface_->video_profile().apply(value);
    return status==SettingsResult::saved || status==SettingsResult::session_only;
}
}
