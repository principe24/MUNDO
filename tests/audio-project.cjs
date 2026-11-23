"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {MundoWorld:W,MundoProject:P} = require("../server/room-runtime.cjs");
const Clips = require("../web/audio-clips.js"), Scene = require("../web/audio-scene.js");
const Pack = require("../web/audio-project.js");
const {mount,until,open:openStudio} = require("./support/studio-dom.cjs");
const {memoryDatabase} = require("./support/creator-database.cjs");

const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
async function fixture() {
  const a = await Clips.prepare(Clips.encodeMono([-.75,-.2,1]));
  const b = await Clips.prepare(Clips.encodeMono([.75,.2,-1]));
  const c = await Clips.prepare(Clips.encodeMono([.25,.25,-.25]));
  const worlds = [], gates = [];
  for (const [name,bank] of [["Primer patio",[a,b]],["Segundo patio",[a]]]) {
    const world = W.empty();
    const gate = W.add(world,"Portal/Siguiente",1);
    gate.s=[2,.08,2]; gates.push(String(gate.id));
    for (const clip of bank) Scene.add(world,{preset:clip.key,label:clip.key===a.key?"Común":"Agua",position:[0,0,0],radius:3,volume:.5});
    worlds.push(await P.draft(worlds.length+1,world,name,null,null));
  }
  const project = {name:"Patios compartidos",start:1,worlds,portals:[
    {from:1,to:2,tile:gates[0]},{from:2,to:1,tile:gates[1]}],studioPlugins:[{id:"mundo.info-privada",version:1}]};
  return {a,b,c,project};
}

test("el proyecto conserva dos portales y comparte un WAV entre mundos sin exportar el catálogo privado", async () => {
  const {a,b,c,project} = await fixture();
  const library = new Map([a,b,c].map(item => [item.key,item]));
  const requested = [];
  const compressed = await Pack.exportProject(project,key=>{requested.push(key);return library.get(key);});
  assert.equal(compressed.hasAudio,true);
  assert.deepEqual(requested,[a.key,b.key]);
  const file = await bytes(compressed.blob), out = await Pack.open(file);
  assert.equal(Buffer.from(file).includes("mundo.info-privada"),false);
  assert.equal(out.index.studioPlugins,undefined);
  assert.equal(out.index.portals.length,2);
  assert.equal(out.sourcesByWorld.get(1).length,2);
  assert.equal(out.sourcesByWorld.get(2)[0].preset,a.key);
  assert.deepEqual(new Set(out.items.map(item=>item.key)),new Set([a.key,b.key]));
  assert.deepEqual(out.items.map(item=>item.name).sort(),["Agua","Común"]);
  const guest = await bytes(await P.packForRoom(project)), wrapped = await Pack.pack(guest,[b,a]);
  assert.deepEqual(file,wrapped);
  const raw = Pack.unpack(wrapped);
  assert.deepEqual(raw.project,guest);
  assert.ok(raw.items.every(item => item.bytes.length>44));
  assert.throws(()=>Clips.unpack(file));
});

test("el paquete rechaza proyectos de autor, audio sobrante, faltante, alterado y versiones inválidas", async () => {
  const {a,b,c,project} = await fixture();
  const guest = await bytes(await P.packForRoom(project));
  await assert.rejects(Pack.pack(await bytes(await P.pack(project)),[a,b]),/invitados/);
  await assert.rejects(Pack.pack(guest,[a,b,c]),/corresponder/);
  await assert.rejects(Pack.pack(guest,[b]),/corresponder/);
  await assert.rejects(Pack.exportProject(project,key=>key===a.key?a:null),/Falta la grabación/);
  await assert.rejects(Pack.exportProject(project,null),/Autoriza/);
  const valid = await Pack.pack(guest,[a,b]), bad = valid.slice();
  bad[bad.length-1] ^= 1;
  await assert.rejects(Pack.open(bad),/huella/);
  assert.throws(()=>Pack.unpack(valid.slice(0,-1)));
  const forged = valid.slice();forged[0]=0;
  assert.throws(()=>Pack.unpack(forged));
  const large = valid.slice();new DataView(large.buffer).setUint32(8,64*1024*1024+1,true);
  assert.throws(()=>Pack.unpack(large));
  const wrongBase = valid.slice();wrongBase[16]=0;
  assert.throws(()=>Pack.unpack(wrongBase));
});

test("la exportación sin grabaciones conserva el formato anterior sin consultar el catálogo",async()=>{
  const world=W.empty();
  Scene.add(world,{preset:"agua",label:"Fuente",radius:1,volume:.9,position:[0,0,0]});
  const project={name:"Fuente",start:1,worlds:[await P.draft(1,world,"Fuente",null,null)]};
  const result=await Pack.exportProject(project,null);
  assert.equal(result.hasAudio,false);
  assert.deepEqual(await bytes(result.blob),await bytes(await P.packForRoom(project)));
});

function mountStudio() {
  const data={stores:new Map(),version:0};
  const name="mundo-studio-audio", audioDatabase={name,...memoryDatabase(data,name)};
  return {...mount({},{audioDatabase}),data};
}

test("Studio recibe el proyecto entero, restaura el catálogo y prepara la revisión con autorización", async () => {
  const {a,b,project} = await fixture(), guest = await bytes(await P.packForRoom(project));
  const original = await Pack.pack(guest,[a,b]), studio = mountStudio(), el = studio.element;
  await openStudio(studio,new Blob([original]),project.name);
  assert.equal(studio.data.stores.get("recordings").size,2);
  await el("projectSaveAudio").click();
  assert.equal(studio.getDownload().name,"Patios_compartidos.mprojectaudio",el("projectStatus").textContent);
  assert.deepEqual(await bytes(studio.getDownload().blob),original);
  const prev=studio.getDownload();
  await el("projectPlay").click();
  assert.equal(studio.getDownload(),prev);
  assert.match(el("projectStatus").textContent,/Autoriza/);
  el("projectPlayAudio").checked=true;
  await el("projectPlay").click();
  assert.deepEqual(await bytes(studio.getDownload().blob),original);
  await el("projectEdit").click();
  assert.equal(el("audioSource").options.length,3);
  // Reopening a damaged project must leave both the current project and DB untouched.
  const damaged=original.slice();damaged[damaged.length-1]^=1;
  el("projectFile").files=[new Blob([damaged])];el("projectFile").onchange();
  await until("rechazo de proyecto con muestra dañada",()=>/huella/.test(el("projectStatus").textContent));
  assert.equal(el("projectName").value,project.name);
  assert.equal(studio.data.stores.get("recordings").size,2);
  const clean=mountStudio();clean.element("projectFile").files=[new Blob([damaged])];clean.element("projectFile").onchange();
  await until("validación previa a la escritura",()=>/huella/.test(clean.element("projectStatus").textContent));
  assert.equal(clean.data.stores.get("recordings")?.size || 0,0);
});
