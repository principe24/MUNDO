"use strict";
const mundoRoomHex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
const mundoRoomError=message=>Object.assign(new Error(message),{status:422});
async function mundoRoomBytes(response,limit,type="application/octet-stream"){
  if(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!==type ||
     Number(response.headers.get("content-length"))>limit || !response.body)
    throw mundoRoomError("Archivo de sala incompatible.");
  const reader=response.body.getReader(),chunks=[];
  let total=0;
  try{
    for(;;){
      const {value,done}=await reader.read();if(done)break;
      total+=value.byteLength;
      if(total>limit){await reader.cancel();throw mundoRoomError("El archivo de la sala supera el límite.");}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);
  let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  return bytes;
}
async function mundoRoomJson(response){
  const bytes=await mundoRoomBytes(response,4096,"application/json");
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{throw mundoRoomError("El mensaje JSON de la sala es inválido.");}
}
function mundoRoomNpcs(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>8)throw mundoRoomError("Número de NPC inválido.");
  const ids=new Set(),states=["patrol","waiting","follow","return","blocked","idle"];
  for(const npc of value){
    if(!npc||typeof npc.id!=="string"||!/^[1-9][0-9]{0,19}$/.test(npc.id)||
       BigInt(npc.id)>0xffffffffffffffffn||ids.has(npc.id)||!states.includes(npc.state)||
       !Array.isArray(npc.position)||npc.position.length!==3||
       !npc.position.every(n=>Number.isFinite(n)&&Math.abs(n)<=1e12)||
       !Number.isFinite(npc.yaw)||Math.abs(npc.yaw)>Math.PI+.000001)
      throw mundoRoomError("Pose de NPC inválida.");
    ids.add(npc.id);
  }
  return value;
}
function mundoSameScene(a,b){
  return a && b && a.world===b.world && a.root===b.root && a.revision===b.revision;
}
const mundoPartSize=1024*1024,mundoWorldLimit=24*mundoPartSize;
function mundoEntryInfo(bytes,revision,mobile){
  if(bytes.length!==112 || bytes[0]!==77 || bytes[1]!==69 || bytes[2]!==73 || bytes[3]!==49)
    throw mundoRoomError("La descripción de la zona de entrada es incompatible.");
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const length=view.getUint32(4,true),cells=view.getUint32(8,true);
  const focus=[view.getFloat64(80,true),view.getFloat64(88,true)];
  if(length<24 || length>(mobile?4:8)*mundoPartSize || cells<1 || cells>(mobile?10:26) ||
     view.getUint32(12,true)!==(mobile?1:2) || bytes.subarray(96).some(byte=>byte!==0) ||
     mundoRoomHex(bytes.subarray(16,48))!==revision || !focus.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e15))
    throw mundoRoomError("La zona de entrada no corresponde a esta sala.");
  return {length,focus,hash:mundoRoomHex(bytes.subarray(48,80))};
}
function mundoPageSize(header,offset,knownTotal){
  const total=header.getUint32(4,true),start=header.getUint32(8,true),length=header.getUint32(12,true);
  if(total<24 || total>mundoWorldLimit || (knownTotal && total!==knownTotal) ||
     start!==offset || offset%mundoPartSize!==0 || offset>=total ||
     length!==Math.min(mundoPartSize,total-offset))
    throw mundoRoomError("El fragmento no corresponde al tamaño o a la posición solicitada.");
  return {total,length};
}
function mundoWorldPart(frame,offset,knownTotal){
  if(frame.length<16 || frame[0]!==77 || frame[1]!==87 || frame[2]!==67 || frame[3]!==49)
    throw mundoRoomError("La cabecera del fragmento de mundo es incompatible.");
  const {total,length}=mundoPageSize(new DataView(frame.buffer,frame.byteOffset,16),offset,knownTotal);
  if(frame.length!==16+length)throw mundoRoomError("La longitud del fragmento no coincide.");
  return total;
}
function mundoWorldPage(frame,offset,knownTotal,source){
  if(!source || frame[2]===67)
    return {total:mundoWorldPart(frame,offset,knownTotal),payload:frame.subarray(16),copied:false};
  const invalid=()=>mundoRoomError("La página de la sala no corresponde al sector de entrada.");
  if(frame.length<24 || frame[0]!==77 || frame[1]!==87 || frame[2]!==82 || frame[3]!==49)throw invalid();
  const header=new DataView(frame.buffer,frame.byteOffset,frame.byteLength);
  const {total,length}=mundoPageSize(header,offset,knownTotal);
  const ops=header.getUint32(16,true),literals=header.getUint32(20,true);
  if(!ops || ops>4096 || ops>length || literals>length ||
      frame.length>16+length || frame.length!==24+8*ops+literals)throw invalid();
  // Rebuild separately so an invalid instruction never advances the verified page boundary.
  const payload=new Uint8Array(length);
  let cursor=24,written=0,inline=0;
  for(let i=0;i<ops;i++){
    if(cursor+8>frame.length)throw invalid();
    const from=header.getUint32(cursor,true),count=header.getUint32(cursor+4,true);
    cursor+=8;
    if(!count || count>length-written)throw invalid();
    if(from===0xffffffff){
      if(count>literals-inline || count>frame.length-cursor)throw invalid();
      payload.set(frame.subarray(cursor,cursor+count),written);
      cursor+=count;inline+=count;
    }else{
      if(from>source.length || count>source.length-from)throw invalid();
      payload.set(source.subarray(from,from+count),written);
    }
    written+=count;
  }
  if(written!==length || inline!==literals || cursor!==frame.length)throw invalid();
  return {total,payload,copied:inline<length};
}
function mundoDecodeRoom(bytes){
  try{return MundoWorld.decode(bytes);}
  catch{throw mundoRoomError("El contenido de la revisión recibida es incompatible.");}
}
function mundoCircuitState(score,gates,last) {
  const phases=["ready","running","finished"];
  const integer=n=>Number.isSafeInteger(n)&&n>=0;
  const fail=()=>{throw mundoRoomError("El marcador no corresponde a las puertas o a la vuelta de esta revisión.");};
  if(score==null){if(last)fail();return null;}
  const phase=phases.indexOf(score.phase);
  if(!integer(score.run) || !score.run || !integer(score.total) || !score.total || score.total!==gates.length ||
     !integer(score.passed) || score.passed>score.total || phase<0 || !integer(score.elapsedMs) ||
     !(score.bestMs===null || integer(score.bestMs)))fail();
  const done=phase===2, next=gates[score.passed];
  if(done!==(score.passed===score.total) || score.nextId!==(next?String(next.id):null) ||
     (done && (score.bestMs===null || score.bestMs>score.elapsedMs)) ||
     (phase===0 && (score.passed!==0 || score.elapsedMs!==0)))fail();
  const startMode=Object.hasOwn(score,"startMode")?score.startMode:"movement";
  if(startMode!=="movement" && startMode!=="flying")fail();
  if(last && (last.startMode??"movement")!==startMode)fail();
  const split=score.split;
  if(startMode==="flying" && (score.total<2 || (!score.passed && phase!==0) ||
     (score.passed===1 && split && (split.atMs!==0 || (split.referenceMs!==null && split.referenceMs!==0)))))fail();
  if(Object.hasOwn(score,"split") && split!==null){
    if(typeof split!=="object" || Array.isArray(split) || Object.keys(split).length!==2 ||
       !Object.hasOwn(split,"atMs") || !Object.hasOwn(split,"referenceMs") ||
       !score.passed || !integer(split.atMs) || split.atMs>score.elapsedMs ||
       (done && split.atMs!==score.elapsedMs) ||
       !(split.referenceMs===null || integer(split.referenceMs)))fail();
    if(last?.run===score.run && last.split &&
       (split.atMs<last.split.atMs || (last.passed===score.passed &&
        (split.atMs!==last.split.atMs || split.referenceMs!==last.split.referenceMs))))fail();
  }
  if(last && (score.run<last.run || score.total!==last.total ||
     (last.bestMs!==null && (score.bestMs===null || score.bestMs>last.bestMs)) ||
     (score.run===last.run && (score.passed<last.passed || phase<phases.indexOf(last.phase) ||
       (!done && score.elapsedMs<last.elapsedMs) ||
       (last.phase==="finished" && score.elapsedMs!==last.elapsedMs)))))fail();
  return {...score,startMode,nextLabel:next?.label??null,target:next?.point??null,
    splitLabel:split?gates[score.passed-1].label:null};
}
// Only compact cumulative masks are queued; the simulation never awaits a report.
class MundoSectorUsageQueue{
  constructor(send){
    this.send=send;this.pending=new Map();this.flight=null;this.sending=null;this.timer=null;
    this.closed=false;this.noStages=false;this.flushDone=null;
  }
  merge(first,second){
    if(!first)return second;
    const rank={active:0,changed:1,released:2,turned:3,crossed:4};
    return {...second,verified:first.verified|second.verified,used:first.used|second.used,
      ...(second.via?{middle:first.middle|second.middle}:{}),
      reason:rank[first.reason]>rank[second.reason]?first.reason:second.reason};
  }
  add(body){
    if(this.closed || (body.via && this.noStages))return;
    const key=[body.revision,body.profile,body.epoch,body.token,body.via??"direct"].join("/");
    const old=this.pending.get(key);
    if(!old && this.pending.size>=16){
      const expendable=[...this.pending].find(([,item])=>item.body.reason==="active");
      if(!expendable && body.reason==="active")return;
      this.pending.delete(expendable?.[0]??this.pending.keys().next().value);
    }
    const sending=this.sending?.key===key?this.sending.body:null;
    this.pending.set(key,{key,body:this.merge(sending,this.merge(old?.body,body)),retries:old?.retries??0});
    this.schedule();
  }
  schedule(){
    if(this.closed || this.flight || this.timer!==null)return;
    if(!this.pending.size){this.flushDone?.();return;}
    this.timer=setTimeout(()=>{this.timer=null;void this.drain();},180);
  }
  async drain(){
    if(this.closed || this.flight || !this.pending.size)return;
    const items=this.pending.values();
    const item=[...items].find(entry=>entry.body.reason!=="active")??this.pending.values().next().value;
    this.pending.delete(item.key);this.sending=item;
    const flight=this.flight=new AbortController(),timer=setTimeout(()=>flight.abort(),1500);
    try{
      const response=await this.send(item.body,flight.signal);
      if(response.status!==204)throw mundoRoomError("Recibo de precarga incompatible.");
    }catch(error){
      if(item.body.via && [404,405].includes(error.status)){
        this.noStages=true;
        for(const [key,pending] of this.pending)if(pending.body.via)this.pending.delete(key);
      }else if([401,403,404,405,410].includes(error.status))this.close();
      else if(!this.closed && (!error.status || error.status===408 || error.status===429 || error.status>=500) &&
          item.retries<1 && !this.pending.has(item.key) && this.pending.size<16){
        item.retries++;this.pending.set(item.key,item);
      }
    }finally{
      clearTimeout(timer);
      if(this.flight===flight){this.flight=null;this.sending=null;}
      this.schedule();
    }
  }
  async flush(){
    if(this.closed || (!this.pending.size && !this.flight))return;
    // Leaving may release the seat immediately on the host. Give a pending final
    // report one bounded opportunity while the same reservation is still live.
    let timeout;
    try{
      await new Promise(resolve=>{
        this.flushDone=resolve;timeout=setTimeout(resolve,450);
        if(this.timer!==null){clearTimeout(this.timer);this.timer=null;}
        if(!this.flight)void this.drain();
      });
    }finally{clearTimeout(timeout);this.flushDone=null;}
  }
  close(){
    this.closed=true;clearTimeout(this.timer);this.timer=null;
    this.pending.clear();this.flight?.abort();this.flushDone?.();
  }
}
// The room owns positions and the simulation clock. A car command describes a desired seat state.
window.MundoRoomLink=class {
  constructor(invite,proof,request=fetch){
    this.invite=invite;this.proof=proof;this.request=request;
    this.cacheLimit=(window.MundoView?.mobile===false?32:8)*1024*1024;
    this.resetSeat();
  }
  resetSeat(){
    this.resetRoomActor();
    this.brumaOffered=false;this.clearRoomBruma();this.modelsOffered=false;
    this.cancelWorld();this.wholeWorldOnly=false;this.noEntryEndpoint=false;this.noRestEndpoint=false;
    this.usageQueue?.close();this.usageQueue=null;
    this.noCellsEndpoint=false;this.soloResidence=null;
    this.soloScene=null;this.noSectorEndpoint=false;this.sectorHost=false;this.fullKey=null;this.courseScene=null;
    this.noAheadEndpoint=false;this.aheadPausedUntil=0;
    this.seq=0;this.ack=0;this.id=null;this.lease=null;this.unconfirmed=null;
    this.project=false;this.waiting=false;this.route=null;this.staged=null;this.scene=null;
    this.world=null;this.revision=null;this.courseEpoch=null;this.gates=[];this.lastCourse=null;
  }
  resetRoomActor(){
    this.actorEpoch=(this.actorEpoch??0)+1;
    this.actorOffered=false;this.actorDone=false;this.actorRetries=0;this.actorRetryAt=0;
    this.actorFlight?.abort();this.actorFlight=null;
    this.actorReceiver?.setRoomOffer(false);this.actorReceiver?.clearRoomFile();this.actorReceiver=null;
  }
  retryRoomActor(receiver){
    if(!this.actorOffered || !this.lease || !receiver.acceptsRoomFile)return false;
    if(this.actorFlight)return true;
    this.actorDone=false;this.actorRetries=0;this.actorRetryAt=0;
    this.roomActor(receiver);
    return true;
  }
  roomActor(receiver){
    if(!receiver)return;
    if(this.actorReceiver!==receiver){
      this.actorReceiver=receiver;receiver.setRoomOffer(this.actorOffered);
    }
    if(!receiver.acceptsRoomFile || !this.actorOffered || !this.lease || this.actorDone || this.actorFlight ||
        this.actorRetries>=3 || performance.now()<this.actorRetryAt)return;
    const lease=this.lease,epoch=this.actorEpoch;
    const current=()=>this.actorEpoch===epoch && this.lease===lease && this.actorOffered;
    const flight=this.actorFlight=new AbortController();
    const timer=setTimeout(()=>flight.abort(),15000);
    ++this.actorRetries;
    const load=async()=>{
      const response=await this.call("actor",{lease},null,flight.signal,true);
      const bytes=await mundoRoomBytes(response,4*1024*1024);
      if(!current())return;
      const file=new File([bytes],"Ines_Bajamar.mavatar",{type:"application/octet-stream"});
      await receiver.applyRoomFile(file,current);
      if(current())this.actorDone=true;
    };
    void load().catch(error=>{
      if(!current())return;
      if(error.status && error.status<500 && ![408,429].includes(error.status))this.actorDone=true;
      else this.actorRetryAt=performance.now()+10000*this.actorRetries;
    }).finally(()=>{
      clearTimeout(timer);
      if(this.actorFlight===flight)this.actorFlight=null;
    });
  }
  clearRoomBruma(){
    const prior=this.brumaTransfer;
    this.brumaTransfer=null;
    if(prior){
      prior.flight?.abort();
      prior.receiver.clearBruma();
    }
  }
  roomBruma(receiver,wanted){
    const revision=this.project?this.scene?.revision:this.revision;
    const lease=this.lease;
    if(!receiver || !wanted || !lease || !revision || !this.brumaOffered){
      this.clearRoomBruma();return;
    }
    let transfer=this.brumaTransfer;
    if(!transfer || transfer.receiver!==receiver || transfer.revision!==revision || transfer.lease!==lease){
      this.clearRoomBruma();
      transfer=this.brumaTransfer={receiver,revision,lease,flight:null,attempts:0,next:0,done:false};
    }
    if(transfer.done || transfer.flight || transfer.attempts>=3 || performance.now()<transfer.next)return;
    const current=()=>this.brumaTransfer===transfer && this.lease===lease && this.brumaOffered &&
      revision===(this.project?this.scene?.revision:this.revision);
    const flight=transfer.flight=new AbortController();
    const timeout=setTimeout(()=>flight.abort(),15000);
    ++transfer.attempts;
    const fetchLook=async()=>{
      const response=await this.call("bruma",{lease,revision},null,flight.signal,true);
      const bytes=await mundoRoomBytes(response,4*1024*1024);
      if(!current())return;
      await receiver.applyBruma(bytes,current);
      if(current())transfer.done=true;
    };
    // The optional art download has an independent lifetime from world replication.
    void fetchLook().catch(error=>{
      if(!current())return;
      if([403,404,410,422].includes(error.status))transfer.done=true;
      else transfer.next=performance.now()+10000*transfer.attempts;
    }).finally(()=>{
      clearTimeout(timeout);
      if(transfer.flight===flight)transfer.flight=null;
    });
  }
  cancelWorld(){
    this.turn=(this.turn??0)+1;
    this.sectorGeneration=(this.sectorGeneration??0)+1;
    for(const store of this.sectorStores??[])store.clear();
    this.sectorStores=new Set();this.sectorJob=null;
    this.dismissEntry();this.entryAttempt=null;
    this.cellRequest?.abort();this.cellRequest=null;
    this.download?.abort();this.download=null;this.partial=null;
    this.projectCache=new Map();this.cellCache=new Map();this.cachedBytes=0;
    this.preparedBytes=new WeakMap();
  }
  dismissEntry(){
    this.entryRequest?.abort();this.entryRequest=null;
    this.entrySource=null;
    this.entryShown=null;this.onEntryScene?.(null);
  }
  checkTurn(turn){
    if(turn!==this.turn)throw Object.assign(new Error("Cambió la solicitud de mundo."),{status:412});
  }
  async call(path,body={},scene=null,signal=null,bounded=false){
    // A caller with its own timer controls the fetch and its response body directly.
    // This also keeps short optional requests bounded on browsers without AbortSignal.any.
    const timeout=bounded?signal:AbortSignal.timeout(8000);
    const deadline=!bounded && signal && typeof AbortSignal.any==="function"?AbortSignal.any([signal,timeout]):timeout;
    const response=await this.request("/room/"+path,{method:"POST",cache:"no-store",credentials:"omit",redirect:"error",referrerPolicy:"no-referrer",
      signal:deadline,headers:{"content-type":"application/json","x-invite":this.invite,
        "x-seat":this.proof,"x-mundo-room-version":"3","x-mundo-travel":"1","x-mundo-circuit":"1",
        ...(path==="input"?{"x-mundo-splits":"1","x-mundo-race-start":"1","x-mundo-npcs":"1"}:{}),...(scene?{"x-mundo-scene":scene}:{})},body:JSON.stringify(body)});
    if(!response.ok){
      const status=response.status;
      const newInvitation=status===403 || (status===410 && path==="join");
      const notices={
        403:"Esta invitación ya no es válida. Pide al anfitrión un enlace nuevo para tu plaza.",
        410:newInvitation?"La invitación caducó. Pide al anfitrión un enlace nuevo para tu plaza.":
          "Tu reserva terminó. Vuelve a entrar con la invitación. Si caducó, pide otra al anfitrión.",
        409:"La plaza o el punto de entrada están ocupados. Espera a que se liberen o pide otra plaza al anfitrión.",
        423:"El anfitrión pausó las entradas. Vuelve a entrar cuando las reanude."
      };
      const detail=await mundoRoomJson(response).catch(()=>({}));
      throw Object.assign(new Error(notices[status] ?? (typeof detail?.error==="string"?detail.error:"La sala no responde.")),
        {status,newInvitation});
    }
    return response;
  }
  transferKey(revision,route){
    return [this.id,this.lease,revision,route?.world,route?.epoch,route?.root].join("/");
  }
  committedWorldKey(route){
    return [this.id,this.lease,route.world,route.root,route.revision].join("/");
  }
  forgetCells(key){
    const bytes=this.cellCache.get(key);
    if(bytes){this.cellCache.delete(key);this.cachedBytes-=bytes.byteLength;}
  }
  clearCellCache(){
    this.cellRequest?.abort();this.cellRequest=null;
    for(const key of this.cellCache.keys())this.forgetCells(key);
  }
  forgetWorld(key){
    this.forgetCells(key);
    const bytes=this.projectCache.get(key);
    if(bytes){
      this.cachedBytes-=bytes.byteLength;
      this.projectCache.delete(key);
    }
  }
  reserveWorldBytes(length){
    while(this.cachedBytes+length>this.cacheLimit && this.cellCache.size)
      this.forgetCells(this.cellCache.keys().next().value);
    while(this.projectCache.size>=8 || this.cachedBytes+length>this.cacheLimit){
      this.forgetWorld(this.projectCache.keys().next().value);
    }
  }
  rememberCommittedWorld(scene,route,indexBytes){
    // A failed transfer vote never adds a destination to the return-trip cache.
    const entry=this.preparedBytes.get(scene);
    if(!entry || entry.key!==this.committedWorldKey(route))return;
    this.preparedBytes.delete(scene);
    this.forgetWorld(entry.key);
    this.reserveWorldBytes(entry.bytes.byteLength);
    this.projectCache.set(entry.key,entry.bytes);
    this.cachedBytes+=entry.bytes.byteLength;
    // Keep the downloaded revision first. A directory never evicts a world.
    if(indexBytes && indexBytes.byteLength<=this.cacheLimit-this.cachedBytes){
      this.cellCache.set(entry.key,indexBytes);this.cachedBytes+=indexBytes.byteLength;
    }
  }
  alignEntry(route){
    if(this.entryShown && (this.entryShown.key!==this.transferKey(route.revision,route) ||
        this.entryShown.proposed!==(route.phase===1)))this.dismissEntry();
  }
  async readEntry(revision,route,turn){
    const key=this.transferKey(revision,route);
    if(this.noEntryEndpoint || this.entryAttempt===key || !this.onEntryScene || document.hidden)return;
    this.entryAttempt=key;
    this.dismissEntry();
    const request=this.entryRequest=new AbortController();
    const timer=setTimeout(()=>request.abort(),8000);
    const mobile=window.MundoView?.mobile!==false;
    const context={revision,profile:mobile?"mobile":"pc",...(route?{epoch:route.epoch,lease:this.lease}:{})};
    try{
      const result=await this.call("entry-info",context,"loading",request.signal,true);
      this.checkTurn(turn);
      if(result.status===204 || request.signal.aborted)return;
      const info=mundoEntryInfo(await mundoRoomBytes(result,112),revision,mobile);
      this.checkTurn(turn);
      const bytes=new Uint8Array(info.length);
      for(let offset=0;offset<bytes.length;){
        if(request.signal.aborted || document.hidden)return;
        const response=await this.call("entry-part",{...context,hash:info.hash,offset},"loading",request.signal,true);
        this.checkTurn(turn);
        if(response.status===204 || request.signal.aborted)return;
        const frame=await mundoRoomBytes(response,16+mundoPartSize);
        this.checkTurn(turn);
        mundoWorldPart(frame,offset,info.length);
        const payload=frame.subarray(16);
        bytes.set(payload,offset);offset+=payload.length;
      }
      if(request.signal.aborted || document.hidden)return;
      const hash=mundoRoomHex(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)));
      this.checkTurn(turn);
      if(hash!==info.hash || request.signal.aborted || document.hidden)return;
      const world=mundoDecodeRoom(bytes);
      this.onEntryScene({world,focus:info.focus,title:route?.title,proposed:route?.phase===1});
      this.entryShown={key,proposed:route?.phase===1};
      if(!this.noRestEndpoint && !this.wholeWorldOnly)this.entrySource={key,profile:context.profile,hash,bytes};
    }catch(error){
      this.checkTurn(turn);
      if([401,403,410,423].includes(error.status) || (route && error.status===412))throw error;
      if(error.status===404 || error.status===405)this.noEntryEndpoint=true;
      // The full revision is still fetched and verified when the optional preview is unavailable.
    }finally{
      clearTimeout(timer);
      if(this.entryRequest===request)this.entryRequest=null;
    }
  }
  async readWorld(revision,route,turn,preview=true){
    this.checkTurn(turn);
    const key=this.transferKey(revision,route);
    if(this.partial?.key!==key)this.partial={key,bytes:null,offset:0,copied:false,ordinaryOnly:false};
    const partial=this.partial;
    const params=route?{epoch:route.epoch,lease:this.lease}:{};
    const retryOriginal=()=>{
      if(!partial.copied || partial.ordinaryOnly)return false;
      const total=partial.bytes.length;
      this.entrySource=null;partial.ordinaryOnly=true;
      partial.bytes=null;partial.offset=0;partial.copied=false;
      this.onProgress?.(0,total,false);
      return true;
    };
    this.download?.abort();
    const download=this.download=new AbortController();
    const fetchBytes=async (path,body,limit,optional=false)=>{
      const response=await this.call(path,body,null,download.signal);
      this.checkTurn(turn);
      if(optional && response.status===204)return null;
      const bytes=await mundoRoomBytes(response,limit);
      this.checkTurn(turn);
      return bytes;
    };
    const readPage=async()=>{
      const offset=partial.offset,known=partial.bytes?.length,body={...params,revision,offset};
      if(!partial.ordinaryOnly && this.entrySource?.key===key && !document.hidden){
        // Hold only the grant fields while waiting. Hiding or leaving removes the source bytes.
        const {hash,profile}=this.entrySource;
        try{
          const frame=await fetchBytes("world-rest",{...body,profile,hash},16+mundoPartSize,true);
          if(frame && this.entrySource?.key===key && this.entrySource.hash===hash &&
              this.entrySource.profile===profile && !document.hidden)
            return mundoWorldPage(frame,offset,known,this.entrySource.bytes);
        }catch(error){
          this.checkTurn(turn);
          if(![404,405,409,416,422].includes(error.status) && !(error.status===412 && !route))throw error;
          if(error.status===404 || error.status===405)this.noRestEndpoint=true;
        }
        this.entrySource=null;
      }
      const frame=await fetchBytes("world-part",body,16+mundoPartSize);
      return mundoWorldPage(frame,offset,known,null);
    };
    try{
      if(preview && !partial.offset && !partial.ordinaryOnly)await this.readEntry(revision,route,turn);
      this.checkTurn(turn);
      if(partial.offset)this.onProgress?.(partial.offset,partial.bytes.length,false);
      for(;;){
        while(!this.wholeWorldOnly && (!partial.bytes || partial.offset<partial.bytes.length)){
          let page;
          try{page=await readPage();}
          catch(error){
            this.checkTurn(turn);
            if((error.status===416 || error.status===422) && retryOriginal())continue;
            if(error.status!==404 && error.status!==405)throw error;
            this.wholeWorldOnly=true;partial.bytes=null;partial.offset=0;partial.copied=false;break;
          }
          this.checkTurn(turn);
          partial.bytes??=new Uint8Array(page.total);
          partial.bytes.set(page.payload,partial.offset);
          partial.offset+=page.payload.length;partial.copied||=page.copied;
          this.onProgress?.(partial.offset,page.total,true);
        }
        const bytes=this.wholeWorldOnly?await fetchBytes("world",params,mundoWorldLimit):partial.bytes;
        if(bytes.length<24)throw mundoRoomError("El mundo recibido está incompleto.");
        const hash=mundoRoomHex(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)));
        this.checkTurn(turn);
        this.entrySource=null;
        if(hash===revision){this.partial=null;return bytes;}
        if(!retryOriginal())throw mundoRoomError("La huella del mundo recibido no coincide con la revisión.");
      }
    }catch(error){
      if(turn===this.turn && error.status>=400 && error.status<500 && ![408,429].includes(error.status)){
        this.partial=null;this.entrySource=null;
      }
      throw error;
    }finally{
      if(this.download===download)this.download=null;
    }
  }
  sectorContext(revision,route){
    return {revision,profile:window.MundoView?.mobile===false?"pc":"mobile",...(route?{epoch:route.epoch,lease:this.lease}:{})};
  }
  sectorReporter(context){
    const id=this.id,lease=this.lease;
    if(id==null)return null;
    if(!this.usageQueue){
      this.usageQueue=new MundoSectorUsageQueue((body,signal)=>
        this.call(body.via?"sector-usage-stages":"sector-usage",body,null,signal,true));
    }
    const queue=this.usageQueue;
    return receipt=>{
      if(this.usageQueue===queue && this.id===id && this.lease===lease)queue.add({...context,...receipt});
    };
  }
  dropStore(store,reason="released"){
    if(store){store.clear(reason);this.sectorStores.delete(store);}
  }
  trimAhead(){
    this.aheadPausedUntil=performance.now()+4000;
    for(const store of this.sectorStores)store.stopAhead(false,"released");
  }
  observeAhead(scene,self,state,centered,playable){
    const sector=scene.sectors,store=sector?.store;
    if(!store)return;
    const aboard=state && (state.driver===self.id || state.passenger===self.id);
    if(!aboard || this.noAheadEndpoint || document.hidden || performance.now()<this.aheadPausedUntil){
      store.stopAhead();return;
    }
    const role=state.driver===self.id?"driver":"passenger";
    const cx=MundoZones.cell(state.x),cz=MundoZones.cell(state.z);
    const aim=MundoZones.aheadWindow(state.x,state.z,state.yaw,state.speed);
    if(store.followDiagonal(state,role,cx,cz,aim,!centered || !!this.sectorJob))return;
    if(!playable){store.stopAhead(false,"changed",state,role);return;}
    if(!centered || this.sectorJob){
      // An ordinary window has priority immediately. Only completed files for
      // the actual arrival can still be used by that independently issued plan.
      store.approaching(state,role,cx,cz);return;
    }
    if(!aim){store.stopAhead(false,"changed",state,role);return;}
    const turn=this.turn,context=this.sectorContext(scene.revision??scene.route.revision,scene.route);
    const current=()=>turn===this.turn && scene.sectors===sector && !sector.refresh &&
      this.sectorStores.has(store) && !this.sectorJob && !document.hidden;
    const request=async(path,body,signal)=>{
      try{return await this.call(path,body,null,signal,true);}
      catch(error){
        if(current() && [404,405].includes(error.status))this.noAheadEndpoint=true;
        throw error;
      }
    };
    // A speculative failure cannot suspend the admitted player or change its receipts.
    store.prefetch(request,context,aim,state,role,current).catch(()=>{});
  }
  orderSectorReceipt(check,operation){
    const send=(this.lastSectorReceipt??Promise.resolve()).then(()=>{check();return operation();});
    this.lastSectorReceipt=send.then(()=>{},()=>{});
    return send;
  }
  async sectors(revision,route,title,turn,existing=null,carRoot=route?.root,onCandidate=null){
    if(this.noSectorEndpoint || !window.MundoSectorStore || document.hidden)return null;
    const context=this.sectorContext(revision,route);
    const store=existing??new MundoSectorStore(revision,context.profile,this.sectorReporter(context));
    this.sectorStores.add(store);
    const current=()=>turn===this.turn && this.sectorStores.has(store) && !document.hidden;
    const check=()=>{this.checkTurn(turn);if(!current())throw Object.assign(new Error("La carga de barrios se interrumpió."),{status:408});};
    const fetchSector=async(path,body,signal)=>{
      check();
      try{
        const response=await this.call(path,body,"loading",signal,true);
        if(path==="sector-plan")this.sectorHost=true;
        return response;
      }catch(error){
        if(path==="sector-plan" && [404,405].includes(error.status) && !this.sectorHost)this.noSectorEndpoint=true;
        throw error;
      }
    };
    this.fullKey=null;
    let retained=false;
    try{
      for(let attempt=0;attempt<2;attempt++){
        try{
          const plan=await store.prepare(fetchSector,context,current);check();
          if(!plan)return null;
          const selected=carRoot && plan.available.find(car=>String(car.rootId)===carRoot);
          if(carRoot && !selected)return null;
          const solid=selected?plan.geometry.objects.filter(o=>!selected.partIds.has(o.n.id)):plan.geometry.objects;
          const walker=new MundoWalk(solid,false);
          const area={world:plan.world,geometry:plan.geometry,available:plan.available,walker,road:selected?walker:null,
            revision,title,route,sectors:{store,token:plan.token,cx:plan.cx,cz:plan.cz,radius:plan.radius,refresh:false}};
          onCandidate?.(area);
          const response=await this.orderSectorReceipt(check,()=>this.call("sector-ready",{...context,token:plan.token},"loading"));
          check();
          if(response.status!==204)return null;
          store.commit(plan);retained=true;
          return area;
        }catch(error){
          check();
          if([401,403,410,423].includes(error.status) || (route && error.status===412))throw error;
          if(error.status!==409 || attempt===1)return null;
        }
      }
    }finally{if(!retained)this.dropStore(store,"changed");}
  }
  async confirmFull(revision,route,turn,current=()=>true){
    const key=this.transferKey(revision,route);
    const check=()=>{
      this.checkTurn(turn);
      if(!current() || document.hidden)throw Object.assign(new Error("La recuperación cambió antes de confirmar el mundo."),{status:408});
    };
    check();
    if(!window.MundoSectorStore || this.noSectorEndpoint || this.fullKey===key)return;
    const context=this.sectorContext(revision,route);
    try{
      await this.orderSectorReceipt(check,async()=>{
        for(let attempt=0;attempt<2;attempt++){
          check();
          try{
            const offer=await this.call("sector-full",context,"loading");check();
            this.sectorHost=true;
            if(offer.status!==200)throw mundoRoomError("El anfitrión no entregó el desafío de la revisión.");
            const token=await mundoRoomBytes(offer,16);check();
            if(token.length!==16)throw mundoRoomError("El desafío de la revisión está incompleto.");
            const ack=await this.call("sector-full",{...context,token:mundoRoomHex(token)},"loading");check();
            if(ack.status!==204)throw mundoRoomError("El anfitrión no confirmó la revisión completa.");
            this.fullKey=key;return;
          }catch(error){
            check();if(error.status!==409 || attempt===1)throw error;
          }
        }
      });
    }catch(error){
      check();
      if(!this.sectorHost && [404,405].includes(error.status)){this.noSectorEndpoint=true;return;}
      throw error;
    }
  }
  async join(){
    const turn=++this.turn;
    const generation=this.sectorGeneration;
    const response=await this.call("join",{},"loading");
    const data=await mundoRoomJson(response);
    this.checkTurn(turn);
    if(![0,1].includes(data?.id)||typeof data.name!=="string"||typeof data.revision!=="string"||!Number.isSafeInteger(data.ack)||data.ack<0||!/^[a-f0-9]{64}$/.test(data.revision))
      throw Object.assign(new Error("La sala devolvió una reserva inválida."),{status:422});
    if(data.lease!=null&&(typeof data.lease!=="string"||!/^[a-f0-9]{32}$/.test(data.lease)))
      throw Object.assign(new Error("La reserva de sala es incompatible."),{status:422});
    const project=data.project===true;
    if(project&&!data.lease)throw mundoRoomError("El proyecto requiere una reserva de jugador.");
    const resumed=this.id!==null;
    if(resumed&&(this.id!==data.id||this.lease!==(data.lease??null)||data.ack<this.ack||
        (this.project!==project || (!project&&this.revision&&this.revision!==data.revision)))){
      // The reservation may have expired during transport loss. Release the fresh seat
      // and let its owner explicitly join again, without replaying an old car request.
      try{await this.leave();}catch{}
      throw Object.assign(new Error("La reserva anterior terminó. Vuelve a entrar para tomar un asiento."),{status:410});
    }
    if(this.unconfirmed&&data.ack>=this.unconfirmed.seq)this.unconfirmed=null;
    this.id=data.id;this.seq=this.ack=data.ack;this.lease=data.lease??null;
    const offered=Boolean(this.lease) && response.headers.get("x-mundo-actor")==="ines-bajamar-1";
    if(this.actorOffered && !offered)this.resetRoomActor();
    this.actorOffered=offered;
    this.actorReceiver?.setRoomOffer(offered);
    this.brumaOffered=Boolean(this.lease) && response.headers.get("x-mundo-car-art")==="bruma-1";
    if(!this.brumaOffered)this.clearRoomBruma();
    this.modelsOffered=Boolean(this.lease) && !project && response.headers.get("x-mundo-creator-models")==="mesh-1";
    this.project=project;
    if(project){this.waiting=true;return this.scene;}
    if(this.revision!==data.revision){
      let scene=await this.sectors(data.revision,null,data.name,turn);
      this.checkTurn(turn);
      if(!scene){
        const bytes=await this.readWorld(data.revision,null,turn);
        this.checkTurn(turn);
        const world=mundoDecodeRoom(bytes),cells=await this.readCells(world,data.revision,null,turn,bytes.byteLength);
        this.checkTurn(turn);
        this.soloResidence=cells?this.makeResidence(world,cells.roots,MundoGeometry.flatten(world)):null;
        scene={world,title:data.name,revision:data.revision,residence:this.soloResidence};
        await this.confirmFull(data.revision,null,turn,()=>generation===this.sectorGeneration);this.checkTurn(turn);
      }
      this.soloScene=scene;this.world=scene.world;this.revision=data.revision;
    }
    return this.soloScene;
  }
  async readCells(world,revision,route,turn,worldBytes){
    if(this.noCellsEndpoint || !window.MundoRoomResidence || document.hidden || !MundoZones.eligibleRoomBytes(worldBytes))return null;
    const key=route?this.committedWorldKey(route):null;
    const cached=key && this.cellCache.get(key);
    if(cached){
      try{return {roots:MundoZones.roomCells(cached,revision,world),bytes:cached};}
      catch{this.forgetCells(key);}
    }
    const body=route?{revision,epoch:route.epoch,lease:this.lease}:{revision};
    this.cellRequest?.abort();
    const request=this.cellRequest=new AbortController();
    const timer=setTimeout(()=>request.abort(),2000);
    try{
      const response=await this.call("cell-index",body,"loading",request.signal,true);
      this.checkTurn(turn);
      if(response.status===204 || request.signal.aborted)return null;
      const bytes=await mundoRoomBytes(response,48+16*65536);
      this.checkTurn(turn);
      return request.signal.aborted?null:{roots:MundoZones.roomCells(bytes,revision,world),bytes};
    }catch(error){
      this.checkTurn(turn);
      if([401,403,410,423].includes(error.status) || (route && error.status===412))throw error;
      if(error.status===404 || error.status===405)this.noCellsEndpoint=true;
      return null;
    }finally{
      clearTimeout(timer);if(this.cellRequest===request)this.cellRequest=null;
    }
  }
  makeResidence(world,cells,geometry,cars=null){
    try{return new MundoRoomResidence(world,cells,geometry,cars);}catch{return null;}
  }
  async routeInfo(body={}){
    const bytes=await mundoRoomBytes(await this.call("route",body),346);
    if(bytes.length<92 || String.fromCharCode(...bytes.subarray(0,4))!=="MWT1" ||
       String.fromCharCode(...bytes.subarray(45,49))!=="MWJ1" || bytes[49]!==this.id ||
       bytes[90]!==bytes.length-91 || bytes[4]>2 || mundoRoomHex(bytes.subarray(29,45))!==this.lease)
      throw mundoRoomError("El cambio de mundo no corresponde a esta reserva.");
    const view=new DataView(bytes.buffer),epoch=Number(view.getBigUint64(5,true)),world=Number(view.getBigUint64(13,true));
    const root=view.getBigUint64(21,true),ack=Number(view.getBigUint64(50,true));
    const title=new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(91));
    if(!Number.isSafeInteger(epoch)||epoch<1||!Number.isSafeInteger(world)||world<1||
       !Number.isSafeInteger(ack)||ack<this.ack||!title.trim()||/[\u0000-\u001f\u007f-\u009f]/u.test(title))
      throw mundoRoomError("El destino de la sala es inválido.");
    return {phase:bytes[4],epoch,world,root:root?String(root):null,ack,revision:mundoRoomHex(bytes.subarray(58,90)),title};
  }
  async prepareScene(route,turn,fullOnly=false,owner=null){
    this.checkTurn(turn);
    const generation=this.sectorGeneration,current=owner??(()=>generation===this.sectorGeneration);
    const key=this.committedWorldKey(route);
    const cached=this.projectCache.get(key);
    if(cached)this.onWorldReuse?.();
    if(!cached && !fullOnly){
      const sector=await this.sectors(route.revision,route,route.title,turn);
      this.checkTurn(turn);if(sector)return sector;
    }
    const bytes=cached??await this.readWorld(route.revision,route,turn,!fullOnly);
    this.checkTurn(turn);
    let world,result;
    try{world=mundoDecodeRoom(bytes);}catch(error){if(cached)this.forgetWorld(key);throw error;}
    try{
      const geometry=MundoGeometry.flatten(world);
      const available=MundoDriving.discover(geometry);
      const selected=route.root && available.find(car=>String(car.rootId)===route.root);
      if(route.root&&!selected)throw mundoRoomError("El turismo anunciado no existe en el destino.");
      const solid=selected?geometry.objects.filter(obj=>!selected.partIds.has(obj.n.id)):geometry.objects;
      const walker=new MundoWalk(solid,false);
      result={route,world,worldBytes:bytes.byteLength,title:route.title,geometry,walker,available,road:selected?walker:null};
      if(bytes.byteLength<=this.cacheLimit){
        // Reserve room before the prepared bytes wait for a vote. They become
        // reusable only once the server confirms this destination.
        if(!cached)this.reserveWorldBytes(bytes.byteLength);
        this.preparedBytes.set(result,{key,bytes});
      }
    }catch(error){
      if(cached)this.forgetWorld(key);
      if(error.status===422)throw error;
      throw mundoRoomError("No se pudo preparar la geometría del destino.");
    }
    await this.confirmFull(route.revision,route,turn,current);this.checkTurn(turn);
    return result;
  }
  async syncRoute(){
    const turn=++this.turn,generation=this.sectorGeneration;
    let route=await this.routeInfo();
    this.checkTurn(turn);
    this.alignEntry(route);
    if(this.route && route.epoch<this.route.epoch)throw mundoRoomError("La sala devolvió un viaje anterior.");
    if(this.partial && this.partial.key!==this.transferKey(route.revision,route))this.partial=null;
    if(route.phase===1){
      const ballot={epoch:route.epoch,lease:this.lease,vote:"ready"};
      if(this.staged?.route.epoch!==route.epoch || !mundoSameScene(this.staged?.route,route)){
        this.dropStore(this.staged?.sectors?.store);
        this.staged=null;
        try{
          const staged=await this.prepareScene(route,turn);
          this.checkTurn(turn);this.staged=staged;
        }
        catch(error){
          this.checkTurn(turn);
          if(!error.status || [401,403,408,410,412,423,429].includes(error.status) || error.status>=500)throw error;
          ballot.vote="failed";
        }
      }
      if(document.hidden)ballot.vote="failed";
      if(ballot.vote==="failed")this.dismissEntry();
      route=await this.routeInfo(ballot);
      this.checkTurn(turn);
      this.alignEntry(route);
      if(route.phase===1)return false;
    }
    if(this.route && route.epoch<this.route.epoch)throw mundoRoomError("La sala devolvió un viaje anterior.");
    if(route.phase===2 && this.route?.epoch!==route.epoch)this.clearCellCache();
    const same=mundoSameScene(this.route,route);
    if(!same || (this.scene?.sectors && this.route.epoch!==route.epoch)){
      const cached=this.staged;
      const matches=cached?.route.epoch===route.epoch && mundoSameScene(cached?.route,route);
      if(cached && !matches){this.preparedBytes.delete(cached);this.dropStore(cached.sectors?.store);}
      const next=matches?cached:await this.prepareScene(route,turn);
      this.checkTurn(turn);
      // Only this descriptor identifies a confirmed destination. The optional
      // directory never delays a ready vote or attaches to a rejected proposal.
      const cells=next.sectors?null:await this.readCells(next.world,route.revision,route,turn,next.worldBytes);
      this.checkTurn(turn);
      const residence=cells?this.makeResidence(next.world,cells.roots,next.geometry,next.available):null;
      if(residence){
        next.residence=residence;
        delete next.geometry;delete next.walker;delete next.road;delete next.available;
      }
      next.route=route;
      this.rememberCommittedWorld(next,route,residence?cells.bytes:null);
      this.dropStore(this.scene?.sectors?.store);
      if(same)this.replaceArea(this.scene,next);
      else this.scene=next;
    }else if(this.route.epoch!==route.epoch){
      this.dropStore(this.staged?.sectors?.store);
      await this.confirmFull(route.revision,route,turn,()=>generation===this.sectorGeneration);this.checkTurn(turn);
      this.scene.route=route;
    }
    this.route=route;this.staged=null;this.waiting=false;
    this.seq=this.ack=route.ack;this.unconfirmed=null;
    return true;
  }
  replaceArea(scene,next){
    // Keep the admission object stable so camera, occupants and the race are
    // continuous across swaps within the same world, including a cancelled portal.
    Object.assign(scene,{geometry:null,available:null,walker:null,road:null,residence:null,sectors:null},next);
    scene.areaRevision=(scene.areaRevision??0)+1;
    if(scene===this.soloScene)this.world=scene.world;
  }
  pauseSectors(){
    ++this.sectorGeneration;
    const job=this.sectorJob;this.sectorJob=null;
    if(job?.whole){++this.turn;this.download?.abort();}
    for(const store of this.sectorStores)this.dropStore(store);
    for(const scene of [this.scene,this.soloScene])if(scene?.sectors){
      scene.sectors.refresh=true;scene.sectors.store=null;
    }
    if(this.staged?.sectors)this.staged=null;
  }
  async fullArea(scene,turn,root,current){
    if(scene.route)return this.prepareScene(scene.route,turn,true,current);
    const bytes=await this.readWorld(scene.revision,null,turn,false);this.checkTurn(turn);
    const world=mundoDecodeRoom(bytes),geometry=MundoGeometry.flatten(world),available=MundoDriving.discover(geometry);
    const car=root && available.find(car=>String(car.rootId)===root);
    if(root && !car)throw mundoRoomError("El turismo no pertenece a la revisión completa.");
    const walker=new MundoWalk(car?geometry.objects.filter(o=>!car.partIds.has(o.n.id)):geometry.objects,false);
    await this.confirmFull(scene.revision,null,turn,current);this.checkTurn(turn);
    return {world,geometry,available,walker,road:car?walker:null,title:scene.title,revision:scene.revision};
  }
  sectorIsLocal(scene,self,state){
    if(!scene.sectors)return true;
    const {cx,cz,radius}=scene.sectors;
    const reach=(radius+.5)*64;
    const inside=(x,z,hx,hz)=>Math.abs(x-cx*64)+hx<=reach && Math.abs(z-cz*64)+hz<=reach;
    const aboard=state && (state.driver===self.id || state.passenger===self.id);
    if(!inside(self.position[0],self.position[2],.28,.28))return false;
    if(!aboard)return true;
    const car=scene.available.find(c=>String(c.rootId)===state.root);
    if(!car)return false;
    const c=Math.abs(Math.cos(state.yaw)),s=Math.abs(Math.sin(state.yaw)),w=car.width+.04,l=car.length+.04;
    return inside(state.x,state.z,Math.max(c*w+s*l,.28+c*car.width*.36),Math.max(s*w+c*l,.28+s*car.width*.36));
  }
  sectorSupports(scene,self,state){
    if(!this.sectorIsLocal(scene,self,state))return false;
    if(!scene.sectors)return true;
    const car=state && scene.available.find(c=>String(c.rootId)===state.root);
    if(state && !car)return false;
    if(car && !scene.road)scene.road=new MundoWalk(scene.geometry.objects.filter(o=>!car.partIds.has(o.n.id)),false);
    const ground=scene.road??scene.walker;
    const floor=(x,z,y,pad,tolerance)=>{
      for(const b of ground.region(x-pad,x+pad,z-pad,z+pad))
        if(x+pad>=b.min[0] && x-pad<=b.max[0] && z+pad>=b.min[2] && z-pad<=b.max[2] &&
           Math.abs(y-b.max[1])<=tolerance)return true;
      return false;
    };
    if(car && (state.driver===self.id || state.passenger===self.id))
      return car.contacts.every(([i,j])=>{
        const [wx,wz]=car.point(i,j,state.x,state.z,state.yaw);return floor(wx,wz,car.base,.001,.04);
      });
    const [x,y,z]=self.position;
    return !self.grounded || floor(x,z,y,.30,.35);
  }
  canSendSectorInput(scene){
    const job=this.sectorJob;
    if(!job || job.owner!==scene)return !scene?.sectors?.refresh;
    return job.playable && (!job.candidate || this.sectorSupports(job.candidate,job.self,job.state));
  }
  followSector(scene,self,state){
    let job=this.sectorJob;
    if(job?.owner===scene && job.done){
      this.sectorJob=null;
      if(job.error){
        if(scene.route && job.error.status===412){this.waiting=true;return false;}
        throw job.error;
      }
      if(!job.result.sectors)this.dropStore(scene.sectors?.store);
      else if(job.result.sectors.cx!==job.cx || job.result.sectors.cz!==job.cz)
        job.result.sectors.missed=[job.cx,job.cz];
      if(scene.route && !job.result.sectors)this.rememberCommittedWorld(job.result,scene.route,null);
      this.replaceArea(scene,job.result);
    }
    const sector=scene.sectors;
    if(!sector)return true;
    const aboard=state && (state.driver===self.id || state.passenger===self.id);
    const cx=MundoZones.cell(aboard?state.x:self.position[0]),cz=MundoZones.cell(aboard?state.z:self.position[2]);
    const centered=cx===sector.cx && cz===sector.cz;
    const playable=!sector.refresh && this.sectorSupports(scene,self,state);
    this.observeAhead(scene,self,state,centered,playable);
    if(this.sectorJob?.owner===scene){
      Object.assign(this.sectorJob,{self,state,playable});
      return this.canSendSectorInput(scene);
    }
    if(centered && playable)return true;
    const turn=this.turn;
    const missed=sector.missed?.[0]===cx && sector.missed?.[1]===cz;
    job={owner:scene,done:false,cx,cz,self,state,playable,whole:missed || (!sector.refresh && centered && !playable)};
    this.sectorJob=job;
    const current=()=>this.sectorJob===job && this.turn===turn;
    const load=async()=>{
      let next=null;
      if(!job.whole)next=await this.sectors(scene.revision??scene.route.revision,scene.route,scene.title,turn,sector.store,state?.root,
        candidate=>{if(current())job.candidate=candidate;});
      if(!current())return;
      if(!next){job.whole=true;job.candidate=null;this.dropStore(sector.store);next=await this.fullArea(scene,turn,state?.root,current);}
      if(current())job.result=next;
    };
    load().catch(error=>{if(current())job.error=error;}).finally(()=>{if(current())job.done=true;});
    return playable;
  }
  async meeting(body){
    if(this.project){
      if(this.waiting||!this.route)return "stale";
      body={...body,epoch:this.route.epoch};
    }
    const response=await this.call("meeting",body);
    if(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()!=="text/plain" || !response.body)
      throw new Error("Respuesta de encuentro incompatible.");
    const reader=response.body.getReader();
    let text="";
    try{
      for(;;){
        const {done,value}=await reader.read();
        if(done)return text;
        if(text.length+value.length>64 || value.some(b=>b<32||b>126)){
          await reader.cancel();throw new Error("Respuesta de encuentro inválida.");
        }
        text+=String.fromCharCode(...value);
      }
    }finally{reader.releaseLock();}
  }
  async step(mask,yaw,jump,brake=false,action=null,scene=null){
    const seq=this.unconfirmed?.seq??(this.seq+1);
    this.seq=seq;
    if(action&&!this.unconfirmed)this.unconfirmed={seq,action};
    const input={seq,mask,yaw:Math.atan2(Math.sin(yaw),Math.cos(yaw)),jump};
    if(brake)input.brake=true;
    if(this.unconfirmed)input.action=this.unconfirmed.action;
    if(this.project){input.epoch=this.route.epoch;input.lease=this.lease;}
    let response;
    try{response=await this.call("input",input,scene);}
    catch(error){
      if(!this.project||error.status!==412)throw error;
      this.waiting=true;this.unconfirmed=null;return null;
    }
    const snap=await mundoRoomJson(response);
    const players=snap?.players;
    if(!Number.isSafeInteger(snap?.ack)||snap.ack<seq||!Array.isArray(players)||players.length<1||players.length>2||
       !players.every(p=>p&&[0,1].includes(p.id)&&Array.isArray(p.position)&&p.position.length===3&&
         p.position.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e15)&&Number.isFinite(p.yaw)&&
         Math.abs(p.yaw)<=Math.PI+.000001&&Number.isFinite(p.vy)&&typeof p.grounded==="boolean")||
       new Set(players.map(p=>p.id)).size!==players.length||!players.some(p=>p.id===this.id))
      throw Object.assign(new Error("Respuesta de sala incompatible."),{status:422});
    snap.npcs=mundoRoomNpcs(snap.npcs);
    const car=snap.car;
    if(car!=null&&(typeof car.root!=="string"||!/^([1-9][0-9]{0,19})$/.test(car.root)||
       BigInt(car.root)>0xffffffffffffffffn||!["x","z","yaw","speed","steer","distance"].every(k=>Number.isFinite(car[k]))||
       Math.abs(car.x)>1e15||Math.abs(car.z)>1e15||Math.abs(car.distance)>1e15||Math.abs(car.yaw)>Math.PI+.000001||
       car.speed < -4.000001||car.speed>14.000001||Math.abs(car.steer)>.470001||
       !(car.driver===null||players.some(p=>p.id===car.driver))||
       !(car.passenger===null||(car.passenger!==car.driver&&players.some(p=>p.id===car.passenger)))))
      throw Object.assign(new Error("Estado de carro inválido."),{status:422});
    if(this.project && (car?.root??null)!==this.route.root)throw mundoRoomError("El turismo cambió de revisión.");
    const world=this.project?this.scene.world:this.world;
    const courseScene=(this.project?this.scene:this.soloScene)??world;
    const epoch=this.project?this.route.epoch:null;
    if(this.courseScene!==courseScene || this.courseEpoch!==epoch){
      this.courseScene=courseScene;this.courseEpoch=epoch;this.gates=null;this.lastCourse=null;
    }
    if(snap.course!=null && !this.gates){
      try{this.gates=MundoCircuit.scan(world);}catch{throw mundoRoomError("El mundo contiene puertas incompatibles.");}
    }
    if(snap.course!=null && !car)throw mundoRoomError("El circuito carece de un turismo compartido.");
    snap.course=mundoCircuitState(snap.course,this.gates??[],this.lastCourse);
    this.lastCourse=snap.course;
    this.seq=this.ack=snap.ack;this.unconfirmed=null;
    return snap;
  }
  async leave(){
    this.resetRoomActor();
    this.brumaOffered=false;this.clearRoomBruma();this.modelsOffered=false;
    this.cancelWorld();
    const turn=this.turn;
    try{
      await this.usageQueue?.flush();
      this.checkTurn(turn);await this.call("leave");
    }finally{if(this.turn===turn)this.resetSeat();}
  }
};

// The same Studio transforms are used for the observer, the driver and the map view.
window.MundoRoomCar=class {
  constructor(car,scene,state,preparedRoad=null){
    this.car=car;
    window.MundoBrumaLook?.bind(car);
    this.road=preparedRoad??new MundoWalk(scene.objects.filter(entry=>!car.partIds.has(entry.n.id)),false);
    // The on-foot camera sees the moving chassis at its current position.
    this.walkCamera=Object.create(MundoWalk.prototype);
    this.walkCamera.region=(left,right,back,front)=>{
      const boxes=this.road.region(left,right,back,front);
      for(const {entry} of car.parts){
        const p=entry.center,r=entry.extent;
        if(p[0]+r[0]<left||p[0]-r[0]>right||p[2]+r[2]<back||p[2]-r[2]>front)continue;
        boxes.add({min:p.map((v,i)=>v-r[i]),max:p.map((v,i)=>v+r[i])});
      }
      return boxes;
    };
    this.target=state;this.display={...state};this.moving=false;
    car.applyNetworkPose(state);
  }
  accept(state,snap=false){
    if(snap || Math.hypot(this.display.x-state.x,this.display.z-state.z)>5){
      this.display={...state};this.car.applyNetworkPose(state);this.moving=false;
    }else if(["x","z","speed","steer","distance","yaw"].some(k=>state[k]!==this.target[k])){
      this.moving=true;
    }
    this.target=state;
  }
  advance(dt){
    if(!this.moving||dt<=0)return;
    const d=this.display,t=this.target,factor=-Math.expm1(-24*dt);
    const yawDelta=Math.atan2(Math.sin(t.yaw-d.yaw),Math.cos(t.yaw-d.yaw));
    let error=Math.abs(yawDelta);
    for(const field of ["x","z","speed","steer","distance"]){
      const difference=t[field]-d[field];
      error=Math.max(error,Math.abs(difference));d[field]+=difference*factor;
    }
    d.yaw+=yawDelta*factor;d.driver=t.driver;
    if(error<.0001){this.display={...t};this.moving=false;}
    this.car.applyNetworkPose(this.display);
  }
};
