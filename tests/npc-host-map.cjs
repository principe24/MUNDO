"use strict";
const assert=require("node:assert/strict");
const test=require("node:test");
const fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const {createHash}=require("node:crypto");
const {makeRoom}=require("../server/room.cjs");
const {MundoWorld}=require("../server/room-runtime.cjs");
const routes=require("../web/npc-routes.js");
const {encodeNpcs}=require("../server/room-wire.cjs");

function scene(){
  const world=MundoWorld.empty();
  const ground=MundoWorld.add(world,"Patio",1);
  ground.s=[12,.5,12];ground.p=[0,-.25,0];
  const route=routes.addRoute(world,"Ronda",[[1,0,2],[2,0,2]]);
  const marker={label:"Guía",route,mode:"patrol",speed:2,waitSeconds:0};
  routes.addNpc(world,{...marker,spawn:[-3,0,2]});
  routes.addNpc(world,{...marker,label:"Sin suelo",spawn:[100,0,100]});
  return Buffer.from(MundoWorld.encode(world));
}

test("host retains diagnostics for missing spawns and only publishes available poses",()=>{
  let time=0;
  const room=makeRoom(scene(),"Taller",()=>time);
  const seat=room.authorize(room.seats[0].invite,createHash("sha256").update("internal-seat").digest("hex").slice(0,48),true);
  time+=100;room.advance();
  const npcs=room.moderation.status("live").track.npcs;
  assert.equal(npcs.length,2);
  assert.equal(npcs.filter(npc=>npc.position===null && npc.reason==="spawn").length,1);
  const command={seq:1,mask:0,yaw:0,jump:false};
  const visible=room.input(seat,command,"ready",true).npcs;
  assert.equal(visible.length,1);
  assert.equal(visible[0].id,npcs.find(npc=>npc.position).id);
  assert.deepEqual(Object.keys(visible[0]).sort(),["id","position","state","yaw"]);
  assert.equal(room.input(seat,command,"ready").npcs,undefined);
});

test("local map shows states and heights, tolerates an unsupported spawn and clears the previous room",()=>{
  const elements=new Map(),calls=[];
  const ctx=new Proxy({}, {get(target,key){
    if(key==="measureText")return ()=>({width:30});
    return target[key]??((...args)=>calls.push([key,...args]));
  }});
  const get=id=>{
    if(!elements.has(id))elements.set(id,{textContent:"",open:true,options:[],selectedOptions:[],
      width:720,height:400,getContext:()=>ctx,addEventListener(){}});
    return elements.get(id);
  };
  const scope={window:{},document:{getElementById:get}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../server/panel/route-map.js"),"utf8"),scope);
  const panel=scope.window.MundoHostMap();
  const track={world:"Taller",epoch:1,seats:[],gates:[],npcs:[
    {id:"9007199254740999",position:[-3,2,4],state:"patrol",reason:null},
    {id:"22",position:null,state:"blocked",reason:"spawn"}]};
  panel.update(track);
  assert.match(get("trackingSummary").textContent,/NPC 9007199254740999 · en patrulla.*Y 2 m/);
  assert.match(get("trackingSummary").textContent,/NPC 22 · detenido · punto de aparición/);
  assert.ok(calls.some(call=>call[0]==="closePath"));
  panel.update({...track,npcs:undefined});
  assert.doesNotMatch(get("trackingSummary").textContent,/NPC /);
  panel.update(null);
  assert.equal(get("trackingSummary").textContent,"");
});

test("wire encoding preserves base snapshots and rejects ambiguous or unrepresentable NPC poses",()=>{
  const base=Buffer.from("MWS3");
  const p={id:"18446744073709551615",position:[0,1,-1],yaw:0,state:"idle"};
  assert.equal(encodeNpcs(base,[]),base);
  const wire=encodeNpcs(base,[p]);
  assert.equal(wire.readBigUInt64LE(7+base.length),BigInt(p.id));
  assert.equal(wire.at(-1),5);
  for(const bad of [[p,p],[{...p,id:"01"}],[{...p,id:"18446744073709551616"}],
    [{...p,position:[NaN,1,0]}],[{...p,yaw:Infinity}],[{...p,state:"admin"}]]) {
    assert.throws(()=>encodeNpcs(base,bad),RangeError);
  }
});
