"use strict";
(function expose(create) {
  if (typeof module === "object" && module.exports) module.exports = create(require("./component-record.js"));
  else globalThis.MundoCreatorSurfaceMaterials = create(MundoComponentRecords);
})(records => {
  const key = "mundo.materiales-superficie", hash = /^[0-9a-f]{64}$/;
  const cache = new WeakMap(), encoder = new TextEncoder();
  const fail = message => { throw Error(message); };

  function creatorKey(visual) {
    return typeof visual === "bigint" && (visual >> 60n) === 12n;
  }
  function matches(node, digest) {
    return creatorKey(node?.visual) && typeof digest === "string" && digest.length === 64 && hash.test(digest)
      && node.visual.toString(16) === "c" + digest.slice(0,15);
  }
  function surfaceName(value) {
    return value === null || (typeof value === "string" && value.length > 0 && value.trim() === value
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && encoder.encode(value).length <= 160);
  }
  function layoutName(id) {
    return id === "uniform" || (typeof id === "string" && id.length === 64 && hash.test(id));
  }
  function properties(value, keys) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).every(k => keys.includes(k));
  }
  function finish(value) {
    const patch = {};
    if (Object.hasOwn(value,"color")) {
      if (typeof value.color !== "string" || value.color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(value.color))
        fail("El color requiere seis dígitos hexadecimales.");
      patch.color = value.color.toLowerCase();
    }
    if (Object.hasOwn(value,"rough")) {
      if (!Number.isFinite(value.rough) || value.rough < 0 || value.rough > 1)
        fail("La rugosidad debe estar entre 0 y 1.");
      patch.rough = value.rough;
    }
    return patch;
  }
  function checked(node, raw) {
    if (raw.version !== 1 || !properties(raw,["key","version","digest","layoutId","overrides"]))
      fail("Esta versión del acabado se conserva en el proyecto y requiere otro editor.");
    if (!matches(node,raw.digest) || !layoutName(raw.layoutId) || !Array.isArray(raw.overrides) || !raw.overrides.length)
      fail("El acabado guardado no corresponde al modelo de esta instancia.");
    const seen = new Set();
    const overrides = raw.overrides.map(row => {
      if (!properties(row,["surface","color","rough"]) || !surfaceName(row.surface) || seen.has(row.surface)
        || (raw.layoutId === "uniform" && row.surface !== null)
        || (!Object.hasOwn(row,"color") && !Object.hasOwn(row,"rough")))
        fail("Los ajustes de superficie están incompletos o repetidos.");
      seen.add(row.surface);
      return Object.freeze({surface:row.surface, ...finish(row)});
    });
    return Object.freeze({digest:raw.digest, layoutId:raw.layoutId, overrides:Object.freeze(overrides)});
  }
  function get(node) {
    if (!creatorKey(node?.visual) || !node.components?.length) return null;
    const prior = cache.get(node);
    if (prior && prior.components === node.components && prior.visual === node.visual) return prior.value;
    const entry = node.components.find(text => records.describe(text).key === key);
    const value = entry === undefined ? null : checked(node,JSON.parse(entry));
    cache.set(node,{components:node.components,visual:node.visual,value});
    return value;
  }
  function names(layout) {
    return layout.ranges.length ? [...new Set(layout.ranges.map(row=>row.surface))] : [null];
  }
  function withoutFinish(node) {
    const others = (node.components || []).filter(text => records.describe(text).key !== key);
    return {...node,components:Object.freeze(others)};
  }
  function clear(node) { return get(node) ? withoutFinish(node) : node; }

  // A patch describes both inputs of one surface. An absent input inherits the
  // corresponding material of this instance. Each edit creates a new component list.
  function set(node, info, layoutId, surface, patch) {
    if (!info || !matches(node,info.digest) || node.visual.toString(16) !== info.key)
      fail("Selecciona una instancia de este modelo de creador.");
    const layout = info.surfaceLayouts?.find(item=>item.id === layoutId);
    if (!layout || !layoutName(layoutId) || !surfaceName(surface) || !names(layout).includes(surface))
      fail("La superficie elegida no está en esta distribución del modelo.");
    if (!properties(patch,["color","rough"])) fail("Ajustes de superficie inválidos.");
    const next = finish(patch), old = get(node);
    if (old && (old.digest !== info.digest || old.layoutId !== layoutId))
      fail("Restablece los acabados de esta instancia antes de elegir otra distribución.");
    const overrides = (old?.overrides || []).filter(row => row.surface !== surface);
    if (Object.keys(next).length) overrides.push({surface,...next});
    if (!overrides.length) return old ? withoutFinish(node) : node;
    overrides.sort((a,b) => a.surface === b.surface ? 0 : a.surface === null ? -1 : b.surface === null ? 1 : a.surface < b.surface ? -1 : 1);
    const text = JSON.stringify({key,version:1,digest:info.digest,layoutId,overrides});
    records.describe(text);
    const items = Array.from(node.components || []), i = items.findIndex(item => records.describe(item).key === key);
    if (i === -1) items.push(text);
    else if (items[i] === text) return node;
    else items[i] = text;
    return {...node,components:Object.freeze(items)};
  }
  return Object.freeze({get,set,clear,names,key});
});
