"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const {MundoWorld: W, MundoProject: P} = require("../server/room-runtime.cjs");
const scene = require("../web/audio-scene.js");
const roomFile = require("../web/room-file.js");
const field = {label:"Viento / alto", preset:"brisa", position:[1,2,3], radius:8.25, volume:.225};
const plain = value => JSON.parse(JSON.stringify(value));

test("la fuente se guarda sin cambiar la versión de mundo y conserva su ID al moverla", () => {
  const world = W.empty();
  world.next = 9007199254740997n;
  let pos = [1,2,3];
  const id = scene.add(world, {...field,position:pos});
  pos[1] = 18;
  assert.equal(world.nodes.get(id).name,"MUNDO/Audio/v1/brisa/825/225/Viento / alto");
  assert.equal(world.nodes.get(id).shape,0);
  const bytes = W.encode(world);
  assert.equal(new DataView(bytes.buffer).getUint32(8,true),1);
  const copy = W.decode(bytes), changed = W.fork(copy);
  assert.equal(scene.update(changed,id,{...field,preset:"maquina",position:[3,10,2],volume:.75}),id);
  assert.deepEqual(plain(scene.read(copy)),[{...field,id:String(id),spatial:"3d",playbackRate:1,loop:true,group:"ambiente"}]);
  assert.deepEqual(plain(scene.read(changed)[0].position),[3,10,2]);
  scene.remove(changed,id);
  assert.deepEqual(scene.read(changed),[]);
  assert.equal(scene.read(copy).length,1);
});

test("proyecto de Studio y revisión para invitados conservan campos extendidos y clave de contenido", async () => {
  const world = W.empty();
  const expected = {...field,label:"Música",preset:"s0123456789abcdef",group:"musica",loop:false,spatial:"2d",playbackRate:2.75};
  const id = scene.add(world,expected);
  assert.equal(world.nodes.get(id).name,"MUNDO/Audio/v2/s0123456789abcdef/825/225/2d/275/once/musica/Música");
  const entry = await P.draft(1,world,"Sala sonora",null,null);
  const full = await P.open(await P.pack({name:"Sonora",start:1,worlds:[entry],portals:[]}));
  const guests = await P.open(await P.packForRoom(full));
  for (const project of [full,guests]) {
    const file = roomFile.unpack(new Uint8Array(await project.worlds[0].blob.arrayBuffer()));
    const decoded = W.decode(file.world);
    assert.deepEqual(plain(scene.read(decoded)),[{id:String(id),...expected}]);
  }
});

test("los mapas anteriores y marcadores futuros ajenos a v1/v2 permanecen intactos",()=>{
  const fs=require("node:fs"),path=require("node:path");
  const bytes=fs.readFileSync(path.join(__dirname,"../examples/Plaza_Brisa.mworld"));
  const world=W.decode(bytes), before=W.encode(world);
  assert.deepEqual(scene.read(world),[]);
  W.add(world,"MUNDO/Audio/v3/Fuente experimental",0);
  assert.deepEqual(scene.read(world),[]);
  assert.ok(Buffer.from(before).equals(bytes));
});

test("la edición rechaza posiciones, etiquetas, catálogos y límites inválidos antes de cambiar la escena",()=>{
  const world=W.empty(), id=scene.add(world,field),before=Buffer.from(W.encode(world));
  const bad=Object.entries({preset:"https://example.test/song.wav", radius:1.001,volume:1.1,position:[0,NaN,0],
    group:"privado",spatial:"otro",playbackRate:Infinity,loop:"once",label:" "});
  for (const [key,value] of bad) {
    assert.throws(()=>scene.update(world,id,{...field,[key]:value}));
    assert.throws(()=>scene.add(world,{...field,[key]:value}));
  }
  assert.throws(()=>scene.add(world,{...field,label:"\ud800"}));
  assert.throws(()=>scene.update(world,"999",field));
  assert.ok(Buffer.from(W.encode(world)).equals(before));
  for(let i=1;i<16;i++)scene.add(world,field);
  assert.throws(()=>scene.add(world,field));
  assert.equal(scene.read(world).length,16);
});

test("marcador de datos no puede ocultar geometría ni inventar una dirección de archivo",()=>{
  const world=W.empty(), id=scene.add(world,field),marker=world.nodes.get(id);
  for(const patch of [{shape:1},{s:[2,1,1]},{q:[0,1,0,0]},{visual:777n},{parent:5n},
    {name:scene.prefix+"../other/1/1/../x"},{name:scene.prefix+"brisa/050/1000/X"},
    {name:scene.extendedPrefix+"agua/50/1000/2d/401/once/efectos/X"}]) {
    const draft=W.fork(world);
    draft.nodes.set(id,{...marker,...patch});
    assert.throws(()=>scene.read(draft));
  }
  W.add(world,"Geom",1,id);
  assert.throws(()=>scene.read(world));
  assert.throws(()=>scene.remove(world,id));
});
