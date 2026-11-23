#include "room_http.hpp"
#include <algorithm>
#include <array>

namespace mundo::room {
namespace {
constexpr std::wstring_view invitation_path = L"/mundo/MUNDO.html#seat=";
constexpr std::size_t credential_length = 48;
template<class Char>
bool lower_hex(std::basic_string_view<Char> value, std::size_t length) {
    return value.size() == length && std::all_of(value.begin(), value.end(), [](Char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

std::optional<unsigned> decimal(std::wstring_view text, unsigned max) {
    if (text.empty() || (text.size() > 1 && text.front() == L'0')) return {};
    unsigned value = 0;
    for (const wchar_t c : text) {
        if (c < L'0' || c > L'9') return {};
        value = value * 10 + static_cast<unsigned>(c - L'0');
        if (value > max) return {};
    }
    return value;
}

bool dns_name(std::wstring_view host) {
    if (host.find(L'.') == host.npos) return false;
    const auto letter = [](wchar_t c) { return c >= L'a' && c <= L'z'; };
    while (!host.empty()) {
        const auto dot = host.find(L'.');
        const auto label = host.substr(0, dot);
        if (label.empty() || label.size() > 63 || label.front() == L'-' || label.back() == L'-') return false;
        for (const auto c : label)
            if (!letter(c) && !(c >= L'0' && c <= L'9') && c != L'-') return false;
        if (dot == host.npos) return letter(label.front());
        host.remove_prefix(dot + 1);
    }
    return false;
}

bool permitted_address(std::wstring_view host, bool tls) {
    if (host == L"127.0.0.1") return true;
    if (!tls) return false;
    if (dns_name(host)) return true;
    std::array<unsigned,4> octets{};
    for (std::size_t i = 0; i < octets.size(); ++i) {
        const auto dot = host.find(L'.');
        if ((i + 1 == octets.size()) != (dot == host.npos)) return false;
        const auto octet = decimal(host.substr(0, dot), 255);
        if (!octet) return false;
        octets[i] = *octet;
        if (dot != host.npos) host.remove_prefix(dot + 1);
    }
    return octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) ||
           (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
}

} // namespace

std::string hex_text(std::span<const unsigned char> bytes) {
    constexpr char digits[] = "0123456789abcdef";
    std::string result;
    result.reserve(bytes.size() * 2);
    for (const unsigned char value : bytes) {
        result.push_back(digits[value >> 4]);
        result.push_back(digits[value & 15]);
    }
    return result;
}

std::optional<Invitation> parse_invitation(std::wstring_view link) {
    if (link.size() > 256) return {};
    const bool tls = link.starts_with(L"https://");
    if (!tls && !link.starts_with(L"http://")) return {};
    const std::wstring_view scheme = tls ? L"https://" : L"http://";
    link.remove_prefix(scheme.size());
    const auto slash = link.find(L'/');
    if (slash == link.npos) return {};
    const auto authority = link.substr(0, slash);
    link.remove_prefix(slash);
    if (!link.starts_with(invitation_path)) return {};
    link.remove_prefix(invitation_path.size());
    if (!lower_hex(link, credential_length)) return {};

    const auto colon = authority.find(L':');
    const auto host = authority.substr(0, colon);
    if (!permitted_address(host, tls)) return {};
    const auto port = colon == authority.npos ? std::optional<unsigned>{tls ? 443u : 80u}
                                              : decimal(authority.substr(colon + 1), 65535);
    if (!port || *port == 0) return {};
    Invitation result;
    result.host = host;
    result.port = static_cast<unsigned short>(*port);
    result.tls = tls;
    result.origin = std::wstring(scheme) + result.host;
    if (*port != (tls ? 443u : 80u)) result.origin += L":" + std::to_wstring(*port);
    result.token.assign(link.begin(), link.end());
    return result;
}

bool valid_credentials(const Invitation& invite, std::string_view proof) {
    if (!lower_hex(std::string_view(invite.token), credential_length) ||
        !lower_hex(proof, credential_length) || invite.origin.size() > 185) return false;
    const std::wstring token(invite.token.begin(), invite.token.end());
    const auto canonical = parse_invitation(invite.origin + std::wstring(invitation_path) + token);
    return canonical && canonical->origin == invite.origin && canonical->host == invite.host &&
           canonical->port == invite.port && canonical->tls == invite.tls;
}
} // namespace mundo::room
