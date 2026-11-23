#pragma once
#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>
#include <type_traits>

namespace mundo::wire {
class Reader {
public:
    explicit Reader(std::span<const std::byte> bytes):remaining_(bytes){}
    std::span<const std::byte> pop(std::size_t size) {
        if(size>remaining_.size()){good_=false;return {};}
        auto result=remaining_.first(size);remaining_=remaining_.subspan(size);return result;
    }
    bool magic(std::string_view text) {
        auto bytes=pop(text.size());
        return good_&&std::equal(bytes.begin(),bytes.end(),text.begin(),
            [](std::byte a,char b){return std::to_integer<unsigned>(a)==static_cast<unsigned char>(b);});
    }
    template<class T> T integer(){
        static_assert(std::is_unsigned_v<T>);
        auto data=pop(sizeof(T));std::uint64_t n{};
        for(std::size_t i=0;i<data.size();++i)n|=std::uint64_t(std::to_integer<unsigned>(data[i]))<<(i*8);
        return static_cast<T>(n);
    }
    float scalar(){return std::bit_cast<float>(integer<std::uint32_t>());}
    bool good() const noexcept{return good_;}
    std::size_t left() const noexcept{return remaining_.size();}
private:
    std::span<const std::byte> remaining_;
    bool good_{true};
};
}
