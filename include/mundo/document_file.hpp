#pragma once

#include "mundo/project.hpp"
#include "mundo/project_history.hpp"
#include "mundo/document_digest.hpp"
#include <filesystem>

namespace mundo {
enum class DocumentWrite { create_new, replace };

// The host selects the path. Saving requires an existing parent directory and
// publishes the complete document as a single filesystem operation.
[[nodiscard]] std::optional<World> load_world_file(const std::filesystem::path&);
[[nodiscard]] bool save_world_file(const std::filesystem::path&, const World&,
                                   DocumentWrite = DocumentWrite::create_new);

// The requested ID is the stable world ID from the project's index. An empty
// selection opens its starting world. All embedded hashes are checked.
[[nodiscard]] project::Scene open_project_file(const std::filesystem::path&,
                                               std::optional<std::uint64_t> world_id = {});
// Produce a new project file by replacing one editable draft. Publications are immutable.
// All rooms, links and content hashes must validate before the exclusive write.
void replace_project_draft(const std::filesystem::path& source, std::uint64_t id,
                           const World& replacement, const std::filesystem::path& output,
                           const std::optional<ProjectHistory>& history = {});
}
