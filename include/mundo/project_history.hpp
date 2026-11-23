#pragma once
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace mundo {
struct ProjectHistory {
    std::filesystem::path directory;
    std::string line;
};
struct ProjectRevision {
    std::uint64_t sequence{};
    std::string digest;
    std::size_t bytes{};
};
struct ProjectRevisionList {
    std::vector<ProjectRevision> revisions;
    std::size_t damaged{};
    // Recovery remains available if damage prevents safe allocation of a new sequence.
    bool numbering_known{true};
};

inline constexpr std::size_t project_history_slots = 4;
// Each line has its own bounded disk history. A consecutive identical save reuses its revision.
ProjectRevision archive_project(const ProjectHistory&, const std::filesystem::path& source);
ProjectRevisionList list_project_revisions(const ProjectHistory&);
void restore_project_revision(const ProjectHistory&, std::uint64_t sequence,
                              const std::filesystem::path& new_output);
}
