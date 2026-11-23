"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {webcrypto}=require("node:crypto");
const globals={Uint8Array,TextEncoder,TextDecoder,Blob,crypto:webcrypto};
globals.window=globals;
const context=vm.createContext(globals);
for(const file of ["web/world.js","web/geometry.js","mundo/walk.js","mundo/drive.js","web/bruma-look.js","web/meeting.js","web/room-file.js","web/circuit.js","web/component-record.js","web/npc-routes.js","web/project.js","web/zones.js"]){
  const source=fs.readFileSync(path.join(__dirname,"..",file),"utf8");
  vm.runInContext(source,context,{filename:file});
}
module.exports=globals;
