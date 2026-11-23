"use strict";

// A store belongs to one authorized destination. Only the active window and
// one candidate overlap. A cancelled request cannot replace the active window.
window.MundoSectorStore=(()=>{
  const header=80, rowSize=48, maxNodes=65536, cosThirtyDegrees=Math.sqrt(3)/2;
  function requireValue(ok,detail){
    if(!ok)throw mundoRoomError(detail||"La ventana de sectores de la sala es incompatible.");
  }
  function readPlan(bytes,revision,profile,aim=null){
    const radius=profile==="mobile"?1:2;
    const limits=aim?MundoZones.aheadLimits(profile):{rows:1+(2*radius+1)**2,bytes:(profile==="mobile"?4:8)*1024*1024};
    const maxCells=limits.rows,cap=limits.bytes;
    requireValue(bytes.length>=header+rowSize && bytes.length<=header+maxCells*rowSize);
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const count=v.getUint32(4,true),cx=v.getInt32(8,true),cz=v.getInt32(12,true);
    const fullBytes=v.getUint32(20,true),token=mundoRoomHex(bytes.subarray(56,72));
    requireValue(v.getUint32(0)===(aim?0x4d414831:0x4d535031) && count>=1 && count<=maxCells &&
      bytes.length===header+count*rowSize && v.getUint32(16,true)===radius &&
      fullBytes>=128*1024 && fullBytes<=mundoWorldLimit &&
      mundoRoomHex(bytes.subarray(24,56))===revision && bytes.subarray(72,80).every(n=>n===0));
    if(aim)requireValue(cx===aim.cx && cz===aim.cz &&
      Math.max(Math.abs(cx-aim.fromX),Math.abs(cz-aim.fromZ))===1 &&
      cx-aim.fromX===aim.axisX && cz-aim.fromZ===aim.axisZ);
    const rows=[],coords=new Set(),hashes=new Set();
    let nodes=0,size=0;
    for(let i=0;i<count;++i){
      const at=header+i*rowSize,x=v.getInt32(at,true),z=v.getInt32(at+4,true);
      const length=v.getUint32(at+8,true),n=v.getUint32(at+12,true);
      const local=!!aim || i>0,hash=mundoRoomHex(bytes.subarray(at+16,at+48)),key=local?x+","+z:"global";
      requireValue(!coords.has(key) && !hashes.has(hash) &&
        (local ? Math.abs(x-cx)<=radius && Math.abs(z-cz)<=radius && n>0 : x===0 && z===0));
      if(aim)requireValue(Math.max(Math.abs(x-aim.fromX),Math.abs(z-aim.fromZ))>radius);
      size+=length;nodes+=n;
      requireValue(length>=24+119*n && size<=cap && nodes<=maxNodes);
      rows.push({slot:i,key,x,z,length,nodes:n,hash});coords.add(key);hashes.add(hash);
    }
    requireValue(nodes>0 && nodes<=Math.floor((fullBytes-24)/119));
    return {cx,cz,radius,token,fullBytes,rows};
  }
  function sameAim(a,b){
    return !!a && !!b && a.fromX===b.fromX && a.fromZ===b.fromZ && a.cx===b.cx && a.cz===b.cz;
  }
  function stageAt(ahead,cx,cz){
    const aim=ahead.aim;
    if(cx===aim.cx && cz===aim.cz)return "final";
    if(!ahead.meters.size)return null;
    const mid=MundoZones.diagonalVia(aim,cx,cz);
    return ahead.intermediate && mid!==ahead.intermediate?null:mid;
  }
  function sameMotion(ahead,state,role){
    return !!state && ahead.root===state.root && ahead.role===role && Math.sign(state.speed)===ahead.sign &&
      Math.abs(state.speed)>=2 && Math.cos(state.yaw-ahead.heading)>=cosThirtyDegrees;
  }
  async function sectorFile(row,token,path,context,fetchBytes){
    const file=new Uint8Array(row.length);
    for(let offset=0;offset<file.length;){
      const body={...context,token,slot:row.slot,offset};
      const frame=await fetchBytes(path,body,16+Math.min(mundoPartSize,file.length-offset),8000);
      if(!frame)return null;
      mundoWorldPart(frame,offset,file.length);
      file.set(frame.subarray(16),offset);offset+=frame.length-16;
    }
    const hash=mundoRoomHex(new Uint8Array(await crypto.subtle.digest("SHA-256",file)));
    requireValue(hash===row.hash,"La huella de un sector no coincide con la publicación.");
    return file;
  }
  function sectorReader(call,request,guard){
    return async(path,body,limit,ms)=>{
      guard();
      const timer=setTimeout(()=>request.abort(),ms);
      try{
        const response=await call(path,body,request.signal);guard();
        if(response.status===204)return null;
        requireValue(response.status===200);
        const bytes=await mundoRoomBytes(response,limit);guard();
        return bytes;
      }finally{clearTimeout(timer);}
    };
  }

  function validateLocal(world,row){
    if(row.slot===0)return;
    const {byId}=MundoGeometry.flatten(world);
    const drawableRoots=new Set(),owner=new Map();
    for(const node of world.nodes.values()){
      requireValue(node.name!=="Chasis" && (node.parent!==0n ||
        (!node.name.startsWith(MundoCircuit.prefix) && !node.name.startsWith(MundoProject.tilePrefix))));
      if(!node.shape && !node.visual)continue;
      const piece=byId.get(node.id);
      requireValue(piece && [0,2].every(axis=>{
        const center=piece.center[axis],extent=piece.extent[axis],target=axis===0?row.x:row.z;
        return MundoZones.cell(center-extent)===target && MundoZones.cell(center+extent)===target;
      }),"Una pieza queda fuera de su sector publicado.");
      let parent=node;
      const path=[];
      while(parent.parent && !owner.has(parent.id)){path.push(parent.id);parent=world.nodes.get(parent.parent);}
      const root=owner.get(parent.id)??parent.id;
      for(const id of path)owner.set(id,root);
      drawableRoots.add(root);
    }
    for(const n of world.nodes.values())if(n.parent===0n)requireValue(drawableRoots.has(n.id));
  }

  return class MundoSectorStore{
    constructor(revision,profile,report=null){
      requireValue(/^[0-9a-f]{64}$/.test(revision) && ["pc","mobile"].includes(profile));
      this.revision=revision;this.profile=profile;
      this.report=report;this.assembling=null;this.pendingInstall=null;
      this.active=new Map();this.activeToken=null;this.activeInfo=null;this.candidate=null;this.request=null;this.ahead=null;this.nextAheadAt=0;
    }
    record(meter,reason){
      if(meter.done)return;
      if(reason!=="active")meter.done=true;
      this.report?.({token:meter.token,verified:meter.verified,used:meter.used,reason,
        ...(meter.via?{via:meter.via,middle:meter.middle}:{})});
    }
    settle(usage){
      const ahead=usage?.ahead;
      if(!ahead?.closed || this.assembling?.ahead===ahead || this.candidate?.usage?.ahead===ahead ||
          this.pendingInstall?.usage?.ahead===ahead)return;
      for(const [meter,reason] of ahead.closed)this.record(meter,reason);
    }
    installed(token){
      if(!this.pendingInstall || this.pendingInstall.token!==token)return;
      const usage=this.pendingInstall.usage;this.pendingInstall=null;
      if(!usage)return;
      const final=usage.stage==="final";
      for(const meter of usage.ahead.meters.values()){
        const used=usage.borrowed.get(meter.token)??0;
        meter.used|=used;
        if(!final){meter.via=usage.stage;meter.middle|=used;}
        this.record(meter,final?"crossed":"active");
      }
      if(final && usage.ahead===this.ahead)this.stopAhead(false,"crossed");
      this.settle(usage);
    }
    clear(reason="released"){
      this.stopAhead(false,reason);this.activeInfo=null;
      const abandoned=[this.pendingInstall?.usage,this.candidate?.usage,this.assembling];
      this.pendingInstall=null;this.candidate=null;this.assembling=null;
      for(const usage of abandoned)this.settle(usage);
      this.request?.abort();this.request=null;this.active.clear();this.activeToken=null;
    }
    commit(plan){
      // A late ready reply from an older request must not install another window.
      if(this.candidate?.plan!==plan){
        requireValue(this.activeToken===plan.token,"La ventana de juego ya cambió.");
        return;
      }
      const replaced=this.pendingInstall?.usage;
      this.pendingInstall={token:plan.token,usage:this.candidate.usage};
      this.active=this.candidate.parts;this.activeToken=plan.token;this.candidate=null;
      this.settle(replaced);
      // Active ordinary parts now own these decoded objects. A failed ready
      // leaves the original raw cache intact for the next ordinary plan.
      if(this.ahead)for(const part of this.active.values())this.ahead.files.delete(part.hash);
      this.activeInfo={cx:plan.cx,cz:plan.cz,fullBytes:plan.fullBytes};
    }
    stopAhead(keepVerified=false,reason="changed",state=null,role=null){
      if(!this.ahead)return;
      this.ahead.request?.abort();this.ahead.request=null;
      if(!keepVerified){
        const ahead=this.ahead;
        const sameRide=state && state.root===ahead.root && role===ahead.role &&
          Number.isFinite(state.yaw) && Number.isFinite(state.speed) && Math.abs(state.speed)>=2;
        ahead.closed=new Map();
        for(const meter of ahead.meters.values()){
          // Each retry can issue its own grant after a small change of heading.
          const turned=sameRide && (Math.sign(state.speed)!==meter.sign ||
            Math.cos(state.yaw-meter.heading)<cosThirtyDegrees);
          ahead.closed.set(meter,turned?"turned":reason);
        }
        // Raw speculative bytes can go immediately. A concurrently accepted
        // MSP1 can still be installed on this very snapshot before the UI closes.
        ahead.files.clear();this.ahead=null;this.settle({ahead});
      }
    }
    approaching(state,role,cx,cz){
      const ahead=this.ahead;
      if(!ahead)return;
      // Crossing the predicted boundary can move the next prediction beyond this
      // square. Check heading at the last observation in the old cell instead.
      const continuing=sameMotion(ahead,state,role) && cx===ahead.aim.cx && cz===ahead.aim.cz &&
        sameAim(ahead.aim,MundoZones.aheadWindow(ahead.x,ahead.z,state.yaw,state.speed));
      this.stopAhead(!!continuing,"changed",state,role);
    }
    followDiagonal(state,role,cx,cz,predicted,demand){
      const ahead=this.ahead;
      if(!ahead?.meters.size || !ahead.aim.axisX || !ahead.aim.axisZ)return false;
      const aim=ahead.aim,atStart=cx===aim.fromX && cz===aim.fromZ,stage=stageAt(ahead,cx,cz);
      if(sameMotion(ahead,state,role)){
        if(atStart && !ahead.intermediate && sameAim(aim,predicted))return ahead.frozen===true;
        const next=predicted && stageAt(ahead,predicted.cx,predicted.cz);
        // As the car nears a corner, the prediction can narrow to the first
        // axis. Stop speculative I/O but keep its verified files for the MSP1.
        const firstLeg=atStart && !ahead.intermediate && (next==="x" || next==="z");
        const secondLeg=(stage==="x" || stage==="z") && (demand || next==="final");
        if(firstLeg || secondLeg || stage==="final"){
          ahead.frozen=true;
          if(secondLeg)ahead.intermediate=stage;
          this.stopAhead(true);return true;
        }
      }
      this.stopAhead(false,"changed",state,role);return false;
    }
    async prefetch(call,context,aim,state,role,current){
      if(!aim || this.request || this.candidate || !this.activeInfo ||
          aim.fromX!==this.activeInfo.cx || aim.fromZ!==this.activeInfo.cz){this.stopAhead(false,"changed",state,role);return;}
      requireValue(context.revision===this.revision && context.profile===this.profile);
      const now=performance.now();
      let ahead=this.ahead;
      if(sameAim(ahead?.aim,aim) && sameMotion(ahead,state,role)){
        ahead.x=state.x;ahead.z=state.z;
        if(ahead.request || !ahead.retryAt || now<ahead.retryAt || ahead.attempts>=2)return;
      }else{
        this.stopAhead(false,"changed",state,role);
        if(now<this.nextAheadAt)return;
        ahead={aim,root:state.root,x:state.x,z:state.z,heading:state.yaw,sign:Math.sign(state.speed),
          role,files:new Map(),meters:new Map(),request:null,attempts:0,retryAt:0};
        this.ahead=ahead;
      }
      this.nextAheadAt=now+750;
      const request=ahead.request=new AbortController();
      ahead.attempts++;ahead.retryAt=0;
      const defer=()=>{
        if(!request.signal.aborted && this.ahead===ahead && ahead.attempts<2)ahead.retryAt=performance.now()+750;
      };
      const guard=()=>{
        if(this.ahead!==ahead || request.signal.aborted || this.request || !current())
          throw new DOMException("Se canceló la anticipación.","AbortError");
      };
      const fetchBytes=sectorReader(call,request,guard);
      const timeout=setTimeout(()=>request.abort(),8000);
      try{
        const limit=MundoZones.aheadLimits(this.profile);
        const packet=await fetchBytes("sector-ahead",context,header+limit.rows*rowSize,2000);
        if(!packet){defer();return;}
        const plan=readPlan(packet,this.revision,this.profile,aim);
        requireValue(plan.fullBytes===this.activeInfo.fullBytes);
        let meter=ahead.meters.get(plan.token);
        if(!meter){
          meter={token:plan.token,verified:0,used:0,middle:0,via:null,done:false,
            heading:state.yaw,sign:Math.sign(state.speed)};
          ahead.meters.set(plan.token,meter);this.record(meter,"active");
        }
        for(const [hash,cached] of ahead.files){
          if(!plan.rows.some(r=>r.hash===hash && r.key===cached.key && r.nodes===cached.nodes && r.length===cached.bytes.length))
            ahead.files.delete(hash);
        }
        for(const row of plan.rows){
          if(ahead.files.has(row.hash))continue;
          const bytes=await sectorFile(row,plan.token,"sector-ahead-part",context,fetchBytes);guard();
          if(!bytes){defer();return;}
          // Keep the receipt of the request that actually supplied these bytes.
          const bit=1<<row.slot;
          ahead.files.set(row.hash,{key:row.key,nodes:row.nodes,bytes,meter,bit});
          meter.verified|=bit;this.record(meter,"active");
        }
      }catch(error){
        if(!request.signal.aborted && this.ahead===ahead){
          if([401,403,409,410,412,422].includes(error.status))ahead.files.clear();
          if([408,429,503].includes(error.status) || !error.status)defer();
        }
        throw error;
      }finally{
        clearTimeout(timeout);
        if(ahead.request===request)ahead.request=null;
      }
    }
    async prepare(call,context,current=()=>true){
      requireValue(context.revision===this.revision && context.profile===this.profile);
      this.stopAhead(true);
      const abandoned=[this.assembling,this.candidate?.usage];
      this.request?.abort();this.candidate=null;this.assembling=null;
      for(const usage of abandoned)this.settle(usage);
      const request=this.request=new AbortController();
      const guard=()=>{
        if(request.signal.aborted || this.request!==request || !current())
          throw new DOMException("La descarga de sectores se canceló.","AbortError");
      };
      const timeout=setTimeout(()=>request.abort(),24000);
      const fetchBytes=sectorReader(call,request,guard);
      try{
        let packet;
        try{packet=await fetchBytes("sector-plan",context,header+26*rowSize,4500);}
        catch(error){if([404,405].includes(error.status))return null;throw error;}
        if(!packet)return null;
        const plan=readPlan(packet,this.revision,this.profile),parts=new Map(),nodes=new Map();
        if(this.activeInfo)requireValue(plan.fullBytes===this.activeInfo.fullBytes);
        const stage=this.ahead && stageAt(this.ahead,plan.cx,plan.cz);
        if(!stage)this.stopAhead();
        const usage=this.ahead?.meters.size?{ahead:this.ahead,stage,borrowed:new Map()}:null;
        this.assembling=usage;
        if(usage && stage!=="final")usage.ahead.intermediate=stage;
        let next;
        for(const row of plan.rows){
          const retained=this.active.get(row.key);
          if(retained)requireValue(retained.hash===row.hash && retained.length===row.length &&
            retained.world.nodes.size===row.nodes,"La misma revisión cambió el contenido de un sector.");
          let part=retained;
          if(!part){
            const cached=this.ahead?.files.get(row.hash);
            const usable=row.slot>0 && cached?.key===row.key && cached.nodes===row.nodes && cached.bytes.length===row.length;
            const file=usable?cached.bytes:await sectorFile(row,plan.token,"sector-part",context,fetchBytes);
            guard();if(!file)return null;
            const world=mundoDecodeRoom(file);
            requireValue(world.nodes.size===row.nodes);
            validateLocal(world,row);
            part={world,hash:row.hash,length:row.length};
            if(usable)part.origin={meter:cached.meter,bit:cached.bit};
          }
          // If an accepted intermediate was superseded before it was displayed,
          // only its genuinely prefetched parts carry credit into the final.
          const origin=part.origin;
          if(origin && usage?.ahead.meters.get(origin.meter.token)===origin.meter){
            const token=origin.meter.token;
            usage.borrowed.set(token,(usage.borrowed.get(token)??0)|origin.bit);
          }
          parts.set(row.key,part);
          if(next===undefined)next=part.world.next;
          requireValue(next===part.world.next);
          for(const [id,node] of part.world.nodes){
            requireValue(!nodes.has(id),"La ventana contiene un identificador repetido.");
            nodes.set(id,node);
          }
        }
        guard();
        // The full publication and native clients visit authored IDs in ascending order.
        // Sorting here keeps roles and the first solid independent of network slot order.
        const ordered=new Map([...nodes].sort(([a],[b])=>a<b?-1:a>b?1:0));
        plan.world=MundoWorld.validate({nodes:ordered,next});
        plan.geometry=MundoGeometry.flatten(plan.world);
        // Physics and the first course snapshot rely on the permanent terrain.
        const anchor=plan.geometry.objects.find(o=>o.n.shape);
        requireValue(anchor && parts.get("global").world.nodes.has(anchor.n.id),
          "No hay terreno de llegada en el conjunto preparado.");
        plan.available=MundoDriving.discover(plan.geometry);
        this.candidate={plan,parts,usage};this.assembling=null;
        return plan;
      }finally{
        clearTimeout(timeout);
        if(this.request===request){
          this.request=null;
          const discarded=this.assembling;this.assembling=null;
          if(!this.candidate)this.stopAhead();
          this.settle(discarded);
        }
      }
    }
  };
})();
