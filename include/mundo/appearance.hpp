#pragma once
#include "mundo/runtime.hpp"
#include <array>
#include <memory>

namespace mundo {
enum class ArtStyle : std::uint8_t { blocks = 0, realistic = 1 };
struct Section { std::uint32_t first{}, count{}; Material material{}; };
struct ArtLevel { Mesh mesh; std::vector<Section> sections; };
struct ModelArt { std::array<ArtLevel,3> levels; };
constexpr std::size_t max_pack_bytes = 32 * 1024 * 1024;
constexpr std::size_t release_header_bytes = 8 + 8 + 1 + 4 + 4;
constexpr std::size_t max_release_bytes = 64 + release_header_bytes + 2 * max_pack_bytes;

// Public playback accepts published art. The offline owner preview uses a build-time resource.
class ArtPack {
public:
    static std::optional<ArtPack> read(std::span<const std::byte> bytes,ArtStyle expected);
    const ArtLevel* find(VisualKey key,Detail detail) const;
    bool covers(const ArtPack& other) const;
private:
    std::map<VisualKey,ModelArt> models_;
};

class PublishedArt {
public:
    using PublicKey=std::array<std::uint8_t,32>;
    // The linked base contains only block art. No external bytes or signing key enter here.
    static std::shared_ptr<const PublishedArt> builtin_blocks();
    // Pass the key pinned by the host and its saved minimum publication number.
    static std::shared_ptr<const PublishedArt> open_signed(std::span<const std::byte> envelope,
        const PublicKey& trusted_key,std::uint64_t minimum_revision);
    const ArtLevel* find(VisualKey key,Detail detail) const;
    std::uint64_t revision() const noexcept { return revision_; }
    ArtStyle style() const noexcept { return style_; }
    PublishedArt(const PublishedArt&)=delete;
    PublishedArt& operator=(const PublishedArt&)=delete;
private:
    PublishedArt()=default;
    std::uint64_t revision_{};
    ArtStyle style_{ArtStyle::blocks};
    ArtPack blocks_;
    std::optional<ArtPack> realistic_;
};
}
