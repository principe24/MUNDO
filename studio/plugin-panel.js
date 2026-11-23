"use strict";
window.MundoPluginPanel = function(applyTemplate) {
  const R = MundoPlugins, el = id => document.getElementById(id);
  const list = el("pluginSelect"), presets = el("pluginPreset"), files = el("pluginFiles");
  const status = el("pluginStatus");
  let state = R.initial(), db = null, busy = false, ready = false;
  let projectPins, review = null, audits = [], revisionOf;
  const revision = el("pluginRevision");
  function projectImpact(label, pins, prior, next) {
    function selection(catalog) {
      const view = R.profileView(catalog,pins);
      const enabled = new Set(view.enabled);
      const active = view.plugins.filter(p => enabled.has(p.id)).map(p => p.id+" v"+p.version);
      return [active.join(", ") || "sin plugins efectivos", ...view.issues].join(" ");
    }
    const before = selection(prior), after = selection(next);
    const heading = label+(pins === undefined ? " (hereda el catálogo)" : " (versiones fijadas)");
    return heading+" · "+(before === after ? after+" · se conserva" : before+" → "+after);
  }
  function drawReview() {
    el("pluginReviewBox").hidden = !review;
    el("pluginCancel").disabled = !review || busy;
    const stale = review && JSON.stringify(state) !== review.baseline;
    el("pluginConfirm").disabled = !review || busy || stale;
    if (!review) { el("pluginReviewSummary").textContent = ""; return; }
    const impacts = [["Proyecto abierto",projectPins],...audits.map(p => [p.name,p.pins])];
    el("pluginReviewSummary").textContent = [...review.plan.changes,
      ...impacts.map(([label,pins]) => projectImpact(label,pins,review.prior,review.plan.next)),
      ...(stale ? ["El catálogo ha cambiado en otra ventana. Vuelve a revisar el cambio."] : [])].join("\n");
  }
  function message(text) {
    status.textContent = db ? text : text+" · Solo esta sesión.";
  }
  function draw(selected = list.value) {
    const active = new Set(state.enabled);
    list.replaceChildren(...state.plugins.map(p => new Option(
      p.name+" · "+p.id+" v"+p.version+(active.has(p.id) ? " · activo" : " · inactivo"),p.id)));
    if (state.plugins.some(p => p.id === selected)) list.value = selected;
    const key = list.value, p = state.plugins.find(item => item.id === key);
    const oldRevision = revisionOf === key ? Number(revision.value) : null;
    const saved = R.versions(state,key);
    revision.replaceChildren(...saved.map(v => new Option("v"+v.version+(v.version === p.version ? " · preferida" : ""),String(v.version))));
    if (p) revision.value = String(saved.some(v => v.version === oldRevision) ? oldRevision : p.version);
    revisionOf = key;
    revision.disabled = !ready || busy || !p;
    el("pluginReviewVersion").disabled = !ready || busy || !p || Number(revision.value) === p.version;
    drawReview();
    el("pluginDeps").textContent = p ? (p.requires.length ?
      "Requiere "+p.requires.map(d => d.id+" v"+d.minVersion+"+").join(", ") : "Sin dependencias.") : "";
    el("pluginEnable").disabled = !ready || busy || !p || active.has(key);
    el("pluginDisable").disabled = !ready || busy || !active.has(key);
    el("pluginRemove").disabled = !ready || busy || !p;
    el("pluginExport").disabled = !ready || busy || !p;
    // A native file picker can return focus before it dispatches its change event.
    files.disabled = !ready;
    list.disabled = !ready || busy;
    const previous = presets.value;
    const effective = R.profileView(state,projectPins);
    const options = R.templates(effective);
    el("projectPluginCapture").disabled = !ready || busy;
    el("projectPluginClear").disabled = projectPins === undefined;
    const summary = projectPins === undefined ? "Se usa el catálogo del navegador." :
      projectPins.length ? "Perfil del proyecto: "+projectPins.map(p => p.id+" v"+p.version).join(", ")+"."
                         : "Perfil del proyecto sin plugins.";
    el("projectPluginStatus").textContent = [summary,...effective.issues].join(" ");
    presets.replaceChildren(...options.map(t => new Option(t.label+" · "+t.plugin,t.key)));
    if (options.some(t => t.key === previous)) presets.value = previous;
    el("pluginApply").disabled = presets.disabled = !ready || busy || options.length === 0;
  }
  function openDatabase() {
    return new Promise((resolve,reject) => {
      const req = indexedDB.open("MundoStudioPlugins",2);
      req.onupgradeneeded = event => { if (!event || event.oldVersion === 0) req.result.createObjectStore("catalog"); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(Error("Cierra otra versión de Studio para abrir el catálogo."));
      req.onsuccess = () => resolve(req.result);
    });
  }
  // Read the latest registry and commit a single replacement in the same transaction.
  function access(transform) {
    if (!db) return Promise.resolve(transform ? transform(state) : state);
    return new Promise((resolve,reject) => {
      const tx = db.transaction("catalog",transform ? "readwrite" : "readonly");
      const store = tx.objectStore("catalog"), req = store.get("active-catalog");
      let next, reason;
      req.onsuccess = () => {
        try {
          const raw = req.result;
          const prior = raw === undefined ? R.initial() : R.catalog(raw.plugins,raw.enabled,raw.retained);
          next = transform ? transform(prior) : prior;
          if (transform) store.put(next,"active-catalog");
        } catch (error) { reason = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = () => reject(reason || tx.error || Error("El catálogo no pudo guardarse."));
    });
  }
  let channel = null, tail = Promise.resolve(), pending = 0;
  let refreshing = false, refreshAgain = false;
  function run(fn) {
    if (!ready) return;
    pending++;
    if (!busy) { busy = true; draw(); }
    tail = tail.then(fn).catch(error => message(error.message)).finally(() => {
      if (--pending === 0) { busy = false; draw(); }
    });
  }
  function refresh() {
    if (!ready) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    run(async () => {
      try { state = await access(); }
      finally {
        refreshing = false;
        if (refreshAgain) { refreshAgain = false; refresh(); }
      }
    });
  }
  async function save(transform, feedback, selected) {
    state = await access(transform);
    draw(selected);
    message(feedback);
    if (channel) channel.postMessage("changed");
  }
  function discardReview() { review = null; audits = []; }
  async function commit(reviewed) {
    let stale = false;
    try {
      await save(prior => {
        stale = JSON.stringify(prior) !== reviewed.baseline || reviewed !== review;
        if (stale) throw Error("La revisión cambió. Revisa el catálogo antes de confirmar.");
        return R.proposal(prior,reviewed.request).next;
      },"Cambios de manifiestos guardados.",reviewed.selected);
    } catch (error) {
      if (stale) { discardReview(); state = await access(); }
      throw error;
    }
    discardReview();
    draw(reviewed.selected);
  }
  async function stage(request, selected) {
    discardReview();
    const prior = await access(), plan = R.proposal(prior,request);
    state = prior;
    review = {prior,baseline:JSON.stringify(prior),plan,request,selected};
    if (!plan.confirmation) { await commit(review); return; }
    draw(selected); message("Revisa el cambio de versión y los proyectos antes de confirmarlo.");
  }
  revision.onchange = () => draw();
  el("pluginReviewVersion").onclick = () => {
    const id = list.value, version = Number(revision.value);
    run(() => stage({kind:"select",id,version},id));
  };
  el("pluginConfirm").onclick = () => {
    const reviewed = review;
    if (reviewed) run(() => commit(reviewed));
  };
  el("pluginCancel").onclick = () => { discardReview(); draw(); message("Revisión cancelada."); };
  const auditFiles = el("pluginAuditFiles");
  auditFiles.onchange = () => {
    const chosen = Array.from(auditFiles.files || []), current = review;
    auditFiles.value = "";
    if (!current || !chosen.length) return;
    run(async () => {
      if (chosen.length > 8 || chosen.reduce((n,f) => n+f.size,0) > 128*1024*1024)
        throw Error("Elige hasta ocho proyectos que sumen como máximo 128 MiB.");
      const documents = [];
      for (const file of chosen) {
        const {studioPlugins} = await MundoProject.open(file);
        documents.push({name:file.name,pins:studioPlugins});
      }
      if (review === current) { audits = documents; draw(); }
    });
  };
  list.onchange = () => draw();
  files.onchange = () => {
    const chosen = Array.from(files.files || []);
    files.value = "";
    if (!chosen.length) return;
    run(async () => {
      if (chosen.length > R.maxPlugins || chosen.some(file => file.size > R.maxBytes))
        throw Error("Elige hasta 32 archivos de 32 KiB cada uno.");
      const decoder = new TextDecoder("utf-8",{fatal:true});
      const batch = await Promise.all(chosen.map(async file => R.parse(decoder.decode(await file.arrayBuffer()))));
      await stage({kind:"install",batch},batch[0].id);
    });
  };
  for (const [id,action,feedback] of [
    ["pluginEnable","enable","Plugin y dependencias activados."],
    ["pluginDisable","disable","Plugin desactivado."],
    ["pluginRemove","remove","Plugin retirado. Los componentes de los proyectos se conservan."]
  ]) el(id).onclick = () => {
    const key = list.value;
    run(async () => { discardReview(); await save(prior => R.change(prior,key,action),feedback,key); });
  };
  el("pluginExport").onclick = () => {
    const p = R.versions(state,list.value).find(item => item.version === Number(revision.value));
    if (!p) return;
    const a = document.createElement("a");
    // The normalized compact form always meets the importer's byte limit.
    const url = URL.createObjectURL(new Blob([JSON.stringify(p)],{type:"application/json"}));
    a.href = url; a.download = p.id+".mplugin"; a.click();
    setTimeout(() => URL.revokeObjectURL(url),60000);
  };
  el("pluginApply").onclick = () => {
    const view = R.profileView(state,projectPins);
    const template = R.templates(view).find(t => t.key === presets.value);
    if (!template) return;
    try { applyTemplate(template); message("Plantilla aplicada a la pieza."); }
    catch (error) { message(error.message); }
  };
  async function start() {
    draw();
    try { db = await openDatabase(); } catch { db = null; }
    try {
      state = await access();
      ready = true;
      if (db) {
        db.onversionchange = () => {
          ready = false; db.close(); draw();
          status.textContent = "Vuelve a abrir Studio para usar la nueva versión del catálogo.";
        };
        window.addEventListener("focus",refresh);
        if (typeof BroadcastChannel === "function") {
          try { channel = new BroadcastChannel("MundoStudioPlugins"); channel.onmessage = refresh; }
          catch { /* Access on focus still sees the latest registry. */ }
        }
      }
      message(db ? "Catálogo local del navegador." : "Almacenamiento persistente no disponible.");
    } catch (error) { message("No se pudo abrir el catálogo. "+error.message); }
    draw();
  }
  start();
  return {
    captureProfile() {
      if (!ready || busy) throw Error("Espera a que termine de cargar el catálogo.");
      return R.captureProfile(state);
    },
    useProfile(pins) {
      const selection = MundoComponentRecords.pluginPins(pins);
      if (JSON.stringify(selection) !== JSON.stringify(projectPins)) discardReview();
      projectPins = selection;
      draw();
    }
  };
};
