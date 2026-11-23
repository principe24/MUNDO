"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const {createNavigation}=require("../server/navigation-3d.cjs");
const {NpcSimulation}=require("../server/npc-simulation.cjs");

const box=(min,max)=>({n:{shape:1},center:min.map((v,i)=>(v+max[i])/2),extent:min.map((v,i)=>(max[i]-v)/2)});
const floor=(left,back,right,front,y=0)=>box([left,y-.2,back],[right,y,front]);
const definition=(points,mode="patrol")=>({id:"73",points,mode,speed:2,waitSeconds:.1});
function run(sim,steps,input) {
  const poses=[];
  for(let i=0;i<steps;i++) {
    sim.advance(.05,input);
    poses.push(sim.snapshot()[0]);
  }
  return poses;
}
const near=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]))<1e-5;

test("patrol goes around a wall, waits at the destination and reaches home",()=>{
  const nav=createNavigation([floor(-6,-5,6,5),box([0,0,-2],[.1,3,2])]);
  const home=[-4,0,0],goal=[4,0,0],sim=new NpcSimulation(nav,[definition([home,goal])]);
  const poses=run(sim,260);
  const visited=poses.findIndex(p=>p.state==="waiting" && near(p.position,goal));
  assert.ok(visited>10);
  assert.ok(poses.slice(visited).some(p=>p.state==="waiting" && near(p.position,home)));
  assert.ok(poses.some(p=>Math.abs(p.position[2])>=2.28));
  for(const {position:[x,y,z]} of poses) {
    assert.equal(y,0);
    assert.ok(x<=-.28 || x>=.38 || Math.abs(z)>=2.28);
  }
});

test("a follower walks stairs to a hosted seat then returns across the same heights",()=>{
  const scene=[floor(-4,-1,0,1),floor(0,-1,.9,1,.2),floor(.9,-1,1.8,1,.4),floor(1.8,-1,5,1,.6)];
  const nav=createNavigation(scene),home=[-2,0,0];
  const sim=new NpcSimulation(nav,[definition([home],"follow")]);
  const poses=run(sim,100,{players:[{id:0,position:[4,.6,0]}]});
  assert.equal(poses.at(-1).state,"idle");
  assert.ok(near([0,poses.at(-1).position[1],0],[0,.6,0]));
  assert.ok(poses.at(-1).position[0]>2.8 && poses.at(-1).position[0]<3.5);
  const returned=run(sim,100,{players:[]});
  assert.ok(returned.some(p=>p.state==="return"));
  assert.ok(near(returned.at(-1).position,home));
  assert.equal(returned.at(-1).state,"idle");
});

test("NPC waits when terrain levels are disconnected or a moving solid closes its passage",()=>{
  const isolated=createNavigation([floor(-3,-1,3,1),floor(-3,-1,3,1,2)]);
  const home=[-2,0,0], upstairs=[2,2,0];
  const separated=new NpcSimulation(isolated,[definition([home,upstairs])]);
  run(separated,60);
  assert.ok(near(separated.snapshot()[0].position,home));
  assert.equal(separated.inspect()[0].reason,"unreachable");

  const nav=createNavigation([floor(-4,-1,4,1)]),goal=[2,0,0];
  const sim=new NpcSimulation(nav,[definition([home,goal])]);
  run(sim,7);
  const barrier={min:[-.5,0,-1],max:[0,1.8,1]};
  const halted=run(sim,50,{obstacles:[barrier]});
  assert.ok(halted.every(p=>p.position[0]<=-.78));
  assert.equal(sim.snapshot()[0].state,"blocked");
  assert.ok(run(sim,100).some(p=>near(p.position,goal)));
});

test("actors on intersecting routes avoid interpenetration",()=>{
  const nav=createNavigation([floor(-5,-5,5,5)]);
  const sim=new NpcSimulation(nav,[definition([[-2,0,0],[2,0,0]]),
    {...definition([[0,0,-2],[0,0,2]]),id:"74"}]);
  const visited=new Set();
  for(let i=0;i<200;i++){
    sim.advance(.05);
    const [a,b]=sim.snapshot();
    const dx=Math.abs(a.position[0]-b.position[0]), dz=Math.abs(a.position[2]-b.position[2]);
    assert.ok(dx>=.56-1e-7 || dz>=.56-1e-7);
    if(near(a.position,[2,0,0]))visited.add(a.id);
    if(near(b.position,[0,0,2]))visited.add(b.id);
  }
  assert.equal(visited.size,2);
});

test("checkpoint restores the waypoint, pause and yaw after restarting without carrying stale seats",()=>{
  const nav=createNavigation([floor(-8,-4,8,4)]), home=[-2,0,0],goal=[2,0,0];
  const defs=[{...definition([home,goal]),waitSeconds:1},
    {...definition([[0,0,2]],"follow"),id:"74"}];
  const original=new NpcSimulation(nav,defs);
  const players=[{id:1,position:[4,0,2]}];
  run(original,64,{players});
  const saved=JSON.parse(JSON.stringify(original.checkpoint()));
  assert.ok(saved.actors[0].wait>0 && saved.actors[0].wait<20);
  assert.ok(near(saved.actors[0].position,goal));
  assert.equal(saved.actors[0].index,0);
  const resumed=new NpcSimulation(nav,defs);
  assert.equal(resumed.canRestore(saved),true);
  assert.equal(resumed.restore(saved),true);
  assert.deepEqual(resumed.checkpoint(),saved);
  assert.equal(resumed.snapshot()[0].yaw,Math.PI/2);
  run(resumed,saved.actors[0].wait-1);
  assert.ok(near(resumed.snapshot()[0].position,goal));
  run(resumed,120);
  assert.ok(near(resumed.snapshot()[1].position,[0,0,2]));
  assert.equal(resumed.snapshot()[1].state,"idle");
});

test("bad checkpoints reject every row atomically; a restored car may temporarily occupy a saved pose",()=>{
  const nav=createNavigation([floor(-6,-4,6,4)]);
  const sim=new NpcSimulation(nav,[definition([[-2,0,0],[2,0,0]]),
    {...definition([[-2,0,2],[2,0,2]]),id:"74"}]);
  run(sim,15);
  const good=sim.checkpoint();
  for(const mutate of [
    a=>a.actors.pop(), a=>a.version=2, a=>a.actors[1].id=a.actors[0].id,
    a=>a.actors[1].position=[0,7,0], a=>a.actors[1].position=[100,0,0],
    a=>a.actors[1].position=a.actors[0].position.slice(), a=>a.actors[1].index=200,
    a=>a.actors[1].wait=9999, a=>a.actors[1].yaw=NaN, a=>a.actors[1].extra=1
  ]){
    const bad=structuredClone(good); mutate(bad);
    assert.equal(sim.canRestore(bad),false);
    assert.equal(sim.restore(bad),false);
    assert.deepEqual(sim.checkpoint(),good);
  }
  const [x,y,z]=good.actors[0].position;
  const obstacles=[{min:[x-.7,y,z-.7],max:[x+.7,y+1.2,z+.7]}];
  assert.equal(sim.restore(good,{obstacles}),true);
  assert.deepEqual(sim.checkpoint(),good);
  assert.equal(sim.inspect()[0].reason,"obstacle");
  assert.equal(sim.snapshot().length,1);
  run(sim,4,{obstacles});
  assert.equal(sim.snapshot().length,1);
  run(sim,2);
  assert.ok(near(sim.snapshot()[0].position,good.actors[0].position));
  run(sim,10);
  assert.ok(sim.snapshot()[0].position[0]>x+.3);
});

test("a companion on another unreachable floor gives way to a reachable player on the host",()=>{
  const nav=createNavigation([floor(-6,-3,6,3),floor(-2,-1,2,1,2)]);
  const sim=new NpcSimulation(nav,[definition([[0,0,0]],"follow")]);
  const poses=run(sim,120,{players:[{id:0,position:[0,2,0]},{id:1,position:[4,0,0]}]});
  assert.ok(poses.some(p=>p.state==="blocked"));
  assert.equal(poses.at(-1).state,"idle");
  assert.ok(poses.at(-1).position[0]>2.8);
  assert.ok(poses.every(p=>p.position[1]===0));
});

test("an unspawned actor survives a checkpoint and retries when the berth clears",()=>{
  const nav=createNavigation([floor(-4,-2,4,2)]);
  const defs=[definition([[0,0,0],[2,0,0]])];
  const obstacles=[{min:[-.3,0,-.3],max:[.3,2,.3]}];
  const blocked=new NpcSimulation(nav,defs,{obstacles});
  assert.equal(blocked.snapshot().length,0);
  const restored=new NpcSimulation(nav,defs);
  assert.equal(restored.restore(blocked.checkpoint(),{obstacles}),true);
  run(restored,15,{obstacles});
  assert.equal(restored.snapshot().length,0);
  run(restored,30);
  assert.equal(restored.snapshot().length,1);
  assert.ok(restored.snapshot()[0].position[0]>0);
});
