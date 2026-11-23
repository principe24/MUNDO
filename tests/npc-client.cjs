"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const env=vm.createContext({});
env.window=env;
for(const file of ["room.js","avatar.js"]){
  vm.runInContext(fs.readFileSync(path.join(__dirname,"../mundo",file),"utf8"),env,{filename:file});
}
const npc=(id,x=0)=>({id,position:[x,1,0],yaw:0,state:"patrol"});
test("browser decodes bounded optional host NPCs independently from seats",()=>{
  const parse=env.mundoRoomNpcs, max=0xffffffffffffffffn.toString();
  assert.equal(parse(undefined).length,0);
  assert.equal(parse([npc(max)])[0].id,max);
  for(const value of [null,[npc("1"),npc("1")],[npc("01")],[npc("0")],[npc("18446744073709551616")],
    [npc("1",Infinity)],[{...npc("1"),state:"driver"}],[{...npc("1"),yaw:10}],
    Array.from({length:9},(_,i)=>npc(String(i+1)))])
    assert.throws(()=>parse(value),{status:422});
});
test("rendering reconciles a full snapshot, animates motion and clears removed actors",()=>{
  const crowd=new env.MundoNpcView();
  const draw=(time,dt=.016)=>{
    const view={actorParts:[]};
    crowd.draw(view,time,dt);
    return view;
  };
  crowd.accept([npc("1"),npc("18446744073709551615",5)],1);
  const first=draw(1);
  assert.equal(first.npcPositions.length,2);
  assert.ok(first.actorParts.every(part=>part.actorRig.npc && part.n.id < -128n));
  assert.equal(new Set(first.actorParts.map(part=>part.n.id)).size,first.actorParts.length);
  const firstId=first.actorParts[0].n.id;
  crowd.accept([npc("1",1)],1.1);
  assert.ok(Math.abs(draw(1.15).npcPositions[0][0]-.5)<1e-9);
  assert.equal(draw(80).npcPositions[0][0],1);
  crowd.accept([npc("1",10)],81);
  const snapped=draw(81);
  assert.equal(snapped.npcPositions[0][0],10);
  assert.equal(snapped.actorParts[0].n.id,firstId);
  crowd.accept([npc("2",4)],81.1);
  assert.equal(draw(81.1).npcPositions[0][0],4);
  crowd.clear();
  assert.equal(draw(82).actorParts.length,0);
});
