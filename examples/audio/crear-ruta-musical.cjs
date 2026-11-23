"use strict";

const fs=require("node:fs"),path=require("node:path");
const {MundoProject}=require("../../server/room-runtime.cjs");
const Clips=require("../../web/audio-clips.js"),Scene=require("../../web/audio-scene.js");
const MusicProject=require("../../web/audio-music-project.js");

function melody(notes,seconds=13){
  const samples=new Float32Array(Clips.rate*seconds),beat=Clips.rate*.5;
  for(let i=0;i<samples.length;i++){
    const note=notes[Math.floor(i/beat)%notes.length],phase=i/Clips.rate;
    const envelope=Math.min(1,(i%beat)/(Clips.rate*.02))*Math.max(0,1-(i%beat)/beat);
    samples[i]=Math.sin(2*Math.PI*note*phase)*.22*envelope+
      Math.sin(2*Math.PI*note*2*phase)*.04*envelope;
  }
  return Clips.encodeMono(samples);
}

async function create(output){
  const tracks=await Promise.all([
    Clips.prepareMusic(melody([220,277.18,329.63,277.18])),
    Clips.prepareMusic(melody([196,246.94,293.66,246.94]))
  ]);
  const {courtyard,garden,projectBytes}=require("../navigation/generate.cjs"),first=courtyard(),second=garden();
  for(const [index,item] of [first,second].entries()){
    Scene.setMusic(item.world,{streamId:tracks[index].id,
      label:index?"Jardín del anochecer":"Patio del amanecer",loop:true});
  }
  const author=await MundoProject.open(new Blob([await projectBytes(first,second)]));
  const result=await MusicProject.exportProject(author,null,id=>tracks.find(track=>track.id===id));
  fs.writeFileSync(output,Buffer.from(await result.blob.arrayBuffer()));
}

const output=path.resolve(process.argv[2]||path.join(__dirname,"Ruta_musical_de_los_patios.mprojectmusic"));
create(output).then(()=>process.stdout.write(output+"\n"),error=>{console.error(error);process.exitCode=1;});
