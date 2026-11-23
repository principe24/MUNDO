#include "session.hpp"
#include <utility>
#include <cmath>

namespace mundo::mobile {
namespace {
// Use the existing room input bits. Keep small stick drift inside the dead zone.
unsigned movement_mask(double forward, double side) {
    unsigned mask = 0;
    if (forward > .18) mask |= 1;
    if (forward < -.18) mask |= 2;
    if (side < -.18) mask |= 4;
    if (side > .18) mask |= 8;
    if (mask && std::hypot(forward, side) > 1.2) mask |= 16;
    return mask;
}
}

void Session::report_room(std::string message) {
    if (room_status_ == message) return;
    room_status_ = std::move(message);
    ++room_status_revision_;
}

bool Session::room_has_car() const {
    return room_ && room_active_ && room_->phase == room::Phase::playing && room_->scene.ready() && room_->actors.has_car();
}

std::uint64_t Session::meeting_ticket() const {
    if (!room_ || !room_active_ || room_->phase != room::Phase::playing || !room_->scene.ready() || room_->actors.aboard()) return 0;
    return room_->meeting_ticket;
}

bool Session::return_to_meeting(std::uint64_t ticket) {
    if (!ticket || ticket != meeting_ticket()) return false;
    pause();
    if (!connection_.return_to_meeting(ticket)) return false;
    room_->meeting_ticket = 0;
    room_->meeting_notice = "Regreso solicitado al anfitrión.";
    room_->notice_until = 0; // Pending until the worker reports or the connection changes.
    ++room_status_revision_;
    return true;
}

unsigned Session::room_seat_choices() const {
    if (!room_has_car()) return 0;
    unsigned choices=0;
    for(auto action:{room::CarAction::enter,room::CarAction::exit,room::CarAction::ride})
        if(room_->actors.allows(action))choices|=static_cast<unsigned>(action);
    return choices;
}

const char* Session::request_seat(room::CarAction action) {
    if(!room_has_car() || !room_->actors.allows(action))return "La plaza elegida ya no está disponible.";
    pause();
    connection_.vehicle_action(action);
    report_room(action==room::CarAction::exit?"Buscando una salida con el carro detenido.":
                "Plaza solicitada. El carro debe estar detenido y al alcance.");
    return nullptr;
}

bool Session::join_room(std::string_view link) {
    if (room_ || link.empty() || link.size() > 256) return false;
    for (const unsigned char c : link) if (c < 0x21 || c > 0x7e) return false;
    // The server emits ASCII invitation URLs for both native and web players.
    if (!connection_.start(std::wstring(link.begin(), link.end()))) return false;
#ifdef MUNDO_NATIVE_PROJECT_FILES
    cancel_travel();
#endif
    room_.emplace();
    room_->look.third_person = local_look_.third_person;
    pause();
#ifdef MUNDO_OWNER_VEHICLE_ART
    if (surface_) surface_->show_owner_vehicle_art(realistic_);
#endif
    report_room("Entrando a la sala privada…");
    return true;
}

void Session::end_room(std::string message) {
    pause();
    if(room_)room_->audio.suspend();
    if(room_)room_->entry.clear(surface_.get());
    if(surface_)surface_->discard_scene();
    connection_.leave();
    room_.reset();
#ifdef MUNDO_OWNER_VEHICLE_ART
    if (surface_) surface_->show_owner_vehicle_art(realistic_);
#endif
    report_room(std::move(message));
}

void Session::leave_room() {
    if (room_) end_room("Saliste de la sala.");
}

void Session::trim_world_cache() {
    connection_.trim_world_cache();
    if(room_)room_->entry.clear(surface_.get());
    if(room_)room_->scene.reduce_memory();
    if(surface_)surface_->trim_on_next_scene();
}

void Session::set_room_active(bool active) {
    if (active == room_active_) return;
    room_active_ = active;
    if (!active && room_) {
        room_->presented=false;
        room_->course.clear();
        room_->entry.clear(surface_.get());
        room_->audio.suspend();
        room_->scene.suspend();
        if(surface_)surface_->discard_scene();
        if(room_->phase==room::Phase::playing){
            room_->phase=room::Phase::reconnecting;
            report_room("Esperando una actualización de la sala…");
        }
        room_->meeting_ticket = 0;
        room_->meeting_notice.clear();
        room_->notice_until = 0;
        ++room_status_revision_;
    }
    pause();
    connection_.set_active(active);
}

bool Session::draw_room(double now, double elapsed, const DisplayCaps& caps) {
    auto& play = *room_;
    if (!room_active_) return false;
    if (play.notice_until > 0 && now >= play.notice_until) {
        play.meeting_notice.clear();
        play.notice_until = 0;
        ++room_status_revision_;
    }
    const bool poll_due = now >= play.next_poll;
    const bool was_driving = play.actors.driving();
    const bool was_aboard = play.actors.aboard();
    const bool had_passenger = play.actors.passenger_taken();
    const bool had_car = play.actors.has_car();
    const bool was_occupied = play.actors.occupied();
    const double exit_yaw = was_aboard ? play.actors.car_heading() + play.look.yaw : play.look.yaw;
    bool status_changed = false;
    if (poll_due) {
        play.next_poll = now + .016;
        const bool constrained = surface_ && surface_->memory_constrained();
        auto state = connection_.poll(constrained);
        if (state.phase == room::Phase::ended || state.phase == room::Phase::offline) {
            end_room(state.message.empty() ? "La sala se cerró." : std::move(state.message));
            return false;
        }
        if(play.phase==room::Phase::playing && state.phase!=room::Phase::playing){
            play.audio.suspend();
            play.scene.suspend();
            play.course.clear();
            surface_->discard_scene();
        }
        play.entry.accept(state,surface_.get());
        const bool installed = state.world.has_value();
        if (installed) {
            play.presented=false;
            play.course.clear();
            play.title = state.title;
            play.scene.install(state,play.actors);
            play.audio.install(play.scene.world(), true);
            for (const auto& clip : state.audio_clips)
                play.audio.install_clip(clip.key, std::as_bytes(std::span(clip.bytes)));
            pause();
            play.look.yaw=0.;play.look.pitch=0.;
        }
        if(state.region){
            play.scene.replace_region(std::move(state.region->world),std::move(state.region->terrain));
            play.audio.install(play.scene.world(), false);
            surface_->trim_on_next_scene();
        }
        if (installed || state.region) state.confirm_install();
        const auto previous_ticket = meeting_ticket();
        const bool changed = play.phase != state.phase;
        play.phase = state.phase;
        if (changed && state.phase == room::Phase::reconnecting) {
            pause();
            play.meeting_notice.clear();
            play.notice_until = 0;
            ++room_status_revision_;
        }
        if (state.phase == room::Phase::joining || state.phase == room::Phase::reconnecting) {
            if (!state.message.empty()) report_room(std::move(state.message));
            else if (changed) report_room(state.phase == room::Phase::joining
                ? "Entrando a la sala privada…" : "Reconectando con la sala…");
        }
        if (state.snapshot) {
            const auto caption=room::course_caption(state.snapshot->course);
            if(play.course!=caption){play.course=caption;++room_status_revision_;}
            const bool snap=state.meeting_returned || changed;
            const bool previously_ready=play.scene.ready();
            play.actors.accept(*state.snapshot,state.seat,now,snap);
            if(constrained)play.scene.reduce_memory();
            if(play.scene.follow(*state.snapshot,state.seat,play.actors,now,snap) || installed)
                surface_->trim_on_next_scene();
            if (state.meeting_returned || previously_ready!=play.scene.ready()) pause();
            const auto count = state.snapshot->players.size();
            play.seat = state.seat;
            status_changed = changed || installed || play.players != count;
            play.players = count;
        }
        play.meeting_ticket = state.meeting_available ? state.meeting_ticket : 0;
        if (previous_ticket != meeting_ticket()) ++room_status_revision_;
        if (state.phase == room::Phase::playing && !state.meeting_notice.empty()) {
            play.meeting_notice = std::move(state.meeting_notice);
            play.notice_until = now + 6.;
            ++room_status_revision_;
        }
    }
    if (play.phase!=room::Phase::playing || !play.scene.ready()) {
        play.audio.suspend();
        play.presented=false;
        return play.entry.draw(*surface_,caps);
    }
    play.actors.advance(play.scene.world(), now, elapsed);
    const bool aboard = play.actors.aboard(), driving = play.actors.driving();
    if (was_aboard != aboard || was_driving != driving) {
        // A control held on foot must never become throttle or brake after admission.
        // The camera orbit is relative to the car only while the local seat drives.
        pause();
        if(was_aboard != aboard){
            play.look.yaw = aboard ? 0. : exit_yaw;
            play.look.pitch = aboard ? -.13 : 0.;
        }
    }
    if (poll_due && play.phase == room::Phase::playing) {
        if (status_changed || was_driving != driving || was_aboard != aboard || had_passenger != play.actors.passenger_taken() || had_car != play.actors.has_car() ||
            was_occupied != play.actors.occupied()) {
            std::string status = play.title + " · Jugador " + std::to_string(play.seat + 1);
            if (driving) status += play.actors.passenger_taken() ? " · conduciendo con pasajero" : " · conduciendo";
            else if (play.actors.riding()) status += play.actors.occupied() ? " · pasajero" : " · pasajero · volante disponible";
            else if (play.actors.occupied()) status += " · el otro jugador conduce";
            else if (play.actors.has_car()) status += " · carro libre";
            status += play.players == 1 ? " · esperando al otro jugador" : " · dos jugadores";
            report_room(std::move(status));
        }
        connection_.input(play.actors.riding()?0:movement_mask(forward_, side_), play.look.yaw, !aboard && jump_requested_,
                          driving && (pedal_down_ || braking_));
        jump_requested_ = false;
    }
    const auto feet = play.actors.local_feet();
    if (!feet) { play.audio.suspend(); return false; }
    CameraPose camera;
    bool show_self = false;
    if (aboard) {
        camera = play.actors.vehicle_camera(play.scene.terrain(), play.look.yaw, play.look.pitch, play.look.third_person, show_self);
    } else {
        camera.eye = {feet->x, feet->y + 1.58, feet->z};
        const double cp = std::cos(play.look.pitch);
        camera.forward = {cp * std::sin(play.look.yaw), std::sin(play.look.pitch), -cp * std::cos(play.look.yaw)};
        show_self = play.look.third_person && play.actors.follow_pedestrian(camera, play.scene.terrain());
    }
    play.audio.frame(*feet, std::atan2(camera.forward.x, -camera.forward.z));
    const bool submitted=surface_->frame_with_peer(play.scene.world(), camera, caps, show_self ? play.actors.local_avatar() : nullptr,
                              play.actors.peer_avatar(),play.actors.vehicles(),play.actors.npc_avatars());
    if(submitted)play.presented=true;
    return play.presented;
}
}
