"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {readFileSync}=require("node:fs"),path=require("node:path");
const {ordinary}=require("../server/project-room.cjs");
const {MundoWorld,MundoMeeting}=require("../server/room-runtime.cjs");
const routes=require("../web/npc-routes.js");

function addStationary(world, position) {
  const route=routes.addRoute(world,"Punto de guardia",[position]);
  routes.addNpc(world,{label:"Guía",route,mode:"patrol",speed:2,waitSeconds:0,spawn:position});
}

function plaza(points,meeting=null) {
  const w=MundoWorld.empty(),floor=MundoWorld.add(w,"Suelo",1);
  floor.p=[0,-.2,0];floor.s=[30,.4,30];
  for(const point of points)addStationary(w,point);
  return ordinary(MundoWorld.encode(w),"Sala",null,meeting,null);
}

function pista(points,meeting=null){
  const w=MundoWorld.decode(readFileSync(path.join(__dirname,"../examples/Pista_Turismo.mworld")));
  for(const point of points)addStationary(w,point);
  return ordinary(MundoWorld.encode(w),"Turismo",null,meeting,null);
}

test("an occupied authored meeting or ordinary spawn chooses a free, grounded location",()=>{
  for(const meeting of [null,[0,0,4]]){
    const normal=plaza([],meeting), first=normal.vehicle.newBody(0).position;
    const guard=[first[0],0,first[2]];
    const scene=plaza([guard],meeting), seat=scene.seats[0];
    const body=scene.vehicle.newBody(0);
    assert.ok(body);
    assert.ok(!MundoMeeting.overlapsPlayer(body.position,guard));
    seat.player={body,keys:new Set()};
    const second=scene.vehicle.newBody(1,true);
    assert.ok(second && !MundoMeeting.overlapsPlayer(second.position,guard));
    assert.ok(!MundoMeeting.overlapsPlayer(second.position,body.position));
    if(meeting){
      body.position=[8,0,8];assert.equal(scene.vehicle.returnToMeeting(seat),"returned");
      assert.ok(!MundoMeeting.overlapsPlayer(body.position,guard));
    }
    assert.equal(body.position[1],0);
  }
});

test("player cannot walk through a stationary NPC or stand on its proxy",()=>{
  const scene=plaza([[0,0,1]],[0,0,3]);
  const body=scene.vehicle.newBody(0),forward=new Set(["KeyW"]);
  for(let i=0;i<90;i++)body.update(.05,forward,0);
  assert.ok(body.position[2]>=1+.56-1e-8 && body.position[2]<2);
  assert.equal(body.position[1],0);
  for(let i=0;i<15;i++)body.update(.05,new Set(["KeyD"]),0);
  for(let i=0;i<20;i++)body.update(.05,forward,0);
  assert.ok(body.position[2]<0);
});

test("the real workshop car stops before an NPC and chooses another exit beside an occupied door",()=>{
  const reference=pista([]);
  function takeWheel(scene) {
    const seat=scene.seats[0],body=scene.vehicle.newBody(0);
    seat.player={body,keys:new Set()};
    assert.equal(scene.vehicle.action(seat,"enter"),true);
    return seat;
  }
  const first=takeWheel(reference);
  assert.equal(reference.vehicle.action(first,"exit"),true);
  const door=Array.from(first.player.body.position);
  const car=reference.vehicle.snapshot();
  const opposite=[2*car.x-door[0],door[1],2*car.z-door[2]];
  const atDoor=pista([door],opposite),second=takeWheel(atDoor);
  assert.equal(atDoor.vehicle.action(second,"exit"),true);
  assert.ok(!MundoMeeting.overlapsPlayer(second.player.body.position,door));

  function drive(scene) {
    const seat=takeWheel(scene);
    seat.player.keys=new Set(["KeyW"]);
    for(let i=0;i<70;i++)scene.vehicle.advance(.05);
    return scene.vehicle.snapshot();
  }
  const npc=[2.4,0,3.7], blocked=pista([npc]);
  const stopped=drive(blocked), open=drive(pista([]));
  assert.ok(stopped.z<8 && stopped.z>npc[2]+2.16+.28);
  assert.ok(open.z<stopped.z-1);
});
