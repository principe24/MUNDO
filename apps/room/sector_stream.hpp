#pragma once
#include "room_http.hpp"
#include "mundo/character.hpp"
#include "mundo/room_wire.hpp"
#include <cstdint>
#include <functional>
#include <map>

namespace mundo::room {
struct SectorRow {
    std::int32_t x{}, z{};
    std::size_t bytes{}, nodes{};
    std::string hash;
};
struct SectorWindow {
    std::int32_t x{}, z{};
    unsigned radius{};
    std::size_t full_bytes{};
    std::string revision, token;
    std::vector<SectorRow> rows;
};
struct SectorPlan : SectorWindow {};
struct AheadPlan {
    SectorWindow window;
    std::int32_t base_x{}, base_z{};
};
enum class AheadStage { outside, via_x, via_z, target };
[[nodiscard]] AheadStage ahead_stage(std::int32_t base_x,std::int32_t base_z,std::int32_t target_x,
                                    std::int32_t target_z,std::int32_t x,std::int32_t z) noexcept;

using SectorPageFetch=std::function<std::optional<std::vector<std::byte>>(std::size_t slot,std::size_t offset)>;
using SectorBlob=std::shared_ptr<const std::vector<std::byte>>;
class AheadCache;
using AheadProgress=std::function<void(std::shared_ptr<const AheadCache>)>;
class SectorCache {
public:
    void clear(){revision_.clear();ahead_token_.clear();blobs_.clear();}
private:
    friend std::optional<World> assemble_sector(const SectorPlan&,SectorCache&,const SectorPageFetch&,CancelToken,const AheadCache*,std::uint16_t*);
    struct CachedBlob {
        SectorBlob bytes;
        std::uint16_t ahead_bit{};
    };
    // A window can retain provenance from at most one unexpired MAH1 grant.
    std::string revision_, ahead_token_;
    std::map<std::string,CachedBlob> blobs_;
};

class AheadCache {
public:
    [[nodiscard]] std::string_view token() const noexcept { return token_; }
    [[nodiscard]] std::uint16_t verified_mask() const noexcept { return verified_mask_; }
private:
    friend std::shared_ptr<const AheadCache> prefetch_ahead(const AheadPlan&,const SectorPageFetch&,CancelToken,const AheadProgress&);
    friend std::optional<World> assemble_sector(const SectorPlan&,SectorCache&,const SectorPageFetch&,CancelToken,const AheadCache*,std::uint16_t*);
    struct Piece {
        std::int32_t x{}, z{};
        std::size_t nodes{};
        std::uint16_t slot_bit{};
        SectorBlob blob;
    };
    std::string revision_;
    std::string token_;
    std::uint16_t verified_mask_{};
    std::int32_t base_x_{}, base_z_{}, x_{}, z_{};
    unsigned radius_{};
    std::size_t full_bytes_{};
    std::map<std::string,Piece> pieces_;
};

[[nodiscard]] std::optional<SectorPlan> read_sector_plan(std::span<const std::byte>,std::string_view revision,bool mobile);
[[nodiscard]] std::optional<AheadPlan> read_ahead_plan(std::span<const std::byte>,std::string_view revision,bool mobile,
                                                      std::int32_t base_x,std::int32_t base_z);
[[nodiscard]] std::shared_ptr<const AheadCache> prefetch_ahead(const AheadPlan&,const SectorPageFetch&,CancelToken,
                                                              const AheadProgress& publish={});
[[nodiscard]] std::optional<World> assemble_sector(const SectorPlan&,SectorCache&,const SectorPageFetch&,CancelToken,
                                                 const AheadCache* ahead=nullptr,std::uint16_t* used=nullptr);
[[nodiscard]] bool sector_supports(const World&,const CharacterTerrain&,const Snapshot&,unsigned seat);
}
