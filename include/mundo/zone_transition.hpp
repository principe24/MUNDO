#pragma once
#include "mundo/zones.hpp"
#include "mundo/character.hpp"
#include <future>

namespace mundo {
// Owners keep the archive and live world alive and read-only until poll or finish completes.
class ZoneTransition {
public:
    enum class Status { ready, waiting, failed };
    Status update(ZoneArchive&,Vec3,unsigned,EntityId,World&,std::optional<CharacterTerrain>&);
    bool pending() const {return task_.valid();}
    void finish();
private:
    struct Region { World world; CharacterTerrain terrain; };
    std::future<std::optional<Region>> task_;
};
}
