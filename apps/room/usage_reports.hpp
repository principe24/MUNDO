#pragma once

#include "sector_stream.hpp"
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <list>
#include <mutex>
#include <thread>

namespace mundo::room {

enum class UsageReason { active, changed, released, turned, crossed };

struct UsageSeat {
    Invitation invite;
    std::string proof;
    std::atomic_bool unsupported{}, stages_unsupported{};
    UsageSeat(const Invitation& value, const std::string& credential) : invite(value), proof(credential) {}
};

struct UsageKey {
    std::shared_ptr<UsageSeat> seat;
    std::string prefix; // Exact verified context including MAH1 token. Ends before the mask properties.
};

// One optional sender for the client. HTTP never runs under a lock or on either
// the simulation or render thread. Entries keep the credentials of their own seat.
class UsageReports {
    using Clock = std::chrono::steady_clock;
    struct Packet {
        std::shared_ptr<const UsageKey> key;
        std::uint16_t verified{}, used{};
        UsageReason reason{};
        Clock::time_point due{};
        unsigned failures{};
        AheadStage via{AheadStage::outside};
        std::uint16_t middle{};
    };
    static constexpr std::size_t capacity = 12;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::list<Packet> queue_;
    CancelToken stop_ = CancelToken::tracked();
    std::thread worker_;

    auto find(const UsageKey& key) {
        return std::find_if(queue_.begin(), queue_.end(), [&](const Packet& p){
            return p.key->seat == key.seat && p.key->prefix == key.prefix;
        });
    }
    static const char* name(UsageReason reason) {
        switch (reason) {
            case UsageReason::crossed: return "crossed";
            case UsageReason::turned: return "turned";
            case UsageReason::released: return "released";
            case UsageReason::changed: return "changed";
            default: return "active";
        }
    }
    void send_loop() {
        using namespace std::chrono_literals;
        std::unique_lock lock(mutex_);
        auto next_send = Clock::now();
        while (!stop_.stop_requested()) {
            if (queue_.empty()) { changed_.wait(lock); continue; }
            auto it = std::min_element(queue_.begin(), queue_.end(), [](const Packet& a, const Packet& b){return a.due < b.due;});
            const auto when = std::max(next_send, it->due);
            if (Clock::now() < when) { changed_.wait_until(lock, when); continue; }
            auto sent = *it;
            lock.unlock();
            unsigned status{};
            try {
                Http http(sent.key->seat->invite, sent.key->seat->proof);
                auto json = sent.key->prefix + ",\"verified\":" + std::to_string(sent.verified) +
                    ",\"used\":" + std::to_string(sent.used) + ",\"reason\":\"" + name(sent.reason) + "\"";
                const bool staged = sent.via != AheadStage::outside;
                if (staged) json += std::string(",\"via\":\"") + (sent.via == AheadStage::via_x ? "x" : "z") +
                                    "\",\"middle\":" + std::to_string(sent.middle);
                status = http.post(staged ? "sector-usage-stages" : "sector-usage", json + "}", 0, stop_).status;
            } catch (...) { /* A missing receipt never affects gameplay. */ }
            lock.lock();
            next_send = Clock::now() + 140ms;
            it = find(*sent.key);
            if (status == 404 || status == 405) {
                const bool staged = sent.via != AheadStage::outside;
                if (staged) sent.key->seat->stages_unsupported = true;
                else sent.key->seat->unsupported = true;
                queue_.remove_if([&](const Packet& p){
                    return p.key->seat == sent.key->seat && (p.via != AheadStage::outside) == staged;
                });
            } else if (it != queue_.end() && it->via == sent.via) {
                const bool same = it->verified == sent.verified && it->used == sent.used && it->reason == sent.reason &&
                                  it->middle == sent.middle;
                if (status == 204 && !same) {
                    it->failures = 0;
                } else if ((status == 0 || status == 408 || status == 429 || (status >= 500 && status < 600)) &&
                           (!same || it->failures < 2)) {
                    // A newer terminal receipt may have arrived during the final
                    // attempt for an older mask. It has not been attempted yet.
                    it->failures = same ? it->failures + 1 : 0;
                    it->due = Clock::now() + (status == 429 ? 1400ms : 400ms * it->failures);
                } else queue_.erase(it);
            }
            changed_.notify_all();
        }
    }
public:
    ~UsageReports() {
        { std::lock_guard lock(mutex_); stop_.request_stop(); }
        changed_.notify_one();
        if (worker_.joinable()) worker_.join();
    }
    void submit(std::shared_ptr<const UsageKey> key, std::uint16_t verified, std::uint16_t used, UsageReason reason,
                AheadStage via, std::uint16_t middle) noexcept {
        try {
            std::lock_guard lock(mutex_);
            const bool staged = via == AheadStage::via_x || via == AheadStage::via_z;
            if (stop_.stop_requested() || (staged ? key->seat->stages_unsupported.load() : key->seat->unsupported.load())) return;
            if (!worker_.joinable()) worker_ = std::thread(&UsageReports::send_loop,this);
            auto it = find(*key);
            if (it == queue_.end()) {
                if (queue_.size() == capacity) {
                    // Prefer to preserve completed receipts under sustained congestion.
                    auto evict = std::find_if(queue_.begin(),queue_.end(),[](const Packet& p){return p.reason == UsageReason::active;});
                    if (evict == queue_.end() && reason == UsageReason::active) return;
                    queue_.erase(evict == queue_.end() ? queue_.begin() : evict);
                }
                const auto delay = std::chrono::milliseconds(reason == UsageReason::active ? 90 : 0);
                queue_.push_back({std::move(key),verified,used,reason,Clock::now() + delay,0,via,middle});
            } else {
                if (staged && it->via != AheadStage::outside && it->via != via) return;
                if (staged && it->via == AheadStage::outside) {
                    it->via = via;
                    it->failures = 0;
                }
                if (reason > it->reason && !it->failures) it->due = Clock::now();
                if (staged) it->middle |= middle;
                it->verified |= verified;
                it->used |= used;
                it->reason = std::max(it->reason,reason);
            }
            changed_.notify_all();
        } catch (...) {}
    }

    // The old seat still exists until its leave POST. Offer the sender a short
    // opportunity on exit only; yield immediately to another invitation or shutdown.
    template<class Interrupted>
    void finish_seat(const std::shared_ptr<UsageSeat>& seat, Interrupted interrupted) {
        using namespace std::chrono_literals;
        const auto deadline = Clock::now() + 350ms;
        std::unique_lock lock(mutex_);
        for (auto& p : queue_)
            if (p.key->seat == seat && !p.failures) p.due = Clock::time_point::min();
        changed_.notify_all();
        while (Clock::now() < deadline && !stop_.stop_requested() &&
               std::any_of(queue_.begin(),queue_.end(),[&](const Packet& p){return p.key->seat == seat;})) {
            lock.unlock();
            if (interrupted()) return;
            lock.lock();
            changed_.wait_until(lock,std::min(deadline,Clock::now()+20ms));
        }
    }
};

// One receipt survives the immutable partial caches, the authoritative sector
// request and an unconsumed UI update, without retaining any of their world data.
class UsageReceipt {
    std::mutex mutex_;
    std::weak_ptr<UsageReports> reports_;
    std::shared_ptr<UsageSeat> seat_;
    std::string context_;
    std::shared_ptr<const UsageKey> key_;
    std::string token_;
    std::uint16_t verified_{}, used_{}, middle_{};
    AheadStage via_{AheadStage::outside};
    bool final_installed_{};
    UsageReason reason_{};
    void emit() {
        if (!key_) return;
        if (auto reports = reports_.lock()) reports->submit(key_,verified_,used_,reason_,via_,middle_);
    }
public:
    UsageReceipt(std::weak_ptr<UsageReports> reports, std::shared_ptr<UsageSeat> seat, std::string context)
        : reports_(std::move(reports)), seat_(std::move(seat)), context_(std::move(context)) {}
    void begin(const std::string& token) noexcept {
        try {
            std::lock_guard lock(mutex_);
            if (key_ || token.size() != 32 || context_.empty() || context_.back() != '}') return;
            token_ = token;
            auto prefix = context_.substr(0,context_.size()-1) + ",\"token\":\"" + token + "\"";
            key_ = std::make_shared<UsageKey>(UsageKey{seat_,std::move(prefix)});
            emit();
        } catch (...) {}
    }
    bool matches(std::string_view token) {
        std::lock_guard lock(mutex_);
        return key_ && token_ == token;
    }
    void record(std::uint16_t verified, UsageReason reason) noexcept {
        std::lock_guard lock(mutex_);
        const auto before = verified_;
        const auto previous = reason_;
        verified_ |= verified;
        reason_ = std::max(reason_,reason);
        if (before != verified_ || previous != reason_) emit();
    }

    void install(AheadStage stage, std::uint16_t mask) noexcept {
        std::lock_guard lock(mutex_);
        if (final_installed_) return;
        const auto fresh = static_cast<std::uint16_t>(mask & verified_ & ~used_);
        if (stage == AheadStage::target) {
            final_installed_ = true;
            reason_ = UsageReason::crossed;
        } else if (stage == AheadStage::via_x || stage == AheadStage::via_z) {
            if (via_ != AheadStage::outside) return; // Only the first installed intermediate counts.
            via_ = stage;
            middle_ = fresh;
        } else return;
        used_ |= fresh;
        emit();
    }
};

struct RegionUsage {
    RegionUsage() = default;
    RegionUsage(const RegionUsage&) = delete;
    RegionUsage& operator=(const RegionUsage&) = delete;
    std::shared_ptr<UsageReceipt> receipt;
    AheadStage stage{AheadStage::outside};
    std::uint16_t used{};
    bool release_on_drop{};
    ~RegionUsage() { if (receipt && release_on_drop) receipt->record(0,UsageReason::released); }
    void installed() noexcept {
        if (auto token = std::move(receipt)) token->install(stage,used);
    }
};

} // namespace mundo::room
