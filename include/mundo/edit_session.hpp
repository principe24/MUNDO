#pragma once

#include "mundo/world.hpp"

namespace mundo {

enum class EditSessionStatus { committed, unchanged, rejected, conflict, history_limit };
struct EditSessionResult {
    EditSessionStatus status;
    WorldEditResult edits;
};

// Owns a document for one editor. History is session-local; a backup or saved
// document can outlive the session. The byte budget counts allocated snapshot
// payloads; it excludes the working World and temporary transaction storage.
class WorldEditSession {
public:
    explicit WorldEditSession(World initial, std::size_t max_steps = 32,
                              std::size_t max_bytes = 64 * 1024 * 1024);
    [[nodiscard]] const World& world() const noexcept { return current_; }
    [[nodiscard]] std::size_t undo_count() const noexcept { return cursor_; }
    [[nodiscard]] std::size_t redo_count() const noexcept {
        return history_.empty() ? 0 : history_.size() - cursor_ - 1;
    }
    [[nodiscard]] std::size_t history_bytes() const noexcept { return retained_; }
    [[nodiscard]] EditSessionResult apply(std::span<const WorldEdit> edits,
                                          std::optional<std::string_view> expected = {});
    [[nodiscard]] bool undo();
    [[nodiscard]] bool redo();
private:
    [[nodiscard]] bool restore_at(std::size_t position);
    World current_;
    std::size_t max_steps_, max_bytes_;
    std::vector<std::vector<std::byte>> history_;
    std::size_t cursor_{}, retained_{};
};

} // namespace mundo
