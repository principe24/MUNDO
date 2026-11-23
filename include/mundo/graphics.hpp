#pragma once
#include "mundo/runtime.hpp"
#include "mundo/appearance.hpp"
#include "mundo/visibility.hpp"
#include <memory>
#include <span>

namespace filament { class Engine; class SwapChain; }
namespace mundo {

class BlockAvatar;
class VehicleSession;

// The platform owns the GPU engine and swapchain. They must outlive this object.
// The material package is the trusted, precompiled materials/surface.mat shipped by the host.
class Graphics {
public:
    static std::unique_ptr<Graphics> create(filament::Engine&,std::span<const std::byte> material_package);
    ~Graphics();
    Graphics(const Graphics&)=delete;
    Graphics& operator=(const Graphics&)=delete;
    bool frame(filament::SwapChain&,const World&,const CameraPose&,const DisplayCaps&,const VideoSettings&);
    bool frame(filament::SwapChain&,const World&,const CameraPose&,const DisplayCaps&,const VideoSettings&,const BlockAvatar* actor,
               const VehicleSession* vehicles=nullptr);
    bool frame_with_peer(filament::SwapChain&,const World&,const CameraPose&,const DisplayCaps&,
                         const VideoSettings&,const BlockAvatar* local,const BlockAvatar* peer,
                         const VehicleSession* vehicles=nullptr, std::span<const BlockAvatar* const> npcs={});
#ifdef MUNDO_OWNER_VEHICLE_ART
    bool load_owner_vehicle_art(std::span<const std::byte> bundled,std::span<const std::byte> bruma={});
    void show_owner_vehicle_art(bool enabled);
#endif
    bool install_art(std::shared_ptr<const PublishedArt> release);
    void discard_scene();
    void trim_on_next_scene();
    [[nodiscard]] bool memory_constrained() const;
    std::optional<FrameQuality> requested_quality() const;
    [[nodiscard]] SceneFrameStats last_scene_stats() const;
private:
    bool draw_frame(filament::SwapChain&,const World&,const CameraPose&,const DisplayCaps&,
                    const VideoSettings&,const BlockAvatar*,const VehicleSession*,const BlockAvatar* peer,
                    std::span<const BlockAvatar* const> npcs={});
    struct Impl;
    explicit Graphics(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};
}
