#include "room_http.hpp"
#include "mundo/project.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winhttp.h>
#include <bcrypt.h>

#include <array>
#include <chrono>

namespace mundo::room {
namespace {
constexpr std::size_t max_world_size = 24 * 1024 * 1024;
constexpr wchar_t wire_media[] = L"application/vnd.mundo.room-v3";

struct CloseInternet {
    void operator()(HINTERNET value) const noexcept { WinHttpCloseHandle(value); }
};
using Internet = std::unique_ptr<void, CloseInternet>;

struct Algorithm {
    BCRYPT_ALG_HANDLE handle{};
    ~Algorithm() { if (handle) BCryptCloseAlgorithmProvider(handle, 0); }
};
struct Hash {
    BCRYPT_HASH_HANDLE handle{};
    ~Hash() { if (handle) BCryptDestroyHash(handle); }
};

bool expected_type(HINTERNET request, const wchar_t* expected) {
    std::array<wchar_t,128> buffer{};
    DWORD size = static_cast<DWORD>(sizeof(buffer));
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
                             buffer.data(), &size, WINHTTP_NO_HEADER_INDEX)) return false;
    std::wstring_view type(buffer.data(), size / sizeof(wchar_t));
    if (!type.empty() && type.back() == L'\0') type.remove_suffix(1);
    type = type.substr(0, type.find(L';'));
    return CompareStringOrdinal(type.data(), static_cast<int>(type.size()), expected, -1, TRUE) == CSTR_EQUAL;
}
} // namespace

std::optional<std::string> new_proof() {
    std::array<unsigned char,24> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) return {};
    return hex_text(bytes);
}

bool matches_digest(std::span<const std::byte> bytes, std::string_view revision) {
    if (revision.size() != 64 || bytes.empty() || bytes.size() > project::max_room_bytes) return false;
    Algorithm algorithm;
    if (BCryptOpenAlgorithmProvider(&algorithm.handle, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
    Hash hash;
    if (BCryptCreateHash(algorithm.handle, &hash.handle, nullptr, 0, nullptr, 0, 0) < 0) return false;
    // Windows declares the input pointer as mutable but reads these bytes.
    auto data = reinterpret_cast<PUCHAR>(const_cast<std::byte*>(bytes.data()));
    std::array<unsigned char,32> digest{};
    return BCryptHashData(hash.handle, data, static_cast<ULONG>(bytes.size()), 0) >= 0 &&
           BCryptFinishHash(hash.handle, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0 &&
           hex_text(digest) == revision;
}

struct Http::Impl {
    Internet session;
    Internet connection;
    bool tls{};
    std::wstring headers;
};

Http::Http(const Invitation& invitation, std::string proof) : impl_(std::make_unique<Impl>()) {
    if (!valid_credentials(invitation, proof)) return;
    const std::wstring token(invitation.token.begin(), invitation.token.end());
    impl_->tls = invitation.tls;
    impl_->headers = L"Content-Type: application/json\r\nX-Mundo-Travel: 1\r\nX-Mundo-Circuit: 1\r\nX-Mundo-Splits: 1\r\nX-Mundo-Npcs: 1\r\nX-Mundo-Race-Start: 1\r\nOrigin: " + invitation.origin +
        L"\r\nX-Invite: " + token + L"\r\nX-Seat: " + std::wstring(proof.begin(), proof.end()) + L"\r\n";
    impl_->session.reset(WinHttpOpen(L"MUNDO", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                                     WINHTTP_NO_PROXY_BYPASS, 0));
    if (!impl_->session || !WinHttpSetTimeouts(impl_->session.get(), 2000, 2500, 2500, 3000)) return;
    impl_->connection.reset(WinHttpConnect(impl_->session.get(), invitation.host.c_str(), invitation.port, 0));
}

Http::~Http() = default;

Response Http::post(std::string_view action, std::string_view json, std::size_t max_bytes,
                    CancelToken stop, ScenePresence presence) {
    if (stop.stop_requested() || !impl_->connection || json.size() > 512 || max_bytes > max_world_size) return {};
    const auto fragment_limit = room_fragment_limit(action);
    if (fragment_limit && max_bytes > *fragment_limit) max_bytes = *fragment_limit;
    const wchar_t* path;
    if (action == "audio") path = L"/room/audio";
    else if (action == "audio-info") path = L"/room/audio-info";
    else if (action == "join") path = L"/room/join";
    else if (action == "world") path = L"/room/world";
    else if (action == "world-part") path = L"/room/world-part";
    else if (action == "world-rest") path = L"/room/world-rest";
    else if (action == "cell-index") path = L"/room/cell-index";
    else if (action == "entry-info") path = L"/room/entry-info";
    else if (action == "entry-part") path = L"/room/entry-part";
    else if (action == "sector-plan") path = L"/room/sector-plan";
    else if (action == "sector-ahead") path = L"/room/sector-ahead";
    else if (action == "sector-ahead-part") path = L"/room/sector-ahead-part";
    else if (action == "sector-usage") path = L"/room/sector-usage";
    else if (action == "sector-usage-stages") path = L"/room/sector-usage-stages";
    else if (action == "sector-part") path = L"/room/sector-part";
    else if (action == "sector-ready") path = L"/room/sector-ready";
    else if (action == "sector-full") path = L"/room/sector-full";
    else if (action == "route") path = L"/room/route";
    else if (action == "input") path = L"/room/input";
    else if (action == "meeting") path = L"/room/meeting";
    else if (action == "leave") path = L"/room/leave";
    else return {};

    const wchar_t* accept[] = {action == "audio" ? L"audio/wav" : (action == "meeting" || action == "audio-info") ? L"text/plain" :
        (action == "route" || fragment_limit) ? L"application/octet-stream" : wire_media, nullptr};
    const DWORD flags = impl_->tls ? WINHTTP_FLAG_SECURE : 0;
    Internet request(WinHttpOpenRequest(impl_->connection.get(), L"POST", path, nullptr,
                                        WINHTTP_NO_REFERER, accept, flags));
    if (!request) return {};
    if (const char* value = scene_header(presence)) {
        const std::string_view ascii(value);
        const auto header = L"X-Mundo-Scene: " + std::wstring(ascii.begin(),ascii.end()) + L"\r\n";
        if (!WinHttpAddRequestHeaders(request.get(), header.c_str(), static_cast<DWORD>(header.size()),
                                      WINHTTP_ADDREQ_FLAG_ADD)) return {};
    }
    const bool status_only = action == "leave" || is_usage_report(action);
    if (status_only && !WinHttpSetTimeouts(request.get(), 1000, 1000, 1000, 1000)) return {};
    DWORD disabled = WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_AUTHENTICATION;
    if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled))) return {};
    const auto bytes = static_cast<DWORD>(json.size());
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(12);
    if (!WinHttpSendRequest(request.get(), impl_->headers.c_str(), static_cast<DWORD>(impl_->headers.size()),
                            bytes ? const_cast<char*>(json.data()) : nullptr, bytes, bytes, 0) ||
        stop.stop_requested() ||
        !WinHttpReceiveResponse(request.get(), nullptr)) return {};

    DWORD status{}, size = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) return {};
    if (status != 200 || status_only) return {status, {}};
    const wchar_t* type = action == "world" ? L"application/octet-stream" : accept[0];
    if (!expected_type(request.get(), type)) return {};
    DWORD length{};
    size = sizeof(length);
    const BOOL has_length = WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                                                WINHTTP_HEADER_NAME_BY_INDEX, &length, &size, WINHTTP_NO_HEADER_INDEX);
    if (has_length && length > max_bytes) return {};
    Response response{status, {}};
    if (has_length) response.body.reserve(length);
    std::array<std::byte,16384> chunk;
    for (;;) {
        if (stop.stop_requested() || std::chrono::steady_clock::now() >= deadline) return {};
        DWORD read{};
        if (!WinHttpReadData(request.get(), chunk.data(), static_cast<DWORD>(chunk.size()), &read)) return {};
        if (!read) break;
        if (read > max_bytes - response.body.size()) return {};
        response.body.insert(response.body.end(), chunk.begin(), chunk.begin() + read);
    }
    if (has_length && response.body.size() != length) return {};
    if (!valid_room_reply_size(action,status,response.body.size())) return {};
    return response;
}
} // namespace mundo::room
