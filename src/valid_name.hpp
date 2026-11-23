#pragma once
#include <cstdint>
#include <string_view>

namespace mundo {
inline bool valid_name(std::string_view name, std::size_t max_bytes) {
    if (name.empty() || name.size() > max_bytes) return false;
    for (std::size_t pos = 0; pos < name.size();) {
        const auto ch = static_cast<unsigned char>(name[pos++]);
        if (ch < 0x80) { if (ch < 0x20 || ch == 0x7f) return false; continue; }
        const unsigned count = ch >= 0xc2 && ch <= 0xdf ? 1 : ch >= 0xe0 && ch <= 0xef ? 2 : ch >= 0xf0 && ch <= 0xf4 ? 3 : 0;
        if (!count || name.size() - pos < count) return false;
        std::uint32_t cp = ch & (0x7fU >> (count + 1));
        for (unsigned i = 0; i < count; ++i) {
            const auto c = static_cast<unsigned char>(name[pos++]);
            if ((c & 0xc0) != 0x80) return false;
            cp = (cp << 6) | (c & 0x3f);
        }
        if ((count == 2 && cp < 0x800) || (count == 3 && cp < 0x10000) ||
            (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff || (cp >= 0x80 && cp <= 0x9f)) return false;
    }
    return true;
}
}
