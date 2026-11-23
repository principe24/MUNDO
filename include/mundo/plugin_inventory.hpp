#pragma once

#include "mundo/project.hpp"
#include <cstdint>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace mundo::plugins {
struct Pin {
    std::string id;
    std::uint64_t version;
};

// A missing selection inherits the browser's private catalog. A present but
// empty selection explicitly authorizes no plugins in this project.
using Profile = std::optional<std::vector<Pin>>;
enum class IssueKind { missing, version, dependency, cycle, template_collision };
struct Issue {
    IssueKind kind;
    std::string id;
    std::uint64_t required{};
    std::string dependency, key;
    std::vector<std::uint64_t> versions;
};
struct Inventory {
    Profile profile;
    std::vector<std::string> enabled;
    std::vector<Issue> issues;
};

// Reads the verified project and caller-selected local manifests once. Imported
// revisions remain in memory for this call; neither the project nor any catalog is modified.
[[nodiscard]] Inventory inspect_project_plugins(const std::filesystem::path& project,
                                               std::span<const std::filesystem::path> manifests);
}

namespace mundo::project {
// Owner-side metadata from the same validated stream used by the normal project reader.
[[nodiscard]] plugins::Profile read_plugin_profile(std::istream&, DigestCheck);
}
