"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const path=require("node:path"),fs=require("node:fs"),vm=require("node:vm");
const {randomBytes}=require("node:crypto");
const {makeRoom,createHost}=require("../server/room.cjs");
const revision=fs.readFileSync(path.join(__dirname,"../examples/Plaza_Brisa.mworld"));
global.window=global;
global.document={hidden:false};
for(const file of ["../web/world.js","../mundo/room.js"])
  vm.runInThisContext(fs.readFileSync(path.join(__dirname,file),"utf8"),{filename:file});
const proof=()=>randomBytes(24).toString("hex");
const delay=n=>new Promise(resolve=>setTimeout(resolve,n));
function floorAndWall(){
  const w=MundoWorld.empty(),floor=MundoWorld.add(w,"Piso",1),wall=MundoWorld.add(w,"Pared",1);
  floor.s=[30,.4,30];floor.p=[0,-.2,0];wall.s=[10,4,.2];wall.p=[0,2,4];
  return MundoWorld.encode(w);
}
test("the authoritative clock resolves collisions, stops stale commands and expires a reservation",()=>{
  let t=0;const room=makeRoom(floorAndWall(),"Patio",()=>t);
  const key=proof(),seat=room.authorize(room.seats[0].invite,key,true);
  const input=(seq,mask,jump=false)=>room.input(seat,{seq,mask,jump,yaw:0});
  for(let i=1;i<=180;i++){input(i,1);t+=1000/60;room.advance();}
  assert.ok(seat.player.body.position[2]>=4.37 && seat.player.body.position[2]<4.46);
  input(181,0,true);t+=50;room.advance();assert.ok(seat.player.body.position[1]>.09);
  input(182,2);t+=100;room.advance();const before=seat.player.body.position[2];
  t+=400;room.advance();const stopped=seat.player.body.position[2];
  assert.equal(stopped,before);
  assert.equal(input(181,1).ack,182);
  t+=60001;room.advance();assert.equal(seat.player,null);
  assert.throws(()=>room.authorize(seat.invite,key,false),e=>e.status===410);
});
test("two HTTP clients play the same revision, resume, and leave independently",async()=>{
  const room=makeRoom(revision,"Plaza privada"),app=createHost(room,{port:0}),origin=await app.start();
  const transport=(p,opts)=>fetch(origin+p,{...opts,headers:{...opts.headers,origin}});
  const first=new MundoRoomLink(room.seats[0].invite,proof(),transport);
  const second=new MundoRoomLink(room.seats[1].invite,proof(),transport);
  try{
    const page=await fetch(origin+"/mundo/MUNDO.html");assert.equal(page.status,200);
    assert.match(await page.text(),/connect-src 'self'/);
    const a=await first.join(),b=await second.join();assert.equal(a.world.nodes.size,b.world.nodes.size);
    assert.equal(first.revision,second.revision);assert.equal(first.revision,room.revision);
    const start=await first.step(1,0,false);assert.equal(start.players.length,2);
    await delay(180);
    const remote=(await second.step(0,0,false)).players.find(x=>x.id===first.id);
    assert.ok(remote.position[2]<start.players[0].position[2]);
    const stolen=new MundoRoomLink(room.seats[0].invite,proof(),transport);
    await assert.rejects(stolen.join(),e=>e.status===409);
    await assert.rejects(first.call("input",{seq:100,position:[9000,0,0]}),e=>e.status===400);
    const resume=new MundoRoomLink(first.invite,first.proof,transport);
    await resume.join();assert.ok(resume.seq>=first.seq);
    await second.leave();assert.equal((await resume.step(0,0,false)).players.length,1);
    await second.join();assert.equal((await second.step(0,0,false)).players.length,2);
    const unauth=await fetch(origin+"/room/world",{method:"POST",headers:{origin,"content-type":"application/json"}});
    assert.equal(unauth.status,403);
    assert.equal((await fetch(origin+"/authoring/street-post/vault/RealisticMaster.usda")).status,404);
    await first.leave();await second.leave();
  }finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}
});
