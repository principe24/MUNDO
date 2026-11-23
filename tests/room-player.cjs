"use strict";
// Real HTTP and production player scripts; only DOM events and drawing are substituted.
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const {makeRoom,createHost}=require("../server/room.cjs");
async function until(fn){
  const start=Date.now();
  while(!fn()){if(Date.now()-start>7000)throw Error("Timed out waiting for room state");await new Promise(r=>setTimeout(r,20));}
}
async function player(origin,seat,title="Escena de prueba",environment={}){
  const elements=new Map(),handlers={},storage=new Map();let view,connected=true;
  const get=id=>{
    if(!elements.has(id))elements.set(id,{textContent:"",hidden:false,parentElement:{classList:{add(){},remove(){}}},focus(){},setAttribute() {},addEventListener(){}});
    return elements.get(id);
  };
  const g=vm.createContext({
    location:new URL(origin+"/mundo/MUNDO.html#seat="+seat.invite),
    TextEncoder,TextDecoder,Uint8Array,atob,URLSearchParams,Uint8ClampedArray,
    AbortController,Blob,URL,console,
    setTimeout,clearTimeout,setInterval,clearInterval,AbortSignal,crypto,performance,...environment,
    fetch:(url,o)=>connected?fetch(origin+url,{...o,headers:{...o.headers,origin}}):Promise.reject(new TypeError("offline")),
    document:{body:{dataset:{}},getElementById:get,addEventListener(){},hasFocus:()=>true,hidden:false},
    navigator:{maxTouchPoints:0},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    HTMLButtonElement:class{},MundoView:{mobile:false,View:class{
      constructor(){view=this;this.gpuReady=true;this.levels=new Map();}
    }},addEventListener:(event,fn)=>{handlers[event]=fn;}
  });
  g.window=g;
  const html=await (await fetch(origin+"/mundo/MUNDO.html")).text();
  for(const match of html.matchAll(/<script src="([^"]+)"><\/script>/g)){
    const url=new URL(match[1],origin+"/mundo/MUNDO.html");
    if(url.pathname==="/web/view.js")continue;
    const reply=await fetch(url);assert.equal(reply.status,200);
    vm.runInContext(await reply.text(),g,{filename:url.pathname});
  }
  await until(()=>get("world").textContent===title);
  const frame=setInterval(()=>view.onMove(.016),16);
  return {get,view,handlers,setConnected:value=>{connected=value;},stop:async()=>{clearInterval(frame);if(get("roomAction").textContent==="Salir de la sala")await get("roomAction").onclick();}};
}
test("two production players show peer movement and remove the avatar after leave",async()=>{
  const bytes=fs.readFileSync(path.join(__dirname,"../examples/Plaza_Brisa.mworld"));
  const room=makeRoom(bytes,"Escena de prueba"),app=createHost(room,{port:0}),origin=await app.start();
  let a,b;
  try{
    a=await player(origin,room.seats[0]);b=await player(origin,room.seats[1]);
    await until(()=>b.view.peerPosition&&a.view.peerPosition);
    assert.ok(b.view.actorParts.some(o=>o.n.id< -64n));
    const z=b.view.peerPosition[2];
    a.handlers.keydown({code:"KeyW",preventDefault(){}});
    await until(()=>b.view.peerPosition[2]<z-.3);a.handlers.keyup({code:"KeyW"});
    const body=room.seats[0].player.body;
    a.setConnected(false);await until(()=>a.get("notice").textContent.includes("Reconectando"));
    a.setConnected(true);await until(()=>a.get("notice").textContent.includes("2 jugadores"));
    assert.equal(room.seats[0].player.body,body);
    await a.get("roomAction").onclick();await until(()=>!b.view.peerPosition);
    assert.equal(a.get("roomAction").textContent,"Volver a entrar");
    await a.get("roomAction").onclick();await until(()=>a.view.peerPosition&&b.view.peerPosition);
    assert.equal(a.get("useCar").hidden,true);
  }finally{
    if(a)await a.stop();if(b)await b.stop();
    app.server.closeAllConnections();await new Promise(r=>app.server.close(r));
  }
});

test("hosted MUNDO player shows the courtyard NPC walking, hides stale poses and recovers the same guide", async t => {
  const {readProject}=require("../server/project-room.cjs");
  const bytes=fs.readFileSync(path.join(__dirname,"../examples/navigation/Los_dos_patios.mproject"));
  const project=await readProject(bytes);
  const room=makeRoom(null,null,undefined,null,null,project);
  const host=createHost(room,{port:0}), origin=await host.start();
  let guest;
  t.after(async()=>{try{if(guest)await guest.stop();}finally{await host.close();}});
  guest=await player(origin,room.seats[0],"Patio del muro");
  await until(()=>guest.view.npcPositions?.length===1 && guest.view.actorParts.some(part=>part.actorRig.npc));
  const start=guest.view.npcPositions[0].slice();
  const moved=()=>guest.view.npcPositions?.[0]?.some((x,i)=>Math.abs(x-start[i])>.3);
  await until(moved);
  assert.equal(room.seats[1].player,null);
  assert.equal(guest.view.peerPosition,null);
  guest.setConnected(false);
  await until(()=>guest.get("notice").textContent.includes("Reconectando") && !guest.view.npcPositions.length);
  guest.setConnected(true);
  await until(()=>guest.view.npcPositions.length===1 && guest.get("notice").textContent.includes("esperando"));
  assert.ok(guest.view.actorParts.filter(part=>part.actorRig.npc).length>1);
  assert.equal(guest.get("world").textContent,"Patio del muro");
});

function outputCapture(){
  const pending=new Set(); let device;
  class AudioContext {
    constructor(){device=this;this.sampleRate=24000;this.state="suspended";this.destination={};}
    get currentTime(){return performance.now()/1000;}
    resume(){this.state="running";return Promise.resolve();}
    close(){this.state="closed";return Promise.resolve();}
    createGain(){return {gain:{value:1},connect(){},disconnect(){}};}
    createBuffer(_,frames){
      const channels=[new Float32Array(frames),new Float32Array(frames)];
      return {getChannelData:i=>channels[i],duration:frames/this.sampleRate};
    }
    createBufferSource(){
      const clock=this;
      return {connect(){},disconnect(){},stop(){clearTimeout(this.timer);pending.delete(this);},
        start(at){
          pending.add(this);
          this.timer=setTimeout(()=>{pending.delete(this);this.onended?.();},
            Math.max(0,(at+this.buffer.duration-clock.currentTime)*1000));
        }};
    }
  }
  const signal=(polarity=0)=>[...pending].some(node=>node.buffer.getChannelData(0)
    .some(sample=>(polarity?sample*polarity:Math.abs(sample))>.05));
  return {AudioContext,signal,get device(){return device;}};
}

test("production player mixes a sealed WAV over real HTTP, silences a lost seat and resumes the mix",async t=>{
  const {MundoWorld}=require("../server/room-runtime.cjs");
  const {roomFromSource}=require("../server/room.cjs"),{readRoomSource}=require("../server/room-source.cjs");
  const Scene=require("../web/audio-scene.js"),Clips=require("../web/audio-clips.js"),File=require("../web/room-file.js");
  const world=MundoWorld.decode(fs.readFileSync(path.join(__dirname,"../examples/Plaza_Brisa.mworld")));
  const samples=Float32Array.from({length:2400},(_,i)=>.5*Math.sin(i/10));
  const clip=await Clips.prepare(Clips.encodeMono(samples));
  Scene.add(world,{label:"Emisora",preset:clip.key,spatial:"2d",group:"musica",position:[0,0,0],volume:1,radius:1});
  const bytes=MundoWorld.encode(world),title="Emisora privada";
  const base=File.pack({title,revision:1,hash:await File.digest(bytes)},bytes);
  const sealed=await Clips.pack(base,[clip]);
  const room=await roomFromSource(readRoomSource("Emisora.mroomaudio",Buffer.from(sealed)));
  const host=createHost(room,{port:0}),origin=await host.start();
  let guest,fetches=0;
  host.server.on("request", req=>{if(req.url==="/room/audio")fetches++;});
  const capture = outputCapture(), {AudioContext,signal:energy} = capture;
  t.after(async()=>{try{if(guest)await guest.stop();}finally{await host.close();}});
  guest=await player(origin,room.seats[0],room.name,{AudioContext,Float32Array});
  assert.equal(capture.device,undefined);
  await guest.get("audioEnable").onclick();
  await until(()=>fetches>0 && energy());
  assert.equal(guest.get("audioStatus").textContent,"Salida de audio activa.");
  guest.setConnected(false);
  await until(()=>guest.get("notice").textContent.includes("Reconectando") && !energy());
  guest.setConnected(true);
  await until(()=>guest.get("notice").textContent.includes("esperando") && energy());
  assert.equal(fetches,1,"the verified clip survives a transient disconnect for the same lease");
  await guest.get("roomAction").onclick();
  await until(()=>capture.device.state==="closed" && !energy());
});

test("walking through a published portal switches the real client to the second world's WAV",async t=>{
  const {MundoWorld,MundoProject}=require("../server/room-runtime.cjs");
  const Clips=require("../web/audio-clips.js"),Project=require("../web/audio-project.js");
  const Scene=require("../web/audio-scene.js"),{roomFromSource}=require("../server/room.cjs");
  const {readRoomSource}=require("../server/room-source.cjs");
  const clips=[],worlds=[],portals=[];
  for(const id of [1,2]){
    // Opposite signs distinguish the two recordings exactly after clipping and panning.
    const clip=await Clips.prepare(Clips.encodeMono(new Float32Array(1200).fill(id===1?.3:-.4)));
    const world=MundoWorld.empty(),floor=MundoWorld.add(world,"Plaza",1);
    floor.p=[0,-.25,0];floor.s=[24,.5,24];
    if(id===1){
      const tile=MundoWorld.add(world,"Portal/Biblioteca",1);
      tile.p=[0,.05,2];tile.s=[4,.1,1.5];
      portals.push({from:1,tile:String(tile.id),to:2});
    }
    Scene.add(world,{label:"Emisión",preset:clip.key,position:[0,0,0],radius:10,
      spatial:"2d",group:"musica",volume:1});
    worlds.push(await MundoProject.draft(id,world,id===1?"Plaza inicial":"Biblioteca",null,null));
    clips.push(clip);
  }
  const index={name:"Paseo privado",start:1,worlds,portals};
  const project=await Project.exportProject(index,key=>clips.find(clip=>clip.key===key));
  const bytes=Buffer.from(await project.blob.arrayBuffer());
  const room=await roomFromSource(readRoomSource("Paseo.mprojectaudio",bytes)),host=createHost(room,{port:0});
  const capture=outputCapture(),origin=await host.start(),revisions=[];
  host.server.on("request",req=>{if(req.url==="/room/audio")revisions.push(room.revision);});
  let guest;
  t.after(async()=>{try{if(guest)await guest.stop();}finally{await host.close();}});
  guest=await player(origin,room.seats[0],"Plaza inicial",{AudioContext:capture.AudioContext,Float32Array});
  await guest.get("audioEnable").onclick();
  await until(()=>capture.signal(1) && room.seats[0].player.scene==="ready" && room.seats[0].player.body.grounded);
  const first=room.revision;assert.deepEqual(revisions,[first]);assert.equal(capture.signal(-1),false);
  guest.handlers.keydown({code:"KeyW",preventDefault(){}});
  await until(()=>guest.get("world").textContent==="Biblioteca" && capture.signal(-1));
  guest.handlers.keyup({code:"KeyW"});
  assert.notEqual(first,room.revision);assert.deepEqual(revisions,[first,room.revision]);
  assert.equal(capture.signal(1),false);
  await guest.get("roomAction").onclick();assert.equal(capture.device.state,"closed");
});
