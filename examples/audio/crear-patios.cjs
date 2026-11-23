"use strict";

const fs = require("node:fs/promises");
const {courtyard,garden,projectBytes} = require("../navigation/generate.cjs");
const {MundoProject:Project} = require("../../server/room-runtime.cjs");
const Scene = require("../../web/audio-scene.js");
const Clips = require("../../web/audio-clips.js");
const AudioProject = require("../../web/audio-project.js");
const {chime} = require("./render-demo.cjs");

async function createPatios() {
  const first=courtyard(), second=garden();
  const bell=await Clips.prepare(Clips.encodeMono(chime()));
  const softSignal=await Clips.prepare(Clips.encodeMono(chime().map((sample,i)=>sample*Math.exp(-i/12000)*.6)));
  Scene.add(first.world,{label:"Reloj del patio",preset:bell.key,position:[-4,1,-3],radius:10,volume:.8,loop:false,group:"efectos"});
  Scene.add(first.world,{label:"Torno de la galería",preset:"maquina",position:[4,1,-3],radius:7,volume:.65,group:"ambiente"});
  Scene.add(second.world,{label:"Campanilla del jardín",preset:softSignal.key,position:[4,1,7],radius:12,volume:.9,loop:false,playbackRate:1.3,group:"musica"});
  Scene.add(second.world,{label:"Agua al pie del muro",preset:"agua",position:[-2,1,3],radius:9,volume:.8});
  const index=await Project.open(new Blob([await projectBytes(first,second)]));
  index.name="Patios del carillón";
  const contents=new Map([bell,softSignal].map(item=>[item.key,item]));
  const result=await AudioProject.exportProject(index,key=>contents.get(key));
  return new Uint8Array(await result.blob.arrayBuffer());
}
module.exports = {createPatios};
if (require.main === module) {
  const output=process.argv[2];
  if (!output?.endsWith(".mprojectaudio")) throw Error("Indica un archivo .mprojectaudio nuevo.");
  createPatios().then(bytes=>fs.writeFile(output,bytes,{flag:"wx"}))
    .catch(error=>{console.error(error.message);process.exitCode=1;});
}
