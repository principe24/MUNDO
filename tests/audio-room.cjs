"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {createHash,randomBytes}=require("node:crypto");
const Clips=require("../web/audio-clips.js");
const Scene=require("../web/audio-scene.js");
const RoomFile=require("../web/room-file.js");
const DSP=require("../web/audio-dsp.js");
const {MundoWorld}=require("../server/room-runtime.cjs");
const {readRoomSource,byteLimit}=require("../server/room-source.cjs");
const {roomFromSource,createHost}=require("../server/room.cjs");
const filename="Plaza_del_carillon.mroomaudio";
const sample=fs.readFileSync(path.join(__dirname,"../examples/audio",filename));
const sha=b=>createHash("sha256").update(b).digest("hex");
async function host(t,name,bytes){
  const room=await roomFromSource(readRoomSource(name,bytes));
  const server=createHost(room,{port:0}),origin=await server.start();
  t.after(()=>server.close());
  const post=(seat,route,data,override={})=>fetch(origin+"/room/"+route,{method:"POST",
    headers:{origin,"content-type":"application/json","x-mundo-room-version":"3","x-invite":seat.invite,"x-seat":seat.proof,...override},
    body:JSON.stringify(data)});
  const seats=room.seats.map(({invite})=>({invite,proof:randomBytes(24).toString("hex")}));
  return {room,origin,seats,post};
}
test("two authenticated guests retrieve, verify and render a Studio recording from the same room",async t=>{
  const {origin,room,seats,post}=await host(t,filename,sample);
  const {items:[clip]}=Clips.unpack(sample);
  for(const seat of seats) {
    const join=await post(seat,"join",{});assert.equal(join.status,200);
    assert.equal(join.headers.get("x-mundo-audio-clips"),"wav-1");
    const {lease,revision}=await join.json();Object.assign(seat,{lease,revision});
    assert.equal(revision,room.revision);
    const manifest=await post(seat,"audio-info",{revision});assert.equal(manifest.status,200);
    assert.equal(await manifest.text(),lease+"\n"+clip.digest+"\n");
    const result=await post(seat,"audio",{lease,revision,key:clip.key});
    assert.equal(result.status,200);assert.equal(result.headers.get("content-type"),"audio/wav");
    const wav=new Uint8Array(await result.arrayBuffer());
    assert.equal(sha(wav),result.headers.get("x-mundo-audio-digest"));assert.deepEqual(wav,new Uint8Array(clip.bytes));
    const source=Scene.read(MundoWorld.decode(room.bytes)).find(s=>s.preset===clip.key);
    const mix=DSP.create(48000);mix.setClip(source.preset,await Clips.verify(source.preset,wav,clip.digest));
    mix.setSources([source]);mix.setListener(source.position,0);
    const l=new Float32Array(2048),r=new Float32Array(l.length);mix.render(l,r);
    assert.ok(l.some(x=>Math.abs(x)>.001) && r.some(x=>Math.abs(x)>.001));
  }
  const [a,b]=seats, request={lease:a.lease,revision:a.revision,key:clip.key};
  for(const [seat,body,status] of [[b,request,403],[a,{...request,revision:"0".repeat(64)},409],
    [a,{...request,key:"s1111111111111111"},404],[a,{...request,key:"../secret.wav"},400]]){
    assert.equal((await post(seat,"audio",body)).status,status);
  }
  assert.equal((await post(a,"audio-info",{revision:a.revision},{"x-seat":randomBytes(24).toString("hex")})).status,409);
  assert.equal((await fetch(origin+"/room/audio")).status,404);
  for(const file of ["web/audio-scene.js","web/audio-clips.js","web/audio-dsp.js","web/audio-output.js","mundo/scene-audio.js"]){
    assert.equal((await fetch(origin+"/"+file)).status,200);
  }
  assert.equal((await fetch(origin+"/web/audio-library.js")).status,404);
  assert.equal((await post(a,"leave",{})).status,200);
  assert.notEqual((await post(a,"audio",request)).status,200);
});
test("legacy revisions carry emitter references without attaching Studio's private media",async t=>{
  const {room:base,items:[clip]}=Clips.unpack(sample);
  const {seats,post}=await host(t,"ordinary.mroom",base);
  const reply=await post(seats[0],"join",{});assert.equal(reply.status,200);
  assert.equal(reply.headers.get("x-mundo-audio-clips"),null);
  const {lease,revision}=await reply.json();
  assert.equal((await post(seats[0],"audio-info",{revision})).status,204);
  assert.equal((await post(seats[0],"audio",{lease,revision,key:clip.key})).status,404);
});
test("host rejects substituted or unrelated clips, malformed markers, and preserves immutable room data",async()=>{
  const src=readRoomSource(filename,sample);
  const {room,items}=Clips.unpack(sample);
  assert.equal(src.audioClips.size,1);
  assert.equal(sha(src.bytes),RoomFile.unpack(room).hash);
  assert.equal(byteLimit(filename),Clips.maxRoomBytes);
  const bad=Buffer.from(sample);bad[bad.length-1]^=1;
  assert.throws(()=>readRoomSource(filename,bad),/huella/);
  const other=await Clips.prepare(Clips.encodeMono(Float32Array.of(.05,-.05)));
  const wrong=await Clips.pack(room,[other]);
  assert.throws(()=>readRoomSource(filename,wrong),/corresponder/);
  assert.throws(()=>readRoomSource(filename,sample.subarray(0,-1)));
  const world=MundoWorld.decode(src.bytes);
  const emitter=Scene.read(world)[0];world.nodes.get(BigInt(emitter.id)).name="MUNDO/Audio/v2/invalid";
  const changed=MundoWorld.encode(world);
  await assert.rejects(roomFromSource({bytes:changed,title:"Inválido"}),/audio inválido/);
  assert.equal(sha(items[0].bytes),items[0].digest);
});
