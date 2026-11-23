"use strict";

const {randomBytes,timingSafeEqual}=require("node:crypto");
const {worldPart,PART_SIZE}=require("./world-part.cjs");
const {MundoZones}=require("./room-runtime.cjs");

const rowSize=52;
const hex32=/^[0-9a-f]{32}$/,hex64=/^[0-9a-f]{64}$/;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function validate(msg,project,action){
  const staged=action==="usage-stages",usage=action==="usage" || staged;
  const keys=["revision","profile"];
  if(project)keys.push("epoch","lease");
  if(action==="ready" || action==="part" || usage || (action==="full" && msg && Object.hasOwn(msg,"token")))keys.push("token");
  if(action==="part")keys.push("slot","offset");
  if(usage)keys.push("verified","used","reason");
  if(staged)keys.push("via","middle");
  if(!msg || typeof msg!=="object" || Array.isArray(msg) || Object.keys(msg).length!==keys.length ||
     !keys.every(key=>Object.hasOwn(msg,key)) || !["pc","mobile"].includes(msg.profile) ||
     typeof msg.revision!=="string" || msg.revision.length!==64 || !hex64.test(msg.revision) ||
     (project && (!Number.isSafeInteger(msg.epoch) || msg.epoch<1 || typeof msg.lease!=="string" ||
                  msg.lease.length!==32 || !hex32.test(msg.lease))) ||
     (keys.includes("token") && (typeof msg.token!=="string" || msg.token.length!==32 || !hex32.test(msg.token))) ||
     (usage && (!Number.isInteger(msg.verified) || msg.verified<0 || msg.verified>511 ||
       !Number.isInteger(msg.used) || msg.used<0 || msg.used>511 || (msg.used & msg.verified)!==msg.used ||
       (msg.reason!=="crossed" && msg.used!==(staged?msg.middle:0)) ||
       !["active","changed","released","turned","crossed"].includes(msg.reason))) ||
     (staged && (!["x","z"].includes(msg.via) || !Number.isInteger(msg.middle) || msg.middle<0 ||
       msg.middle>511 || (msg.middle & msg.used)!==msg.middle)) ||
     (action==="part" && (!Number.isSafeInteger(msg.slot) || msg.slot<0 || msg.slot>25 ||
       !Number.isSafeInteger(msg.offset) || msg.offset<0 || msg.offset%PART_SIZE!==0)))
    fail(400,"Solicitud de sectores inválida.");
}
function rowAt(table,i){
  const at=i*rowSize,flags=table.readUInt32LE(at+16);
  return {x:table.readInt32LE(at),z:table.readInt32LE(at+4),start:table.readUInt32LE(at+8),
    bytes:table.readUInt32LE(at+12),nodes:flags&0x7fffffff,road:flags>=0x80000000,hash:table.toString("hex",at+20,at+52)};
}
function localAt(table,x,z){
  let lo=1,hi=table.length/rowSize;
  while(lo<hi){
    const mid=(lo+hi)>>>1,at=mid*rowSize;
    const dx=table.readInt32LE(at)-x,dz=table.readInt32LE(at+4)-z;
    if(!dx && !dz)return rowAt(table,mid);
    if(dx<0 || (!dx && dz<0))lo=mid+1;else hi=mid;
  }
  return null;
}
function windowRows(def,table,profile,cx,cz,radius,initial){
  if(![cx,cz].every(n=>Number.isSafeInteger(n) && n>=-2147483648 && n<=2147483647))return null;
  const rows=[rowAt(table,0)];
  let total=rows[0].bytes;
  for(let x=cx-radius;x<=cx+radius;++x){
    for(let z=cz-radius;z<=cz+radius;++z){
      const row=localAt(table,x,z);
      if(row){rows.push(row);total+=row.bytes;}
    }
  }
  return MundoZones.sectorFits(profile,total,def.bytes.length,initial)?rows:null;
}
function manifest(magic,def,profile,cx,cz,radius,rows){
  const token=randomBytes(16);
  const frame=Buffer.alloc(80+48*rows.length);
  frame.write(magic,0,4,"ascii");frame.writeUInt32LE(rows.length,4);
  frame.writeInt32LE(cx,8);frame.writeInt32LE(cz,12);
  frame.writeUInt32LE(radius,16);frame.writeUInt32LE(def.bytes.length,20);
  Buffer.from(def.revision,"hex").copy(frame,24);token.copy(frame,56);
  rows.forEach((row,i)=>{
    const at=80+48*i;
    frame.writeInt32LE(row.x,at);frame.writeInt32LE(row.z,at+4);
    frame.writeUInt32LE(row.bytes,at+8);frame.writeUInt32LE(row.nodes,at+12);
    Buffer.from(row.hash,"hex").copy(frame,at+16);
  });
  return {profile,cx,cz,radius,rows,frame,token:token.toString("hex")};
}

class SectorDelivery{
  constructor(room,zones){
    this.room=room;
    this.zones=zones;
    this.players=new WeakMap();
    this.closed=false;
  }
  context(seat,player,msg){
    if(this.closed || seat.player!==player)fail(410,"La reserva del jugador ha caducado.");
    const result=this.room.entryContext(seat,msg,true);
    if(result.def.revision!==msg.revision)fail(412,"La revisión solicitada cambió.");
    return result;
  }
  state(seat,player,msg,def){
    let contexts=this.players.get(player);
    if(!contexts){contexts=new Map();this.players.set(player,contexts);}
    // The active and the proposed scene may coexist. Rollback advances the epoch,
    // invalidating both the old token and any completion waiting on its worker.
    for(const [epoch,item] of contexts){
      try{
        if(this.room.worldDocument(seat,{epoch,lease:player.lease})===item.def)continue;
      }catch(error){if(error.status!==412)throw error;}
      contexts.delete(epoch);
    }
    const epoch=msg.epoch??0;
    let state=contexts.get(epoch);
    if(!state){
      state={def,offered:null,confirmed:null,pending:null,delivered:new Set(),fullChallenges:new Map()};
      contexts.set(epoch,state);
    }
    return state;
  }
  async plan(seat,player,msg){
    validate(msg,this.room.project,"plan");
    const {def}=this.context(seat,player,msg);
    const state=this.state(seat,player,msg,def);
    // Even a retry for the same cell supersedes an outstanding full-world receipt.
    state.fullChallenges.clear();
    state.ahead=null;
    if(state.pending)fail(429,"Ya se está preparando la ventana.");
    const ticket=Symbol();
    state.pending=ticket;
    try{
      const catalog=await this.zones.catalog(def);
      const current=this.context(seat,player,msg);
      if(current.def!==def)fail(412,"La escena solicitada cambió.");
      if(state.pending!==ticket)fail(409,"La solicitud de ventana fue sustituida.");
      if(!catalog)return null;
      const [cx,cz]=current.focus.map(MundoZones.cell);
      const same=grant=>grant && grant.profile===msg.profile && grant.cx===cx && grant.cz===cz;
      const previous=state.offered??state.confirmed;
      if(same(previous)){
        state.fullChallenges.clear();
        return previous.frame;
      }
      const radius=msg.profile==="mobile"?1:2;
      const rows=windowRows(def,catalog.table,msg.profile,cx,cz,radius,!state.confirmed);
      if(!rows)return null;
      const grant=manifest("MSP1",def,msg.profile,cx,cz,radius,rows);
      this.room.sectorWindow(seat,player,msg,undefined);
      state.offered=grant;
      // A challenge may have been issued while the catalog worker was running.
      state.fullChallenges.clear();
      return grant.frame;
    }finally{if(state.pending===ticket)state.pending=null;}
  }
  grant(seat,player,msg){
    const {def}=this.context(seat,player,msg);
    const state=this.players.get(player)?.get(msg.epoch??0);
    if(state?.def===def){
      for(const grant of [state.offered,state.confirmed]){
        if(grant?.token===msg.token && grant.profile===msg.profile)return {def,state,grant};
      }
    }
    fail(409,"Solicita la ventana actual.");
  }
  part(seat,player,msg,admit){
    validate(msg,this.room.project,"part");
    const {def,state,grant}=this.grant(seat,player,msg);
    const row=grant.rows[msg.slot];
    if(!row || msg.offset>=row.bytes)fail(416,"El fragmento está fuera del sector.");
    const catalog=this.zones.peekCatalog(def);
    if(!catalog)fail(409,"Vuelve a preparar la ventana de sectores.");
    const count=Math.min(PART_SIZE,row.bytes-msg.offset);
    // One publication worth of sector payload uses one transfer credit, including small worlds.
    admit(count/def.bytes.length);
    const bytes=catalog.bytes.subarray(row.start,row.start+row.bytes);
    return {frame:worldPart(bytes,row.hash,{revision:row.hash,offset:msg.offset}),state,key:row.hash+"/"+msg.offset,count};
  }
  // Only an installed, acknowledged window on the active car can produce a
  // hint. Never enqueue a worker or hold a catalog allocation in the grant.
  aheadContext(seat,player,msg,request){
    const {def}=this.context(seat,player,msg);
    const state=this.players.get(player)?.get(msg.epoch??0);
    if(!state || state.def!==def)return null;
    const installed=state.confirmed;
    if(state.pending || state.offered || state.fullChallenges.size || !installed){
      state.ahead=null;return null;
    }
    if(installed.profile!==msg.profile)return null;
    const catalog=this.zones.peekCatalog(def);
    const guard=catalog && this.room.aheadMotion(seat,request);
    if(!guard || guard.def!==def || guard.epoch!==msg.epoch || guard.window.fromX!==installed.cx ||
       guard.window.fromZ!==installed.cz || guard.square.radius!==installed.radius){
      state.ahead=null;return null;
    }
    return {state,def,guard,installed,catalog};
  }
  ahead(seat,player,msg,available){
    validate(msg,this.room.project,"plan");
    const ctx=this.aheadContext(seat,player,msg,true);
    if(!ctx || !available)return null;
    const {state,def,guard,installed,catalog}=ctx;
    const w=guard.window,previous=state.ahead;
    let rows,requiredBytes;
    if(previous?.guard===guard && previous.installed===installed){
      // A duplicate request shares an open observation. A retained terminal
      // observation gets a new token even if the vehicle resumed on the same approach.
      if(!previous.grant || !this.room.aheadTerminal(previous.grant.token))return previous.grant?.frame??null;
      rows=previous.grant.rows;requiredBytes=previous.requiredBytes;
    }else{
      const window=windowRows(def,catalog.table,msg.profile,w.cx,w.cz,installed.radius,false);
      // Global is distinct from local (0,0). Only the entering strip is new.
      const locals=window?window.slice(1):[];
      rows=locals.length?MundoZones.aheadRows(msg.profile,w,(x,z)=>locals.find(row=>row.x===x && row.z===z)):[];
      requiredBytes=0;
      for(const row of locals){
        if(Math.max(Math.abs(row.x-installed.cx),Math.abs(row.z-installed.cz))>installed.radius)requiredBytes+=row.bytes;
      }
    }
    const grant=rows.length?manifest("MAH1",def,msg.profile,w.cx,w.cz,installed.radius,rows):null;
    if(grant)this.room.aheadOffered(seat,player,msg,guard,grant,requiredBytes,installed.following);
    state.ahead={guard,installed,grant,requiredBytes};
    return grant?.frame??null;
  }
  aheadPart(seat,player,msg,admit){
    validate(msg,this.room.project,"part");
    const ctx=this.aheadContext(seat,player,msg,false);
    if(!ctx)return null;
    const {state,guard,installed,catalog,def}=ctx;
    const hint=state.ahead;
    if(!hint || hint.guard!==guard || hint.installed!==installed || hint.grant?.token!==msg.token)
      fail(409,"La anticipación del turismo ha cambiado.");
    const row=hint.grant.rows[msg.slot];
    if(!row || msg.offset>=row.bytes)fail(416,"El fragmento está fuera del sector previsto.");
    const count=Math.min(PART_SIZE,row.bytes-msg.offset);
    if(!admit(count/def.bytes.length))return null;
    const bytes=catalog.bytes.subarray(row.start,row.start+row.bytes);
    return worldPart(bytes,row.hash,{revision:row.hash,offset:msg.offset});
  }
  usage(seat,player,msg,staged=false){
    validate(msg,this.room.project,staged?"usage-stages":"usage");
    if(this.closed)fail(410,"La sala se está cerrando.");
    // Debriefs can cross a portal after the old epoch closed. The receipt binds
    // the exact revision, original epoch and live reservation independently.
    this.room.reportAheadUsage(seat,player,msg);
  }
  delivered(seat,player,msg,result){
    if(this.closed || player!==seat.player || this.players.get(player)?.get(msg.epoch??0)!==result.state)return;
    const seen=result.state.delivered;
    if(seen.has(result.key))return;
    // An arrival does not move while the portal is preparing. Even both profiles
    // together fit here. Active worlds keep a bounded recent-page ledger.
    if(seen.size>=128)seen.delete(seen.values().next().value);
    seen.add(result.key);
    this.room.sectorDelivered(seat,player,msg,result.count);
  }
  ready(seat,player,msg){
    validate(msg,this.room.project,"ready");
    const {state,grant}=this.grant(seat,player,msg);
    if(state.confirmed!==grant){
      this.room.sectorWindow(seat,player,msg,{cx:grant.cx,cz:grant.cz,radius:grant.radius});
      // Each confirmed window has exactly one first successor. Receipts retain
      // these two coordinates, never this grant or its scene, even after travel.
      const previous=state.confirmed;
      if(previous && previous.profile===grant.profile){
        previous.following.cx=grant.cx;
        previous.following.cz=grant.cz;
      }
      grant.following={cx:null,cz:null};
      state.confirmed=grant;state.offered=null;
      state.ahead=null;
    }
    state.fullChallenges.clear();
  }
  full(seat,player,msg){
    validate(msg,this.room.project,"full");
    const {def}=this.context(seat,player,msg);
    const state=this.state(seat,player,msg,def);
    // At most one 16-byte receipt per profile in each authorized scene.
    let challenge=state.fullChallenges.get(msg.profile);
    if(!Object.hasOwn(msg,"token")){
      state.ahead=null;
      if(!challenge){
        challenge={bytes:randomBytes(16),confirmed:false};
        state.fullChallenges.set(msg.profile,challenge);
      }
      return challenge.bytes;
    }
    if(!challenge || !timingSafeEqual(challenge.bytes,Buffer.from(msg.token,"hex")))
      fail(409,"Solicita una nueva confirmación de la revisión completa.");
    if(!challenge.confirmed){
      this.room.sectorWindow(seat,player,msg,null);
      challenge.confirmed=true;
      // Cancel any waiting worker ticket and detach late HTTP finish callbacks.
      // Retain completed receipts for idempotent retries until the next negotiation.
      state.pending=null;
      this.players.get(player).set(msg.epoch??0,{def,offered:null,confirmed:null,pending:null,
        delivered:new Set(),fullChallenges:state.fullChallenges});
    }
    return null;
  }
  close(){this.closed=true;this.players=new WeakMap();}
}
module.exports={SectorDelivery};
