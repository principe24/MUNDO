#include "playback_audio.hpp"
#include <AudioToolbox/AudioToolbox.h>
#include <atomic>

namespace mundo::room {
namespace {
class IOSOutput final : public AudioDevice {
public:
    IOSOutput(void* owner, RenderAudio render) : owner_(owner), render_(render) {}
    ~IOSOutput() override {
        closing_.store(true);
        if (queue_) {
            AudioQueueStop(queue_, true);
            AudioQueueDispose(queue_, true);
        }
    }

    bool open() {
        AudioStreamBasicDescription format{};
        format.mSampleRate = audio_sample_rate;
        format.mFormatID = kAudioFormatLinearPCM;
        format.mFormatFlags = kAudioFormatFlagsNativeFloatPacked;
        format.mFramesPerPacket = 1;
        format.mChannelsPerFrame = 2;
        format.mBitsPerChannel = 32;
        format.mBytesPerFrame = format.mBytesPerPacket = sizeof(float) * 2;
        if (AudioQueueNewOutput(&format, refill, this, nullptr, nullptr, 0, &queue_) != noErr) return false;
        for (unsigned i = 0; i < 3; ++i) {
            AudioQueueBufferRef buffer = nullptr;
            if (AudioQueueAllocateBuffer(queue_, 512 * format.mBytesPerFrame, &buffer) != noErr) return false;
            refill(this, queue_, buffer);
            if (failed_.load(std::memory_order_relaxed)) return false;
        }
        return AudioQueueStart(queue_, nullptr) == noErr;
    }

    bool healthy() const noexcept override {
        if (failed_.load(std::memory_order_relaxed) || !queue_) return false;
        UInt32 running = 0;
        UInt32 size = sizeof(running);
        return AudioQueueGetProperty(queue_, kAudioQueueProperty_IsRunning, &running, &size) == noErr && running;
    }

private:
    void* owner_;
    RenderAudio render_;
    AudioQueueRef queue_{};
    std::atomic<bool> closing_{}, failed_{};

    static void refill(void* context, AudioQueueRef queue, AudioQueueBufferRef buffer) {
        auto& self = *static_cast<IOSOutput*>(context);
        if (self.closing_.load()) return;
        self.render_(self.owner_, {static_cast<float*>(buffer->mAudioData), buffer->mAudioDataBytesCapacity / sizeof(float)});
        buffer->mAudioDataByteSize = buffer->mAudioDataBytesCapacity;
        if (AudioQueueEnqueueBuffer(queue, buffer, 0, nullptr) != noErr) self.failed_.store(true, std::memory_order_relaxed);
    }
};
}

std::unique_ptr<AudioDevice> open_audio_device(void* owner, RenderAudio render) {
    auto device = std::make_unique<IOSOutput>(owner, render);
    if (!device->open()) return {};
    return device;
}
} // namespace mundo::room
