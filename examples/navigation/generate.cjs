"use strict";
// Creates the scene through the same world and project APIs used by Studio.
const {writeFile} = require("node:fs/promises");
const {MundoWorld, MundoProject} = require("../../server/room-runtime.cjs");
const routes = require("../../web/npc-routes.js");

function box(world, name, position, size, color) {
  const part = MundoWorld.add(world, name, 1);
  part.p = position;
  part.s = size;
  part.color = color;
  return part.id;
}

function courtyard() {
  const world = MundoWorld.empty();
  box(world, "Suelo de los patios", [0, -.25, 0], [32, .5, 32], [.35, .43, .42]);
  box(world, "Muro entre las dos paradas", [0, 1.5, -3], [1, 3, 4], [.67, .35, .20]);
  const portal = box(world, "Portal/Jardín", [0, .06, 2], [2.5, .12, 1.5], [.12, .64, .65]);
  const west = [-4, 0, -3], east = [4, 0, -3];
  const route = routes.addRoute(world, "Entre los dos bancos", [west, east]);
  const npc = routes.addNpc(world, {label:"Guía del patio", route, mode:"patrol",
    speed:2, waitSeconds:.6, spawn:west});
  return {world, portal, npc};
}

function garden() {
  const world = MundoWorld.empty();
  box(world, "Suelo del jardín", [0, -.25, 0], [32, .5, 32], [.25, .46, .32]);
  const portal = box(world, "Portal/Patio", [0, .06, 2], [2.5, .12, 1.5], [.12, .64, .65]);
  // The high ID also exercises transfer of full unsigned 64-bit IDs through the browser protocol.
  world.next = 9007199254741001n;
  const start = [-5, 0, -1];
  const route = routes.addRoute(world, "Paseo del jardín", [start, [-5, 0, -6]]);
  const npc = routes.addNpc(world, {label:"Guía del jardín", route, mode:"patrol",
    speed:1.5, waitSeconds:1, spawn:start});
  return {world, portal, npc};
}

async function projectBytes(first, second) {
  const worlds = [
    await MundoProject.draft(1, first.world, "Patio del muro", null, null),
    await MundoProject.draft(2, second.world, "Jardín", null, null)
  ];
  const portals = [
    {from:1, tile:String(first.portal), to:2},
    {from:2, tile:String(second.portal), to:1}
  ];
  const project = await MundoProject.pack({name:"Los dos patios", start:1, worlds, portals});
  return Buffer.from(await project.arrayBuffer());
}

if (require.main === module) {
  (async () => {
    const target = process.argv[2];
    if (!target || !target.endsWith(".mproject")) throw Error("Indica un archivo de salida .mproject.");
    await writeFile(target, await projectBytes(courtyard(), garden()), {flag:"wx"});
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {courtyard, garden, projectBytes};
