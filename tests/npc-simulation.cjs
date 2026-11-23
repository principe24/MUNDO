"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {NpcSimulation, NPC_STATES} = require("../server/npc-simulation.cjs");

const route = (extra = {}) => ({id: "9007199254740993", mode: "patrol",
  points: [[0,0,0], [2,0,0]], speed: 2, waitSeconds: 0, ...extra});
const tick = (sim, count, inputs = {}) => {
  for (let i = 0; i < count; i++) sim.advance(.05, inputs);
};
const pos = sim => sim.snapshot()[0].position;
const state = sim => sim.snapshot()[0].state;

// This walking plane isolates behavior, planning budgets and scheduling. The
// integration suite uses actual engine solids and the real multilayer planner.
function plane() {
  const calls = [];
  function open(point, blockers) {
    return !blockers.some(b => point[0]+.28>b.min[0] && point[0]-.28<b.max[0] &&
      point[1]+1.68>b.min[1] && point[1]<b.max[1] &&
      point[2]+.28>b.min[2] && point[2]-.28<b.max[2]);
  }
  return {
    calls,
    project(p, {obstacles}) { return open(p, obstacles) ? p.slice() : null; },
    plan(a, b, {maxNodes}) {
      calls.push({a:a.slice(), b:b.slice(), maxNodes});
      return {status:"ok", points:[a.slice(), b.slice()]};
    },
    advance(a, [x,z], {obstacles}) {
      const p = [x, a[1], z];
      return open(p, obstacles) ? p : null;
    },
    canTraverse() { return true; }
  };
}

test("host patrol preserves feet, orientation, waits and closes a loop", () => {
  const sim = new NpcSimulation(plane(), [route({waitSeconds:.2})]);
  assert.equal(state(sim), "waiting");
  tick(sim, 3);
  assert.deepEqual(pos(sim), [0,0,0]);
  tick(sim, 20);
  assert.deepEqual(pos(sim), [2,0,0]);
  assert.equal(state(sim), "waiting");
  assert.equal(sim.snapshot()[0].yaw, Math.PI/2);
  tick(sim, 3);
  assert.deepEqual(pos(sim), [2,0,0]);
  tick(sim, 20);
  assert.deepEqual(pos(sim), [0,0,0]);
  assert.equal(sim.snapshot()[0].yaw, -Math.PI/2);
});

test("same elapsed simulation produces identical snapshots; large gaps cannot teleport", () => {
  const make = () => new NpcSimulation(plane(), [route()]);
  const split = make(), chunked = make();
  tick(split, 24);
  for (let i=0;i<12;i++) chunked.advance(.1);
  assert.deepEqual(split.snapshot(),chunked.snapshot());
  const frozen = make();
  for (const elapsed of [NaN, -.1, Infinity, 0]) frozen.advance(elapsed);
  assert.deepEqual(pos(frozen), [0,0,0]);
  frozen.advance(300);
  assert.ok(Math.abs(pos(frozen)[0]-.5)<1e-8);
});

test("failed planning retries fairly and widens the budget without moving agents", () => {
  const nav=plane(), calls=[];
  nav.plan=(start, goal, {maxNodes})=>{
    calls.push({z:start[2], maxNodes});
    return {status:"budget",points:[]};
  };
  const defs=Array.from({length:8},(_,i)=>route({id:String(i+1), points:[[0,0,2*i],[4,0,2*i]]}));
  const sim = new NpcSimulation(nav, defs);
  tick(sim, 1);
  assert.equal(calls.length, 1);
  tick(sim, 7);
  assert.deepEqual(calls.map(x=>x.z), defs.map(x=>x.points[0][2]));
  assert.ok(sim.snapshot().every(x=>x.state==="blocked" && x.position[0]===0));
  tick(sim, 12);
  assert.equal(calls.length,8);
  tick(sim, 8);
  assert.ok(calls.slice(8).every(x=>x.maxNodes>calls[0].maxNodes));
  nav.plan=(a,b)=>({status:"ok",points:[a,b]});
  tick(sim, 28);
  assert.ok(sim.snapshot().every(x=>x.position[0]>0));
});

test("car entering the route stops movement; removing it permits resumption", () => {
  const nav = plane(), sim = new NpcSimulation(nav, [route({points:[[0,0,0],[5,0,0]]})]);
  tick(sim, 5);
  const blocker = {min:[1.1,0,-1],max:[1.5,2,1]};
  tick(sim, 15, {obstacles:[blocker]});
  assert.ok(pos(sim)[0] <= 1.1-.28);
  assert.equal(state(sim), "blocked");
  const mark = pos(sim)[0];
  tick(sim, 12);
  assert.ok(pos(sim)[0] > mark+.5);
});

test("follow chooses a host seat, stops beside it, ignores an out-of-leash seat and returns home", () => {
  const nav=plane(), sim=new NpcSimulation(nav,[route({mode:"follow"})]);
  const players=[{id:1,position:[-3,0,0]},{id:0,position:[3,0,0]},{id:999,position:[.2,0,0]}];
  tick(sim, 48, {players});
  const [x] = pos(sim);
  assert.ok(x>1.8 && x<2.5);
  assert.equal(state(sim), "idle");
  // Seat 1 becomes closer, yet the NPC keeps its original companion.
  tick(sim, 5, {players:[{id:1,position:[x,0,1]},{id:0,position:[4,0,0]}]});
  assert.ok(pos(sim)[0] > x);
  tick(sim, 1, {players:[{id:0,position:[25,0,0]}]});
  assert.equal(state(sim), "return");
  tick(sim, 45);
  assert.deepEqual(pos(sim), [0,0,0]);
  assert.equal(state(sim), "idle");
  assert.equal(sim.snapshot()[0].id, "9007199254740993");
  assert.deepEqual(Object.keys(sim.snapshot()[0]).sort(),["id","position","state","yaw"]);
});

test("NPCs sharing a spawn wait for clearance; returned data cannot move the host actor", () => {
  const defs=[route(), route({id:"2"})];
  const sim=new NpcSimulation(plane(), defs);
  assert.equal(sim.snapshot().length,1);
  sim.snapshot()[0].position[0]=99;
  defs[0].points[1][0]=99;
  assert.deepEqual(pos(sim), [0,0,0]);
  tick(sim, 20);
  assert.equal(sim.snapshot().length,2);
  assert.ok(sim.snapshot().every(x=>x.position[0]<=2));
  assert.ok(sim.snapshot().every(x=>NPC_STATES.includes(x.state)));
});

test("authored identities, limits and coordinates are validated before publication", () => {
  for(const invalid of [{id:"0"},{id:"01"},{id:"18446744073709551616"},{id:5},{mode:"controller"},
    {speed:Infinity},{points:[[0,NaN,1]]},{waitSeconds:-.01},{points:[]}]) {
    assert.throws(()=>new NpcSimulation(plane(),[route(invalid)]));
  }
  assert.throws(()=>new NpcSimulation(plane(),[route(),route()]));
  assert.throws(()=>new NpcSimulation(plane(),Array(9).fill(route())));
  const solo=new NpcSimulation(plane(),[route({points:[[1,0,1]]})]);
  tick(solo,50);
  assert.deepEqual(solo.snapshot(),[{id:"9007199254740993",position:[1,0,1],yaw:0,state:"idle"}]);
});

test("host inspection includes spawn and planning failures, cleared on recovery and absent on the wire", () => {
  const nav=plane(), blocker={min:[-1,-1,-1],max:[1,2,1]};
  const sim=new NpcSimulation(nav, [route()], {obstacles:[blocker]});
  assert.deepEqual(sim.snapshot(),[]);
  assert.deepEqual(sim.inspect(),[{id:"9007199254740993",position:null,state:"blocked",reason:"spawn"}]);
  const plan=nav.plan;
  nav.plan=()=>({status:"unreachable",points:[]});
  tick(sim, 21);
  assert.equal(sim.inspect()[0].reason,"unreachable");
  assert.equal(sim.snapshot()[0].state,"blocked");
  assert.ok(!Object.hasOwn(sim.snapshot()[0],"reason"));
  nav.plan=plan;
  tick(sim, 20);
  assert.equal(sim.inspect()[0].reason,null);
  assert.equal(sim.inspect()[0].state,"patrol");
  sim.inspect()[0].position.fill(123);
  assert.ok(pos(sim)[0]<2);

  const dynamic={min:[.4,0,-1],max:[1,2,1]};
  tick(sim,1,{obstacles:[dynamic]});
  assert.equal(sim.inspect()[0].reason,"obstacle");
});
