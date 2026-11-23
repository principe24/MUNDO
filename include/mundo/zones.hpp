#pragma once
#include "mundo/world.hpp"
#include <filesystem>
#include <fstream>
#include <memory>

namespace mundo {
// A single owning thread reads ranges and keeps decoded pages in the current neighborhood.
class ZoneArchive {
public:
    static std::optional<ZoneArchive> open(const std::filesystem::path&);
    const World& permanent() const { return permanent_; }
    bool needs(Vec3 position,unsigned radius) const;
    std::optional<World> select(Vec3 position,unsigned radius,const World* current=nullptr);
private:
    using Cell=std::pair<std::int32_t,std::int32_t>;
    struct Entry { std::uint32_t start,size,count; };
    static std::optional<Cell> cell(Vec3);
    std::optional<World> read(Entry);
    std::ifstream file_;
    World permanent_;
    std::map<Cell,Entry> directory_;
    std::map<Cell,std::shared_ptr<const World>> cache_;
    std::optional<Cell> center_;
    unsigned radius_{};
};
}
