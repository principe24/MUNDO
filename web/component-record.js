"use strict";
// Project-owned JSON is retained as text. An editor can round-trip a plugin
// version it does not understand, including large integer literals in its data.
(function expose(create) {
  if (typeof module === "object" && module.exports) module.exports = create();
  else window.MundoComponentRecords = create();
})(() => {
  const utf8 = new TextEncoder();
  const empty = Object.freeze([]);
  const perRecordBytes = 2048, perWorldBytes = 8192, perEntity = 16, perWorld = 64;
  function check(condition, message) {
    if (!condition) throw Error(message);
  }
  function describe(text) {
    check(typeof text === "string" && text.length <= perRecordBytes &&
      utf8.encode(text).length <= perRecordBytes, "Un componente admite hasta 2048 bytes de JSON.");
    let record;
    try { record = JSON.parse(text); } catch { throw Error("El componente necesita un objeto JSON válido."); }
    check(record && Object.hasOwn(record,"key") && typeof record.key === "string" &&
      /^[a-z][a-z0-9._-]{0,63}$/.test(record.key) && Number.isSafeInteger(record.version) && record.version > 0,
      "El componente necesita una clave y una versión entera positiva.");
    return {key:record.key, version:record.version};
  }
  const maxPlugins = 32;
  function pluginId(value) {
    return typeof value === "string" && value.length <= 48 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value);
  }
  function pluginVersion(value) { return Number.isSafeInteger(value) && value >= 1; }
  // Undefined means the author has chosen to inherit the local catalog.
  // An explicitly empty array means the project uses no plugin templates.
  function pluginPins(raw) {
    if (raw === undefined) return undefined;
    check(Array.isArray(raw) && raw.length <= maxPlugins, "El perfil de proyecto admite hasta 32 plugins.");
    const seen = new Set();
    const pins = raw.map(pin => {
      check(pin && !Array.isArray(pin) && Object.keys(pin).length === 2 && Object.hasOwn(pin,"id") &&
        Object.hasOwn(pin,"version") && pluginId(pin.id) && pluginVersion(pin.version) && !seen.has(pin.id),
        "Identificador o versión de plugin inválidos o repetidos en el perfil de proyecto.");
      seen.add(pin.id);
      return Object.freeze({id:pin.id,version:pin.version});
    });
    return Object.freeze(pins.sort((a,b) => a.id < b.id ? -1 : 1));
  }
  function snapshot(world) {
    const rows = [];
    for (const node of world.nodes.values()) {
      for (const text of node.components || empty) rows.push({entity:String(node.id), text});
    }
    if (!rows.length) return empty;
    return normalize(world, rows);
  }
  function normalize(world, rows) {
    check(Array.isArray(rows) && rows.length <= perWorld, "Un mundo admite hasta 64 componentes en el proyecto.");
    if (!rows.length) return empty;
    const byNode = new Map();
    const copy = [];
    let bytes = 0;
    for (const row of rows) {
      check(row && typeof row.entity === "string" && /^[1-9][0-9]{0,19}$/.test(row.entity) &&
        world.nodes.has(BigInt(row.entity)), "El componente pertenece a una pieza que falta.");
      const {key} = describe(row.text);
      let keys = byNode.get(row.entity);
      if (!keys) byNode.set(row.entity, keys = new Set());
      check(!keys.has(key) && keys.size < perEntity, "Clave repetida o demasiados componentes en esta pieza.");
      keys.add(key);
      bytes += utf8.encode(row.text).length;
      check(bytes <= perWorldBytes, "Los componentes de este mundo superan 8192 bytes.");
      copy.push(Object.freeze({entity:row.entity, text:row.text}));
    }
    return Object.freeze(copy);
  }
  // The target world has just been decoded from a geometry-only world snapshot.
  function apply(world, rows) {
    const grouped = new Map();
    for (const {entity,text} of rows) {
      const id = BigInt(entity);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(text);
    }
    for (const [id,items] of grouped) {
      const node = world.nodes.get(id);
      world.nodes.set(id, {...node, components:Object.freeze(items)});
    }
    return world;
  }
  return Object.freeze({empty, describe, normalize, snapshot, apply, maxPlugins, pluginId, pluginVersion, pluginPins});
});
