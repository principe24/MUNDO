package studio.mundo.player;

import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import java.util.function.Consumer;

// Activity and focus events all run on the UI thread. An old listener cannot
// restart sound after the player has left the room or released its focus request.
final class RoomAudioFocus {
    private final AudioManager manager;
    private final Consumer<Boolean> allowPlayback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private AudioFocusRequest request;
    private long generation;

    RoomAudioFocus(AudioManager manager, Consumer<Boolean> allowPlayback) {
        this.manager = manager;
        this.allowPlayback = allowPlayback;
    }

    void update(boolean wanted) {
        if (manager == null) {
            allowPlayback.accept(false);
            return;
        }
        if (wanted == (request != null)) return;
        final long ticket = ++generation;
        if (!wanted) {
            allowPlayback.accept(false);
            AudioFocusRequest old = request;
            request = null;
            manager.abandonAudioFocusRequest(old);
            return;
        }
        AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        request = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes)
                .setWillPauseWhenDucked(true)
                .setAcceptsDelayedFocusGain(true)
                .setOnAudioFocusChangeListener(change -> {
                    if (generation == ticket && request != null)
                        allowPlayback.accept(change == AudioManager.AUDIOFOCUS_GAIN);
                }, main).build();
        boolean granted = manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        allowPlayback.accept(granted);
    }

    void restart(boolean wanted) {
        ++generation;
        allowPlayback.accept(false);
        if (manager == null) return;
        AudioFocusRequest old = request;
        request = null;
        if (old != null) manager.abandonAudioFocusRequest(old);
        if (wanted) update(true);
    }
}
