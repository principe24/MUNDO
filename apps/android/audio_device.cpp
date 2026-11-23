#include "playback_audio.hpp"
#include <aaudio/AAudio.h>
#include <atomic>

namespace mundo::room {
namespace {
class AndroidOutput final : public AudioDevice {
public:
    AndroidOutput(void* owner, RenderAudio render) : owner_(owner), render_(render) {}
    ~AndroidOutput() override {
        if (stream_) {
            AAudioStream_requestStop(stream_);
            AAudioStream_close(stream_);
        }
    }

    bool open() {
        AAudioStreamBuilder* builder = nullptr;
        if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK) return false;
        AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
        AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_FLOAT);
        AAudioStreamBuilder_setChannelCount(builder, 2);
        AAudioStreamBuilder_setSampleRate(builder, audio_sample_rate);
        AAudioStreamBuilder_setDataCallback(builder, data, this);
        AAudioStreamBuilder_setErrorCallback(builder, error, this);
        const auto status = AAudioStreamBuilder_openStream(builder, &stream_);
        AAudioStreamBuilder_delete(builder);
        return status == AAUDIO_OK && AAudioStream_getFormat(stream_) == AAUDIO_FORMAT_PCM_FLOAT &&
            AAudioStream_getChannelCount(stream_) == 2 && AAudioStream_getSampleRate(stream_) == audio_sample_rate &&
            AAudioStream_requestStart(stream_) == AAUDIO_OK;
    }
    bool healthy() const noexcept override {
        if (failed_.load(std::memory_order_relaxed) || !stream_) return false;
        const auto state = AAudioStream_getState(stream_);
        return state == AAUDIO_STREAM_STATE_STARTING || state == AAUDIO_STREAM_STATE_STARTED;
    }

private:
    void* owner_;
    RenderAudio render_;
    AAudioStream* stream_{};
    std::atomic<bool> failed_{};

    static aaudio_data_callback_result_t data(AAudioStream*, void* context, void* output, int32_t frames) {
        auto& self = *static_cast<AndroidOutput*>(context);
        if (frames > 0) self.render_(self.owner_, {static_cast<float*>(output), std::size_t(frames) * 2});
        return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }
    static void error(AAudioStream*, void* context, aaudio_result_t) {
        static_cast<AndroidOutput*>(context)->failed_.store(true, std::memory_order_relaxed);
    }
};
}

std::unique_ptr<AudioDevice> open_audio_device(void* owner, RenderAudio render) {
    auto device = std::make_unique<AndroidOutput>(owner, render);
    if (!device->open()) return {};
    return device;
}
} // namespace mundo::room
