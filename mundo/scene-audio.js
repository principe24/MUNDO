"use strict";

globalThis.MundoPlayerAudio = (() => {
  const groups = Object.freeze(["ambiente", "efectos", "musica", "voces"]);
  const defaults = Object.freeze({volume: 80, muted: false, ambiente: 100, efectos: 100, musica: 100, voces: 100});
  function valid(prefs) {
    return prefs && Number.isInteger(prefs.volume) && prefs.volume >= 0 && prefs.volume <= 100 &&
      typeof prefs.muted === "boolean" && groups.every(group => Number.isInteger(prefs[group]) &&
        prefs[group] >= 0 && prefs[group] <= 100);
  }

  function create(host, mobile) {
    const key = "mundo.audio.v1." + (mobile ? "mobile" : "pc");
    let settings = defaults;
    try {
      const stored = JSON.parse(host.localStorage.getItem(key));
      if (valid(stored)) settings = stored;
    } catch {}
    let output = null, sources = [], position = [0, 0, 0], yaw = 0, active = false;
    let unlocked = false, attempt = null;
    const clips = new Map();

    function applyVolume() {
      if (!output) return;
      output.setVolume(settings.muted ? 0 : settings.volume / 100);
      for (const group of groups) output.setGroupVolume(group, settings[group] / 100);
    }
    function activate(force = false) {
      if (!force && (!active || !sources.length || settings.muted || !settings.volume))
        return Promise.resolve(false);
      if (attempt) return attempt;
      if (unlocked && output?.running) return Promise.resolve(true);
      if (!output) {
        output = host.MundoAudioOutput.create(host);
        output.setPaused(!active);
        for (const [key, pcm] of clips) output.setClip(key, pcm);
        output.setSources(sources);
        output.setListener(position, yaw);
        applyVolume();
      }
      const target = output;
      const task = target.unlock().then(ok => {
        if (output !== target) return false;
        unlocked = ok;
        return ok;
      }).finally(() => { if (attempt === task) attempt = null; });
      attempt = task;
      return task;
    }

    return {
      defaults, groups, activate,
      get settings() { return {...settings}; },
      get unlocked() { return unlocked; },
      get clipKeys() { return [...new Set(sources.map(s => s.preset).filter(id => /^s[0-9a-f]{16}$/.test(id)))]; },
      setClip(key, pcm) { clips.set(key, pcm); output?.setClip(key, pcm); },
      clearClips() { clips.clear(); output?.clearClips(); },
      apply(prefs) {
        if (!valid(prefs)) throw Error("El volumen debe estar entre 0 y 100.");
        settings = Object.fromEntries(Object.keys(defaults).map(key => [key, prefs[key]]));
        applyVolume();
        try { host.localStorage.setItem(key, JSON.stringify(settings)); return true; }
        catch { return false; }
      },
      install(world) {
        const next = host.MundoAudioScene.read(world);
        sources = next;
        output?.setSources(next);
      },
      listen(next, angle) {
        position = next; yaw = angle;
        output?.setListener(next, angle);
      },
      setActive(next) {
        active = Boolean(next);
        output?.setPaused(!active);
      },
      clear() {
        active = false; sources = []; clips.clear(); unlocked = false; attempt = null;
        output?.close();
        output = null;
      }
    };
  }
  function roomClips(link, audio, codec, readBytes, report, clock = () => performance.now()) {
    let scope = null, flight = null, reported = "";
    const loaded = new Set(), failures = new Map();
    function status(next) {
      if (reported !== next) { reported = next; report(next); }
    }
    function pause() {
      flight?.abort();
      flight = null;
    }
    function clear() {
      pause(); scope = null; failures.clear(); loaded.clear(); audio.clearClips(); status("");
    }
    function update() {
      if (!link.audioClipsOffered || !link.lease || !link.revision || link.project) {
        if (scope) clear();
        return;
      }
      if (link.lease !== scope?.lease || link.revision !== scope?.revision) {
        clear(); scope = {lease: link.lease, revision: link.revision};
      }
      if (flight) return;
      const wanted = audio.clipKeys;
      status(wanted.some(key => failures.get(key)?.after === Infinity)
        ? "Algún sonido de esta sala no está disponible." : "");
      const key = wanted.find(key => !loaded.has(key) && (failures.get(key)?.after ?? 0) <= clock());
      if (!key) return;
      const ticket = scope, controller = flight = new AbortController();
      const current = () => flight === controller && scope === ticket && link.audioClipsOffered &&
        link.lease === ticket.lease && link.revision === ticket.revision;
      const timeout = setTimeout(() => controller.abort(), 15000);
      async function download() {
        const response = await link.call("audio", {...ticket,key}, null, controller.signal, true);
        const digest = response.headers.get("x-mundo-audio-digest");
        if (!digest || !/^[a-f0-9]{64}$/.test(digest) || key !== "s" + digest.slice(0,16))
          throw Object.assign(Error("Identidad del sonido inválida."), {status:422});
        const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (type !== "application/octet-stream" && type !== "audio/wav")
          throw Object.assign(Error("Tipo de sonido incompatible."), {status:422});
        const bytes = await readBytes(response, codec.maxClipBytes, type);
        if (!current() || !audio.clipKeys.includes(key)) return;
        const pcm = await codec.verify(key, bytes, digest);
        if (!current() || !audio.clipKeys.includes(key)) return;
        audio.setClip(key, pcm); loaded.add(key); failures.delete(key);
      }
      return download().catch(error => {
        if (!current()) return;
        const count = (failures.get(key)?.count ?? 0) + 1;
        const permanent = count >= 3 || [400,403,404,409,410,422].includes(error.status);
        failures.set(key, {count, after: permanent ? Infinity : clock() + 2000 * count});
      }).finally(() => {
        clearTimeout(timeout);
        if (flight === controller) flight = null;
      });
    }
    return Object.freeze({update, pause, clear});
  }
  return Object.freeze({create, roomClips});
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.MundoPlayerAudio;
