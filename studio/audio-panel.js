"use strict";

window.MundoStudioAudioPanel = function({world, edit, redraw, camera, mark, cancelMark}) {
  const scene = MundoAudioScene;
  const get = id => document.getElementById(id);
  const panel = get("audioPanel"), list = get("audioSource"), status = get("audioStatus");
  const axes = ["audioX", "audioY", "audioZ"];
  const defaults = {label:"Ambiente", preset:"brisa", position:[0,0,0], radius:12, volume:.65};
  const presets = get("audioPreset");
  let sources = [], active = null, catalog = [], catalogTicket = 0;

  function showPresets(preferred) {
    const options = [new Option("Brisa","brisa"), new Option("Agua","agua"), new Option("Máquina","maquina")];
    for (const entry of catalog) options.push(new Option(entry.name + " · " + entry.key,entry.key));
    if (scene.isClip(preferred) && !catalog.some(entry => entry.key === preferred))
      options.push(new Option("Clip pendiente de importar · " + preferred,preferred));
    presets.replaceChildren(...options);
    presets.value = preferred;
  }

  async function reloadCatalog() {
    const ticket = ++catalogTicket;
    try {
      const found = await MundoAudioLibrary.list();
      if (ticket !== catalogTicket) return;
      catalog = found;
      showPresets(presets.value || "brisa");
    } catch (error) {
      if (ticket === catalogTicket && panel.open) status.textContent = "Catálogo local no disponible. " + error.message;
    }
  }

  function fields() {
    return {label:get("audioName").value.trim(), preset:get("audioPreset").value,
      position:axes.map(id => get(id).valueAsNumber), radius:get("audioRadius").valueAsNumber,
      volume:get("audioVolume").valueAsNumber / 100, spatial:get("audioSpatial").value,
      group:get("audioGroup").value, loop:get("audioLoop").value === "loop", playbackRate:get("audioRate").valueAsNumber};
  }

  function stop() {
    const previous = active;
    active = null;
    get("audioStop").disabled = true;
    if (previous) {
      previous.output.close();
      status.textContent = "Escucha detenida.";
    }
  }

  function selected() {
    return sources.find(item => item.id === list.value);
  }

  function fill() {
    const item = selected(), source = item || defaults;
    get("audioName").value = source.label;
    showPresets(source.preset);
    get("audioSpatial").value = source.spatial || "3d";
    get("audioGroup").value = source.group || "ambiente";
    get("audioLoop").value = source.loop === false ? "once" : "loop";
    get("audioRate").value = source.playbackRate ?? 1;
    get("audioRadius").value = source.radius;
    get("audioVolume").value = Number((source.volume * 100).toFixed(1));
    axes.forEach((id,i) => { get(id).value = source.position[i]; });
    get("audioRemove").disabled = get("audioApply").disabled = !item;
    get("audioCreate").disabled = !!item || sources.length >= scene.maxSources;
    get("audioCopy").disabled = !item || sources.length >= scene.maxSources;
    get("audioMix").disabled = !sources.length;
  }

  function refresh(id = list.value) {
    stop();
    sources = scene.read(world());
    list.replaceChildren(new Option("Nueva fuente", ""), ...sources.map(s => new Option(s.label + " · " + s.id, s.id)));
    list.value = sources.some(s => s.id === String(id)) ? String(id) : "";
    fill();
    status.textContent = sources.length + " de " + scene.maxSources + " fuentes.";
  }

  function select(id) {
    if (id == null || !sources.some(s => s.id === String(id)) || list.value === String(id)) return;
    list.value = String(id);
    list.onchange();
  }

  function change(action, message) {
    let result;
    const error = edit(copy => { result = action(copy); return result; }, message);
    if (!error) {
      refresh(result ?? "");
      redraw();
    }
    status.textContent = error?.message || message;
  }

  // Audition the uncommitted controls without consuming a scene ID or changing undo history.
  function previewSource() {
    const preview = MundoWorld.empty();
    scene.add(preview, fields());
    return scene.read(preview)[0];
  }

  function moveListener() {
    if (active?.mode !== "mix") return;
    const pose = camera();
    active.output.setListener(pose.position, pose.yaw);
  }

  async function configureRun(run, updated) {
    const ticket = ++run.ticket;
    const selectedSources = run.mode === "solo" ? [previewSource()] : sources;
    const keys = new Set(selectedSources.map(s => s.preset).filter(key => scene.isClip(key)));
    for (const key of keys) {
      if (run.loaded.has(key)) continue;
      const item = await MundoAudioLibrary.get(key);
      if (active !== run || ticket !== run.ticket) return;
      if (!item) throw Error("Importa el WAV de " + key + " para escucharlo.");
      run.output.setClip(key, MundoAudioClips.decode(item.bytes));
      run.loaded.add(key);
    }
    if (active !== run || ticket !== run.ticket) return;
    run.output.setSources(selectedSources);
    if (run.mode === "mix") moveListener();
    else run.output.setListener(selectedSources[0].position, 0);
    if (!await run.ready || active !== run || ticket !== run.ticket) return;
    for (const s of selectedSources) {
      if (!s.loop && (!updated || run.lastPreset !== s.preset || run.lastLoop)) run.output.trigger(s.id);
    }
    if (run.mode === "solo") {
      run.lastPreset = selectedSources[0].preset;
      run.lastLoop = selectedSources[0].loop;
    }
    status.textContent = run.mode === "solo" ? "Escucha de la fuente en su origen." : "Escucha de la mezcla desde la cámara.";
  }

  function fail(run, error) {
    if (active !== run) return;
    stop();
    status.textContent = error.message;
  }

  function updateSolo() {
    const run = active;
    if (run?.mode === "solo") return configureRun(run, true).catch(error => fail(run,error));
  }

  async function listen(mode) {
    stop();
    let run;
    try {
      run = {mode, output:MundoAudioOutput.create(), ticket:0, loaded:new Set()};
      active = run;
      get("audioStop").disabled = false;
      status.textContent = "Abriendo salida de audio…";
      // Carry the click directly into unlock before any asynchronous local catalog lookup.
      run.ready = Promise.resolve(run.output.unlock()).then(ready => {
        if (!ready) fail(run,Error("El navegador no pudo abrir la salida de audio."));
        return ready;
      }).catch(error => { fail(run,error); return false; });
      await configureRun(run,false);
    } catch (error) {
      if (run) fail(run,error);
      else status.textContent = error.message;
    }
  }

  function locate(position) {
    axes.forEach((id,i) => { get(id).value = position[i]; });
    updateSolo();
    redraw();
    status.textContent = "Posición elegida. Guarda la fuente para incluirla en la sala.";
  }

  function overlays() {
    if (!panel.open) return [];
    // Only the current editor panel draws these indicators. They have no collision or world node.
    return sources.map((source,i) => {
      const [x,y,z] = source.position;
      const size = source.id === list.value ? .46 : .30;
      return {n:{id:-10000n-BigInt(i), shape:2, visual:0n, metal:0, rough:.7,
        color:source.id === list.value ? [1,.67,.18] : [.49,.32,.88]},
        center:[x,y,z], extent:[size/2,size/2,size/2], radius:size,
        m:[size,0,0,0,0,size,0,0,0,0,size,0,x,y,z,1]};
    });
  }

  list.onchange = () => { stop(); fill(); redraw(); };
  get("audioCreate").onclick = () => change(copy => scene.add(copy, fields()), "Fuente creada.");
  get("audioCopy").onclick = () => change(copy => scene.add(copy, fields()), "Copia independiente creada.");
  get("audioApply").onclick = () => change(copy => scene.update(copy, list.value, fields()), "Fuente guardada.");
  get("audioRemove").onclick = () => change(copy => { scene.remove(copy, list.value); return null; }, "Fuente retirada.");
  get("audioPick").onclick = mark;
  get("audioSolo").onclick = () => listen("solo");
  get("audioMix").onclick = () => listen("mix");
  get("audioStop").onclick = stop;
  for (const id of [...axes, "audioName", "audioRadius", "audioVolume"]) get(id).oninput = updateSolo;
  for (const id of ["audioPreset","audioGroup","audioSpatial","audioLoop"]) get(id).onchange = updateSolo;
  get("audioRate").oninput = updateSolo;
  get("audioWav").onchange = async event => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const start = world(), chosen = list.value, previous = presets.value;
    try {
      const item = await MundoAudioLibrary.importFile(file);
      await reloadCatalog();
      if (start !== world() || chosen !== list.value || previous !== presets.value) return;
      showPresets(item.key);
      updateSolo();
      status.textContent = "Sonido importado. Guarda la fuente para usarlo en este mundo.";
    } catch (error) { if (start === world()) status.textContent = error.message; }
  };
  panel.ontoggle = () => { if (!panel.open) { stop(); cancelMark(); } else reloadCatalog(); redraw(); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("pagehide", stop);
  return {refresh, select, locate, overlays, moveListener, reloadCatalog,
    marking(mode) { get("audioPick").setAttribute("aria-pressed", String(mode === "audio-position")); }};
};
