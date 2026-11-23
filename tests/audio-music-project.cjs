"use strict";

const test=require("node:test"),assert=require("node:assert/strict");
const {randomBytes,createHash}=require("node:crypto");
const {MundoWorld,MundoProject}=require("../server/room-runtime.cjs");
const Clips=require("../web/audio-clips.js"),Scene=require("../web/audio-scene.js");
const Project=require("../web/audio-music-project.js");
const {readRoomSource,byteLimit}=require("../server/room-source.cjs");
const {roomFromSource,createHost}=require("../server/room.cjs");

const sha=value=>createHash("sha256").update(value).digest("hex");
const bytes=async blob=>new Uint8Array(await blob.arrayBuffer());
const wav=(seconds,value)=>Clips.encodeMono(new Float32Array(Clips.rate*seconds).fill(value));

async function fixture(withClip=true){
  const tracks=await Promise.all([.12,-.28].map(value=>Clips.prepareMusic(wav(13,value))));
  const clip=await Clips.prepare(Clips.encodeMono(Float32Array.of(.4,-.4,.2)));
  const {courtyard,garden,projectBytes}=require("../examples/navigation/generate.cjs");
  const first=courtyard(),second=garden();
  for(const [index,item] of [first,second].entries()){
    for(const node of [...item.world.nodes.values()])if(node.shape===0)item.world.nodes.delete(node.id);
    Scene.setMusic(item.world,{streamId:tracks[index].id,label:index?"Jardín nocturno":"Patio del alba",loop:index===0});
  }
  if(withClip)Scene.add(first.world,{preset:clip.key,label:"Campana",position:[0,0,0],radius:8,
    spatial:"2d",volume:.7,pitch:1,loop:true,paused:false,group:"efectos"});
  const author=await MundoProject.open(new Blob([await projectBytes(first,second)]));
  const result=await Project.exportProject(author,key=>key===clip.key?clip:null,
    id=>tracks.find(track=>track.id===id));
  return {tracks,clip,author,result,data:await bytes(result.blob)};
}

test("el proyecto musical comparte su base de audio corto y vincula cada pista a su mundo",async()=>{
  const {tracks,clip,data,result}=await fixture();
  assert.equal(result.hasAudio,true);assert.equal(result.hasMusic,true);
  assert.equal(Buffer.from(data.subarray(0,8)).toString(),Project.magic);
  const opened=await Project.open(data);
  assert.equal(opened.index.worlds.length,2);assert.equal(opened.items.length,1);
  assert.equal(opened.items[0].key,clip.key);assert.deepEqual(opened.streams.map(item=>item.id),tracks.map(item=>item.id).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1));
  assert.deepEqual([...opened.musicByWorld.values()].map(item=>item.label),["Patio del alba","Jardín nocturno"]);
  const source=readRoomSource("Patios.mprojectmusic",Buffer.from(data));
  assert.equal(source.audioClips.size,1);assert.equal(source.musicStreams.size,2);
  assert.equal(byteLimit("Patios.mprojectmusic"),Project.maxBytes);
  const room=await roomFromSource(source);
  assert.equal(room.musicStreams.size,2);assert.equal(room.musicByRevision.size,2);
  assert.deepEqual(new Set([...room.musicByRevision.values()].map(item=>item.label)),new Set(["Patio del alba","Jardín nocturno"]));
});

test("el contenedor rechaza pistas faltantes, ajenas, alteradas y directorios incompatibles",async()=>{
  const {tracks,author,data}=await fixture(false);
  await assert.rejects(Project.exportProject(author,null,id=>id===tracks[0].id?tracks[0]:null),/Falta la pista/);
  const base=await bytes(await MundoProject.packForRoom(author));
  await assert.rejects(Project.pack(base,[tracks[0]]),/Falta una pista/);
  const extra=await Clips.prepareMusic(wav(1,.7));
  await assert.rejects(Project.pack(base,[...tracks,extra]),/sin referencia/);
  const changed=data.slice();changed[changed.length-1]^=1;
  await assert.rejects(Project.open(changed),/huella/);
  assert.throws(()=>readRoomSource("Dañado.mprojectmusic",Buffer.from(changed)),/huella/);
  assert.throws(()=>Project.unpack(data.slice(0,-1)));
  const header=data.slice();new DataView(header.buffer).setUint32(16,1,true);
  assert.throws(()=>Project.unpack(header),/Directorio/);
});

async function host(t,source){
  const room=await roomFromSource(source),server=createHost(room,{port:0}),origin=await server.start();
  t.after(()=>server.close());
  const seats=room.seats.map(({invite})=>({invite,proof:randomBytes(24).toString("hex"),seq:0}));
  const post=(seat,route,data={},headers={})=>fetch(origin+"/room/"+route,{method:"POST",headers:{origin,
    "content-type":"application/json","x-mundo-room-version":"3","x-mundo-travel":"1","x-mundo-scene":"ready",
    "x-invite":seat.invite,"x-seat":seat.proof,...headers},body:JSON.stringify(data)});
  return {room,seats,post};
}

test("dos jugadores reciben solamente la música de la revisión confirmada después del portal",async t=>{
  const {tracks,data}=await fixture(false),source=readRoomSource("Viaje.mprojectmusic",Buffer.from(data));
  const {room,seats,post}=await host(t,source),travel={"x-mundo-travel":"1","x-mundo-scene":"ready"};
  const route=async(seat,data={})=>{
    const response=await post(seat,"route",data,travel);assert.equal(response.status,200);
    const frame=Buffer.from(await response.arrayBuffer());return {phase:frame[4],epoch:Number(frame.readBigUInt64LE(5))};
  };
  for(const seat of seats){
    const joined=await post(seat,"join",{},travel);assert.equal(joined.status,200);
    assert.equal(joined.headers.get("x-mundo-audio-music"),"pcmseg-1");Object.assign(seat,await joined.json());
    assert.equal((await post(seat,"input",{lease:seat.lease,epoch:1,seq:++seat.seq,mask:0,jump:false,yaw:0},travel)).status,200);
  }
  const initial=room.revision,first=await post(seats[0],"music-info",{revision:initial});
  assert.equal(first.status,200);const firstRows=(await first.text()).trim().split("\n");assert.equal(firstRows[1],tracks[0].id);
  let offer;
  for(let attempt=0;attempt<100;attempt++){
    const response=await post(seats[0],"input",{lease:seats[0].lease,epoch:1,seq:++seats[0].seq,mask:1,jump:false,yaw:0},travel);
    assert.ok([200,412].includes(response.status));offer=await route(seats[0]);if(offer.phase===1)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(offer.phase,1);
  assert.equal((await route(seats[0],{lease:seats[0].lease,epoch:offer.epoch,vote:"ready"})).phase,1);
  assert.equal((await route(seats[1],{lease:seats[1].lease,epoch:offer.epoch,vote:"ready"})).phase,0);
  assert.notEqual(room.revision,initial);
  assert.equal((await post(seats[0],"music-info",{revision:initial})).status,409);
  const next=await post(seats[0],"music-info",{revision:room.revision});assert.equal(next.status,200);
  const rows=(await next.text()).trim().split("\n");assert.equal(rows[1],tracks[1].id);
  const segment=await post(seats[0],"music",{lease:seats[0].lease,revision:room.revision,id:tracks[1].id,index:0});
  assert.equal(segment.status,200);assert.equal(segment.headers.get("x-mundo-audio-digest"),tracks[1].segments[0].digest);
  assert.equal(sha(Buffer.from(await segment.arrayBuffer())),tracks[1].segments[0].digest);
});
