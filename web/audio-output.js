"use strict";

// Schedule stereo PCM directly on the Web Audio clock. This also works in the
// portable Studio document, where loading an external audio worklet is unavailable.
globalThis.MundoAudioOutput = (() => {
  function create(host = globalThis) {
    let context = null, gain = null, mixer = null, pending = null;
    let paused = false, closed = false, volume = 1, sources = [];
    let music = null;
    let position = [0, 0, 0], yaw = 0, timer = null, nextTime = 0;
    const queued = new Set(), buffers = [], clips = new Map(), groups = new Map();

    const pausedSources = new Map();
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
      if (!context || context.state !== "running" || paused || (!sources.length && !music) || !volume) {
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
          if (music) {
            const first=music.segments[0]?.index ?? music.firstIndex;
            mixer.beginMusicStream(music.id,first);
            for (const segment of music.segments)
              mixer.queueMusicSegment(music.id,segment.index,segment.key,segment.pcm,segment.final);
          }
          for (const [group, level] of groups) mixer.setGroupVolume(group, level);
          mixer.setSources(sources);
          for (const id of pausedSources.keys()) mixer.setSourcePaused(id,true);
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
      get bufferedMusicSegments(){return mixer?mixer.bufferedMusicSegments():(music?.segments.length??0);},
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
      beginMusicStream(id, firstIndex = 0) {
        if (closed) return false;
        const key=String(id);
        if (!/^[1-9][0-9]{0,19}$/.test(key) || !Number.isInteger(firstIndex) || firstIndex<0 || firstIndex>0xffffffff)
          return false;
        stopQueue();
        mixer?.beginMusicStream(key,firstIndex);
        music={id:key,firstIndex,expected:firstIndex,segments:[]};
        pump();
        return true;
      },
      queueMusicSegment(id,index,key,pcm,final=false) {
        if (closed || !music || String(id)!==music.id || index!==music.expected || typeof final!=="boolean") return false;
        let accepted;
        if (mixer) accepted=mixer.queueMusicSegment(music.id,index,key,pcm,final);
        else accepted=music.segments.length<2;
        if (!accepted) return false;
        music.segments.push({index,key,pcm,final});
        if (music.segments.length>2) music.segments.shift();
        music.expected++;
        pump();
        return true;
      },
      cancelMusicStream(id) {
        if (closed || !music || String(id)!==music.id) return false;
        mixer?.cancelMusicStream(music.id);
        music=null;
        stopQueue();pump();
        return true;
      },
      setGroupVolume(group, level, milliseconds = 0) {
        if (closed) return;
        if (mixer) milliseconds ? mixer.fadeGroupVolume(group, level, milliseconds) : mixer.setGroupVolume(group, level);
        groups.set(group, level);
      },
      trigger(id) {
        if (!mixer || closed || paused) return false;
        return mixer.trigger(id);
      },
      setSourcePaused(id, value) {
        if (closed) return false;
        if (typeof value !== "boolean") throw Error("Estado de pausa de fuente inválido.");
        const key = String(id), source = sources.find(s => s.id === key);
        if (!source) return false;
        if (mixer) mixer.setSourcePaused(key,value);
        if (value) pausedSources.set(key,{preset:source.preset,loop:source.loop ?? true});
        else pausedSources.delete(key);
        // Already scheduled PCM belongs to all voices. Keep it playing and apply
        // this change on the next render instead of skipping other voices' cursors.
        return true;
      },
      setSources(next) {
        if (closed) return;
        if (mixer) mixer.setSources(next);
        for (const [key, prior] of pausedSources) {
          const source = next.find(s => s.id === key);
          if (!source || source.preset !== prior.preset || (source.loop ?? true) !== prior.loop) pausedSources.delete(key);
        }
        sources = next;
        stopQueue();
        pump();
      },
      setListener(next, angle) {
        if (closed) return;
        position = next; yaw = angle;
        if (mixer) mixer.setListener(next, angle);
      },
      setVolume(next, milliseconds = 0) {
        if (closed || !Number.isFinite(next)) return;
        volume = Math.max(0, Math.min(1, next));
        if (gain) {
          const control=gain.gain;
          if (milliseconds > 0 && milliseconds <= 60000 && control.cancelScheduledValues && control.setValueAtTime && control.linearRampToValueAtTime) {
            control.cancelScheduledValues(context.currentTime);
            control.setValueAtTime(control.value,context.currentTime);
            control.linearRampToValueAtTime(volume,context.currentTime+milliseconds/1000);
          } else control.value = volume;
        }
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
        sources = []; music=null; clips.clear(); groups.clear(); pausedSources.clear();
      }
    };
  }
  return Object.freeze({create});
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.MundoAudioOutput;
