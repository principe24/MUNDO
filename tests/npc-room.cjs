"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {readFile} = require("node:fs/promises");
const path = require("node:path");
const {randomBytes} = require("node:crypto");
const {makeRoom, createHost} = require("../server/room.cjs");
const {readProject} = require("../server/project-room.cjs");
const {mediaTypeV3} = require("../server/room-wire.cjs");
const {MundoProject} = require("../server/room-runtime.cjs");
const {courtyard, garden, projectBytes} = require("../examples/navigation/generate.cjs");

const states = ["patrol", "waiting", "follow", "return", "blocked", "idle"];
const options = {npcs:true};
const binaryOptions = {npcs:true, binary:true};
const examplePath = path.join(__dirname, "../examples/navigation/Los_dos_patios.mproject");

function readEnvelope(frame) {
  assert.equal(frame.toString("ascii", 0, 4), "MWN1");
  const baseSize = frame.readUInt16LE(4);
  const base = frame.subarray(6, 6 + baseSize);
  assert.equal(base.toString("ascii", 0, 4), "MWS3");
  const count = frame[6 + baseSize];
  assert.ok(count >= 1 && count <= 8);
  assert.equal(frame.length, 7 + baseSize + count * 41);
  const npcs = [];
  for (let i = 0; i < count; i++) {
    const at = 7 + baseSize + 41 * i;
    const state = states[frame[at + 40]];
    assert.ok(state);
    npcs.push({
      id: String(frame.readBigUInt64LE(at)),
      position: [8, 16, 24].map(offset => frame.readDoubleLE(at + offset)),
      yaw: frame.readDoubleLE(at + 32), state
    });
  }
  return {base, npcs};
}

async function setup(t) {
  const first = courtyard(), second = garden();
  const bytes = await readFile(examplePath);
  assert.deepEqual(bytes, await projectBytes(first, second), "distributed example must match its generator");
  const project = await readProject(bytes);
  // Use the public simulation clock hook so a slow runner never changes the NPC itinerary.
  let now = 0;
  const room = makeRoom(null, null, () => now, null, null, project);
  const host = createHost(room, {port:0});
  t.after(() => host.close());
  const origin = await host.start();
  const tick = (steps = 1) => {
    for (let i = 0; i < steps; i++) {
      now += 50;
      room.advance();
    }
  };
  function client(seat) {
    const ticket = {invite:seat.invite, proof:randomBytes(24).toString("hex")};
    let seq = 0, lease, epoch = 1;
    async function post(endpoint, data, {binary=false, npcs=false, invite=ticket.invite} = {}) {
      const headers = {origin, "content-type":"application/json", "x-invite":invite, "x-seat":ticket.proof,
        "x-mundo-room-version":"3", "x-mundo-scene":"ready", "x-mundo-travel":"1"};
      if (binary) headers.accept = mediaTypeV3;
      if (npcs) headers["x-mundo-npcs"] = "1";
      return fetch(origin + "/room/" + endpoint,
        {method:"POST", headers, body:JSON.stringify(data)});
    }
    async function route(vote) {
      const reply = await post("route", vote ? {epoch, lease, vote} : {});
      assert.equal(reply.status, 200);
      const bytes = Buffer.from(await reply.arrayBuffer());
      assert.equal(bytes.toString("ascii", 0, 4), "MWT1");
      return {phase: bytes[4], epoch:Number(bytes.readBigUInt64LE(5)), world:Number(bytes.readBigUInt64LE(13))};
    }
    function input(mask=0, flags=options, overrides={}) {
      return post("input", {seq:++seq, mask, yaw:0, jump:false, epoch, lease, ...overrides}, flags);
    }
    async function state(mask=0, flags=options) {
      const res = await input(mask, flags);
      assert.equal(res.status, 200);
      return flags.binary ? Buffer.from(await res.arrayBuffer()) : res.json();
    }
    return {post, input, state, route, setEpoch:newEpoch => {epoch = newEpoch;},
      async join() {
        const res = await post("join", {}, options);
        assert.equal(res.status, 200);
        const info = await res.json();
        assert.equal(info.project, true);
        lease = info.lease;
        return info;
      }};
  }
  return {first, second, room, project, tick, a:client(room.seats[0]), b:client(room.seats[1])};
}

test("Studio project keeps NPC routes when packed for guests", async () => {
  const project = await MundoProject.open(new Blob([await readFile(examplePath)]));
  const guests = await readProject(Buffer.from(await (await MundoProject.packForRoom(project)).arrayBuffer()));
  assert.deepEqual([...guests.worlds.keys()], [1, 2]);
  const host = makeRoom(null, null, () => 0, null, null, guests);
  assert.equal(host.name, "Patio del muro");
  assert.equal(host.revision, guests.worlds.get(1).revision);
  assert.notEqual(guests.worlds.get(1).revision, guests.worlds.get(2).revision);
  // Geometry, route and NPC marker bytes travel intact with the world, even on guest export.
  const stored = await readProject(await readFile(examplePath));
  for (const [id, entry] of guests.worlds) assert.deepEqual(entry.bytes, stored.worlds.get(id).bytes);
});

test("two seats receive the same NPC, negotiate legacy frames, detour and stop at the authored waypoint", async t => {
  const {a,b,first,tick} = await setup(t);
  await a.join(); await b.join();
  const initial = await a.state();
  assert.equal(initial.players.length, 2);
  assert.equal(initial.npcs.length, 1);
  assert.equal(initial.npcs[0].id, String(first.npc));
  assert.deepEqual(readEnvelope(await b.state(0, binaryOptions)).npcs, initial.npcs);
  const old = await b.state(0, {});
  assert.equal(Object.hasOwn(old, "npcs"), false);
  const oldBin = await b.state(0, {binary:true});
  assert.equal(oldBin.toString("ascii", 0, 4), "MWS3");
  assert.equal(oldBin.length, 13 + 2 * 42 + 1);
  const unauthorized = await a.post("input", {}, {npcs:true, invite:"0".repeat(48)});
  assert.equal(unauthorized.status, 403);
  const forged = await a.input(0, options, {npcs:[{id:String(first.npc),position:[99,99,99]}]});
  assert.equal(forged.status, 400);

  let detoured = false, pausedAtFarEnd = false, startedReturn = false;
  let last = initial.npcs[0];
  for (let i = 0; i < 50; i++) {
    tick(5);
    const next = (await a.state()).npcs[0];
    const [x,y,z] = next.position;
    assert.ok(next.position.every(Number.isFinite) && Number.isFinite(next.yaw));
    assert.ok(Math.abs(y) <= .3, "walk at floor level");
    assert.ok(!(Math.abs(x) < .5 && Math.abs(z + 3) < 2), "NPC cannot enter wall");
    if (Math.abs(x) < 1.3 && Math.abs(z + 3) >= 2) detoured = true;
    if (x > 3.25 && next.state === "waiting" && last.state === "waiting"
      && Math.hypot(x - last.position[0], z - last.position[2]) < .001) pausedAtFarEnd = true;
    if (pausedAtFarEnd && x < 2.5) startedReturn = true;
    last = next;
  }
  assert.ok(detoured, "NPC must leave the straight line to cross the wall");
  assert.ok(pausedAtFarEnd, "NPC must pause at the authored destination");
  assert.ok(startedReturn, "NPC must resume its patrol after the wait");
  assert.deepEqual(readEnvelope(await b.state(0, binaryOptions)).npcs, [last]);
});

test("two votes switch the NPC population atomically and stale epochs cannot move it", async t => {
  const {a,b,first,second,room,project,tick} = await setup(t);
  await a.join(); await b.join();
  const start = await a.state();
  await b.state();
  assert.equal(start.npcs[0].id, String(first.npc));
  // Let the feet settle on the floor before entering the portal.
  tick(6);
  let proposal;
  for (let i = 0; i < 15; i++) {
    await a.state(1);
    tick(4);
    proposal = await a.route();
    if (proposal.phase === 1) break;
  }
  assert.equal(proposal.phase, 1);
  assert.equal(proposal.world, 2);
  const otherProposal = await b.route();
  assert.deepEqual(otherProposal, proposal);
  assert.equal((await a.input()).status, 412, "pending transition freezes playable input");
  a.setEpoch(proposal.epoch); b.setEpoch(proposal.epoch);
  assert.equal((await a.route("ready")).phase, 1);
  assert.equal(room.revision, project.worlds.get(1).revision);
  assert.equal((await b.route("ready")).phase, 0);
  assert.equal(room.revision, project.worlds.get(2).revision);
  assert.equal((await a.input(0, options, {epoch:1})).status, 412);
  const arrived = (await a.state()).npcs;
  assert.equal(arrived.length, 1);
  assert.ok(second.npc > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(arrived[0].id, String(second.npc));
  assert.deepEqual(readEnvelope(await b.state(0, binaryOptions)).npcs, arrived);
});

test("an empty room suspends its patrol and the next observer resumes the saved position", async t => {
  const {a,b,tick} = await setup(t);
  await a.join(); await b.join();
  await a.state(); await b.state();
  tick(32);
  const before = (await a.state()).npcs;
  assert.equal(before[0].state, "patrol");
  await b.post("leave", {});
  tick(4);
  const observedAlone = (await a.state()).npcs;
  assert.notDeepEqual(before[0].position, observedAlone[0].position);
  assert.equal((await a.post("leave", {})).status, 200);
  tick(360);
  await b.join();
  assert.deepEqual((await b.state()).npcs, observedAlone);
  tick(4);
  assert.notDeepEqual((await b.state()).npcs[0].position, observedAlone[0].position);
});
