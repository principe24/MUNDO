#include "session.hpp"
#include "room_http.hpp"
#include <string>
#include <android/native_window_jni.h>
#include <jni.h>
#include <array>
#include <string_view>

using mundo::mobile::Session;
namespace {
struct Host {
    Session game;
    ANativeWindow* window{};
    void detach(){game.detach();if(window)ANativeWindow_release(window);window=nullptr;}
    ~Host(){detach();}
};
Host* host(jlong h){return reinterpret_cast<Host*>(h);}
jbyteArray utf8_bytes(JNIEnv* env,std::string_view text) {
    const auto size=static_cast<jsize>(text.size());
    auto result=env->NewByteArray(size);
    if(result && size)env->SetByteArrayRegion(result,0,size,reinterpret_cast<const jbyte*>(text.data()));
    return result;
}
std::string invitation_text(JNIEnv* env,jstring link){
    if(!link)return {};
    const auto length=env->GetStringLength(link);
    std::array<jchar,256> units;
    if(length<=0||static_cast<std::size_t>(length)>units.size())return {};
    env->GetStringRegion(link,0,length,units.data());
    if(env->ExceptionCheck())return {};
    std::string ascii;
    ascii.reserve(length);
    for(jsize i=0;i<length;++i){
        if(units[i]<0x21||units[i]>0x7e)return {};
        ascii.push_back(static_cast<char>(units[i]));
    }
    return ascii;
}

}
#define N(name) Java_studio_mundo_player_PlayerActivity_##name
extern "C" {
JNIEXPORT jlong JNICALL N(create)(JNIEnv*,jclass){
    try{return reinterpret_cast<jlong>(new Host);}catch(...){return 0;}
}
JNIEXPORT void JNICALL N(destroy)(JNIEnv*,jclass,jlong h){delete host(h);}
JNIEXPORT jboolean JNICALL N(attach)(JNIEnv* env,jclass,jlong h,jobject surface,jstring folder){
    auto* p=host(h);p->detach();p->window=ANativeWindow_fromSurface(env,surface);
    if(!p->window)return false;
    const char* path=env->GetStringUTFChars(folder,nullptr);
    if(!path)return false;
    bool ready=false;
    try{ready=p->game.attach(p->window,mundo::GraphicsAPI::automatic,path);}catch(...){}
    env->ReleaseStringUTFChars(folder,path);
    if(!ready)p->detach();
    return ready;
}
JNIEXPORT void JNICALL N(detach)(JNIEnv*,jclass,jlong h){host(h)->detach();}
JNIEXPORT void JNICALL N(pauseGame)(JNIEnv*,jclass,jlong h){host(h)->game.pause();}
JNIEXPORT void JNICALL N(trimWorldCache)(JNIEnv*,jclass,jlong h){
    if(h)host(h)->game.trim_world_cache();
}
JNIEXPORT void JNICALL N(deviceBudget)(JNIEnv*,jclass,jlong h,jlong bytes,jboolean low_memory,jboolean low_power){
    if(h && bytes>=0)host(h)->game.set_device_budget(static_cast<std::uint64_t>(bytes),low_memory,low_power);
}
JNIEXPORT void JNICALL N(frame)(JNIEnv*,jclass,jlong h,jdouble t,jdouble hz){
    host(h)->game.frame(t,hz);
}
JNIEXPORT jboolean JNICALL N(joinRoom)(JNIEnv* env,jclass,jlong h,jstring link){
    if(!h)return false;
    try{
        const auto text=invitation_text(env,link);
        return !text.empty() && host(h)->game.join_room(text);
    }catch(...){return false;}
}
JNIEXPORT jstring JNICALL N(invitationOrigin)(JNIEnv* env,jclass,jstring link){
    try{
        const auto text=invitation_text(env,link);
        const auto invite=mundo::room::parse_invitation(std::wstring(text.begin(),text.end()));
        if(!invite)return nullptr;
        const std::string origin(invite->origin.begin(),invite->origin.end());
        return env->NewStringUTF(origin.c_str());
    }catch(...){return nullptr;}
}
JNIEXPORT void JNICALL N(leaveRoom)(JNIEnv*,jclass,jlong h){if(h)host(h)->game.leave_room();}
JNIEXPORT void JNICALL N(setRoomActive)(JNIEnv*,jclass,jlong h,jboolean active){
    if(h)host(h)->game.set_room_active(active);
}
JNIEXPORT jboolean JNICALL N(roomWantsAudio)(JNIEnv*,jclass,jlong h){return h && host(h)->game.room_wants_audio();}
JNIEXPORT void JNICALL N(roomAudioAllowed)(JNIEnv*,jclass,jlong h,jboolean allowed){
    if(h)host(h)->game.set_room_audio_allowed(allowed);
}
JNIEXPORT jboolean JNICALL N(roomReady)(JNIEnv*,jclass,jlong h){return h && host(h)->game.room_ready();}
JNIEXPORT jboolean JNICALL N(entryVisible)(JNIEnv*,jclass,jlong h){return h && host(h)->game.entry_visible();}
JNIEXPORT jboolean JNICALL N(inRoom)(JNIEnv*,jclass,jlong h){return h && host(h)->game.in_room();}
JNIEXPORT jboolean JNICALL N(roomHasCar)(JNIEnv*,jclass,jlong h){return h && host(h)->game.room_has_car();}
JNIEXPORT jlong JNICALL N(meetingTicket)(JNIEnv*,jclass,jlong h){
    return h?static_cast<jlong>(host(h)->game.meeting_ticket()):0;
}
JNIEXPORT jboolean JNICALL N(returnToMeeting)(JNIEnv*,jclass,jlong h,jlong ticket){
    try{return h && ticket && host(h)->game.return_to_meeting(static_cast<std::uint64_t>(ticket));}
    catch(...){return false;}
}
JNIEXPORT jint JNICALL N(seatChoices)(JNIEnv*,jclass,jlong h){
    return h?static_cast<jint>(host(h)->game.room_seat_choices()):0;
}
JNIEXPORT jstring JNICALL N(requestSeat)(JNIEnv* env,jclass,jlong h,jint choice){
    try{
        const char* reason=h?host(h)->game.request_seat(static_cast<mundo::room::CarAction>(choice)):"Sala cerrada.";
        return reason?env->NewStringUTF(reason):nullptr;
    }catch(...){return env->NewStringUTF("No se pudo solicitar la plaza.");}
}
JNIEXPORT jint JNICALL N(roomStatusRevision)(JNIEnv*,jclass,jlong h){
    return h?static_cast<jint>(host(h)->game.room_status_revision()):0;
}
JNIEXPORT jstring JNICALL N(roomCarGuide)(JNIEnv* env,jclass,jlong h){
    if(!h)return nullptr;
    try{
        const auto guide=host(h)->game.room_car_guide();
        return guide.empty()?nullptr:env->NewStringUTF(guide.c_str());
    }catch(...){return nullptr;}
}
JNIEXPORT jbyteArray JNICALL N(roomCourseUtf8)(JNIEnv* env,jclass,jlong h){
    if(!h)return nullptr;
    try{return utf8_bytes(env,host(h)->game.room_course());}catch(...){return nullptr;}
}
JNIEXPORT jbyteArray JNICALL N(roomStatusUtf8)(JNIEnv* env,jclass,jlong h){
    if(!h)return nullptr;
    try{
        return utf8_bytes(env,host(h)->game.room_status());
    }catch(...){return nullptr;}
}
JNIEXPORT void JNICALL N(touch)(JNIEnv*,jclass,jlong h,jint id,jint phase,jfloat x,jfloat y,jint w,jint height){
    host(h)->game.touch(id,phase,x,y,w,height);
}
JNIEXPORT void JNICALL N(camera)(JNIEnv*,jclass,jlong h){host(h)->game.toggle_camera();}
JNIEXPORT jdouble JNICALL N(vehicleSpeed)(JNIEnv*,jclass,jlong h){
    return h?host(h)->game.vehicle_speed():0.;
}
JNIEXPORT jboolean JNICALL N(driving)(JNIEnv*,jclass,jlong h){return h && host(h)->game.driving();}
JNIEXPORT void JNICALL N(brake)(JNIEnv*,jclass,jlong h,jboolean held){if(h)host(h)->game.hold_brake(held);}
JNIEXPORT jint JNICALL N(ownerStyle)(JNIEnv*,jclass,jlong h,jboolean change){
#ifdef MUNDO_ANDROID_OWNER_PLAYER
    if(h){
        try{
            auto& game=host(h)->game;
            if(change && !game.change_vehicle_style())return -2;
            return game.realistic()?1:0;
        }catch(...){return -2;}
    }
#endif
    return -1;
}
JNIEXPORT void JNICALL N(jump)(JNIEnv*,jclass,jlong h){host(h)->game.jump();}
JNIEXPORT jint JNICALL N(option)(JNIEnv*,jclass,jlong h,jboolean fps){
    auto s=host(h)->game.settings();return fps?s.fps_cap:static_cast<jint>(s.resolution);
}
JNIEXPORT jbyteArray JNICALL N(videoDimensions)(JNIEnv* env,jclass,jlong h){
    if(!h)return nullptr;
    try{return utf8_bytes(env,host(h)->game.video_dimensions());}catch(...){return nullptr;}
}
JNIEXPORT jboolean JNICALL N(video)(JNIEnv*,jclass,jlong h,jint r,jint fps){return host(h)->game.video(r,fps);}
}
