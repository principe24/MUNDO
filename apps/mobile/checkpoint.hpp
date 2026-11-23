#pragma once
#include "mundo/project.hpp"
#include <filesystem>
#include <condition_variable>
#include <mutex>
#include <thread>
namespace mundo::mobile {
struct SavedPose {
    Vec3 feet;
    double yaw{},pitch{};
    std::optional<project::Selection> location;
};
// One writer serializes periodic saves and the final lifecycle flush.
class PoseWriter {
public:
    explicit PoseWriter(std::filesystem::path directory);
    ~PoseWriter();
    bool submit(std::uint64_t key,const SavedPose&,bool wait);
private:
    struct Entry { std::uint64_t key, ticket; SavedPose pose; };
    void run();
    std::filesystem::path directory_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::optional<Entry> pending_;
    std::uint64_t issued_{}, completed_{};
    bool closing_{}, ok_{};
    std::thread worker_;
};
std::uint64_t document_key(std::span<const std::byte> bytes);
std::optional<project::Selection> read_project_location(const std::filesystem::path&);
std::optional<SavedPose> read_pose(const std::filesystem::path&, std::uint64_t key);
bool store_pose(const std::filesystem::path&, std::uint64_t key, const SavedPose&);
}
