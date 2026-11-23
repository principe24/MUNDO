#pragma once
#include "mundo/graphics.hpp"
#include "mundo/device_settings.hpp"
#ifdef MUNDO_HAS_SIGNED_ART
#include "mundo/release_store.hpp"
#endif

#if defined(__ANDROID__)
struct ANativeActivity;
#endif

namespace mundo {
enum class GraphicsAPI { automatic, vulkan, metal, opengl };
// Called by the platform on its render thread. The host owns the native window.
class Surface {
public:
    static std::unique_ptr<Surface> attach(void* native_window,GraphicsAPI,std::span<const std::byte> trusted_material);
    static std::unique_ptr<Surface> attach(void* native_window, GraphicsAPI, std::span<const std::byte> trusted_material,
                                           std::filesystem::path private_settings_directory);
#ifdef MUNDO_HAS_SIGNED_ART
    static std::unique_ptr<Surface> attach_signed(void* native_window, GraphicsAPI,
        std::span<const std::byte> trusted_material, const std::filesystem::path& private_directory,
        const PublishedArt::PublicKey& pinned_key, std::uint64_t minimum_revision);
    [[nodiscard]] ReleaseStatus install_signed(std::span<const std::byte> envelope);
#endif
#if defined(__ANDROID__)
    static std::unique_ptr<Surface> attach_android(const ANativeActivity&, void* native_window, GraphicsAPI,
                                                   std::span<const std::byte> trusted_material);
#endif
    ~Surface();
    Surface(const Surface&)=delete;
    Surface& operator=(const Surface&)=delete;
    bool frame(const World&,const CameraPose&,const DisplayCaps&,const VideoSettings&);
    bool frame(const World&,const CameraPose&,const DisplayCaps&);
    // Windows / Android / Metal surfaces can supply native dimensions. A host may pass measured caps above.
    bool frame_auto(const World&,const CameraPose&);
    bool frame_with_avatar(const World&,const CameraPose&,const DisplayCaps&,const BlockAvatar*,
                           const VehicleSession* vehicles=nullptr);
    bool frame_with_peer(const World&,const CameraPose&,const DisplayCaps&,
                         const BlockAvatar* local,const BlockAvatar* peer,const VehicleSession* vehicles=nullptr,
                         std::span<const BlockAvatar* const> npcs={});
    bool frame_auto(const World&,const CameraPose&,const VideoSettings& settings);
    // Apply or reset from the in-game menu on the owning thread. Changes take effect next frame.
    DeviceVideoProfile& video_profile() noexcept;
#ifdef MUNDO_OWNER_VEHICLE_ART
    bool load_owner_vehicle_art(std::span<const std::byte> bundled,std::span<const std::byte> bruma={});
    void show_owner_vehicle_art(bool enabled);
#endif
    bool install_art(std::shared_ptr<const PublishedArt> release);
    // Release scene renderables and geometry while retaining the native swapchain and art catalog.
    void discard_scene();
    // The next scene sync keeps shared meshes and retires buffers omitted by a residency transition.
    void trim_on_next_scene();
    [[nodiscard]] bool memory_constrained() const;
    std::optional<FrameQuality> requested_quality() const;
    [[nodiscard]] SceneFrameStats last_scene_stats() const;
private:
    struct Impl;
    explicit Surface(std::unique_ptr<Impl>);
    std::unique_ptr<Impl> impl_;
};
}
