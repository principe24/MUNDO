#include "private_file.hpp"
#include "mundo/document_file.hpp"
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <string>
#include <system_error>
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif
#endif

namespace mundo {
namespace fs = std::filesystem;
namespace {
#ifndef _WIN32
bool publish_new(const fs::path& temporary, const fs::path& target) {
#if defined(__linux__) && defined(SYS_renameat2)
    constexpr unsigned no_replace = 1; // Linux RENAME_NOREPLACE
    if (::syscall(SYS_renameat2, AT_FDCWD, temporary.c_str(), AT_FDCWD, target.c_str(), no_replace) == 0)
        return true;
    if (errno != ENOSYS && errno != EINVAL && errno != EOPNOTSUPP) return false;
#elif defined(__APPLE__) && defined(RENAME_EXCL)
    if (::renamex_np(temporary.c_str(), target.c_str(), RENAME_EXCL) == 0) return true;
    if (errno != ENOTSUP && errno != EINVAL) return false;
#endif
    // link() atomically rejects an existing target and exposes the fully written inode.
    if (::link(temporary.c_str(), target.c_str()) != 0) return false;
    ::unlink(temporary.c_str());
    return true;
}
#endif
bool write_record(const fs::path& file, std::span<const std::byte> bytes, DocumentWrite mode,
                  bool create_parents) {
    if (bytes.empty() || bytes.size() > 128u * 1024 * 1024) return false;
    std::error_code error;
    if (file.filename().empty()) return false;
    const auto parent = file.has_parent_path() ? file.parent_path() : fs::path(".");
    if (create_parents) {
        fs::create_directories(parent, error);
        if (error) return false;
    }

    static std::atomic<unsigned long long> sequence{};
#if defined(_WIN32)
    const auto process = GetCurrentProcessId();
#else
    const auto process = getpid();
#endif
    // Each writer owns its temporary file. Concurrent saves can replace only a complete record.
    for (unsigned attempt = 0; attempt < 8; ++attempt) {
        const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
        fs::path temporary = file;
        temporary += ".tmp-" + std::to_string(process) + "-" + std::to_string(stamp) + "-" +
                     std::to_string(sequence.fetch_add(1, std::memory_order_relaxed));
#if defined(_WIN32)
        HANDLE out = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                 FILE_ATTRIBUTE_NORMAL, nullptr);
        if (out == INVALID_HANDLE_VALUE) {
            if (GetLastError() == ERROR_FILE_EXISTS) continue;
            return false;
        }
        DWORD written = 0;
        const bool complete = WriteFile(out, bytes.data(), static_cast<DWORD>(bytes.size()),
                                        &written, nullptr) && written == bytes.size() && FlushFileBuffers(out);
        const bool closed = CloseHandle(out);
        DWORD flags = MOVEFILE_WRITE_THROUGH;
        if (mode == DocumentWrite::replace) flags |= MOVEFILE_REPLACE_EXISTING;
        if (complete && closed && MoveFileExW(temporary.c_str(), file.c_str(), flags)) return true;
#else
        int out = ::open(temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (out < 0) {
            if (errno == EEXIST) continue;
            return false;
        }
        std::size_t offset = 0;
        while (offset < bytes.size()) {
            const auto count = ::write(out, bytes.data() + offset, bytes.size() - offset);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) break;
            offset += static_cast<std::size_t>(count);
        }
        const bool complete = offset == bytes.size() && ::fsync(out) == 0;
        const bool closed = ::close(out) == 0;
        if (complete && closed && (mode == DocumentWrite::create_new
                                   ? publish_new(temporary, file)
                                   : ::rename(temporary.c_str(), file.c_str()) == 0)) {
            // The new record is already visible. Some filesystems also accept a directory sync.
            const int directory = ::open(parent.c_str(), O_RDONLY | O_CLOEXEC);
            if (directory >= 0) {
                ::fsync(directory);
                ::close(directory);
            }
            return true;
        }
#endif
        fs::remove(temporary, error);
        return false;
    }
    return false;
}
} // namespace

bool write_document_bytes(const fs::path& path, std::span<const std::byte> bytes, DocumentWrite mode) {
    return write_record(path, bytes, mode, false);
}

bool write_private_file(const fs::path& path, std::span<const std::byte> bytes) {
    return write_record(path, bytes, DocumentWrite::replace, true);
}
} // namespace mundo
