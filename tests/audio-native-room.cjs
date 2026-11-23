"use strict";
const path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const {spawn} = require("node:child_process");
const {roomFromSource,createHost,playerInvitation} = require("../server/room.cjs");
const {openRoomSource} = require("../server/room-source.cjs");

async function main() {
  const binary=process.argv[2];
  if(!binary) throw Error("Pass the native room test executable");
  const source=openRoomSource(path.join(__dirname,"../examples/audio/Plaza_del_carillon.mroomaudio"));
  for(const mode of ["normal","corrupt","legacy"]){
    const room=await roomFromSource(await source), app=createHost(room,{port:0});
    const origin=await app.start();
    try {
      const child=spawn(binary,[mode],{stdio:["pipe","inherit","inherit"]});
      const result=new Promise((resolve,reject)=>{
        child.once("error",reject);
        child.once("exit",(code,signal)=>code===0 ? resolve():reject(Error("native room "+mode+" failed: "+(code??signal))));
      });
      child.stdin.end(playerInvitation(origin,room.seats[0].invite)+"\n");
      await result;
      console.log("native authenticated audio: "+mode);
    } finally {await app.close();}
  }
}
const data=fs.mkdtempSync(path.join(os.tmpdir(),"mundo-audio-native-room-"));
process.env.XDG_STATE_HOME=data;
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(data,{recursive:true,force:true}));
