"use strict";
// Decode all negotiated host packet variants with the same implementation used by the native players.
const {spawnSync}=require("node:child_process");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),assert=require("node:assert/strict");
const {encodeNpcs,encodeCircuit,encodeSnapshotV3}=require("../server/room-wire.cjs");
const binary=process.argv[2];
if(!binary)throw new Error("Pass the compiled mundo_npc_client_test executable.");
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"mundo-npc-wire-"));
try{
  const player={id:0,position:[0,1,2],yaw:0,vy:0,grounded:true};
  const npcs=[{id:"18446744073709551615",position:[.5,1,.25],yaw:-.5,state:"patrol"}];
  const car={root:"99",driver:0,passenger:null,x:1,z:2,yaw:0,speed:0,steer:0,distance:0};
  const course={run:1,passed:0,total:2,phase:"ready",bestMs:null,elapsedMs:0,nextId:"51",split:null};
  const state={ack:4,players:[player],car};
  const bases=[encodeSnapshotV3({...state,car:null}),encodeCircuit(state,course,false,false),
    encodeCircuit(state,course,true,false),encodeCircuit(state,course,true,true)];
  for(const base of bases){
    const file=path.join(directory,base.toString("ascii",0,4));
    fs.writeFileSync(file,encodeNpcs(base,npcs));
    const result=spawnSync(binary,[file],{encoding:"utf8"});
    if(result.error)throw result.error;
    assert.equal(result.status,0,result.stderr);
    console.log("Native player decoded "+path.basename(file)+" with an NPC");
  }
}finally{fs.rmSync(directory,{recursive:true,force:true});}
