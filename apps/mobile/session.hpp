#pragma once
#include "document.hpp"
#ifdef MUNDO_NATIVE_PROJECT_FILES
#include <future>
#endif
#include "mundo/zone_transition.hpp"
#include "checkpoint.hpp"
#include "mundo/surface.hpp"
#ifdef MUNDO_MOBILE_ROOMS
#include "room_client.hpp"
#include "entry_view.hpp"
#include "active_scene.hpp"
#include "playback_audio.hpp"
#include "mundo/room_view.hpp"
#endif

namespace mundo::mobile {
// The platform delivers input, lifecycle and frame events on one owning UI thread.
class Session {
public:
    Session();
    void configure_storage(const std::filesystem::path&);
    bool checkpoint(bool wait=true);
    bool adopt_document(PlayDocument& document);
    bool take_zone_error();
#ifdef MUNDO_NATIVE_PROJECT_FILES
    bool can_travel() const;
    const auto& destinations() const { return destinations_; }
    const auto& project_location() const { return location_; }
    bool travel(const project::Selection& origin,std::uint64_t destination);
    bool has_travel_notice() const { return !travel_notice_.empty(); }
    void cancel_travel() { if(travelling_)restore_superseded_=true; travel_notice_.clear(); }
    std::string take_travel_notice();
#endif
    const std::string& project_caption() const { return project_caption_; }
    bool attach(void* window, GraphicsAPI backend, const std::filesystem::path& directory);
    void detach();
    void pause();
    void touch(long long id, int phase, double x, double y, double width, double height);
#ifdef MUNDO_MOBILE_ROOMS
    bool join_room(std::string_view ascii_link);
    void leave_room();
    void set_room_active(bool active);
    void set_room_audio_allowed(bool allowed) {
        room_audio_allowed_ = allowed;
        if (!allowed && room_) room_->audio.suspend();
    }
    bool room_wants_audio() const {
        const auto levels = room_levels();
        return room_ready() && !levels.muted && levels.volume && room_->audio.has_sources();
    }
    AudioLevels room_levels() const { return audio_profile_ ? audio_profile_->settings() : AudioLevels{}; }
    bool save_room_levels(const AudioLevels& levels);
    void trim_world_cache();
    void set_device_budget(std::uint64_t bytes, bool low_memory, bool low_power) {
        if (low_memory) trim_world_cache();
        device_caps_.frame_target_budget=bytes;
        device_caps_.memory_pressure=low_memory;
        device_caps_.pressure.low_power=low_power;
    }
    bool in_room() const { return room_.has_value(); }
    bool room_ready() const { return room_ && room_active_ && room_->presented && room_->scene.ready() && room_->phase == room::Phase::playing; }
    bool entry_visible() const { return room_ && room_active_ && room_->entry.presented(); }
    bool room_has_car() const;
    bool room_riding() const { return room_has_car() && room_->actors.riding(); }
    unsigned room_seat_choices() const;
    const char* request_seat(room::CarAction);
    std::uint64_t meeting_ticket() const;
    bool return_to_meeting(std::uint64_t ticket);
    std::string room_status() const {
        if(room_ && room_active_ && room_->phase==room::Phase::playing && !room_->scene.ready())
            return "Preparando el terreno de la partida…";
        return room_ && !room_->meeting_notice.empty() ? room_->meeting_notice : room_status_;
    }
    std::string room_course() const {
        return room_ready() ? room_->course : std::string{};
    }
    std::string room_car_guide() const {
        return room_ready() && room_has_car() ? room_->actors.car_guide(room_->look.yaw) : std::string{};
    }
    unsigned room_status_revision() const { return room_status_revision_; }
#else
    bool in_room() const { return false; }
#endif
    double vehicle_speed() const;
    bool driving() const;
    void hold_brake(bool pressed){pedal_down_=pressed && driving();}
#ifdef MUNDO_OWNER_VEHICLE_ART
    bool change_vehicle_style();
    bool realistic() const {return realistic_;}
#ifndef MUNDO_MOBILE_ROOMS
    static std::span<const std::byte> practice_track();
#endif
#endif
    void toggle_camera();
    const char* interact();
    void jump();
    void frame(double timestamp, double refresh_hz);
    bool video(unsigned resolution, unsigned fps);
    VideoSettings settings() const;
    std::string video_dimensions() const;
private:
    struct Look {
        double yaw{}, pitch{};
        bool third_person{true};
    };
    Look& active_look();
    void install(PlayDocument&);
#ifdef MUNDO_NATIVE_PROJECT_FILES
    std::future<std::unique_ptr<PlayDocument>> restoring_project_;
    bool restore_superseded_{},travelling_{};
    std::optional<project::Selection> location_;
    std::vector<project::Destination> destinations_;
    std::vector<project::PortalPad> portals_;
    project::PortalCrossing crossing_;
    std::string travel_notice_;
    void finish_project_restore();
#endif
#ifdef MUNDO_MOBILE_ROOMS
    struct RoomScene {
        room::Phase phase{room::Phase::joining};
        bool presented{};
        Look look;
        room::View actors;
        room::EntryView entry;
        room::ActiveScene scene{1};
        room::PlaybackAudio audio;
        std::size_t players{};
        unsigned seat{};
        std::uint64_t meeting_ticket{};
        std::string title, meeting_notice, course;
        double notice_until{};
        double next_poll{};
    };
    bool draw_room(double now, double elapsed, const DisplayCaps& caps);
    void end_room(std::string message);
    void report_room(std::string message);
    DisplayCaps device_caps_{};
    room::Client connection_;
    std::optional<RoomScene> room_;
    std::string room_status_;
    unsigned room_status_revision_{};
    std::optional<DeviceAudioProfile> audio_profile_;
    bool room_active_{true}, room_audio_allowed_{true};
#endif
    std::filesystem::path storage_;
    std::uint64_t world_key_{};
    std::string project_caption_;
    std::unique_ptr<PoseWriter> pose_writer_;
    double save_elapsed_{};
    World world_;
    std::optional<CharacterTerrain> terrain_;
    CharacterController character_;
    BlockAvatar avatar_;
    VehicleSession vehicles_;
    bool braking_{},pedal_down_{};
#ifdef MUNDO_OWNER_VEHICLE_ART
    bool realistic_{},art_loaded_{};
#endif
    double boarding_yaw_{},boarding_pitch_{};
    Look local_look_;
    std::unique_ptr<Surface> surface_;
    std::optional<long long> move_,look_;
    double anchor_x_{},anchor_y_{},last_x_{},last_y_{},side_{},forward_{};
    std::optional<double> last_frame_;
    bool jump_requested_{};
    bool failed_{},notify_error_{};
    std::optional<ZoneArchive> zones_;
    ZoneTransition transition_; // Destroy the worker before its borrowed archive and world.
};
}
