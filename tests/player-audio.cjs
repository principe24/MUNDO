"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Output = require("../web/audio-output.js");
const DSP = require("../web/audio-dsp.js");
const Scene = require("../web/audio-scene.js");
const Clips = require("../web/audio-clips.js");
const Player = require("../mundo/scene-audio.js");

function device() {
  const contexts = [], ticks = new Set(), storage = new Map();
  class AudioContext {
    constructor() {
      contexts.push(this);
      this.sampleRate = 48000; this.state = "suspended"; this.currentTime = 1;
      this.nodes = []; this.destination = {};
    }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; }
    createGain() {
      return this.master = {gain:{value:1},connect(){},disconnect(){}};
    }
    createBuffer(channels, length) {
      const data = Array.from({length:channels}, () => new Float32Array(length));
      return {getChannelData:index => data[index]};
    }
    createBufferSource() {
      const node = {connect(){}, disconnect(){}, start(at){this.at = at;}, stop(){this.stopped = true;}};
      this.nodes.push(node);
      return node;
    }
  }
  const host = {AudioContext, MundoAudioScene:Scene, MundoAudioDSP:DSP, MundoAudioOutput:Output,
    localStorage:{getItem:key => storage.get(key), setItem:(key,value) => storage.set(key,value)},
    setInterval(fn){ticks.add(fn); return fn;}, clearInterval(fn){ticks.delete(fn);}};
  return {host, contexts, ticks};
}
function world(preset = "maquina") {
  const result = {nodes:new Map(),next:1n};
  Scene.add(result, {label:"Taller",preset,position:[0,0,0],radius:50,volume:1});
  return result;
}
function energy(ctx) {
  const nodes = ctx.nodes.filter(node => !node.stopped);
  return nodes.reduce((sum,n) => sum + n.buffer.getChannelData(0).reduce((a,b) => a + b*b,0),0);
}

test("confirmed world starts on a gesture, fills the stereo clock, mutes while held and releases on leave", async () => {
  const {host, contexts, ticks} = device(), player = Player.create(host, false);
  player.install(world()); player.listen([0,0,0], 0);
  assert.equal(await player.activate(), false);
  player.setActive(true);
  assert.equal(contexts.length, 0);
  const unlock = player.activate();
  assert.equal(contexts.length, 1);
  assert.equal(await unlock, true);
  const ctx = contexts[0];
  assert.ok(energy(ctx) > 1);
  assert.equal(ticks.size, 1);
  assert.equal(ctx.master.gain.value, .8);
  const first = ctx.nodes;
  for(let i=1;i<first.length;i++)assert.ok(Math.abs(first[i].at - first[i-1].at - .03) < 1e-9);
  player.setActive(false);
  assert.ok(ctx.nodes.every(node => node.stopped)); assert.equal(ticks.size,0);
  player.setActive(true); assert.ok(energy(ctx) > 1);
  assert.equal(player.apply({...player.defaults,volume:25, muted:true, musica:30}), true);
  assert.equal(ctx.master.gain.value,0); assert.equal(ticks.size,0);
  assert.equal(Player.create(host,false).settings.musica,30);
  assert.equal(Player.create(host,true).settings.musica,100);
  player.apply({...player.settings,muted:false});
  assert.equal(ctx.master.gain.value,.25); assert.ok(energy(ctx)>1);
  player.install(world("agua")); // replacement uses the same unlocked audio output.
  assert.equal(contexts.length,1); assert.ok(energy(ctx)>1);
  player.clear(); assert.equal(ctx.state,"closed");assert.equal(ticks.size,0);
  assert.equal(await player.activate(),false);
  player.install(world());player.setActive(true);
  assert.equal(await player.activate(),true);assert.equal(contexts.length,2);
  player.clear();
});

test("unsupported, blocked, interrupted and pending contexts cannot resurrect an old scene",async()=>{
  const {host,contexts,ticks}=device(), Constructor=host.AudioContext;
  const player=Player.create(host,true);
  delete host.AudioContext;
  player.install(world());player.setActive(true);assert.equal(await player.activate(),false);
  let release, allowed=false;
  host.AudioContext=class extends Constructor{
    resume(){
      if(!allowed)return Promise.reject(Error("gesture required"));
      return new Promise(done=>{release=()=>{if(this.state!=="closed")this.state="running";done();};});
    }
  };
  assert.equal(await player.activate(),false);
  allowed=true;
  const attempt=player.activate();
  assert.equal(player.activate(),attempt);
  player.clear();release();
  assert.equal(await attempt,false);assert.equal(ticks.size,0);
  assert.equal(contexts[0].state,"closed");
  host.AudioContext=Constructor;
  player.install(world());player.setActive(true);assert.equal(await player.activate(),true);
  const ctx=contexts[1];ctx.state="interrupted";ctx.onstatechange();assert.equal(ticks.size,0);
  assert.equal(await player.activate(),true);assert.equal(ticks.size,1);
  player.clear();
});

test("a referenced recording starts after verified download, with no transfer for a legacy room",async()=>{
  const {host,contexts}=device(),player=Player.create(host,false);
  const clip=await Clips.prepare(Clips.encodeMono(Float32Array.from({length:4800},(_,i)=>.4*Math.sin(i/7))));
  const ticket={lease:"a".repeat(32),revision:"b".repeat(64)},calls=[];
  const link={...ticket,audioClipsOffered:false,project:false,async call(endpoint,body,scene,signal){
    calls.push({endpoint,body,signal});
    return new Response(clip.bytes,{headers:{"content-type":"application/octet-stream","x-mundo-audio-digest":clip.digest}});
  }};
  const read=async(response,max,type)=>{assert.equal(max,Clips.maxClipBytes);assert.equal(type,"application/octet-stream");return new Uint8Array(await response.arrayBuffer());};
  const room=Player.roomClips(link,player,Clips,read,()=>{});
  player.install(world(clip.key));player.setActive(true);assert.equal(await player.activate(),true);
  assert.equal(energy(contexts[0]),0);
  room.update();assert.equal(calls.length,0);
  link.audioClipsOffered=true;const transfer=room.update();room.update();await transfer;
  assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{...ticket,key:clip.key});
  const ctx=contexts[0];
  // Resume after losing focus also schedules newly available PCM immediately.
  player.setActive(false);player.setActive(true);
  assert.ok(energy(ctx)>1);
  room.update();assert.equal(calls.length,1);
  room.clear();player.clear();
});

test("late or altered clip deliveries never reach a new room, failure leaves other sound available",async()=>{
  const clip=await Clips.prepare(Clips.encodeMono(Float32Array.from([0,.1,.2,.4])));
  const {host,contexts}=device(),player=Player.create(host,false);
  const authored=world();Scene.add(authored,{label:"Grabación",preset:clip.key,position:[0,0,0],radius:50,volume:1});
  player.install(authored);player.setActive(true);await player.activate();assert.ok(energy(contexts[0])>1);
  let release,requestSignal,now=0,body=Uint8Array.from(clip.bytes),messages=[];
  const link={revision:"1".repeat(64),lease:"f".repeat(32),audioClipsOffered:true,
    async call(endpoint, params, scene, signal){requestSignal=signal;await new Promise(done=>{release=done;});return new Response(body,{headers:{"content-type":"audio/wav","x-mundo-audio-digest":clip.digest}});}};
  const installed=[],observer={get clipKeys(){return player.clipKeys;},clearClips:()=>player.clearClips(),setClip:key=>installed.push(key)};
  const room=Player.roomClips(link,observer,Clips,async res=>new Uint8Array(await res.arrayBuffer()),msg=>messages.push(msg),()=>now);
  const abandoned=room.update();room.pause();assert.ok(requestSignal.aborted);
  release();await abandoned;assert.deepEqual(installed,[]);
  body[44]^=127;
  for(let i=0;i<3;i++){
    const attempt=room.update();release();await attempt;now+=8000;
  }
  room.update();assert.match(messages.at(-1),/no está disponible/);
  assert.deepEqual(installed,[]);assert.ok(energy(contexts[0])>1);
  room.clear();player.clear();
});

test("a one-shot keeps its cursor across sectors and re-arms when a different world reuses its ID",async()=>{
  const {host,contexts,ticks}=device(),player=Player.create(host,false);
  const clip=await Clips.prepare(Clips.encodeMono(new Float32Array(240).fill(.5)));
  const authored={nodes:new Map(),next:1n};
  Scene.add(authored,{label:"Campana",preset:clip.key,position:[0,0,0],radius:10,volume:1,loop:false});
  player.install(authored);player.setClip(clip.key,await Clips.verify(clip.key,clip.bytes));
  player.setActive(true);await player.activate();const ctx=contexts[0];
  const levels=()=>ctx.nodes.filter(n=>!n.stopped && n.onended).map(n=>
    n.buffer.getChannelData(0).some(sample=>Math.abs(sample)>.01));
  assert.ok(levels().includes(true));
  for(const n of ctx.nodes){n.onended?.();n.onended=null;}
  ctx.currentTime+=.25;for(const tick of ticks)tick();
  player.install(authored,true);assert.ok(!levels().includes(true));
  player.setActive(false);player.install(authored);player.setActive(true);assert.ok(levels().includes(true));
  player.clear();
});

test("only a project's confirmed route may receive a clip and a new world discards old PCM",async()=>{
  const first=await Clips.prepare(Clips.encodeMono(new Float32Array(240).fill(.1)));
  const second=await Clips.prepare(Clips.encodeMono(new Float32Array(240).fill(.3)));
  const a={revision:"a".repeat(64),epoch:1,world:10,phase:0};
  const b={revision:"b".repeat(64),epoch:2,world:20,phase:0};
  let requested=[],installed=[],key=first.key,release;
  const store=new Map([[first.key,first],[second.key,second]]);
  const link={project:true,revision:null,audioClipsOffered:false,lease:"f".repeat(32),
    route:a,scene:{route:a},waiting:false,
    async call(endpoint,body){
      requested.push(body);await new Promise(done=>{release=done;});
      const item=store.get(body.key);
      return new Response(item.bytes,{headers:{"content-type":"audio/wav","x-mundo-audio-digest":item.digest}});
    }
  };
  const audio={get clipKeys(){return [key];},clearClips(){installed=[];},setClip(id){installed.push(id);}};
  const room=Player.roomClips(link,audio,Clips,async res=>new Uint8Array(await res.arrayBuffer()),()=>{});
  room.update();assert.deepEqual(requested,[]); // legacy project
  link.audioClipsOffered=true;const firstTransfer=room.update();release();await firstTransfer;
  assert.deepEqual(installed,[first.key]);
  link.waiting=true;link.staged={route:b};room.update();
  assert.deepEqual(installed,[]);assert.equal(requested.length,1);
  link.waiting=false;link.route=b;key=second.key;
  room.update();assert.equal(requested.length,1); // installation still describes A
  link.scene={route:b};const abandoned=room.update();
  link.waiting=true;release();await abandoned;assert.deepEqual(installed,[]);
  link.waiting=false;const accepted=room.update();release();await accepted;
  assert.deepEqual(installed,[second.key]);
  assert.deepEqual(requested.map(r=>[r.revision,r.key]),[
    [a.revision,first.key],[b.revision,second.key],[b.revision,second.key]
  ]);
  assert.deepEqual(Object.keys(requested[2]).sort(),["key","lease","revision"]);
  room.clear();
});

test("la salida recuerda la pausa individual antes del gesto, hasta el siguiente bloque y por revisión",async()=>{
  const {host,contexts,ticks}=device(),output=Output.create(host);
  const a={id:"7",preset:"maquina",position:[-1,0,0],volume:1,radius:7};
  const b={...a,id:"8",position:[1,0,0]};
  output.setSources([a,b]);
  assert.equal(output.setSourcePaused("5",true),false);
  assert.equal(output.setSourcePaused("7",true),true);
  assert.equal(await output.unlock(),true);
  const ctx=contexts[0],first=ctx.nodes[0].buffer;
  assert.ok(first.getChannelData(0).every(v=>v===0));
  assert.ok(first.getChannelData(1).some(v=>v!==0));
  const reference=DSP.create(ctx.sampleRate);reference.setSources([a]);
  const expected=new Float32Array(first.getChannelData(0).length);
  reference.render(expected,new Float32Array(expected.length));
  output.setSourcePaused(a.id,false);
  const previouslySubmitted=ctx.nodes.length;
  for(const node of ctx.nodes.slice())node.onended?.();
  ctx.currentTime+=.12;for(const pump of ticks)pump();
  assert.deepEqual(ctx.nodes[previouslySubmitted].buffer.getChannelData(0),expected);
  output.setSourcePaused(a.id,true);
  const resetAt=ctx.nodes.length;
  output.setSources([]);output.setSources([a,b]);
  const next=ctx.nodes[resetAt];
  assert.deepEqual(next.buffer.getChannelData(0),expected);
  output.close();assert.equal(output.setSourcePaused(a.id,false),false);
});
