#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <mmsystem.h>
#include "playback_audio.hpp"
#include <array>
#include <atomic>
#include <cstdint>
#include <thread>

namespace mundo::room {
namespace {
class WindowsOutput final : public AudioDevice {
public:
    WindowsOutput(void* owner, RenderAudio render) : owner_(owner), render_(render) {}
    ~WindowsOutput() override {
        closing_.store(true);
        if (event_) SetEvent(event_);
        if (worker_.joinable()) worker_.join();
        if (output_) {
            waveOutReset(output_);
            for (unsigned i = 0; i < prepared_; ++i)
                waveOutUnprepareHeader(output_, &headers_[i], sizeof(WAVEHDR));
            waveOutClose(output_);
        }
        if (event_) CloseHandle(event_);
    }

    bool open() {
        event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!event_) return false;
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 2;
        format.nSamplesPerSec = audio_sample_rate;
        format.wBitsPerSample = 16;
        format.nBlockAlign = 4;
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
        if (waveOutOpen(&output_, WAVE_MAPPER, &format, reinterpret_cast<DWORD_PTR>(event_), 0, CALLBACK_EVENT) != MMSYSERR_NOERROR)
            return false;
        for (unsigned i = 0; i < headers_.size(); ++i) {
            auto& header = headers_[i];
            header.lpData = reinterpret_cast<char*>(pcm_[i].data());
            header.dwBufferLength = static_cast<DWORD>(pcm_[i].size() * sizeof(std::int16_t));
            if (waveOutPrepareHeader(output_, &header, sizeof(WAVEHDR)) != MMSYSERR_NOERROR) return false;
            ++prepared_;
            if (!submit(i)) return false;
        }
        try {
            worker_ = std::thread(&WindowsOutput::pump, this);
        } catch (const std::system_error&) {
            return false;
        }
        return true;
    }
    bool healthy() const noexcept override { return !failed_.load(std::memory_order_relaxed); }

private:
    void* owner_;
    RenderAudio render_;
    HANDLE event_{};
    HWAVEOUT output_{};
    unsigned prepared_{};
    std::array<WAVEHDR, 3> headers_{};
    std::array<std::array<std::int16_t, 1024>, 3> pcm_{};
    std::array<float, 1024> samples_{};
    std::atomic<bool> closing_{}, failed_{};
    std::thread worker_;

    bool submit(unsigned index) {
        render_(owner_, samples_);
        for (std::size_t n = 0; n < samples_.size(); ++n)
            pcm_[index][n] = static_cast<std::int16_t>(std::clamp(samples_[n], -1.f, 1.f) * 32767.f);
        return waveOutWrite(output_, &headers_[index], sizeof(WAVEHDR)) == MMSYSERR_NOERROR;
    }

    void pump() {
        unsigned next = 0;
        while (!closing_.load()) {
            if (WaitForSingleObject(event_, INFINITE) != WAIT_OBJECT_0) break;
            if (closing_.load()) return;
            // Drivers can complete several buffers before one event is consumed.
            for (unsigned count = 0; count < headers_.size() && (headers_[next].dwFlags & WHDR_DONE); ++count) {
                if (!submit(next)) { failed_.store(true, std::memory_order_relaxed); return; }
                next = (next + 1) % headers_.size();
            }
        }
        failed_.store(true, std::memory_order_relaxed);
    }
};
}

std::unique_ptr<AudioDevice> open_audio_device(void* owner, RenderAudio render) {
    auto device = std::make_unique<WindowsOutput>(owner, render);
    if (!device->open()) return {};
    return device;
}
} // namespace mundo::room
