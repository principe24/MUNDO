#pragma once
#include "mundo/appearance.hpp"
#include <filesystem>

namespace mundo {
enum class ReleaseStatus { ready, missing, already_current, stale, invalid, invalid_cache, busy, io_error };
struct ReleaseResult {
    ReleaseStatus status;
    std::shared_ptr<const PublishedArt> art{};
};

class ReleaseStore {
public:
    ReleaseStore(std::filesystem::path private_directory, PublishedArt::PublicKey pinned_key,
                 std::uint64_t required_revision);
    // Verifies the persisted bytes each time the application opens its local catalog.
    [[nodiscard]] ReleaseResult current() const;
    // Equal revisions are idempotent only when every byte of the signed envelope is identical.
    [[nodiscard]] ReleaseResult accept(std::span<const std::byte> envelope,
                                       std::uint64_t active_revision = 0) const;
private:
    std::filesystem::path directory_;
    PublishedArt::PublicKey key_;
    std::uint64_t minimum_;
};
} // namespace mundo
