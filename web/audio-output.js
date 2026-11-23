"use strict";

// Schedule stereo PCM directly on the Web Audio clock. This also works in the
// portable Studio document, where loading an external audio worklet is unavailable.
globalThis.MundoAudioOutput = (() => {
  function create(host = globalThis) {
    let context = null, gain = null, mixer = null, pending = null;
    let paused = false, closed = false, volume = 1, sources = [];
    let position = [0, 0, 0], yaw = 0, timer = null, nextTime = 0;
    const queued = new Set(), buffers = [], clips = new Map(), groups = new Map();

    function stopQueue() {
      if (timer !== null) host.clearInterval(timer);
      timer = null;
      for (const node of queued) {
        node.onended = null;
        try { node.stop(); } catch {}
        node.disconnect();
      }
      queued.clear();
      nextTime = 0;
    }

    function releaseContext() {
      stopQueue();
      if (context) {
        context.onstatechange = null;
        if (gain) gain.disconnect();
        try { Promise.resolve(context.close()).catch(() => {}); } catch {}
      }
      context = gain = mixer = null;
      buffers.length = 0;
    }

    function pump() {
      if (!context || context.state !== "running" || paused || !sources.length || !volume) {
        if (timer !== null) stopQueue();
        return;
      }
      try {
        const now = context.currentTime, frames = Math.round(context.sampleRate * .03);
        if (nextTime < now || !nextTime) nextTime = now + .006;
        // Discard elapsed time after background throttling. Only future audio is needed.
        while (nextTime < now + .105 && queued.size < 6) {
          const pcm = buffers.pop() || context.createBuffer(2, frames, context.sampleRate);
          mixer.render(pcm.getChannelData(0), pcm.getChannelData(1));
          const node = context.createBufferSource();
          node.buffer = pcm;
          node.connect(gain);
          queued.add(node);
          node.onended = () => {
            if (!queued.delete(node)) return;
            node.disconnect();
            if (buffers.length < 6) buffers.push(pcm);
          };
          node.start(nextTime);
          nextTime += frames / context.sampleRate;
        }
        if (timer === null) timer = host.setInterval(pump, 25);
      } catch {
        // A lost audio device must not tear down the game or its network session.
        releaseContext();
      }
    }

    function unlock() {
      if (closed) return Promise.resolve(false);
      if (pending) return pending;
      try {
        if (context?.state === "closed") releaseContext();
        if (!context) {
          const Constructor = host.AudioContext || host.webkitAudioContext;
          if (!Constructor) return Promise.resolve(false);
          context = new Constructor();
          mixer = host.MundoAudioDSP.create(context.sampleRate);
          for (const [key, pcm] of clips) mixer.setClip(key, pcm);
          for (const [group, level] of groups) mixer.setGroupVolume(group, level);
          mixer.setSources(sources);
          mixer.setListener(position, yaw);
          mixer.setPaused(paused);
          gain = context.createGain();
          gain.gain.value = volume;
          gain.connect(context.destination);
          context.onstatechange = pump;
        }
        const target = context;
        // Invoke resume in the user gesture, before yielding to a promise.
        const resumed = target.state === "running" ? undefined : target.resume();
        pending = Promise.resolve(resumed).then(() => {
          if (closed || context !== target || target.state !== "running") return false;
          pump();
          return context === target;
        }, () => false).finally(() => { pending = null; });
        return pending;
      } catch {
        releaseContext();
        return Promise.resolve(false);
      }
    }

    return {
      unlock,
      get running() { return context?.state === "running"; },
      setClip(key, pcm) {
        if (closed) return;
        if (mixer) mixer.setClip(key, pcm);
        clips.set(key, pcm);
      },
      clearClips() {
        if (closed || !clips.size) return;
        clips.clear();
        mixer?.clearClips();
        stopQueue(); pump();
      },
      setGroupVolume(group, level) {
        if (closed) return;
        mixer?.setGroupVolume(group, level);
        groups.set(group, level);
      },
      trigger(id) {
        if (!mixer || closed || paused) return false;
        return mixer.trigger(id);
      },
      setSources(next) {
        if (closed) return;
        if (mixer) mixer.setSources(next);
        sources = next;
        stopQueue();
        pump();
      },
      setListener(next, angle) {
        if (closed) return;
        position = next; yaw = angle;
        if (mixer) mixer.setListener(next, angle);
      },
      setVolume(next) {
        if (closed || !Number.isFinite(next)) return;
        volume = Math.max(0, Math.min(1, next));
        if (gain) gain.gain.value = volume;
        pump();
      },
      setPaused(next) {
        if (closed || paused === Boolean(next)) return;
        paused = Boolean(next);
        if (mixer) mixer.setPaused(paused);
        if (paused) stopQueue();
        else pump();
      },
      close() {
        if (closed) return;
        closed = true;
        releaseContext();
        sources = []; clips.clear(); groups.clear();
      }
    };
  }
  return Object.freeze({create});
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.MundoAudioOutput;
