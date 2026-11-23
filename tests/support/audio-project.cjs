"use strict";
const {MundoWorld,MundoProject}=require("../../server/room-runtime.cjs");
const {readRoomSource}=require("../../server/room-source.cjs");
const Clips=require("../../web/audio-clips.js"), Project=require("../../web/audio-project.js");
const Scene=require("../../web/audio-scene.js");

// A walkable portal connects two distinct recordings. Their signs allow the
// web and native players to identify the room by the actual rendered samples.
async function portalAudioSource(){
  const clips=[],worlds=[],portals=[];
  for(const id of [1,2]){
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
  const project=await Project.exportProject({name:"Paseo privado",start:1,worlds,portals},
    key=>clips.find(clip=>clip.key===key));
  return readRoomSource("Paseo.mprojectaudio",Buffer.from(await project.blob.arrayBuffer()));
}
module.exports={portalAudioSource};
