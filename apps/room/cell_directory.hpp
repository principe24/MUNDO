#pragma once

#include "mundo/world.hpp"

#include <cstdint>
#include <vector>

namespace mundo::room {

// A row assigns a complete top-level subtree to one cell. Omitted roots stay global.
struct CellRoot {
    EntityId root;
    std::int32_t x, z;
};
using CellDirectory = std::vector<CellRoot>;

} // namespace mundo::room
