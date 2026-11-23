"use strict";

// The three ambiences are synthesized from oscillators and seeded noise. This
// module only fills sample buffers; it also runs offline without an audio device.
globalThis.MundoAudioDSP = (() => {
  const groups = ["ambiente", "efectos", "musica", "voces"];
  const clipKey = /^s[0-9a-f]{16}$/;
  const onceSeconds = Object.freeze({brisa:2, agua:1, maquina:1.5});
  const size = 2048, mask = size - 1, table = new Float64Array(size + 1);
  for (let i = 0; i <= size; i++) table[i] = Math.sin(2 * Math.PI * i / size);
  function sine(phase) {
    const scaled = phase * size, whole = Math.floor(scaled), i = whole & mask;
    return table[i] + (table[i + 1] - table[i]) * (scaled - whole);
  }
  function seed(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return (h >>> 0) || 1;
  }
  function random(voice) {
    let x = voice.rng;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    voice.rng = x >>> 0;
    return voice.rng / 4294967296;
  }
  function voiceFor(source, rate) {
    const rng = seed(source.id);
    return {source, rng, clip:null, cursor:0, age:0, started:false, done:false, paused:false, phase:rng / 4294967296, slow:0, fast:0,
      dropAge:0, nextDrop:0, dropLevel:0, dropStep:0, swellStep:(.14 + (rng % 11) * .005) / rate,
      motorStep:(56 + rng % 12) / rate, left:0, right:0, aimL:0, aimR:0,
      stepL:0, stepR:0, ramp:0};
  }
  function tick(voice, step) {
    voice.phase += step;
    if (voice.phase >= 1) voice.phase -= 1;
  }
  function sourceParams(source) {
    if (!source || typeof source.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(source.id) ||
        BigInt(source.id) > 18446744073709551615n ||
        (typeof source.preset !== "string" || !(Object.hasOwn(onceSeconds, source.preset) || clipKey.test(source.preset))) ||
        !point(source.position) || !Number.isFinite(source.radius) || source.radius < .5 || source.radius > 256 ||
        !Number.isFinite(source.volume) || source.volume < 0 || source.volume > 1)
      throw Error("Fuente de mezcla inválida.");
    const result = {spatial:"3d", playbackRate:1, loop:true, group:"ambiente", ...source, position:source.position.slice()};
    if (!["2d","3d"].includes(result.spatial) || typeof result.loop !== "boolean" || !groups.includes(result.group) ||
        !Number.isFinite(result.playbackRate) || result.playbackRate < .25 || result.playbackRate > 4)
      throw Error("Modo de reproducción inválido.");
    return result;
  }
  function point(p) {
    return Array.isArray(p) && p.length === 3 && [0,1,2].every(i => Number.isFinite(p[i]));
  }
  function targets(voice, position, yaw, rampSamples) {
    const s = voice.source;
    const dx = s.position[0] - position[0], dy = s.position[1] - position[1], dz = s.position[2] - position[2];
    const distance = Math.hypot(dx, dy, dz);
    const audible = distance < s.radius && s.spatial === "3d";
    const gain = s.spatial === "2d" ? s.volume : audible ? s.volume * (1 - distance / s.radius) ** 2 : 0;
    const pan = audible && distance > 0 ?
      Math.max(-1, Math.min(1, (dx * Math.cos(yaw) + dz * Math.sin(yaw)) / distance)) : 0;
    const left = gain * Math.sqrt((1 - pan) / 2), right = gain * Math.sqrt((1 + pan) / 2);
    if (voice.aimL === left && voice.aimR === right) return;
    voice.aimL = left; voice.aimR = right;
    voice.stepL = (left - voice.left) / rampSamples;
    voice.stepR = (right - voice.right) / rampSamples;
    voice.ramp = rampSamples;
  }
  function ramp(voice) {
    if (!voice.ramp) return;
    if (--voice.ramp === 0) {
      voice.left = voice.aimL; voice.right = voice.aimR;
    } else {
      voice.left += voice.stepL; voice.right += voice.stepR;
    }
  }
  function create(rate) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw Error("Frecuencia de audio inválida.");
    let voices = [], listener = [0,0,0], yaw = 0, master = 1, paused = false;
    const rampSamples = Math.max(1, Math.round(.01 * rate));
    const clips = new Map(), groupLevels = {ambiente:1,efectos:1,musica:1,voces:1};
    function configure(voice) {
      const pitch = voice.source.playbackRate;
      voice.slowCoeff = 1 - Math.exp(-2 * Math.PI * 80 * pitch / rate);
      voice.fastCoeff = 1 - Math.exp(-2 * Math.PI * 1400 * pitch / rate);
      voice.decay = Math.exp(-pitch / (.052 * rate));
      voice.attack = Math.max(1, Math.round(.003 * rate / pitch));
      voice.clip = clips.get(voice.source.preset) ?? null;
    }
    function emit(voice) {
      switch (voice.source.preset) {
      case "brisa": {
        const white = random(voice) * 2 - 1;
        voice.slow += voice.slowCoeff * (white - voice.slow);
        voice.fast += voice.fastCoeff * (white - voice.fast);
        tick(voice, voice.swellStep * voice.source.playbackRate);
        return (voice.fast - voice.slow) * (.82 + .25 * sine(voice.phase));
      }
      case "agua": {
        if (voice.nextDrop === 0) {
          voice.nextDrop = Math.round(rate / voice.source.playbackRate * (.09 + .24 * random(voice)));
          voice.dropStep = (620 + 650 * random(voice)) / rate;
          voice.dropLevel = .21 + .16 * random(voice);
          voice.phase = 0;
          voice.dropAge = 0;
        }
        const sample = voice.dropLevel * Math.min(1, voice.dropAge / voice.attack) *
          (sine(voice.phase) + .16 * sine(2 * voice.phase));
        tick(voice, voice.dropStep * voice.source.playbackRate);
        voice.dropLevel *= voice.decay;
        voice.nextDrop--; voice.dropAge++;
        return sample;
      }
      case "maquina": {
        const sample = .23 * sine(voice.phase) + .09 * sine(2 * voice.phase) + .045 * sine(5 * voice.phase);
        tick(voice, voice.motorStep * voice.source.playbackRate);
        return sample;
      }
      default: {
        const samples = voice.clip, i = Math.floor(voice.cursor), fraction = voice.cursor - i;
        const next = i + 1 < samples.length ? samples[i + 1] : voice.source.loop ? samples[0] : samples[i];
        const sample = samples[i] + (next - samples[i]) * fraction;
        voice.cursor += (24000 / rate) * voice.source.playbackRate;
        if (voice.cursor >= samples.length) {
          if (voice.source.loop) voice.cursor %= samples.length;
          else voice.done = true;
        }
        return sample;
      }
      }
    }
    function setSources(sources) {
      if (!Array.isArray(sources) || sources.length > 16) throw Error("Una mezcla admite hasta 16 fuentes.");
      const normalized = Array.from(sources, sourceParams), ids = new Set(normalized.map(s => s.id));
      if (ids.size !== normalized.length) throw Error("Una fuente de audio tiene un identificador repetido.");
      normalized.sort((a,b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const previous = new Map(voices.map(v => [v.source.id, v]));
      voices = normalized.map(s => {
        const old = previous.get(s.id);
        const voice = old && old.source.preset === s.preset && old.source.loop === s.loop ? old : voiceFor(s, rate);
        voice.source = s;
        configure(voice);
        targets(voice, listener, yaw, rampSamples);
        return voice;
      });
    }
    function setListener(position, angle) {
      if (!point(position) || !Number.isFinite(angle)) throw Error("Posición de escucha inválida.");
      listener = position.slice(); yaw = angle;
      for (const voice of voices) targets(voice, listener, yaw, rampSamples);
    }
    function setVolume(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw Error("Volumen general inválido.");
      master = value;
    }
    function setGroupVolume(group, value) {
      if (!groups.includes(group) || !Number.isFinite(value) || value < 0 || value > 1)
        throw Error("Volumen de grupo inválido.");
      groupLevels[group] = value;
    }
    function setClip(key, clip) {
      if (typeof key !== "string" || !clipKey.test(key) || clip?.sampleRate !== 24000 ||
          Object.prototype.toString.call(clip.samples) !== "[object Float32Array]" ||
          clip.samples.length < 1 || clip.samples.length > 384000 || (!clips.has(key) && clips.size >= 16))
        throw Error("Clip de audio fuera de los límites de la sala.");
      const data = new Float32Array(clip.samples);
      if (!data.every(v => Number.isFinite(v) && Math.abs(v) <= 1)) throw Error("Muestras de audio inválidas.");
      for (const voice of voices) if (voice.source.preset === key) {
        voice.clip = data;
        if (voice.cursor >= data.length && !voice.done) voice.cursor %= data.length;
      }
      clips.set(key,data);
    }
    function clearClips() {
      clips.clear();
      for (const voice of voices) voice.clip = null;
    }
    function trigger(id) {
      const i = voices.findIndex(v => v.source.id === String(id));
      if (i < 0 || voices[i].source.loop) return false;
      const voice = voiceFor(voices[i].source, rate);
      voice.paused = voices[i].paused;
      configure(voice); targets(voice, listener, yaw, rampSamples);
      voices[i] = voice;
      return true;
    }
    function setSourcePaused(id, value) {
      if (typeof value !== "boolean") throw Error("Estado de pausa de fuente inválido.");
      const voice = voices.find(v => v.source.id === String(id));
      if (!voice) return false;
      voice.paused = value;
      return true;
    }
    function setPaused(value) {
      if (typeof value !== "boolean") throw Error("Estado de pausa inválido.");
      paused = value;
    }
    function render(left, right) {
      if (Object.prototype.toString.call(left) !== "[object Float32Array]" ||
          Object.prototype.toString.call(right) !== "[object Float32Array]" ||
          left.length !== right.length || left.length > 1048576 ||
          (left.buffer === right.buffer && left.byteOffset < right.byteOffset + right.byteLength &&
           right.byteOffset < left.byteOffset + left.byteLength))
        throw Error("La salida necesita dos canales de muestras separados y de igual longitud.");
      left.fill(0); right.fill(0);
      if (paused || !voices.length) return;
      for (const voice of voices) {
        const s = voice.source, duration = onceSeconds[s.preset], group = groupLevels[s.group];
        if (voice.paused || (!duration && !voice.clip)) continue;
        for (let i = 0; i < left.length; ++i) {
          if (voice.done) break;
          ramp(voice);
          const silent = voice.left === 0 && voice.right === 0 && !voice.ramp;
          if (silent && (s.loop || !voice.started)) break;
          voice.started = true;
          let sample = emit(voice) * group;
          if (!s.loop && duration) {
            const remaining = duration * rate - voice.age;
            sample *= Math.min(1, remaining / (.01 * rate));
            voice.age += s.playbackRate;
            if (voice.age >= duration * rate) voice.done = true;
          }
          left[i] += sample * voice.left;
          right[i] += sample * voice.right;
        }
      }
      for (let i = 0; i < left.length; ++i) {
        left[i] = master * left[i] / (1 + Math.abs(left[i]));
        right[i] = master * right[i] / (1 + Math.abs(right[i]));
      }
    }
    function reset() { voices = []; clips.clear(); listener = [0,0,0]; yaw = 0; }
    return Object.freeze({setSources, setListener, setVolume, setGroupVolume, setPaused, setSourcePaused, setClip, clearClips, trigger, render, reset});
  }
  return Object.freeze({create});
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.MundoAudioDSP;
