"use strict";
const assert=require("node:assert/strict");
const {test}=require("node:test");
const {mount,save,open,until}=require("./support/studio-dom.cjs");
const api=require("../server/room-runtime.cjs");
const {MundoWorld:W,MundoProject:P}=api;
const R=require("../web/room-file.js");
const routes=require("../web/npc-routes.js");
const input={label:"Guía del paseo",mode:"patrol",speed:2.25,waitSeconds:.375,spawn:[0,0,0]};
const plain=x=>JSON.parse(JSON.stringify(x));
function draft(){
  const world=W.empty();world.next=9007199254740995n;
  const r=routes.addRoute(world,"Pasaje",[[0,0,0],[3,0,1],[2,1,4]]);
  const n=routes.addNpc(world,{...input,route:r});
  return {world,r,n};
}
test("puntos en orden, IDs de 64 bits, clon por edición y rutas reutilizables",()=>{
  const {world,r,n}=draft(),copy=W.fork(world);
  const n2=routes.addNpc(copy,{...input,label:"Inspección",route:r,mode:"follow",spawn:[4,1,0]});
  routes.editStep(copy,r,2,"up");
  routes.editStep(copy,r,0,"move",[1,0,4]);
  routes.editStep(copy,r,0,"remove");
  const defs=routes.definitions(W.decode(W.encode(copy)));
  assert.deepEqual(plain(defs[0]),{id:String(n),mode:"patrol",speed:2.25,waitSeconds:.375,points:[[0,0,0],[2,1,4],[3,0,1]]});
  assert.equal(defs[1].id,String(n2));assert.equal(defs[1].mode,"follow");
  assert.deepEqual(plain(routes.read(world)[0].points),[[0,0,0],[3,0,1],[2,1,4]]);
  assert.throws(()=>routes.removeRoute(copy,r),/personajes/);
  copy.nodes.delete(n2);copy.nodes.delete(n);routes.removeRoute(copy,r);
  assert.deepEqual(routes.definitions(copy),[]);
});
test("validación de límites, referencias, jerarquías y transformaciones antes de publicar",()=>{
  const {world,r,n}=draft(),raw=W.encode(world);
  const broken=()=>W.decode(raw);
  let copy=broken();
  copy.nodes.delete(n);copy.nodes.delete(r);
  assert.throws(()=>routes.inspect(copy),/pertenecer/);
  copy=broken();copy.nodes.get(r).q=[0,1,0,0];assert.throws(()=>routes.inspect(copy),/rotación/);
  copy=broken();W.add(copy,"Pieza privada",1,n);assert.throws(()=>routes.inspect(copy),/hijas/);
  copy=broken();copy.nodes.get(r+1n).name="MUNDO/Nav/v1/P/02";assert.throws(()=>routes.inspect(copy),/consecutivo/);
  copy=broken();copy.nodes.get(n).name=copy.nodes.get(n).name.replace(String(r),"42");assert.throws(()=>routes.inspect(copy),/ruta existente/);
  for(const [field,invalid] of [["speed",1.234],["speed",0],["waitSeconds",NaN],["mode","script"],["label"," "],["spawn",[0,0,Infinity]]]){
    assert.throws(()=>routes.addNpc(world,{...input,route:r,[field]:invalid}));
  }
  assert.throws(()=>routes.addRoute(world,"x",Array(33).fill([0,0,0])));
  assert.throws(()=>routes.addRoute(world,"x",[]));
  assert.equal(Buffer.compare(raw,W.encode(world)),0);
  for(let i=1;i<8;i++)routes.addNpc(world,{...input,route:r});
  assert.throws(()=>routes.addNpc(world,{...input,route:r}),/8/);
});
test("intercambio con publicación y paquete de invitados conserva NPCs sin datos privados",async()=>{
  const {world,r}=draft(),node=world.nodes.get(r);
  node.components=['{"key":"privado.nota","version":1,"data":{"nota":"secreto-exclusivo-local"}}'];
  const entry=await P.draft(1,world,"Cruce",null,null);
  const project={name:"Barrio",start:1,worlds:[entry],portals:[]};
  const source=await P.pack(project),guest=await P.packForRoom(project);
  assert.equal(Buffer.from(await source.arrayBuffer()).includes("secreto-exclusivo-local"),true);
  assert.equal(Buffer.from(await guest.arrayBuffer()).includes("secreto-exclusivo-local"),false);
  const reopened=await P.open(guest),loaded=await P.load(reopened.worlds[0]);
  assert.deepEqual(plain(routes.definitions(loaded.world)),plain(routes.definitions(world)));
  const room=await R.verify(new Uint8Array(await entry.blob.arrayBuffer()));
  assert.deepEqual(plain(routes.definitions(W.decode(room.world))),plain(routes.definitions(world)));
  assert.deepEqual(routes.definitions(W.empty()),[]);
});
test("Studio permite crear dos paradas, cambiar la conducta, deshacer y reabrir el proyecto",async()=>{
  const page=mount({}),el=page.element;el("new").click();
  el("navRouteName").value="Paseo interior";el("navCreateRoute").click();
  assert.equal(el("navPoint").options.length,1,el("navStatus").textContent);
  el("navX").value="4";el("navAppend").click();
  assert.equal(el("navPoint").options.length,2);
  el("navX").value="1";el("navNpcName").value="Guía";el("navCreateNpc").click();
  assert.equal(el("navNpc").options.length,2,el("navStatus").textContent);
  el("navMode").value="follow";el("navUpdateNpc").click();
  el("undo").click();assert.equal(el("navMode").value,"patrol");
  el("redo").click();assert.equal(el("navMode").value,"follow");
  el("projectName").value="Ruta del mercado";el("projectName").oninput();
  await el("projectDraft").click();
  const blob=await save(page),again=mount({});
  await open(again,blob,"Ruta del mercado");await again.element("projectEdit").click();
  const actors=again.element("navNpc");actors.value=actors.options[1].value;actors.onchange();
  assert.equal(again.element("navMode").value,"follow");
  assert.equal(again.element("navX").value,"1");
  assert.equal(again.element("navPoint").options.length,2);
});

test("diagnóstico en Studio localiza el tramo y la cota, permite editar y cancela el informe anterior",async()=>{
  const page=mount({}),el=page.element;el("new").click();page.block.click();
  el("positionY").value="-.2";el("sizesX").value="14";el("sizesY").value=".4";el("sizesZ").value="8";
  el("props").onsubmit({preventDefault(){}});
  el("navX").value="-4";el("navCreateRoute").click();
  el("navX").value="4";el("navAppend").click();
  el("navX").value="0";el("navCreateNpc").click();
  async function check(){
    const job=el("navCheck").click();
    await until("informe de navegación",()=>el("navCheck").textContent==="Comprobar recorrido guardado");
    await job;return el("navReport").textContent;
  }
  assert.match(await check(),/3 tramos transitables/);
  el("navPoint").selectedIndex=1;el("navPoint").onchange();el("navY").value="7";el("navMove").click();
  assert.match(await check(),/Sin paso transitable en punto 1 → punto 2 .*Y 7/);
  const pending=el("navCheck").click();await el("navCheck").click();
  // The DOM adapter unrefs timers, while a browser always has a live event loop.
  await new Promise(resolve=>setTimeout(resolve,10));await pending;
  assert.match(el("navReport").textContent,/cancelada/);
  const stale=el("navCheck").click();el("undo").click();
  await new Promise(resolve=>setTimeout(resolve,10));await stale;
  assert.equal(el("navReport").textContent,"");
  assert.match(await check(),/3 tramos transitables/);
  el("navMode").value="follow";el("navUpdateNpc").click();
  assert.match(await check(),/Origen transitable/);
});
