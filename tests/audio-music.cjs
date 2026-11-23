"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createHash,randomBytes}=require("node:crypto");
const Clips=require("../web/audio-clips.js"),Music=require("../web/audio-music.js"),Scene=require("../web/audio-scene.js");
const RoomFile=require("../web/room-file.js"),Player=require("../mundo/scene-audio.js");
const {MundoWorld}=require("../server/room-runtime.cjs");
const {readRoomSource}=require("../server/room-source.cjs");
const {roomFromSource,createHost}=require("../server/room.cjs");

function wav(seconds){
  const frames=Clips.rate*seconds,bytes=new Uint8Array(44+frames*2),view=new DataView(bytes.buffer);
  const text=(at,value)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i);};
  text(0,"RIFF");view.setUint32(4,bytes.length-8,true);text(8,"WAVEfmt ");view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,Clips.rate,true);
  view.setUint32(28,Clips.rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  text(36,"data");view.setUint32(40,frames*2,true);
  for(let i=0;i<frames;i++)view.setInt16(44+i*2,Math.round(Math.sin(i/31)*12000),true);
  return bytes;
}
async function publication(){
  const prepared=await Clips.prepareMusic(wav(25)),world=MundoWorld.empty();
  Scene.setMusic(world,{streamId:prepared.id,label:"Paseo nocturno",loop:true});
  const encoded=MundoWorld.encode(world),hash=await RoomFile.digest(encoded);
  const room=await RoomFile.seal({title:"Paseo",revision:1,hash},encoded);
  return {prepared,world,bytes:await Music.pack(new Uint8Array(room),prepared)};
}
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");

test("Studio segments a long WAV and the package binds every ordered segment to the world marker",async()=>{
  const {prepared,bytes}=await publication();
  assert.equal(prepared.segments.length,3);assert.equal(prepared.segments[0].bytes.length,44+12*Clips.rate*2);
  const unpacked=Music.unpack(bytes),verified=await Music.verify(unpacked.stream);
  assert.equal(verified.id,prepared.id);assert.equal(verified.digest,prepared.digest);
  const source=readRoomSource("Paseo.mroommusic",Buffer.from(bytes));
  assert.equal(source.musicStream.id,prepared.id);assert.equal(source.musicStream.loop,true);
  assert.equal(Scene.readMusic(MundoWorld.decode(source.bytes)).label,"Paseo nocturno");
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
  assert.throws(()=>readRoomSource("alterada.mroommusic",changed),/huella/);
});

test("the private host serves only admitted revision segments with immutable identities",async t=>{
  const {prepared,bytes}=await publication(),room=await roomFromSource(readRoomSource("Paseo.mroommusic",Buffer.from(bytes)));
  const app=createHost(room,{port:0}),origin=await app.start();t.after(()=>app.close());
  const seat={invite:room.seats[0].invite,proof:randomBytes(24).toString("hex")};
  const post=(route,body,proof=seat.proof)=>fetch(origin+"/room/"+route,{method:"POST",headers:{origin,
    "content-type":"application/json","x-mundo-room-version":"3","x-invite":seat.invite,"x-seat":proof},body:JSON.stringify(body)});
  const joined=await post("join",{});assert.equal(joined.status,200);
  assert.equal(joined.headers.get("x-mundo-audio-music"),"pcmseg-1");Object.assign(seat,await joined.json());
  const info=await post("music-info",{revision:seat.revision});assert.equal(info.status,200);
  const rows=(await info.text()).trim().split("\n");
  assert.deepEqual(rows.slice(0,4),[seat.lease,prepared.id,"loop",String(prepared.segments.length)]);
  assert.deepEqual(rows.slice(4),prepared.segments.map(item=>item.digest));
  for(const item of prepared.segments){
    const response=await post("music",{lease:seat.lease,revision:seat.revision,id:prepared.id,index:item.index});
    assert.equal(response.status,200);assert.equal(response.headers.get("x-mundo-music-index"),String(item.index));
    const data=Buffer.from(await response.arrayBuffer());assert.equal(sha(data),item.digest);
  }
  assert.equal((await post("music",{lease:seat.lease,revision:"0".repeat(64),id:prepared.id,index:0})).status,409);
  assert.equal((await post("music",{lease:seat.lease,revision:seat.revision,id:prepared.id,index:99})).status,404);
  assert.equal((await post("music",{lease:seat.lease,revision:seat.revision,id:prepared.id,index:0},randomBytes(24).toString("hex"))).status,409);
});

test("the player keeps a two-segment window, refills in order and cancels on room exit",async()=>{
  const prepared=await Clips.prepareMusic(wav(25)),lease="a".repeat(32),revision="b".repeat(64),calls=[];
  const manifest=[lease,prepared.id,"loop",prepared.segments.length,...prepared.segments.map(item=>item.digest)].join("\n")+"\n";
  const link={audioMusicOffered:true,project:false,lease,revision,async call(route,body,_scene,signal){
    calls.push({route,body,signal});if(route==="music-info")return new Response(manifest,{headers:{"content-type":"text/plain"}});
    const item=prepared.segments[body.index];return new Response(item.bytes,{headers:{"content-type":"audio/wav",
      "x-mundo-audio-digest":item.digest,"x-mundo-music-index":String(item.index)}});
  }};
  let buffered=0,begins=0,cancelled=0;const queued=[];
  const audio={get bufferedMusicSegments(){return buffered;},beginMusicStream(id,index){assert.equal(id,prepared.id);assert.equal(index,0);buffered=0;begins++;return true;},
    queueMusicSegment(id,index,key,_pcm,final){queued.push({id,index,key,final});buffered++;return buffered<=2;},
    cancelMusicStream(){cancelled++;buffered=0;return true;}};
  const read=async response=>new Uint8Array(await response.arrayBuffer()),stream=Player.roomMusic(link,audio,Clips,read,()=>{});
  await stream.update();await stream.update();await stream.update();
  assert.equal(buffered,2);assert.deepEqual(queued.map(item=>item.index),[0,1]);
  buffered=1;await stream.update();assert.deepEqual(queued.map(item=>item.index),[0,1,2]);assert.equal(queued[2].final,true);
  buffered=0;await stream.update();assert.equal(begins,2);await stream.update();assert.equal(queued.at(-1).index,0);
  link.audioMusicOffered=false;stream.update();assert.ok(cancelled>=1);
  assert.ok(calls.every(call=>call.route==="music-info"||call.body.revision===revision));
});

test("the project player scopes music to the confirmed route and accepts a silent world",async()=>{
  const prepared=await Clips.prepareMusic(wav(1)),lease="c".repeat(32),calls=[];
  const manifest=[lease,prepared.id,"once",prepared.segments.length,...prepared.segments.map(item=>item.digest)].join("\n")+"\n";
  const link={audioMusicOffered:true,project:true,lease,waiting:false,
    route:{phase:0,world:1,revision:"1".repeat(64),epoch:3},scene:{route:{world:1,revision:"1".repeat(64),epoch:3}},
    async call(route,body){calls.push({route,body});if(route==="music-info"&&body.revision==="1".repeat(64))return new Response(null,{status:204});
      if(route==="music-info")return new Response(manifest);const item=prepared.segments[body.index];
      return new Response(item.bytes,{headers:{"content-type":"audio/wav","x-mundo-audio-digest":item.digest,
        "x-mundo-music-index":String(item.index)}});}};
  let buffered=0,begins=0;
  const audio={get bufferedMusicSegments(){return buffered;},beginMusicStream(){begins++;buffered=0;return true;},
    queueMusicSegment(){buffered++;return true;},cancelMusicStream(){buffered=0;return true;}};
  const stream=Player.roomMusic(link,audio,Clips,async response=>new Uint8Array(await response.arrayBuffer()),()=>{});
  await stream.update();await stream.update();assert.equal(calls.length,1);assert.equal(begins,0);
  link.route={phase:0,world:2,revision:"2".repeat(64),epoch:4};link.scene={route:{...link.route}};
  await stream.update();await stream.update();assert.equal(begins,1);assert.equal(buffered,1);
  assert.deepEqual(calls.map(item=>item.route),["music-info","music-info","music"]);
});
