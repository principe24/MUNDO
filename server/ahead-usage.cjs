"use strict";

const limit=256;
// If receipts arrive out of order, a completed transition takes precedence even
// if none of the offered files were used. Terminal observations never reopen.
const priority=Object.freeze({unreported:0,active:1,changed:2,released:3,turned:4,crossed:5});

function fail(status,message){throw Object.assign(new Error(message),{status});}
function maskBytes(sizes,mask){
  let bytes=0;
  for(let i=0;i<sizes.length;++i)if(mask & (1<<i))bytes+=sizes[i];
  return bytes;
}
function windowMask(grant,cx,cz){
  let mask=0;
  grant.rows.forEach((row,slot)=>{
    if(Math.abs(row.x-cx)<=grant.radius && Math.abs(row.z-cz)<=grant.radius)mask|=1<<slot;
  });
  return mask;
}
function increment(value,amount){return Math.min(Number.MAX_SAFE_INTEGER,value+amount);}

// Each room owns one journal. Entries keep scalar metadata, offered lengths
// and bounded page identifiers; they do not hold players, scenes or assets.
class AheadUsage{
  constructor(){
    this.entries=new Map();
    this.owners=new WeakMap();
    this.totalOffers=0;
  }
  owner(player,create){
    let owner=this.owners.get(player);
    if(owner && owner.lease===player.lease)return owner.id;
    if(!create)return null;
    owner={lease:player.lease,id:Symbol()};
    this.owners.set(player,owner);
    return owner.id;
  }
  offer(seat,player,msg,guard,grant,requiredBytes,following){
    if(this.entries.has(grant.token))return;
    const sizes=grant.rows.map(row=>row.bytes);
    const root=guard.root;
    const carRoot=typeof root==="string" && /^[1-9][0-9]{0,19}$/.test(root) && BigInt(root)<=0xffffffffffffffffn?root:null;
    const {fromX,fromZ}=guard.window,{cx,cz}=grant;
    const diagonal=Math.abs(cx-fromX)===1 && Math.abs(cz-fromZ)===1;
    const eligible=diagonal?{x:windowMask(grant,cx,fromZ),z:windowMask(grant,fromX,cz)}:null;
    const record={ordinal:++this.totalOffers,seat:seat.id+1,revision:msg.revision,epoch:msg.epoch??0,
      profile:msg.profile,fromX,fromZ,cx,cz,carRoot,
      requiredBytes,plannedBytes:sizes.reduce((sum,n)=>sum+n,0),servedBytes:0,uniqueServedBytes:0,interruptedPages:0,
      state:"unreported",owner:this.owner(player,true),sizes,verified:0,middle:0,final:0,via:null,
      following:diagonal?following:null,eligible,pages:new Set()};
    if(this.entries.size===limit)this.entries.delete(this.entries.keys().next().value);
    this.entries.set(grant.token,record);
  }
  terminal(token){
    const record=this.entries.get(token);
    return Boolean(record && priority[record.state]>priority.active);
  }
  page(token,slot,offset,bytes,finished){
    const r=this.entries.get(token);
    if(!r)return;
    if(!finished){r.interruptedPages=increment(r.interruptedPages,1);return;}
    r.servedBytes=increment(r.servedBytes,bytes);
    const key=slot+"/"+offset;
    if(!r.pages.has(key)){r.pages.add(key);r.uniqueServedBytes+=bytes;}
  }
  report(seat,player,msg){
    if(!player || seat.player!==player || (msg.lease!==undefined && msg.lease!==player.lease))
      fail(410,"La reserva del jugador ha caducado.");
    const r=this.entries.get(msg.token);
    if(!r || r.owner!==this.owner(player,false) || r.seat!==seat.id+1 || r.profile!==msg.profile ||
       r.revision!==msg.revision || r.epoch!==(msg.epoch??0))fail(409,"La oferta ya no corresponde a esta plaza.");
    const offered=(1<<r.sizes.length)-1;
    if((msg.verified & ~offered)!==0)fail(400,"El informe contiene sectores ajenos a la oferta.");
    // A v1 receipt assigns all reuse to the final window. Overlapping receipts
    // may add evidence but can never attribute the same slot to two installs.
    const middle=msg.middle??0,final=msg.used & ~middle;
    if(msg.via!==undefined){
      if(!r.eligible || (middle & ~r.eligible[msg.via])!==0)
        fail(400,"Hay sectores fuera de la ventana intermedia de esta oferta.");
      const viaX=msg.via==="x";
      if((r.via!==null && r.via!==msg.via) || r.following.cx!==(viaX?r.cx:r.fromX) ||
         r.following.cz!==(viaX?r.fromZ:r.cz))
        fail(409,"La sala no confirmó esa ventana intermedia para esta oferta.");
    }
    if((r.middle & final)!==0 || (r.final & middle)!==0)
      fail(409,"El sector ya se atribuyó a otra etapa.");
    if(msg.via!==undefined)r.via=msg.via;
    r.verified|=msg.verified;
    r.middle|=middle;
    r.final|=final;
    if(priority[msg.reason]>priority[r.state])r.state=msg.reason;
  }
  summary(){
    let unreported=0,active=0;
    for(const r of this.entries.values()){
      if(r.state==="unreported")++unreported;
      else if(r.state==="active")++active;
    }
    const retainedOffers=this.entries.size;
    return {totalOffers:this.totalOffers,retainedOffers,omittedOffers:this.totalOffers-retainedOffers,
      unreported,active,closed:retainedOffers-unreported-active};
  }
  snapshot(){
    const entries=[];
    for(const r of this.entries.values()){
      const reported=r.state!=="unreported";
      const verified=reported?maskBytes(r.sizes,r.verified):null;
      const middleBytes=reported?maskBytes(r.sizes,r.middle):null,finalBytes=reported?maskBytes(r.sizes,r.final):null;
      const used=reported?middleBytes+finalBytes:null;
      entries.push({ordinal:r.ordinal,seat:r.seat,revision:r.revision,epoch:r.epoch,profile:r.profile,
        fromX:r.fromX,fromZ:r.fromZ,cx:r.cx,cz:r.cz,carRoot:r.carRoot,plannedBytes:r.plannedBytes,
        requiredBytes:r.requiredBytes,servedBytes:r.servedBytes,uniqueServedBytes:r.uniqueServedBytes,
        interruptedPages:r.interruptedPages,verifiedBytes:verified,usedBytes:used,via:r.via,middleBytes,finalBytes,
        discardedBytes:reported && r.state!=="active"?verified-used:null,state:r.state});
    }
    return {format:"MUNDO-ahead-usage",version:2,limit,totalOffers:this.totalOffers,
      omittedOffers:this.totalOffers-entries.length,entries};
  }
}
module.exports={AheadUsage};
