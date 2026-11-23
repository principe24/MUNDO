"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {mount, save, open} = require("./support/studio-dom.cjs");
const {MundoProject:P} = require("../server/room-runtime.cjs");
const scene = require("../web/audio-scene.js");

function select(el, id) {
  el("audioSource").value = id;
  el("audioSource").onchange();
}

test("Studio conserva fuentes independientes, valores espaciales, deshacer y el proyecto de invitados", async () => {
  const first = mount({}), el = first.element;
  el("new").click();
  el("audioName").value = "Fuente de la plaza";
  el("audioPreset").value = "agua";
  el("audioX").value = "7.75";
  el("audioRadius").value = "21.25";
  el("audioVolume").value = "78.2";
  el("audioGroup").value = "efectos";
  el("audioRate").value = "0.75";
  el("audioCreate").click();
  const original = el("audioSource").value;
  assert(original, el("audioStatus").textContent);
  el("audioCopy").click();
  const copy = el("audioSource").value;
  assert.notEqual(original, copy);
  el("audioName").value = "Melodía interior";
  el("audioX").value = "-3";
  el("audioVolume").value = "37.1";
  el("audioLoop").value = "once";
  el("audioSpatial").value = "2d";
  el("audioGroup").value = "musica";
  el("audioApply").click();
  select(el,original);
  assert.equal(el("audioName").value,"Fuente de la plaza");
  assert.equal(el("audioX").value,"7.75");
  select(el,copy);
  el("audioRadius").value = "999";
  el("audioApply").click();
  assert.match(el("audioStatus").textContent,/alcance/i);
  el("audioRemove").click();
  assert.equal(el("audioSource").options.length,2);
  el("undo").click();
  select(el,copy);
  assert.equal(el("audioRadius").value,"21.25");
  el("redo").click();
  assert.equal(el("audioSource").options.length,2);
  el("undo").click();

  el("projectName").value = "Distrito sonoro";
  el("projectName").oninput();
  await el("projectDraft").click();
  const blob = await save(first), second = mount({});
  await open(second,blob,"Distrito sonoro");
  await second.element("projectEdit").click();
  select(second.element,copy);
  assert.equal(second.element("audioLoop").value,"once");
  assert.equal(second.element("audioSpatial").value,"2d");
  assert.equal(second.element("audioRate").value,"0.75");

  const project = await P.open(blob);
  const guest = await P.open(await P.packForRoom(project));
  const loaded = await P.load(guest.worlds[0]);
  const [a,b] = scene.read(loaded.world);
  assert.equal(a.id,original); assert.equal(a.group,"efectos"); assert.equal(a.volume,.782);
  assert.equal(b.id,copy); assert.equal(b.group,"musica"); assert.equal(b.volume,.371);
  assert.equal(b.position[0],-3); assert.equal(b.loop,false);
});

test("Studio informa de salida no disponible y sigue editando el mismo mundo", async () => {
  const el = mount({}).element;
  assert.equal(el("audioMix").disabled,true);
  await el("audioSolo").click();
  assert.match(el("audioStatus").textContent,/salida de audio/i);
  assert.equal(el("audioStop").disabled,true);
  el("audioCreate").click();
  assert.equal(el("audioSource").options.length,2);
  el("audioPick").click();
  assert.equal(el("audioPick")["aria-pressed"],"true");
  el("audioPanel").open=false;
  el("audioPanel").ontoggle();
  assert.equal(el("audioPick")["aria-pressed"],"false");
});

const clips = require("../web/audio-clips.js");
const {memoryDatabase} = require("./support/creator-database.cjs");

function audioStudio() {
  const contexts=[], data={stores:new Map(),version:0};
  const name="mundo-studio-audio";
  const audioDatabase={name,...memoryDatabase(data,name)};
  class AudioContext {
    constructor() { this.sampleRate=48000;this.currentTime=1;this.state="suspended";this.nodes=[];contexts.push(this); }
    resume() { this.state="running";return Promise.resolve(); }
    close() { this.state="closed"; }
    createGain() { return {gain:{value:1},connect(){},disconnect(){}}; }
    createBuffer(channels,frames) {
      const audio = Array.from({length:channels},()=>new Float32Array(frames));
      return {getChannelData:i=>audio[i]};
    }
    createBufferSource() {
      const node = {connect(){},disconnect(){},start(){},stop(){this.stopped=true;}};
      this.nodes.push(node);
      return node;
    }
  }
  const audioHost={AudioContext,setInterval:()=>1,clearInterval(){}};
  return {...mount({},{audioDatabase,audioHost}),contexts,data};
}

function namedBlob(bytes,name) {
  const file=new Blob([bytes]);
  Object.defineProperty(file,"name",{value:name});
  return file;
}

test("WAV del catálogo a PCM estéreo y sala privada recuperable, con cancelación en vuelo",async()=>{
  const studio=audioStudio(), el=studio.element;
  el("new").click();
  const input=el("audioWav");
  async function upload(name,phase) {
    const samples=Float32Array.from({length:4000},(_,i)=>.5*Math.sin(i*phase));
    input.files=[namedBlob(clips.encodeMono(samples),name)];
    await input.onchange({target:input});
    assert.match(el("audioStatus").textContent,/importado/);
    return el("audioPreset").value;
  }
  const privateKey=await upload("NO-DISTRIBUIR.wav",.1);
  const used=await upload("solamente-local.wav",.22);
  assert.notEqual(privateKey,used);
  el("audioName").value="Campana";
  el("audioGroup").value="voces";
  el("audioSpatial").value="2d";
  el("audioCreate").click();
  assert.match(el("audioStatus").textContent,/creada/i);
  const pending=el("audioSolo").click();
  assert.equal(studio.contexts[0].state,"running","desbloqueo dentro del gesto antes de leer el WAV");
  el("audioStop").click();await pending;
  assert.equal(studio.contexts[0].state,"closed");
  assert.equal(studio.contexts[0].nodes.length,0,"el resultado obsoleto no puede revivir el grafo");
  await el("audioSolo").click();
  const active=studio.contexts.at(-1);
  assert(active.nodes.some(node=>node.buffer.getChannelData(0).some(v=>Math.abs(v)>.005)));
  studio.document.hidden=true;
  studio.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(active.state,"closed");
  studio.document.hidden=false;
  studio.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(studio.contexts.length,2);
  await el("audioMix").click();
  el("undo").click();
  assert.equal(studio.contexts.at(-1).state,"closed");
  el("redo").click();

  await el("audioExport").click();
  const downloaded=studio.getDownload();
  assert.equal(downloaded.name,"Mi_mundo.mroomaudio",el("audioStatus").textContent);
  const packed=new Uint8Array(await downloaded.blob.arrayBuffer());
  const {items}=clips.unpack(packed);
  assert.deepEqual(items.map(i=>i.key),[used]);
  assert(!Buffer.from(packed).includes("solamente-local"));
  const fresh=audioStudio(), file=namedBlob(packed,downloaded.name);
  fresh.element("inputFile").files=[file];
  await fresh.element("inputFile").onchange({target:fresh.element("inputFile")});
  assert.match(fresh.element("notice").textContent,/abierta como borrador/);
  assert.equal(fresh.data.stores.get("recordings").size,1);
  assert(!fresh.data.stores.get("recordings").has(privateKey));
  await fresh.element("audioMix").click();
  assert(fresh.contexts.at(-1).nodes.some(n=>n.buffer.getChannelData(0).some(v=>Math.abs(v)>.005)));
  fresh.events.get("pagehide")();
  assert.equal(fresh.contexts.at(-1).state,"closed");
});
