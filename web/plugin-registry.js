"use strict";
// Portable Studio manifests contain component templates and dependency metadata.
(function expose(create) {
  if (typeof module === "object" && module.exports) module.exports = create(require("./component-record.js"));
  else window.MundoPlugins = create(window.MundoComponentRecords);
})(records => {
  const format = "mundo.studio.plugin/1", maxBytes = 32 * 1024, maxPlugins = records.maxPlugins;
  const utf8 = new TextEncoder();
  const sample = {
    format, id:"mundo.lugares", version:1, name:"Puntos de interés", requires:[],
    presets:[{label:"Punto de interés", record:'{"key":"mundo.lugares.interes","version":1,"data":{"nombre":"Punto de interés","categoria":"lugar"}}'}]
  };
  function check(ok, message) { if (!ok) throw Error(message); }
  function object(raw, fields) {
    check(raw && typeof raw === "object" && !Array.isArray(raw) &&
      Object.keys(raw).every(k => fields.includes(k)) && fields.every(k => Object.hasOwn(raw,k)),
      "Campos de manifiesto desconocidos o ausentes.");
  }
  const id = records.pluginId, version = records.pluginVersion;
  function label(value) {
    return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 96 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
  }
  function manifest(raw) {
    object(raw,["format","id","name","version","requires","presets"]);
    check(raw.format === format && id(raw.id) && version(raw.version) && label(raw.name), "Identidad o versión de plugin inválida.");
    check(Array.isArray(raw.requires) && raw.requires.length <= 16, "Un plugin admite hasta 16 dependencias.");
    const dependencies = new Set();
    const requires = raw.requires.map(dep => {
      object(dep,["id","minVersion"]);
      check(id(dep.id) && dep.id !== raw.id && !dependencies.has(dep.id) && version(dep.minVersion),
        "Dependencia inválida, propia o repetida en " + raw.id);
      dependencies.add(dep.id);
      return {id:dep.id,minVersion:dep.minVersion};
    }).sort((a,b) => a.id < b.id ? -1 : 1);
    check(Array.isArray(raw.presets) && raw.presets.length <= 16, "Un plugin admite hasta 16 plantillas.");
    const keys = new Set();
    const presets = raw.presets.map(preset => {
      object(preset,["label","record"]);
      const {key} = records.describe(preset.record);
      check(label(preset.label) && key.startsWith(raw.id+".") && !keys.has(key),
        "La plantilla necesita una etiqueta y una clave única dentro de " + raw.id);
      keys.add(key);
      return {label:preset.label,record:preset.record};
    });
    const normalized = {format,id:raw.id,name:raw.name,version:raw.version,requires,presets};
    check(utf8.encode(JSON.stringify(normalized)).length <= maxBytes, "El manifiesto supera 32 KiB.");
    return normalized;
  }
  function parse(text) {
    check(typeof text === "string" && text.length <= maxBytes && utf8.encode(text).length <= maxBytes,
      "El manifiesto supera 32 KiB.");
    return manifest(JSON.parse(text));
  }
  // DFS over sorted identifiers produces one stable load order for every input order.
  function catalog(plugins, enabled, retained = []) {
    check(Array.isArray(plugins) && plugins.length <= maxPlugins && Array.isArray(enabled) &&
      enabled.length <= maxPlugins, "Catálogo de plugins inválido o lleno.");
    const byId = new Map(), keys = new Set();
    for (const input of plugins) {
      const p = manifest(input);
      check(!byId.has(p.id), "Plugin repetido: " + p.id);
      byId.set(p.id,p);
      for (const preset of p.presets) {
        const {key} = records.describe(preset.record);
        check(!keys.has(key), "Dos plugins declaran " + key);
        keys.add(key);
      }
    }
    const active = new Set(enabled), visited = new Set(), path = new Set(), order = [];
    check(active.size === enabled.length && enabled.every(key => byId.has(key)), "Selección de plugins activos inválida.");
    function visit(p) {
      if (visited.has(p.id)) return;
      check(!path.has(p.id), "Ciclo de dependencias en " + p.id);
      path.add(p.id);
      for (const dep of p.requires) {
        const found = byId.get(dep.id);
        check(found && found.version >= dep.minVersion, p.id+" requiere "+dep.id+" v"+dep.minVersion+" o posterior.");
        check(!active.has(p.id) || active.has(dep.id), p.id+" requiere que esté activo "+dep.id);
        visit(found);
      }
      path.delete(p.id);
      visited.add(p.id);
      order.push(p);
    }
    for (const key of [...byId.keys()].sort()) visit(byId.get(key));
    check(Array.isArray(retained) && retained.length <= 64, "El catálogo admite hasta 64 versiones adicionales.");
    const historicalKeys = new Set();
    const history = retained.map(raw => {
      const p = manifest(raw), selected = byId.get(p.id), key = p.id+"@"+p.version;
      check(selected && selected.version !== p.version && !historicalKeys.has(key), "Historial de plugins incoherente: "+key);
      historicalKeys.add(key);
      return p;
    }).sort((a,b) => a.id === b.id ? a.version-b.version : a.id < b.id ? -1 : 1);
    return {plugins:order, enabled:order.filter(p => active.has(p.id)).map(p => p.id), retained:history};
  }
  function initial() { return catalog([sample],[]); }
  function versions(state, id) {
    return [...state.plugins,...state.retained].filter(p => p.id === id).sort((a,b) => a.version-b.version);
  }
  function update(state, batch, switchId) {
    check(Array.isArray(batch) && batch.length && batch.length <= maxPlugins, "Elige entre 1 y 32 manifiestos.");
    const byId = new Map(state.plugins.map(p => [p.id,p])), seen = new Set();
    const archive = new Map(state.retained.map(p => [p.id+"@"+p.version,p]));
    for (const raw of batch) {
      const p = manifest(raw), old = byId.get(p.id), key = p.id+"@"+p.version;
      check(!seen.has(p.id), "Plugin repetido en la importación: " + p.id);
      seen.add(p.id);
      const known = old?.version === p.version ? old : archive.get(key);
      check(!known || JSON.stringify(known) === JSON.stringify(p),
        "Para modificar "+p.id+" v"+p.version+" se necesita una versión superior.");
      if (!old || p.version > old.version || switchId === p.id) {
        if (old && old.version !== p.version) archive.set(old.id+"@"+old.version,old);
        archive.delete(key);
        byId.set(p.id,p);
      } else if (p.version < old.version) {
        // An older archive imported on a different computer can satisfy an exact project pin.
        archive.set(key,p);
      }
    }
    return catalog([...byId.values()],state.enabled,[...archive.values()]);
  }
  function install(state, batch) { return update(state,batch); }
  function select(state, key, version) {
    const candidate = versions(state,key).find(p => p.version === version);
    check(candidate,"La versión elegida no está instalada.");
    return update(state,[candidate],key);
  }
  function delta(before, after) {
    const lines = [];
    const changes = (label,previous,current) => {
      const old = new Map(previous), next = new Map(current);
      for (const key of [...new Set([...old.keys(),...next.keys()])].sort()) {
        if (!old.has(key)) lines.push(label+" añadida: "+key+" ("+next.get(key)+")");
        else if (!next.has(key)) lines.push(label+" retirada: "+key+" ("+old.get(key)+")");
        else if (old.get(key) !== next.get(key)) lines.push(label+" modificada: "+key+" ("+old.get(key)+" → "+next.get(key)+")");
      }
    };
    if (before && before.name !== after.name) lines.push("Nombre: "+before.name+" → "+after.name);
    const requirements = p => (p?.requires || []).map(d => [d.id,"v"+d.minVersion+"+"]);
    const presets = p => (p?.presets || []).map(t => [records.describe(t.record).key,t.label+" "+t.record]);
    changes("Dependencia",requirements(before),requirements(after));
    changes("Plantilla",presets(before),presets(after));
    return lines;
  }
  function proposal(state, request) {
    let next;
    if (request.kind === "select") next = select(state,request.id,request.version);
    else {
      check(request.kind === "install","Solicitud de actualización desconocida.");
      next = install(state,request.batch);
    }
    const changes = [];
    let confirmation = false;
    for (const p of next.plugins) {
      const old = state.plugins.find(x => x.id === p.id);
      if (old?.version === p.version) continue;
      if (old) confirmation = true;
      changes.push([p.id+(old ? " v"+old.version+" → v"+p.version : " · instalación v"+p.version),
        ...delta(old,p)].join("\n"));
    }
    for (const p of next.retained) {
      if (!versions(state,p.id).some(x => x.version === p.version)) {
        confirmation = true;
        changes.push([p.id+" v"+p.version+" · conservar para proyectos con esa versión",...delta(null,p)].join("\n"));
      }
    }
    return {next,changes,confirmation};
  }
  function change(state, key, action) {
    const p = state.plugins.find(item => item.id === key);
    check(p, "Selecciona un plugin instalado.");
    const active = new Set(state.enabled);
    if (action === "enable") {
      const byId = new Map(state.plugins.map(item => [item.id,item]));
      function enable(plugin) {
        if (active.has(plugin.id)) return;
        for (const dep of plugin.requires) enable(byId.get(dep.id));
        active.add(plugin.id);
      }
      enable(p);
    } else {
      check(action === "disable" || action === "remove", "Operación de plugin desconocida.");
      const dependents = action === "remove" ? [...state.plugins,...state.retained] : state.plugins;
      for (const other of dependents) {
        if (action === "remove" || active.has(other.id)) check(!other.requires.some(d => d.id === key),
          other.id+" depende de "+key+".");
      }
      active.delete(key);
    }
    const keep = items => action === "remove" ? items.filter(item => item.id !== key) : items;
    return catalog(keep(state.plugins),[...active],keep(state.retained));
  }
  function captureProfile(state) {
    const active = new Set(state.enabled);
    return records.pluginPins(state.plugins.filter(p => active.has(p.id)).map(({id,version}) => ({id,version})));
  }
  function profileView(state, requested) {
    if (requested === undefined) return {enabled:state.enabled,issues:[],plugins:state.plugins};
    const pins = records.pluginPins(requested), picked = new Map(), issues = [];
    for (const pin of pins) {
      const local = versions(state,pin.id);
      const match = local.find(p => p.version === pin.version);
      if (match) picked.set(pin.id,match);
      else if (!local.length) issues.push("Falta "+pin.id+" v"+pin.version+".");
      else issues.push(pin.id+" requiere v"+pin.version+"; en el catálogo: "+local.map(p => "v"+p.version).join(", ")+".");
    }
    const owners = new Map(), blocked = new Set(), visiting = new Set(), active = new Set(), ordered = [];
    for (const p of picked.values()) {
      for (const template of p.presets) {
        const {key} = records.describe(template.record);
        if (owners.has(key)) {
          blocked.add(p.id); blocked.add(owners.get(key));
          issues.push("Plantilla repetida en las versiones del perfil: "+key+".");
        } else owners.set(key,p.id);
      }
    }
    function load(p) {
      if (active.has(p.id)) return true;
      if (blocked.has(p.id)) return false;
      if (visiting.has(p.id)) {
        issues.push("Ciclo de dependencias fijadas en "+p.id+".");
        return false;
      }
      visiting.add(p.id);
      for (const dep of p.requires) {
        const target = picked.get(dep.id);
        if (!target || target.version < dep.minVersion || !load(target)) {
          blocked.add(p.id);
          issues.push(p.id+" necesita en este perfil "+dep.id+" v"+dep.minVersion+"+.");
        }
      }
      visiting.delete(p.id);
      if (blocked.has(p.id)) return false;
      active.add(p.id); ordered.push(p); return true;
    }
    for (const p of picked.values()) load(p);
    return {enabled:[...active],issues,plugins:ordered};
  }
  function resolveProfile(state, requested) {
    const {enabled,issues} = profileView(state,requested); return {enabled,issues};
  }
  function templates(state, enabled = state.enabled) {
    const active = new Set(enabled);
    return state.plugins.filter(p => active.has(p.id)).flatMap(p => p.presets.map(item => ({
      key:records.describe(item.record).key, plugin:p.id, label:item.label, record:item.record
    })));
  }
  return Object.freeze({maxBytes,maxPlugins,initial,parse,catalog,install,change,templates,captureProfile,resolveProfile,profileView,versions,proposal});
});
