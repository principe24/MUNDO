"use strict";
// Real HTTP and production player scripts; only DOM events and drawing are substituted.
const test=require("node:test"),assert=require("node:assert/strict");
const vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const {makeRoom,createHost}=require("../server/room.cjs");
async function until(fn){
  const start=Date.now();
  while(!fn()){if(Date.now()-start>7000)throw Error("Timed out waiting for room state");await new Promise(r=>setTimeout(r,20));}
}
async function player(origin,seat,title="Escena de prueba"){
  const elements=new Map(),handlers={},storage=new Map();let view,connected=true;
  const get=id=>{
    if(!elements.has(id))elements.set(id,{textContent:"",hidden:false,parentElement:{classList:{add(){},remove(){}}},focus(){},setAttribute() {},addEventListener(){}});
    return elements.get(id);
  };
  const g=vm.createContext({
    location:new URL(origin+"/mundo/MUNDO.html#seat="+seat.invite),
    TextEncoder,TextDecoder,Uint8Array,atob,URLSearchParams,Uint8ClampedArray,
    AbortController,Blob,URL,console,
    setTimeout,clearTimeout,AbortSignal,crypto,performance,
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
