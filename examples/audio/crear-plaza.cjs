"use strict";

const fs = require("node:fs/promises");
const {MundoWorld: World, MundoGeometry, MundoMeeting} = require("../../server/room-runtime.cjs");
const Scene = require("../../web/audio-scene.js");
const Clips = require("../../web/audio-clips.js");
const Room = require("../../web/room-file.js");
const {chime} = require("./render-demo.cjs");

// The bell and every material and sound in this plaza originate in this repository.
async function createPlaza() {
  const world = World.empty();
  function part(name, shape, p, s, color, rough = .8, metal = 0) {
    const n = World.add(world, name, shape);
    Object.assign(n, {p, s, color, rough, metal});
    return n;
  }
  const stone = [.48,.44,.37], teal = [.12,.36,.37], brass = [.73,.49,.18];
  part("Atrio de piedra", 1, [0,-.25,0], [26,.5,24], stone);
  for (const x of [-12.5,12.5]) part("Pretil lateral",1,[x,.4,0],[.4,.8,23.5],stone);
  part("Pretil norte",1,[0,.4,-11.5],[25,.8,.4],stone);
  part("Pila de la fuente",1,[-7,.3,0],[3.5,.6,3.5],teal);
  part("Lámina de agua",1,[-7,.61,0],[3.1,.07,3.1],[.20,.48,.63],.15,.13);
  part("Surtidor",1,[-7,1,0],[.18,1.1,.18],brass,.25,.7);
  part("Bancada del motor",1,[7,.22,0],[2.8,.44,2.2],stone);
  part("Carcasa del torno",1,[7,1.05,0],[2,1.2,1.3],teal,.35,.65);
  for (const x of [-1.35,1.35]) part("Pilar del carillón",1,[x,1.7,-7.5],[.35,3.4,.35],teal);
  part("Dintel del carillón",1,[0,3.4,-7.5],[3.05,.3,.5],teal);
  part("Campana de bronce",2,[0,2.64,-7.5],[.88,.95,.88],brass,.28,.7);

  const bell = await Clips.prepare(Clips.encodeMono(chime()));
  Scene.add(world,{label:"Aire de la plaza",preset:"brisa",position:[0,0,0],spatial:"2d",radius:24,volume:.12});
  Scene.add(world,{label:"Fuente de piedra",preset:"agua",position:[-7,1,0],radius:9,volume:.88});
  Scene.add(world,{label:"Motor del taller",preset:"maquina",position:[7,1,0],radius:9,volume:.76,group:"efectos"});
  Scene.add(world,{label:"Campana del arco",preset:bell.key,position:[0,2.64,-7.5],radius:5,volume:.95,loop:false,group:"musica"});

  const meetingPoint = [0,0,7];
  MundoMeeting.validatePublication(world,MundoGeometry.flatten(world),null,meetingPoint,false);
  const bytes = World.encode(world);
  const room = await Room.seal({title:"Plaza del carillón",revision:1,hash:await Room.digest(bytes),meetingPoint},bytes);
  return Clips.pack(room,[bell]);
}

module.exports = {createPlaza};
if (require.main === module) {
  const target = process.argv[2];
  if (!target?.endsWith(".mroomaudio")) throw Error("Indica la ruta de un nuevo archivo .mroomaudio.");
  createPlaza().then(bytes => fs.writeFile(target,bytes,{flag:"wx"}))
    .catch(error => {console.error(error.message);process.exitCode = 1;});
}
