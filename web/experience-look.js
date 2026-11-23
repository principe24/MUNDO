"use strict";
// An experience may recommend an appearance. Distribution of its assets is a host decision.
const MundoExperienceLook = (() => {
  const ines = "ines-bajamar-1";
  const marker = "MUNDO/Apariencia/v1/InesBajamar";
  function markers(world) {
    const ids = new Set();
    for (const node of world.nodes.values()) {
      if (node.name === marker && node.parent === 0n && node.shape === 0 && node.visual === 0n &&
          node.p.every(value => value === 0) && node.s.every(value => value === 1) &&
          node.q[0] === 0 && node.q[1] === 0 && node.q[2] === 0 && Math.abs(node.q[3]) === 1)
        ids.add(node.id);
    }
    // Previous formats allow arbitrary names, including on ordinary mesh parents.
    if (ids.size) for (const node of world.nodes.values()) ids.delete(node.parent);
    return ids;
  }
  function read(world) { return markers(world).size ? ines : null; }
  function set(world, key) {
    if (key !== null && key !== ines) throw Error("Apariencia de personaje desconocida.");
    const ids = markers(world);
    if (key === null) for (const id of ids) world.nodes.delete(id);
    else if (!ids.size) globalThis.MundoWorld.add(world, marker, 0);
  }
  return Object.freeze({ines, markers, read, set});
})();
if (typeof module !== "undefined" && module.exports) module.exports = MundoExperienceLook;
else globalThis.MundoExperienceLook = MundoExperienceLook;
