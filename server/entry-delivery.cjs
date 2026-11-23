"use strict";
const {EntryZones}=require("./entry-zones.cjs");
const {worldPart,validateWorldRequest,PART_SIZE,HEADER_SIZE}=require("./world-part.cjs");
const {reusePage}=require("./world-reuse.cjs");
const {MundoZones}=require("./room-runtime.cjs");

const sha=/^[0-9a-f]{64}$/;
const leaseId=/^[0-9a-f]{32}$/;
function reject(status,message){throw Object.assign(new Error(message),{status});}
function validate(msg,project,part){
  const keys=["revision","profile"];
  if(project)keys.push("epoch","lease");
  if(part)keys.push("hash","offset");
  if(!msg || typeof msg!=="object" || Array.isArray(msg) || Object.keys(msg).length!==keys.length ||
     !keys.every(key=>Object.hasOwn(msg,key)) || !["mobile","pc"].includes(msg.profile) ||
     typeof msg.revision!=="string" || msg.revision.length!==64 || !sha.test(msg.revision) ||
     (project && (!Number.isSafeInteger(msg.epoch) || msg.epoch<1 || typeof msg.lease!=="string" ||
                  msg.lease.length!==32 || !leaseId.test(msg.lease))) ||
     (part && (typeof msg.hash!=="string" || msg.hash.length!==64 || !sha.test(msg.hash) ||
               !Number.isSafeInteger(msg.offset) || msg.offset<0 || msg.offset%PART_SIZE!==0)))
    reject(400,"Solicitud de zona de entrada inválida.");
}
function manifest(def,profile,entry){
  const header=Buffer.alloc(112);
  header.write("MEI1",0,4,"ascii");
  header.writeUInt32LE(entry.bytes.length,4);
  header.writeUInt32LE(entry.cells,8);
  header.writeUInt32LE(profile==="mobile"?1:2,12);
  Buffer.from(def.revision,"hex").copy(header,16);
  Buffer.from(entry.hash,"hex").copy(header,48);
  header.writeDoubleLE(entry.focus[0],80);
  header.writeDoubleLE(entry.focus[1],88);
  return header;
}

// Authorization is per current seat, project epoch and world, independently of
// the shared immutable geometry cache. A grant retains metadata, not a second archive.
class EntryDelivery {
  constructor(room){
    this.room=room;
    this.zones=new EntryZones();
    this.grants=new WeakMap();
    this.closing=null;
  }
  context(seat,player,msg){
    if(this.closing || seat.player!==player)reject(410,"La reserva del jugador ha caducado.");
    const context=this.room.entryContext(seat,msg);
    if(context.def.revision!==msg.revision)reject(412,"La revisión solicitada cambió.");
    return context;
  }
  async cellIndex(seat,player,msg,admit){
    validateWorldRequest(msg,this.room.project);
    const current=()=>{
      if(this.closing || seat.player!==player)reject(410,"La reserva del jugador ha caducado.");
      const def=this.room.worldDocument(seat,msg);
      if(def.revision===msg.revision)return def;
      if(this.room.project)reject(412,"La revisión solicitada cambió.");
      return null;
    };
    const def=current();
    if(!def)return null;
    const bytes=await this.zones.directory(def);
    if(current()!==def){
      if(this.room.project)reject(412,"La escena solicitada cambió.");
      return null;
    }
    if(!bytes)return null;
    admit(1/Math.ceil(def.bytes.length/PART_SIZE));
    return bytes;
  }
  async info(seat,player,msg){
    validate(msg,this.room.project,false);
    const {def,focus}=this.context(seat,player,msg);
    const [cellX,cellZ]=focus.map(MundoZones.cell);
    const old=this.grants.get(player);
    const same=old?.def===def && old.epoch===msg.epoch && old.profile===msg.profile &&
      old.cellX===cellX && old.cellZ===cellZ;
    const now=performance.now();
    if(old?.pending)reject(429,"La zona de entrada ya se está preparando.");
    if(same && old.hash){
      const entry=this.zones.peek(def,msg.profile,focus);
      if(entry && entry.hash===old.hash)return manifest(def,msg.profile,entry);
    }
    // Limit work even if clients switch between profiles or an optional build times out.
    if(old && now-old.at<1500)return null;
    const grant={def,profile:msg.profile,epoch:msg.epoch,focus,cellX,cellZ,
      at:now,pending:true,hash:null,sent:0,total:0,cells:0,completedPages:new Set(),savedBytes:0};
    this.grants.set(player,grant);
    player.entryTransfer=grant;
    try{
      const entry=await this.zones.get(def,msg.profile,focus);
      const current=this.context(seat,player,msg);
      if(current.def!==def)reject(412,"La revisión solicitada cambió.");
      if(!entry || cellX!==MundoZones.cell(current.focus[0]) || cellZ!==MundoZones.cell(current.focus[1]))return null;
      grant.focus=current.focus;
      grant.cells=entry.cells;
      grant.hash=entry.hash;
      grant.total=entry.bytes.length;
      return manifest(def,msg.profile,{...entry,focus:current.focus});
    }finally{grant.pending=false;}
  }
  authorizedEntry(seat,player,msg){
    validate(msg,this.room.project,true);
    const {def}=this.context(seat,player,msg);
    const grant=this.grants.get(player);
    if(!grant || grant.def!==def || grant.epoch!==msg.epoch || grant.profile!==msg.profile ||
       grant.hash!==msg.hash)reject(409,"Vuelve a solicitar la zona de entrada.");
    const entry=this.zones.peek(def,msg.profile,grant.focus);
    if(!entry || entry.hash!==msg.hash)reject(409,"La zona de entrada ya no está disponible.");
    return {grant,entry};
  }
  part(seat,player,msg,admit){
    const {grant,entry}=this.authorizedEntry(seat,player,msg);
    admit(1/Math.ceil(grant.total/PART_SIZE));
    const frame=worldPart(entry.bytes,entry.hash,{offset:msg.offset,revision:msg.hash});
    return {frame,grant};
  }
  remaining(seat,player,msg,admit){
    const {grant,entry}=this.authorizedEntry(seat,player,msg);
    const world=grant.def;
    if(msg.offset>=world.bytes.length)reject(416,"El fragmento está fuera de la revisión.");
    const count=Math.min(PART_SIZE,world.bytes.length-msg.offset);
    admit(1/Math.ceil(world.bytes.length/PART_SIZE));
    const frame=reusePage(world.bytes,entry.ranges,msg.offset)??worldPart(world.bytes,world.revision,msg);
    return {frame,count,grant};
  }
  deliveredWorld(seat,player,msg,grant,count,wireSize){
    if(this.closing || player!==seat.player || grant!==this.grants.get(player))return;
    if(!grant.completedPages.has(msg.offset)){
      grant.completedPages.add(msg.offset);
      grant.savedBytes+=Math.max(0,HEADER_SIZE+count-wireSize);
    }
    this.room.partDelivered(seat,player,msg,count);
  }
  delivered(seat,player,msg,grant,count){
    if(this.closing || player!==seat.player || grant!==this.grants.get(player) || grant.sent!==msg.offset)return;
    grant.sent+=count;
    this.room.partDelivered(seat,player,msg,count,true);
  }
  close(){
    return this.closing??=this.zones.close();
  }
}
module.exports={EntryDelivery};
