#include "mundo/surface.hpp"
#include <filament/Engine.h>
#include <filament/SwapChain.h>
#include "../platform/display.hpp"
#include <utility>
#if defined(__ANDROID__)
#include <android/native_activity.h>
#endif

namespace mundo {
struct Surface::Impl {
    filament::Engine* engine{};
    filament::SwapChain* swap{};
    std::unique_ptr<Graphics> graphics;
    DeviceVideoProfile profile;
#ifdef MUNDO_HAS_SIGNED_ART
    std::unique_ptr<ReleaseStore> releases;
    std::uint64_t active_revision{};
#endif
    void* window{};
    bool metal{};
    explicit Impl(std::filesystem::path settings_directory) : profile(std::move(settings_directory)) {}
    ~Impl(){
        graphics.reset();
        if(swap)engine->destroy(swap);
        if(engine)filament::Engine::destroy(&engine);
    }
};
Surface::Surface(std::unique_ptr<Impl> impl):impl_(std::move(impl)){}
Surface::~Surface()=default;
std::unique_ptr<Surface> Surface::attach(void* window,GraphicsAPI api,std::span<const std::byte> material){
    return attach(window, api, material, default_settings_directory());
}
#if defined(__ANDROID__)
std::unique_ptr<Surface> Surface::attach_android(const ANativeActivity& activity, void* window,
                                                 GraphicsAPI api, std::span<const std::byte> material) {
    if (!activity.internalDataPath || !*activity.internalDataPath) return {};
    return attach(window, api, material, std::filesystem::path(activity.internalDataPath) / "settings");
}
#endif
std::unique_ptr<Surface> Surface::attach(void* window, GraphicsAPI api, std::span<const std::byte> material,
                                         std::filesystem::path settings_directory) {
    if(!window||material.empty())return {};
    using Backend=filament::Engine::Backend;
    Backend backend=Backend::DEFAULT;
    switch(api){
      case GraphicsAPI::automatic: break;
      case GraphicsAPI::vulkan: backend=Backend::VULKAN;break;
      case GraphicsAPI::metal: backend=Backend::METAL;break;
      case GraphicsAPI::opengl: backend=Backend::OPENGL;break;
    }
    auto p=std::make_unique<Impl>(std::move(settings_directory));p->engine=filament::Engine::create(backend);
    if(!p->engine)return {};
    p->window=window;p->metal=p->engine->getBackend()==Backend::METAL;
    p->swap=p->engine->createSwapChain(window);
    if(!p->swap)return {};
    p->graphics=Graphics::create(*p->engine,material);
    if(!p->graphics)return {};
    return std::unique_ptr<Surface>(new Surface(std::move(p)));
}
bool Surface::frame_with_avatar(const World& world,const CameraPose& cam,const DisplayCaps& caps,const BlockAvatar* actor,const VehicleSession* vehicles){
    auto actual=caps;
    supplement_display(actual,impl_->window,impl_->metal);
    return impl_->graphics->frame(*impl_->swap,world,cam,actual,impl_->profile.settings(),actor,vehicles);
}
bool Surface::frame_with_peer(const World& world,const CameraPose& camera,const DisplayCaps& caps,
                              const BlockAvatar* local,const BlockAvatar* peer,const VehicleSession* vehicles,
                              std::span<const BlockAvatar* const> npcs){
    auto actual=caps;
    supplement_display(actual,impl_->window,impl_->metal);
    return impl_->graphics->frame_with_peer(*impl_->swap,world,camera,actual,impl_->profile.settings(),local,peer,vehicles,npcs);
}
DeviceVideoProfile& Surface::video_profile() noexcept { return impl_->profile; }
bool Surface::frame(const World& world, const CameraPose& camera, const DisplayCaps& caps) {
    return frame(world, camera, caps, impl_->profile.settings());
}
bool Surface::frame_auto(const World& world, const CameraPose& camera) {
    return frame(world, camera, DisplayCaps{}, impl_->profile.settings());
}
bool Surface::frame(const World& world,const CameraPose& camera,const DisplayCaps& caps,const VideoSettings& settings){
    auto actual=caps;supplement_display(actual,impl_->window,impl_->metal);
    return impl_->graphics->frame(*impl_->swap,world,camera,actual,settings);
}
bool Surface::frame_auto(const World& world,const CameraPose& camera,const VideoSettings& settings){
    return frame(world,camera,DisplayCaps{},settings);
}
#ifdef MUNDO_HAS_SIGNED_ART
std::unique_ptr<Surface> Surface::attach_signed(void* window,GraphicsAPI api,std::span<const std::byte> material,
    const std::filesystem::path& directory,const PublishedArt::PublicKey& key,std::uint64_t floor) {
    if(directory.empty())return {};
    auto store=std::make_unique<ReleaseStore>(directory/"signed-art",key,floor);
    auto cached=store->current();
    if(cached.status!=ReleaseStatus::ready && cached.status!=ReleaseStatus::missing && cached.status!=ReleaseStatus::stale)return {};
    auto surface=attach(window,api,material,directory/"settings");
    if(!surface)return {};
    if(cached.art){
        surface->impl_->active_revision=cached.art->revision();
        if(!surface->impl_->graphics->install_art(std::move(cached.art)))return {};
    }
    surface->impl_->releases=std::move(store);
    return surface;
}
ReleaseStatus Surface::install_signed(std::span<const std::byte> envelope) {
    if(!impl_->releases)return ReleaseStatus::io_error;
    auto result=impl_->releases->accept(envelope,impl_->active_revision);
    if(result.art && result.art->revision()>impl_->active_revision){
        const auto revision=result.art->revision();
        if(!impl_->graphics->install_art(std::move(result.art)))return ReleaseStatus::invalid;
        impl_->active_revision=revision;
    }
    return result.status;
}
#endif
#ifdef MUNDO_OWNER_VEHICLE_ART
bool Surface::load_owner_vehicle_art(std::span<const std::byte> bundled,std::span<const std::byte> bruma){
    return impl_->graphics->load_owner_vehicle_art(bundled,bruma);
}
void Surface::show_owner_vehicle_art(bool enabled){impl_->graphics->show_owner_vehicle_art(enabled);}
#endif
bool Surface::install_art(std::shared_ptr<const PublishedArt> release){
#ifdef MUNDO_HAS_SIGNED_ART
    if(impl_->releases)return false;
#endif
    return impl_->graphics->install_art(std::move(release));
}
std::optional<FrameQuality> Surface::requested_quality() const{return impl_->graphics->requested_quality();}
void Surface::discard_scene(){impl_->graphics->discard_scene();}
void Surface::trim_on_next_scene(){impl_->graphics->trim_on_next_scene();}
bool Surface::memory_constrained() const{return impl_->graphics->memory_constrained();}
SceneFrameStats Surface::last_scene_stats() const{return impl_->graphics->last_scene_stats();}
}
