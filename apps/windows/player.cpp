#include "resources.h"
#include "entry_view.hpp"
#include "active_scene.hpp"
#include "playback_audio.hpp"
#include "room_client.hpp"
#include "mundo/room_view.hpp"
#include "mundo/surface.hpp"
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <string>
#include <utility>

// Optimus checks this process export when the application starts on hybrid PCs.
extern "C" { __declspec(dllexport) DWORD NvOptimusEnablement = 1; }

namespace {
using namespace mundo;
using Clock = std::chrono::steady_clock;
struct RoomPlay {
    room::Phase phase{room::Phase::joining};
    room::View actors;
    room::EntryView entry;
    room::ActiveScene scene{2};
    room::PlaybackAudio audio;
    CameraPose camera;
    double yaw{}, pitch{};
    bool third_person{true}, draw_self{}, jump_pressed{};
    std::wstring caption{L"Conectando a la sala…"};
    std::string waiting_message;
    std::uint64_t meeting_ticket{};
    std::wstring meeting_notice, course_caption, course_display;
    Clock::time_point next_course_guide{};
    Clock::time_point notice_until{};
    Clock::time_point next_poll{};
};
struct Player {
    HINSTANCE instance{};
    HWND window{};
    HMENU menu{};
    std::unique_ptr<Surface> surface;
    HWND lobby{}, course_label{};
    bool course_visible{}, compact_lobby{};
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
    bool owner_realism{};
#endif
    room::Client connection;
    std::optional<RoomPlay> online;
    bool third_person{true};
    std::array<bool,256> wait_for_release{};
    bool dragging{}, fullscreen{}, app_active{true};
    POINT drag_at{};
    WINDOWPLACEMENT placement{sizeof(WINDOWPLACEMENT)};
    LONG_PTR window_style{};
    Clock::time_point tick{Clock::now()}, last_present{}, last_report{};
    unsigned frames{};
    std::wstring lobby_text;
};

void release_controls_before_reuse(Player& p){
    constexpr int controls[]{'W','A','S','D',VK_UP,VK_LEFT,VK_DOWN,VK_RIGHT,VK_SHIFT,VK_SPACE,VK_CONTROL};
    for(int key:controls)p.wait_for_release[key]=(GetAsyncKeyState(key)&0x8000)!=0;
}
bool control_down(Player& p,int key){
    const bool down=(GetAsyncKeyState(key)&0x8000)!=0;
    if(!down)p.wait_for_release[key]=false;
    return down && !p.wait_for_release[key];
}

void message(HWND owner, const wchar_t* text) {
    MessageBoxW(owner, text, L"MUNDO", MB_OK | MB_ICONINFORMATION);
}
std::wstring wide_text(const std::string& utf8) {
    if(utf8.empty())return {};
    const int bytes=static_cast<int>(utf8.size());
    const int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,utf8.data(),bytes,nullptr,0);
    if(!count)return {};
    std::wstring result(count,L'\0');
    MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,utf8.data(),bytes,result.data(),count);
    for(auto& c:result)if(c<L' ' || (c>=0x7f && c<=0x9f))c=L' ';
    return result;
}
void room_menus(Player& p) {
    EnableMenuItem(p.menu,ID_ROOM_JOIN,MF_BYCOMMAND|(p.online?MF_GRAYED:MF_ENABLED));
    EnableMenuItem(p.menu,ID_ROOM_LEAVE,MF_BYCOMMAND|(p.online?MF_ENABLED:MF_GRAYED));
    EnableMenuItem(p.menu,ID_ROOM_MEETING,MF_BYCOMMAND|
        (p.online && p.online->meeting_ticket?MF_ENABLED:MF_GRAYED));
    DrawMenuBar(p.window);
}
const wchar_t* welcome = L"MUNDO en línea  ·  Elige Sala > Entrar con invitación (F6).";
void layout_lobby(Player& p) {
    if(!p.lobby)return;
    RECT area{};GetClientRect(p.window,&area);
    if(p.compact_lobby)
        MoveWindow(p.lobby,12,10,std::clamp(int(area.right)-24,1,780),42,TRUE);
    else
        MoveWindow(p.lobby,0,0,area.right,area.bottom,TRUE);
}
void layout_course(Player& p) {
    if(!p.course_label || !p.online)return;
    RECT client{};
    if(!GetClientRect(p.window,&client))return;
    const int width=std::clamp(static_cast<int>(client.right)-24,1,780);
    RECT text_area{0,0,width,0};
    HDC dc=GetDC(p.course_label);
    if(!dc)return;
    const auto font=reinterpret_cast<HFONT>(SendMessageW(p.course_label,WM_GETFONT,0,0));
    const auto previous=SelectObject(dc,font);
    const auto& text=p.online->course_display;
    DrawTextW(dc,text.c_str(),static_cast<int>(text.size()),&text_area,DT_CALCRECT|DT_WORDBREAK|DT_NOPREFIX);
    SelectObject(dc,previous);
    ReleaseDC(p.course_label,dc);
    const int height=std::clamp(static_cast<int>(text_area.bottom)+4,1,std::max(1,static_cast<int>(client.bottom)-10));
    MoveWindow(p.course_label,12,10,width,height,TRUE);
}
void show_lobby(Player& p, const std::wstring& text, bool compact=false) {
    if(compact!=p.compact_lobby){p.compact_lobby=compact;layout_lobby(p);}
    if(p.course_visible){ShowWindow(p.course_label,SW_HIDE);p.course_visible=false;}
    if (p.lobby_text != text) {
        p.lobby_text = text;
        SetWindowTextW(p.lobby,text.c_str());
    }
    if (!IsWindowVisible(p.lobby)) ShowWindow(p.lobby,SW_SHOWNA);
}
void suspend_room(Player& p) {
    if(!p.online)return;
    auto& play=*p.online;
    play.entry.clear(p.surface.get());
    play.scene.suspend();
    play.audio.suspend();
    play.course_caption.clear();
    play.next_course_guide={};
    if(p.surface)p.surface->discard_scene();
    if(play.phase==room::Phase::playing){
        play.phase=room::Phase::reconnecting;
        play.caption=L"Esperando una actualización de la sala…";
    }
    if(play.meeting_ticket){play.meeting_ticket=0;room_menus(p);}
    show_lobby(p,play.caption);
}
bool enter_room(Player& p,std::wstring_view invitation) {
    if(p.online || !p.connection.start(invitation))return false;
    auto& online=p.online.emplace();
    online.third_person=p.third_person;
    release_controls_before_reuse(p);
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
    if(p.surface)p.surface->show_owner_vehicle_art(p.owner_realism);
#endif
    room_menus(p);
    show_lobby(p,online.caption);
    SetWindowTextW(p.window,online.caption.c_str());
    return true;
}
void leave_room(Player& p) {
    if(!p.online)return;
    p.online->audio.suspend();
    p.online->entry.clear(p.surface.get());
    if(p.surface)p.surface->discard_scene();
    p.connection.leave();
    p.online.reset();
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
    if(p.surface)p.surface->show_owner_vehicle_art(p.owner_realism);
#endif
    release_controls_before_reuse(p);
    p.tick=Clock::now();
    p.last_report={};
    room_menus(p);
    show_lobby(p,welcome);
    SetWindowTextW(p.window,L"MUNDO en línea");
}
INT_PTR CALLBACK invitation_dialog(HWND dialog,UINT event,WPARAM w,LPARAM l) {
    if(event==WM_INITDIALOG){
        SetWindowLongPtrW(dialog,DWLP_USER,l);
        SendDlgItemMessageW(dialog,ID_ROOM_INVITE,EM_SETLIMITTEXT,512,0);
        return TRUE;
    }
    if(event!=WM_COMMAND)return FALSE;
    if(LOWORD(w)==IDCANCEL){EndDialog(dialog,IDCANCEL);return TRUE;}
    if(LOWORD(w)!=IDOK)return FALSE;
    std::array<wchar_t,513> link{};
    const int size=GetDlgItemTextW(dialog,ID_ROOM_INVITE,link.data(),static_cast<int>(link.size()));
    auto* player=reinterpret_cast<Player*>(GetWindowLongPtrW(dialog,DWLP_USER));
    const bool accepted=player && enter_room(*player,{link.data(),static_cast<size_t>(size)});
    SecureZeroMemory(link.data(),sizeof(link));
    if(accepted){
        SetDlgItemTextW(dialog,ID_ROOM_INVITE,L"");
        EndDialog(dialog,IDOK);
    }else{
        message(dialog,L"No se pudo usar la invitación. Pega el enlace completo que generó el anfitrión.");
        SetFocus(GetDlgItem(dialog,ID_ROOM_INVITE));
        SendDlgItemMessageW(dialog,ID_ROOM_INVITE,EM_SETSEL,0,-1);
    }
    return TRUE;
}
void neutral_controls(Player& p) {
    release_controls_before_reuse(p);
    if(p.online){
        p.online->jump_pressed=false;
        p.connection.neutral();
    }
}
std::span<const std::byte> resource(HINSTANCE instance, unsigned id) {
    auto entry = FindResourceW(instance, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!entry) return {};
    const auto size = SizeofResource(instance, entry);
    auto handle = LoadResource(instance, entry);
    auto data = handle ? static_cast<const std::byte*>(LockResource(handle)) : nullptr;
    return data ? std::span<const std::byte>(data, size) : std::span<const std::byte>{};
}
constexpr std::array resolutions{Resolution::automatic, Resolution::hd720, Resolution::full_hd, Resolution::qhd,
                                 Resolution::uhd4k, Resolution::uhd8k, Resolution::native};
constexpr std::array details{Detail::automatic, Detail::economy, Detail::balanced, Detail::ultra};
void show_preferences(HWND dialog, const VideoSettings& settings) {
    SendDlgItemMessageW(dialog, ID_RESOLUTION, CB_SETCURSEL,
        std::find(resolutions.begin(), resolutions.end(), settings.resolution) - resolutions.begin(), 0);
    SendDlgItemMessageW(dialog, ID_DETAIL, CB_SETCURSEL,
        std::find(details.begin(), details.end(), settings.detail) - details.begin(), 0);
    SetDlgItemInt(dialog, ID_FPS, settings.fps_cap, FALSE);
}
INT_PTR CALLBACK video_dialog(HWND dialog, UINT event, WPARAM w, LPARAM l) {
    if (event == WM_INITDIALOG) {
        auto& profile = *reinterpret_cast<DeviceVideoProfile*>(l);
        SetWindowLongPtrW(dialog, DWLP_USER, l);
        for (const auto label : {L"Automática", L"720p", L"1080p", L"1440p (QHD)", L"4K (2160p)", L"8K (4320p)", L"Pantalla nativa"})
            SendDlgItemMessageW(dialog, ID_RESOLUTION, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
        for (const auto label : {L"Automático", L"Económico", L"Equilibrado", L"Ultra"})
            SendDlgItemMessageW(dialog, ID_DETAIL, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label));
        SendDlgItemMessageW(dialog, ID_FPS, EM_SETLIMITTEXT, 5, 0);
        show_preferences(dialog, profile.settings());
        return TRUE;
    }
    if (event != WM_COMMAND) return FALSE;
    auto* profile = reinterpret_cast<DeviceVideoProfile*>(GetWindowLongPtrW(dialog, DWLP_USER));
    switch (LOWORD(w)) {
        case ID_DEFAULTS:
            if (profile) show_preferences(dialog, default_video_settings(profile->family()));
            return TRUE;
        case IDOK: {
            if (!profile) return FALSE;
            BOOL integer = FALSE;
            const auto fps = GetDlgItemInt(dialog, ID_FPS, &integer, FALSE);
            const auto r = SendDlgItemMessageW(dialog, ID_RESOLUTION, CB_GETCURSEL, 0, 0);
            const auto d = SendDlgItemMessageW(dialog, ID_DETAIL, CB_GETCURSEL, 0, 0);
            if (!integer || fps > 10000 || r < 0 || static_cast<size_t>(r) >= resolutions.size() ||
                d < 0 || static_cast<size_t>(d) >= details.size()) {
                message(dialog, L"Elige un detalle, una resolución y un límite de FPS entre 0 y 10000.");
                return TRUE;
            }
            auto next = profile->settings();
            next.resolution = resolutions[r]; next.detail = details[d]; next.fps_cap = fps;
            auto status = profile->apply(next);
            if (status == SettingsResult::write_failed || status == SettingsResult::invalid) {
                message(dialog, L"No se pudieron guardar estos ajustes.");
                return TRUE;
            }
            EndDialog(dialog, IDOK);
            return TRUE;
        }
        case IDCANCEL: EndDialog(dialog, IDCANCEL); return TRUE;
    }
    return FALSE;
}

void fullscreen(Player& player) {
    HWND window = player.window;
    if (!player.fullscreen) {
        MONITORINFO monitor{sizeof(MONITORINFO)};
        if (!GetWindowPlacement(window, &player.placement) ||
            !GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor)) return;
        player.window_style = GetWindowLongPtrW(window, GWL_STYLE);
        const RECT r = monitor.rcMonitor;
        SetMenu(window, nullptr);
        SetWindowLongPtrW(window, GWL_STYLE, (player.window_style & ~WS_OVERLAPPEDWINDOW) | WS_POPUP);
        SetWindowPos(window, HWND_TOP, r.left, r.top, r.right-r.left, r.bottom-r.top, SWP_FRAMECHANGED);
    } else {
        SetWindowLongPtrW(window, GWL_STYLE, player.window_style);
        SetMenu(window, player.menu);
        SetWindowPlacement(window, &player.placement);
        SetWindowPos(window, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
        DrawMenuBar(window);
    }
    player.fullscreen = !player.fullscreen;
}
void command(Player& p, unsigned id) {
    switch (id) {
        case ID_ROOM_JOIN:
            if(!p.online)
                DialogBoxParamW(p.instance,MAKEINTRESOURCEW(IDD_ROOM_JOIN),p.window,invitation_dialog,
                                reinterpret_cast<LPARAM>(&p));
            break;
        case ID_ROOM_LEAVE: leave_room(p);break;
        case ID_ROOM_MEETING: {
            if(!p.online || !p.online->scene.ready() || !p.online->meeting_ticket || !p.app_active)break;
            const auto ticket=p.online->meeting_ticket;
            neutral_controls(p);
            const auto answer=MessageBoxW(p.window,L"¿Volver al punto de encuentro de esta sala?",
                L"MUNDO · Punto de encuentro",MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2);
            if(answer!=IDYES || !p.online)break;
            if(!p.app_active || p.online->meeting_ticket!=ticket || !p.connection.return_to_meeting(ticket)){
                message(p.window,L"El regreso ya no está disponible.");
                break;
            }
            p.online->meeting_ticket=0;
            room_menus(p);
            break;
        }
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
        case ID_OWNER_STYLE:
            p.owner_realism=!p.owner_realism;
            p.surface->show_owner_vehicle_art(p.owner_realism);
            CheckMenuItem(p.menu,id,MF_BYCOMMAND|(p.owner_realism?MF_CHECKED:MF_UNCHECKED));
            break;
#endif
        case ID_VIDEO_MENU:
            neutral_controls(p);
            if (p.surface) DialogBoxParamW(p.instance, MAKEINTRESOURCEW(IDD_VIDEO), p.window, video_dialog,
                                          reinterpret_cast<LPARAM>(&p.surface->video_profile()));
            break;
        case ID_FULLSCREEN: fullscreen(p); break;
        case ID_THIRD_PERSON:
            if(p.online)p.online->third_person=!p.online->third_person;
            else p.third_person=!p.third_person;
            break;
        case ID_HELP_KEYS:
            neutral_controls(p);
            message(p.window,L"F6 abre una invitación. Mayús+F6 sale de la sala. Esc abre los ajustes. F11 cambia la pantalla completa.\n"
                L"WASD o flechas para caminar, Mayús para correr y Espacio para saltar. Arrastra para mirar y pulsa F3 para cambiar de cámara.\n"
                L"En un turismo compartido, E conduce o baja y G pide el asiento alternativo. WASD conduce y Espacio frena.");
            break;
        case ID_EXIT_PLAYER: SendMessageW(p.window, WM_CLOSE, 0, 0); break;
    }
    p.tick = Clock::now();
}
LRESULT CALLBACK player_window(HWND window, UINT event, WPARAM w, LPARAM l) {
    auto* p = reinterpret_cast<Player*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (event == WM_NCCREATE) {
        p = static_cast<Player*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
        p->window = window;
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(p));
    }
    if (!p) return DefWindowProcW(window, event, w, l);
    switch (event) {
        case WM_COMMAND: command(*p, LOWORD(w)); return 0;
        case WM_KEYUP:
            if(w<p->wait_for_release.size())p->wait_for_release[w]=false;
            break;
        case WM_KEYDOWN:
            if (l & (1LL<<30)) break;
            if(w<p->wait_for_release.size())p->wait_for_release[w]=false;
            if(w==VK_F6){
                command(*p,(GetKeyState(VK_SHIFT)&0x8000)?ID_ROOM_LEAVE:ID_ROOM_JOIN);
                return 0;
            }
            if(w==VK_F7){command(*p,ID_ROOM_MEETING);return 0;}
            if(w==VK_SPACE && p->online){
                if(p->online->phase==room::Phase::playing && p->online->scene.ready() && !p->online->actors.aboard())
                    p->online->jump_pressed=true;
                return 0;
            }
            if((w=='E'||w=='G') && p->online){
                const auto& play=*p->online;
                if(play.phase==room::Phase::playing && play.scene.ready() && play.actors.has_car()){
                    const auto& actors=play.actors;
                    auto action=room::CarAction::enter;
                    if(w=='G')action=actors.riding()?room::CarAction::enter:room::CarAction::ride;
                    else if(actors.aboard())action=room::CarAction::exit;
                    else if(actors.occupied())action=room::CarAction::ride;
                    if(actors.allows(action))p->connection.vehicle_action(action);
                }
                return 0;
            }
            if (w == VK_ESCAPE) {command(*p, ID_VIDEO_MENU); return 0;}
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
            if (w == VK_F4) {command(*p, ID_OWNER_STYLE); return 0;}
#endif
            if (w == VK_F3) {command(*p, ID_THIRD_PERSON); return 0;}
            if (w == VK_F11) {command(*p, ID_FULLSCREEN); return 0;}
            if (w == VK_F1) {command(*p, ID_HELP_KEYS); return 0;}
            break;
        case WM_LBUTTONDOWN:
            if(!p->online || p->online->phase!=room::Phase::playing || !p->online->scene.ready())return 0;
            SetFocus(window); SetCapture(window); p->dragging = true;
            p->drag_at = {GET_X_LPARAM(l), GET_Y_LPARAM(l)}; return 0;
        case WM_MOUSEMOVE:
            if (p->dragging && p->online && p->online->phase==room::Phase::playing && p->online->scene.ready()) {
                POINT next{GET_X_LPARAM(l), GET_Y_LPARAM(l)};
                double& yaw=p->online->yaw;
                double& pitch=p->online->pitch;
                yaw += (next.x-p->drag_at.x)*.005;
                pitch = std::clamp(pitch-(next.y-p->drag_at.y)*.005,-1.4,1.4);
                p->drag_at = next;
            }
            return 0;
        case WM_LBUTTONUP: if (GetCapture() == window) ReleaseCapture(); return 0;
        case WM_CAPTURECHANGED: p->dragging = false; return 0;
        case WM_ENTERMENULOOP:
        case WM_ENTERSIZEMOVE: neutral_controls(*p);return 0;
        case WM_ACTIVATEAPP:
            p->app_active=(w!=FALSE);
            p->connection.set_active(p->app_active && !IsIconic(window));
            if(p->online)p->online->next_poll={};
            if(!p->app_active)suspend_room(*p);
            break;
        case WM_SIZE:
            layout_course(*p);
            layout_lobby(*p);
            p->connection.set_active(p->app_active && w!=SIZE_MINIMIZED);
            if(w==SIZE_MINIMIZED)suspend_room(*p);
            if(p->online)p->online->next_poll={};
            break;
        case WM_SETFOCUS: release_controls_before_reuse(*p);return 0;
        case WM_KILLFOCUS:
            neutral_controls(*p);
            if (GetCapture() == window) ReleaseCapture();
            p->dragging = false; return 0;
        case WM_DPICHANGED: {
            const RECT& r = *reinterpret_cast<const RECT*>(l);
            SetWindowPos(window, nullptr, r.left, r.top, r.right-r.left, r.bottom-r.top, SWP_NOZORDER | SWP_NOACTIVATE);
            return 0;
        }
        case WM_CTLCOLORSTATIC:
            if(reinterpret_cast<HWND>(l)==p->lobby || reinterpret_cast<HWND>(l)==p->course_label){
                auto dc=reinterpret_cast<HDC>(w);
                SetBkColor(dc,GetSysColor(COLOR_WINDOW));SetTextColor(dc,GetSysColor(COLOR_WINDOWTEXT));
                return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
            }
            break;
        case WM_ERASEBKGND: return 1;
        case WM_PAINT: {PAINTSTRUCT ps{}; BeginPaint(window, &ps); EndPaint(window, &ps); return 0;}
        case WM_CLOSE:
            if(p->online){p->online->audio.suspend();p->connection.leave();}
            p->surface.reset();
            if (p->fullscreen) SetMenu(window, p->menu);
            DestroyWindow(window); return 0;
        case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(window, event, w, l);
}
unsigned room_input_mask(Player& p) {
    auto down = [&](int key){return control_down(p,key);};
    unsigned mask{};
    if(down('W')||down(VK_UP))mask|=1;
    if(down('S')||down(VK_DOWN))mask|=2;
    if(down('A')||down(VK_LEFT))mask|=4;
    if(down('D')||down(VK_RIGHT))mask|=8;
    if(down(VK_SHIFT))mask|=16;
    return mask;
}
void update_room(Player& p, Clock::time_point now) {
    auto& play=*p.online;
    const auto t=std::chrono::duration<double>(now.time_since_epoch()).count();
    const double dt=std::clamp(std::chrono::duration<double>(now-p.tick).count(),0.,.08);
    p.tick=now;
    const bool was_driving=play.actors.driving();
    const bool was_aboard=play.actors.aboard();
    const double previous_view_yaw=was_aboard?play.actors.car_heading()+play.yaw:play.yaw;
    const bool poll_due=now>=play.next_poll;
    if(poll_due){
        play.next_poll=now+std::chrono::milliseconds(12);
        const bool constrained=p.surface && p.surface->memory_constrained();
        auto state=p.connection.poll(constrained);
        if(state.phase==room::Phase::ended || state.phase==room::Phase::offline){
            const auto detail=wide_text(state.message);
            leave_room(p);
            if(!detail.empty())message(p.window,detail.c_str());
            return;
        }
        if(play.phase==room::Phase::playing && state.phase!=room::Phase::playing){
            play.audio.suspend();
            play.scene.suspend();
            play.course_caption.clear();
            play.next_course_guide={};
            p.surface->discard_scene();
        }
        play.entry.accept(state,p.surface.get());
        const bool installed=state.world.has_value();
        if(installed){
            play.scene.install(state,play.actors);
            play.audio.install(play.scene.world(), true);
            for (const auto& clip : state.audio_clips)
                play.audio.install_clip(clip.key, std::as_bytes(std::span(clip.bytes)));
            play.course_caption.clear();
            play.next_course_guide={};
            neutral_controls(p);
            play.yaw=0.;play.pitch=0.;
        }
        if(state.region){
            play.scene.replace_region(std::move(state.region->world),std::move(state.region->terrain));
            play.audio.install(play.scene.world(), false);
            p.surface->trim_on_next_scene();
        }
        if (installed || state.region) state.confirm_install();
        if(state.snapshot){
            const bool snap=state.meeting_returned || state.phase!=play.phase;
            const bool previously_ready=play.scene.ready();
            play.actors.accept(*state.snapshot,state.seat,t,snap);
            if(constrained)play.scene.reduce_memory();
            if(play.scene.follow(*state.snapshot,state.seat,play.actors,t,snap) || installed)
                p.surface->trim_on_next_scene();
            if(previously_ready!=play.scene.ready())neutral_controls(p);
            const auto caption=wide_text(room::course_caption(state.snapshot->course));
            if(caption!=play.course_caption){
                play.course_caption=caption;play.next_course_guide={};
            }
        }
        if(state.phase==room::Phase::playing && now>=play.next_course_guide){
            play.next_course_guide=now+std::chrono::milliseconds(500);
            auto text=play.course_caption;
            if(!text.empty() && play.actors.aboard()){
                const auto direction=wide_text(play.actors.car_guide(play.yaw));
                if(!direction.empty())text+=L" · "+direction;
            }
            if(text!=play.course_display){
                play.course_display=text;
                SetWindowTextW(p.course_label,text.c_str());
                layout_course(p);
            }
        }
        if(state.meeting_returned)neutral_controls(p);
        const auto ticket=state.meeting_available && state.phase==room::Phase::playing && play.scene.ready() &&
                          !play.actors.aboard()?state.meeting_ticket:0;
        if(ticket!=play.meeting_ticket){play.meeting_ticket=ticket;room_menus(p);}
        if(!state.meeting_notice.empty()){
            play.meeting_notice=wide_text(state.meeting_notice);
            play.notice_until=now+std::chrono::seconds(8);
            SetWindowTextW(p.window,play.meeting_notice.c_str());
        }
        const bool transition = state.phase!=play.phase || installed;
        if(transition){
            play.phase=state.phase;
            neutral_controls(p);
            if(state.phase==room::Phase::playing){
                play.waiting_message.clear();
                play.caption=L"Sala · "+wide_text(state.title)+L" · Jugador "+std::to_wstring(state.seat+1);
            }
        }
        if(state.phase!=room::Phase::playing && (transition || play.waiting_message!=state.message)){
            play.waiting_message=std::move(state.message);
            play.caption=play.waiting_message.empty()
                ? (state.phase==room::Phase::joining?L"Conectando a la sala…":L"Reconectando con la sala…")
                : wide_text(play.waiting_message);
        }
        // show_lobby updates its label only when the caption changes. Keep the
        // top-level title and input state stable between download milestones.
        if(transition)SetWindowTextW(p.window,play.caption.c_str());
    }
    if(play.phase!=room::Phase::playing || !play.scene.ready())return;
    play.actors.advance(play.scene.world(),t,dt);
    const bool driving=play.actors.driving();
    const bool aboard=play.actors.aboard();
    if(aboard!=was_aboard || driving!=was_driving){
        if(aboard!=was_aboard){
            play.yaw=aboard?0.:previous_view_yaw;
            play.pitch=aboard?-.13:0.;
        }
        play.jump_pressed=false;
        release_controls_before_reuse(p);
    }
    if(poll_due){
        if(play.phase==room::Phase::playing)
            p.connection.input(play.actors.riding()?0:room_input_mask(p),aboard?play.actors.car_heading():play.yaw,
                               !aboard && play.jump_pressed,driving && control_down(p,VK_SPACE));
        play.jump_pressed=false;
    }
    if(aboard){
        play.camera=play.actors.vehicle_camera(play.scene.terrain(),play.yaw,play.pitch,play.third_person,play.draw_self);
        return;
    }
    if(const auto feet=play.actors.local_feet()){
        play.camera.eye={feet->x,feet->y+1.58,feet->z};
        const double cp=std::cos(play.pitch);
        play.camera.forward={cp*std::sin(play.yaw),std::sin(play.pitch),-cp*std::cos(play.yaw)};
        play.draw_self=play.third_person && play.actors.follow_pedestrian(play.camera,play.scene.terrain());
    }
}
bool draw_frame(Player& p) {
    const auto& play=*p.online;
    return p.surface->frame_with_peer(play.scene.world(),play.camera,{},
        play.draw_self?play.actors.local_avatar():nullptr,play.actors.peer_avatar(),play.actors.vehicles(),play.actors.npc_avatars());
}
std::wstring room_title(const RoomPlay& play){
    if(play.phase==room::Phase::playing && Clock::now()<play.notice_until)
        return play.caption+L" · "+play.meeting_notice;
    if(play.phase!=room::Phase::playing || !play.actors.has_car())return play.caption;
    if(play.actors.driving()){
        const auto kmh=std::lround(std::abs(play.actors.car_speed())*3.6);
        return play.caption+L" · Conduciendo · "+std::to_wstring(kmh)+L" km/h · Espacio frena · E baja";
    }
    if(play.actors.riding())return play.caption+(play.actors.occupied()?L" · Pasajero · E baja":L" · Pasajero · G toma el volante · E baja");
    return play.caption+L" · "+wide_text(play.actors.car_guide(play.yaw))+
        (play.actors.occupied()?L" · E sube de pasajero":L" · E conduce · G sube de pasajero");
}
void run(Player& p) {
    MSG msg{};
    for (;;) {
        while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) return;
            TranslateMessage(&msg); DispatchMessageW(&msg);
        }
        auto now = Clock::now();
        if (IsIconic(p.window) || GetForegroundWindow() != p.window) {
            if(p.online)p.online->audio.suspend();
            p.last_report = {}; p.frames = 0;
            // Input and focus events wake the inactive player without polling the GPU.
            MsgWaitForMultipleObjectsEx(0, nullptr, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
            p.tick = Clock::now();
            continue;
        }
        if(p.online)update_room(p,now);
        if(!p.online || p.online->phase!=room::Phase::playing || !p.online->scene.ready() || !p.online->actors.local_feet()){
            if(p.online)p.online->audio.suspend();
            if(p.online && p.online->entry.draw(*p.surface,{}))
                show_lobby(p,L"Zona de entrada · "+p.online->caption,true);
            else if(p.online && p.online->phase==room::Phase::playing && !p.online->scene.ready())
                show_lobby(p,L"Preparando el terreno de la partida…");
            else
                show_lobby(p,p.online?p.online->caption:welcome);
            p.last_report={};p.last_present={};p.frames=0;
            MsgWaitForMultipleObjectsEx(0,nullptr,p.online?25:INFINITE,QS_ALLINPUT,MWMO_INPUTAVAILABLE);
            continue;
        }
        const auto& forward = p.online->camera.forward;
        p.online->audio.frame(*p.online->actors.local_feet(), std::atan2(forward.x, -forward.z));
        const auto cap = p.surface->video_profile().settings().fps_cap;
        if (cap && p.last_present != Clock::time_point{}) {
            const auto remaining = 1000.0/cap - std::chrono::duration<double,std::milli>(now-p.last_present).count();
            if (remaining >= 1.0) {
                MsgWaitForMultipleObjectsEx(0, nullptr, static_cast<DWORD>(std::min(remaining,8.0)), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                continue;
            }
        }
        if (!draw_frame(p)) {
            if(p.compact_lobby)show_lobby(p,p.online->caption);
            SwitchToThread();continue;
        }
        if(IsWindowVisible(p.lobby))ShowWindow(p.lobby,SW_HIDE);
        if(p.compact_lobby){p.compact_lobby=false;layout_lobby(p);}
        const bool show_course=!p.online->course_caption.empty();
        if(show_course!=p.course_visible){
            ShowWindow(p.course_label,show_course?SW_SHOWNA:SW_HIDE);
            p.course_visible=show_course;
        }
        p.last_present = now;
        if (p.last_report == Clock::time_point{}) { p.last_report = now; p.frames = 0; continue; }
        ++p.frames;
        const double seconds = std::chrono::duration<double>(now-p.last_report).count();
        if (seconds >= 1) {
            const auto quality = p.surface->requested_quality();
            const auto dims = quality ? L" · Superficie "+std::to_wstring(quality->video.surface_width)+L" × "+
                std::to_wstring(quality->video.surface_height)+L" · Render solicitado "+
                std::to_wstring(quality->video.render_width)+L" × "+std::to_wstring(quality->video.render_height) : std::wstring{};
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
            const auto badge=p.owner_realism?L"MUNDO Propietario · Realismo · ":L"MUNDO Propietario · Bloques · ";
#else
            const auto badge=L"MUNDO · ";
#endif
            const auto title = badge + room_title(*p.online) + L" · " + std::to_wstring(std::lround(p.frames/seconds)) +
                               L" FPS enviados" + dims + L" · F1 controles";
            SetWindowTextW(p.window, title.c_str()); p.frames = 0; p.last_report = now;
        }
    }
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    std::array<wchar_t,257> host_seat{};
    const DWORD seat_length = GetEnvironmentVariableW(L"MUNDO_HOST_SEAT", host_seat.data(),
        static_cast<DWORD>(host_seat.size()));
    SetEnvironmentVariableW(L"MUNDO_HOST_SEAT", nullptr);
    using SetDpi = BOOL (WINAPI*)(HANDLE);
    auto set_dpi = reinterpret_cast<SetDpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
    if (!set_dpi || !set_dpi(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4)))) SetProcessDPIAware();
    Player p; p.instance = instance;
    WNDCLASSW wc{}; wc.lpfnWndProc = player_window; wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW); wc.lpszClassName = L"MundoEngiePlayer";
    if (!RegisterClassW(&wc)) return 1;
    p.menu = LoadMenuW(instance, MAKEINTRESOURCEW(IDR_MAIN_MENU));
    if (!p.menu) return 1;
    auto window = CreateWindowExW(0, wc.lpszClassName, L"MUNDO en línea", WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
        CW_USEDEFAULT, CW_USEDEFAULT, 1280, 800, nullptr, p.menu, instance, &p);
    if (!window) {DestroyMenu(p.menu); return 1;}
    RECT client{};GetClientRect(window,&client);
    p.lobby=CreateWindowExW(0,L"STATIC",welcome,WS_CHILD|WS_VISIBLE|SS_CENTER|SS_CENTERIMAGE,
        0,0,client.right,client.bottom,window,nullptr,instance,nullptr);
    if(!p.lobby){DestroyWindow(window);return 1;}
    p.course_label=CreateWindowExW(WS_EX_NOACTIVATE,L"STATIC",L"",WS_CHILD|SS_CENTER|SS_NOPREFIX,
        12,10,std::clamp(int(client.right)-24,1,780),42,window,nullptr,instance,nullptr);
    if(!p.course_label){DestroyWindow(window);return 1;}
    SendMessageW(p.course_label,WM_SETFONT,reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)),FALSE);
    p.lobby_text=welcome;
    p.surface = mundo::Surface::attach(window, mundo::GraphicsAPI::automatic, resource(instance, IDR_MATERIAL));
    if (!p.surface) {
        message(window, L"No se pudo iniciar el renderizador de MUNDO.");
        SendMessageW(window, WM_CLOSE, 0, 0); return 1;
    }
#ifdef MUNDO_WINDOWS_OWNER_PLAYER
    const auto bruma_art=resource(instance,IDR_OWNER_BRUMA);
    if(bruma_art.empty()||!p.surface->load_owner_vehicle_art(resource(instance,IDR_OWNER_TURISMO),bruma_art)){
        message(window,L"No se pudo cargar el catálogo privado de vehículos.");
        SendMessageW(window,WM_CLOSE,0,0);return 1;
    }
#endif
    room_menus(p);
    ShowWindow(window, show); UpdateWindow(window);
    int argc = 0;
    if (auto argv = CommandLineToArgvW(GetCommandLineW(), &argc)) {
        if(argc==2 && std::wstring_view(argv[1])==L"--room")command(p,ID_ROOM_JOIN);
        else if(argc==2 && std::wstring_view(argv[1])==L"--host-seat"){
            if(!seat_length || seat_length>=host_seat.size() ||
               !enter_room(p,std::wstring_view(host_seat.data(),seat_length)))
                message(window,L"No se pudo abrir la invitación de esta plaza. Puedes pegarla desde Sala.");
        }else if(argc==2 && !enter_room(p,argv[1]))message(window,L"Entra con una invitación del anfitrión.");
        LocalFree(argv);
    }
    SecureZeroMemory(host_seat.data(),sizeof(host_seat));
    run(p);
    return 0;
}
