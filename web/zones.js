"use strict";
// Local random-access container. Each directory entry owns one complete .mworld payload.
window.MundoZones=(()=>{
  const magic="MZONES01", header=20,row=16,width=64,maxBytes=32*1024*1024;
  const entryRadii={mobile:1,pc:2};
  const previewLimits={mobile:4*1024*1024,pc:8*1024*1024};
  function eligibleRoomBytes(size){
    return Number.isSafeInteger(size) && size>=128*1024 && size<=24*1024*1024;
  }
  const cell=n=>Math.floor(n/width+.5);
  // A fresh stationary viewpoint uses the same border strip as the player.
  // A previous center applies the eight-metre hysteresis during travel.
  function roomWindow(x,z,radius,previous=null,compact=false){
    const center=(n,old)=>old!==undefined && Math.abs(n-old*width)<=width/2+8 ? old : cell(n);
    const cx=center(x,previous?.x),cz=center(z,previous?.z);
    const fringe=(n,c)=>compact?0:n-c*width>=width/2-12?1:n-c*width<=12-width/2?-1:0;
    const dx=fringe(x,cx),dz=fringe(z,cz);
    return {x:cx,z:cz,left:cx-radius+Math.min(dx,0),right:cx+radius+Math.max(dx,0),
      back:cz-radius+Math.min(dz,0),front:cz+radius+Math.max(dz,0)};
  }
  const aheadBudgets=Object.freeze({
    mobile:Object.freeze({bytes:512*1024,rows:5}),
    pc:Object.freeze({bytes:2*1024*1024,rows:9})
  });
  function aheadLimits(profile){return Object.hasOwn(aheadBudgets,profile)?aheadBudgets[profile]:null;}
  const validCell=n=>Number.isInteger(n) && n>=-2147483648 && n<=2147483647;

  // Intersect the velocity ray with the *next* boundary of the current cell.
  // A signed speed makes the same policy work when the driver reverses.
  function aheadWindow(x,z,yaw,speed){
    if(![x,z,yaw,speed].every(Number.isFinite) || Math.abs(speed)<2)return null;
    const fromX=cell(x),fromZ=cell(z);
    if(!validCell(fromX) || !validCell(fromZ))return null;
    const vx=Math.sin(yaw)*speed,vz=-Math.cos(yaw)*speed;
    function crossing(pos,center,v){
      if(Math.abs(v)<1e-6)return Infinity;
      return Math.max(0,(center*width+Math.sign(v)*width/2-pos)/v);
    }
    const tx=crossing(x,fromX,vx),tz=crossing(z,fromZ,vz),first=Math.min(tx,tz);
    if(first>2.5)return null;
    const axisX=tx<=2.5 && tx-first<=.30?Math.sign(vx):0;
    const axisZ=tz<=2.5 && tz-first<=.30?Math.sign(vz):0;
    const cx=fromX+axisX,cz=fromZ+axisZ;
    return validCell(cx) && validCell(cz)?{fromX,fromZ,cx,cz,axisX,axisZ}:null;
  }

  // Only consider the entering edge(s). Never request the permanently resident
  // document, already covered cells, or a coordinate supplied by a remote player.
  function aheadRows(profile,window,lookup){
    const limit=aheadLimits(profile);
    if(!limit || !window)return [];
    const {fromX,fromZ,cx,cz,axisX,axisZ}=window;
    const radius=entryRadii[profile],candidates=[];
    for(let dx=-radius;dx<=radius;++dx){
      for(let dz=-radius;dz<=radius;++dz){
        const x=cx+dx,z=cz+dz;
        if(!validCell(x) || !validCell(z) ||
           (Math.abs(x-fromX)<=radius && Math.abs(z-fromZ)<=radius))continue;
        const row=lookup(x,z);
        if(row && Number.isSafeInteger(row.bytes) && row.bytes>=24 && row.bytes<=limit.bytes)
          candidates.push(row);
      }
    }
    const lateral=r=>Math.abs((r.x-cx)*axisZ-(r.z-cz)*axisX);
    const distance=r=>(r.x-cx)**2+(r.z-cz)**2;
    candidates.sort((a,b)=>Number(Boolean(b.road))-Number(Boolean(a.road)) ||
      lateral(a)-lateral(b) || distance(a)-distance(b) || a.x-b.x || a.z-b.z);
    const selected=[];
    let remaining=limit.bytes;
    for(const row of candidates){
      if(selected.length>=limit.rows)break;
      if(row.bytes<=remaining){selected.push(row);remaining-=row.bytes;}
    }
    return selected;
  }
  // The two orthogonal neighbours of a one-cell diagonal are its only intermediate stops.
  function diagonalVia(aim,x,z){
    if(!aim || ![aim.fromX,aim.fromZ,aim.cx,aim.cz,x,z].every(validCell) ||
       Math.abs(aim.cx-aim.fromX)!==1 || Math.abs(aim.cz-aim.fromZ)!==1)return null;
    if(x===aim.cx && z===aim.fromZ)return "x";
    if(x===aim.fromX && z===aim.cz)return "z";
    return null;
  }

  // Attribute each offered row to its earliest possible window, keeping manifest order.
  function aheadStages(profile,aim,rows,via){
    const limit=aheadLimits(profile);
    if(!limit || !aim || !Array.isArray(rows) || rows.length>limit.rows || (via!=="x" && via!=="z"))return null;
    const x=via==="x"?aim.cx:aim.fromX,z=via==="x"?aim.fromZ:aim.cz;
    if(diagonalVia(aim,x,z)!==via)return null;
    const radius=entryRadii[profile],seen=new Set();
    const stages={via,x,z,middleRows:[],finalRows:[],middleBytes:0,finalBytes:0};
    for(const row of rows){
      if(!row || !validCell(row.x) || !validCell(row.z) || !Number.isSafeInteger(row.bytes) || row.bytes<24 ||
         Math.max(Math.abs(row.x-aim.cx),Math.abs(row.z-aim.cz))>radius ||
         Math.max(Math.abs(row.x-aim.fromX),Math.abs(row.z-aim.fromZ))<=radius)return null;
      const id=key(row.x,row.z);
      if(seen.has(id))return null;
      seen.add(id);
      if(Math.max(Math.abs(row.x-x),Math.abs(row.z-z))<=radius){
        stages.middleRows.push(row);stages.middleBytes+=row.bytes;
      }else{
        stages.finalRows.push(row);stages.finalBytes+=row.bytes;
      }
      if(stages.middleBytes+stages.finalBytes>limit.bytes)return null;
    }
    return stages;
  }
  const key=(x,z)=>x+","+z;
  function requireValue(ok){if(!ok)throw new Error("El paquete de zonas contiene datos incompatibles.");}
  function bounds(entry){
    return [cell(entry.center[0]-entry.extent[0]),cell(entry.center[2]-entry.extent[2]),
            cell(entry.center[0]+entry.extent[0]),cell(entry.center[2]+entry.extent[2])];
  }
  function partition(world,room=null){
    const version=MundoWorld.validatedVersion(world);
    const geometry=MundoGeometry.flatten(world),groups=new Map(),children=new Map();
    for(const node of world.nodes.values()){
      if(!children.has(node.parent))children.set(node.parent,[]);
      children.get(node.parent).push(node);
    }
    const permanent={x:0,z:0,world:{nodes:new Map(),next:world.next}};
    const anchor=geometry.objects.find(o=>o.n.shape)?.n.id;
    let roomAnchor,roadIds;
    if(room){
      // A historical file may order roots differently from Studio. Use its actual
      // first supporting solid after removing the selected car from collisions.
      const source=room.original===world?geometry:MundoGeometry.flatten(room.original);
      const car=MundoDriving.roomCar(source,room.vehicleRoot);
      roomAnchor=source.objects.find(o=>o.n.shape && !car?.partIds.has(o.n.id))?.n.id;
      if(room.buildGroups && car){
        // A top face on the wheel contact plane is a possible support. The
        // driving simulation still checks all four contacts and obstructions.
        roadIds=new Set(source.objects.filter(o=>o.n.shape && !car.partIds.has(o.n.id) &&
          Math.abs(o.center[1]+o.extent[1]-car.base)<=.035).map(o=>o.n.id));
      }
    }
    let floor=Infinity;
    for(const root of children.get(0n)||[]){
      const nodes=[],stack=[root];let zone=null;
      let fixed=Boolean(room && (root.name.startsWith(MundoCircuit.prefix) || root.name.startsWith(MundoProject.tilePrefix)));
      while(stack.length){
        if(room && !room.buildGroups && fixed)break;
        const node=stack.pop();
        if(!room || room.buildGroups)nodes.push(node);
        for(const child of children.get(node.id)||[])stack.push(child);
        if(node.id===anchor||node.id===roomAnchor||node.name==="Chasis")fixed=true;
        if(!node.shape&&!node.visual)continue;
        const e=geometry.byId.get(node.id);
        if(!e){fixed=true;continue;}
        if(node.shape)floor=Math.min(floor,e.center[1]-e.extent[1]);
        const [x,z,x1,z1]=bounds(e);
        if(x!==x1||z!==z1||Math.abs(x)>2147483647||Math.abs(z)>2147483647||
           (zone&&(zone.x!==x||zone.z!==z)))fixed=true;
        zone={x,z};
      }
      if(room && !room.buildGroups){
        if(!fixed && zone)room.rows.push([root.id,zone.x,zone.z]);
        continue;
      }
      let bucket=permanent;
      if(!fixed&&zone){
        const k=key(zone.x,zone.z);
        if(!groups.has(k)){
          if(room?.buildGroups && groups.size>=4096)return null;
          groups.set(k,{...zone,world:{nodes:new Map(),next:world.next}});
        }
        bucket=groups.get(k);
      }
      for(const n of nodes){
        bucket.world.nodes.set(n.id,n);
        if(roadIds?.has(n.id))bucket.road=true;
      }
    }
    return {all:[permanent,...groups.values()],floor,objects:geometry.objects,version};
  }
  function pack(world){
    const {all,floor}=partition(world);
    const index=new Uint8Array(header+row*all.length),v=new DataView(index.buffer);
    index.set(new TextEncoder().encode(magic));v.setUint32(8,all.length,true);
    v.setFloat64(12,Number.isFinite(floor)?floor:0,true);
    const chunks=[index];
    all.forEach((group,i)=>{
      const bytes=MundoWorld.encode(group.world),at=header+row*i;
      v.setInt32(at,group.x,true);v.setInt32(at+4,group.z,true);
      v.setUint32(at+8,bytes.byteLength,true);v.setUint32(at+12,group.world.nodes.size,true);chunks.push(bytes);
    });
    return new Blob(chunks,{type:"application/vnd.mundo.zones"});
  }
  function initialSlot(slot,x,z,centerX,centerZ,radius){
    return slot===0 || Math.max(Math.abs(x-centerX),Math.abs(z-centerZ))<=radius;
  }
  // Build the same whole subtrees that Studio assigns to the entry cells.
  // Keep authored IDs: this is an independent MWENGIE document, not a set
  // of renderer handles from a previous world.
  function entryWorld(world,profile,focus,budget,sourceVersion){
    requireValue((profile==="mobile" || profile==="pc") && Array.isArray(focus) &&
      focus.length===2 && focus.every(Number.isFinite) && Number.isSafeInteger(budget) && budget>=24);
    const radius=entryRadii[profile], cx=cell(focus[0]), cz=cell(focus[1]);
    const {all,objects,version}=partition(world);
    // Keep records compatible with the full publication even if this sector contains only plain blocks.
    const entryVersion=Math.max(version,sourceVersion);
    const minimumRecordBytes=entryVersion===2?127:119;
    const merged={next:world.next,nodes:new Map()};
    let cells=0;
    for(let slot=0;slot<all.length;++slot){
      const group=all[slot];
      if(!initialSlot(slot,group.x,group.z,cx,cz,radius))continue;
      ++cells;
      if(24+minimumRecordBytes*(merged.nodes.size+group.world.nodes.size)>budget)return null;
      for(const [id,node] of group.world.nodes)merged.nodes.set(id,node);
    }
    if(!merged.nodes.size || merged.nodes.size===world.nodes.size)return null;
    // Central floor pieces can belong to the permanent group. Ignore a global
    // solid located only in the distance when deciding whether this view helps.
    const near=objects.some(object=>{
      if(!object.n.shape || !merged.nodes.has(object.n.id))return false;
      const [x0,z0,x1,z1]=bounds(object);
      return x1>=cx-radius && x0<=cx+radius && z1>=cz-radius && z0<=cz+radius;
    });
    if(!near)return null;
    const bytes=MundoWorld.encode(merged,entryVersion);
    return bytes.byteLength<=budget?{bytes,cells}:null;
  }
  // Studio and the room worker both use the size of the original publication.
  // A visible loading sector must save at least a quarter of that first download.
  function roomEntry(world,profile,focus,sourceBytes,sourceVersion=1){
    requireValue((profile==="mobile" || profile==="pc") && (sourceVersion===1 || sourceVersion===2));
    if(!eligibleRoomBytes(sourceBytes) || !Array.isArray(focus) || focus.length!==2 ||
        !focus.every(n=>Number.isFinite(n) && Math.abs(n)<=1e15))return null;
    const budget=Math.min(previewLimits[profile],Math.floor(3*sourceBytes/4));
    return entryWorld(world,profile,focus,budget,sourceVersion);
  }
  const indexHeader=48,indexRow=16,maxRoots=65536;
  function revisionBytes(revision){
    requireValue(typeof revision==="string" && revision.length===64 && /^[0-9a-f]{64}$/.test(revision));
    return Uint8Array.from(revision.match(/../g),byte=>parseInt(byte,16));
  }
  // Generated once per immutable revision and car selection on the host worker.
  // Unlisted roots and their children remain resident. (0,0) is an ordinary cell.
  function roomCellIndex(world,original,revision,vehicleRoot){
    const hash=revisionBytes(revision),rows=[];
    partition(world,{original,vehicleRoot,rows});
    if(!rows.length)return null;
    requireValue(rows.length<=maxRoots);
    const bytes=new Uint8Array(indexHeader+indexRow*rows.length),v=new DataView(bytes.buffer);
    bytes.set([77,90,73,49]);v.setUint32(4,rows.length,true);v.setUint32(8,width,true);bytes.set(hash,16);
    let at=indexHeader;
    for(const [id,x,z] of rows){
      v.setBigUint64(at,id,true);v.setInt32(at+8,x,true);v.setInt32(at+12,z,true);
      at+=indexRow;
    }
    return bytes;
  }
  function roomSectorGroups(world,original,vehicleRoot=null){
    const groups=partition(world,{original,vehicleRoot,buildGroups:true})?.all;
    if(!groups || groups.length<2)return null;
    for(const group of groups)group.road=group.road===true;
    return [groups[0],...groups.slice(1).sort((a,b)=>a.x-b.x || a.z-b.z)];
  }
  function sectorFits(profile,bytes,fullBytes,initial=true){
    return (profile==="mobile" || profile==="pc") && eligibleRoomBytes(fullBytes) &&
      Number.isSafeInteger(bytes) && bytes>=24 && bytes<=previewLimits[profile] && (!initial || bytes<=Math.floor(fullBytes*.75));
  }
  function sectorCatalogFits(globalBytes,totalBlobBytes,groupCount){
    return Number.isSafeInteger(groupCount) && groupCount>=2 && groupCount<=4097 &&
      globalBytes>=24 && globalBytes<=previewLimits.pc && totalBlobBytes>=globalBytes &&
      totalBlobBytes+52*groupCount<=26*1024*1024;
  }
  function roomCells(bytes,revision,world){
    const hash=revisionBytes(revision);
    requireValue(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer);
    const input=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    requireValue(input.byteLength>=indexHeader && input.byteLength<=indexHeader+maxRoots*indexRow);
    const v=new DataView(input.buffer,input.byteOffset,input.byteLength),count=v.getUint32(4,true);
    requireValue(v.getUint32(0,false)===0x4d5a4931 && count>0 && count<=maxRoots && count<=world.nodes.size &&
      v.getUint32(8,true)===width && v.getUint32(12,true)===0 && input.byteLength===indexHeader+indexRow*count &&
      hash.every((byte,i)=>byte===input[16+i]));
    const roots=new Map();
    for(let at=indexHeader;at<input.byteLength;at+=indexRow){
      const id=v.getBigUint64(at,true);
      requireValue(id!==0n && !roots.has(id) && world.nodes.get(id)?.parent===0n);
      roots.set(id,[v.getInt32(at+8,true),v.getInt32(at+12,true)]);
    }
    return roots;
  }
  async function directory(file){
    requireValue(file.size>=header+row+24&&file.size<=maxBytes);
    const h=new DataView(await file.slice(0,header).arrayBuffer());
    requireValue(String.fromCharCode(...new Uint8Array(h.buffer,0,8))===magic);
    const count=h.getUint32(8,true),floor=h.getFloat64(12,true);
    requireValue(count>0&&count<=65537&&Number.isFinite(floor)&&header+count*(24+row)<=file.size);
    const directoryBytes=header+count*row;
    const dir=new DataView(await file.slice(header,directoryBytes).arrayBuffer());
    const zones=new Map();let start=directoryBytes,total=0,base;
    for(let i=0;i<count;i++){
      const at=i*row,x=dir.getInt32(at,true),z=dir.getInt32(at+4,true),size=dir.getUint32(at+8,true),nodes=dir.getUint32(at+12,true);
      const entry={x,z,start,size,nodes,slot:i};start+=size;total+=nodes;
      requireValue(size>=24&&size<=24*1024*1024&&start<=file.size&&total<=65536);
      if(!i){base=entry;continue;}
      requireValue(nodes>0&&!zones.has(key(x,z)));zones.set(key(x,z),entry);
    }
    requireValue(start===file.size);
    return {directoryBytes,floor,base,zones};
  }

  // Offsets address the original .mzones blob. The global payload in slot zero
  // stays distinct from a spatial cell at (0, 0). Node counts come from the
  // directory; open() still verifies them when actually decoding a payload.
  async function inventory(file,worldHash,focus,options={}){
    requireValue(typeof worldHash==="string" && worldHash.length===64 && /^[0-9a-f]{64}$/.test(worldHash));
    requireValue(Array.isArray(focus) && focus.length===2 && Number.isFinite(focus[0]) && Number.isFinite(focus[1]));
    if(!globalThis.crypto?.subtle)throw new Error("El navegador necesita SHA-256 para crear el inventario de zonas.");
    const [x,z]=focus;
    const centerX=cell(x),centerZ=cell(z);
    function current(){
      if(options.current && !options.current()){
        throw Object.assign(new Error("El borrador de zonas cambió."),{name:"AbortError"});
      }
    }
    async function digest(bytes){
      current();
      const result=await crypto.subtle.digest("SHA-256",bytes);
      current();
      return Array.from(new Uint8Array(result),b=>b.toString(16).padStart(2,"0")).join("");
    }
    current();
    const {directoryBytes,base,zones}=await directory(file);
    current();
    // WebCrypto hashes a complete buffer. Keep one bounded source buffer and
    // use views into it rather than buffering every hash job simultaneously.
    const source=new Uint8Array(await file.arrayBuffer());
    requireValue(source.byteLength===file.size);
    const packageSha256=await digest(source);
    const profiles={mobile:{radius:entryRadii.mobile,bytes:directoryBytes,count:0},
      pc:{radius:entryRadii.pc,bytes:directoryBytes,count:0}};
    const entries=[];
    for(const entry of [base,...zones.values()]){
      if(entry.slot && entry.slot%256===0){
        if(options.yield)await options.yield();
        else if(typeof setTimeout==="function")await new Promise(resolve=>setTimeout(resolve,0));
        current();
      }
      const {slot,x,z,start:offset,size:bytes,nodes}=entry;
      const sha256=await digest(source.subarray(offset,offset+bytes));
      entries.push({slot,x,z,offset,bytes,nodes,sha256});
      for(const profile of Object.values(profiles)){
        if(initialSlot(slot,x,z,centerX,centerZ,profile.radius)){
          profile.bytes+=bytes;
          profile.count++;
        }
      }
    }
    current();
    return {format:"MUNDO-zone-index",version:1,worldSha256:worldHash,packageSha256,packageBytes:file.size,
      directoryBytes,cellSize:width,focus:[x,z],profiles,entries};
  }

  async function open(file){
    const {floor,base,zones}=await directory(file);
    async function read(entry){
      const bytes=await file.slice(entry.start,entry.start+entry.size).arrayBuffer();
      const world=MundoWorld.decode(bytes);
      requireValue(world.nodes.size===entry.nodes);
      const scene=MundoGeometry.flatten(world);
      if(entry.slot){
        for(const e of scene.objects){
          const [x,z,x1,z1]=bounds(e);
          requireValue(x===entry.x&&z===entry.z&&x1===x&&z1===z);
          // Render IDs for paged objects cannot alias parked car parts or other pages.
          e.n={...e.n,id:(BigInt(entry.slot)<<64n)|e.n.id};
        }
      }
      return scene;
    }
    const global=await read(base);
    let cache=new Map();
    return {global,floor,cell,async nearby(cx,cz,radius){
      const next=new Map();
      for(let x=-radius;x<=radius;x++)for(let z=-radius;z<=radius;z++){
        const k=key(cx+x,cz+z),entry=zones.get(k);
        if(entry)next.set(k,cache.get(k)||await read(entry));
      }
      const objects=global.objects.slice();
      for(const scene of next.values())for(const o of scene.objects)objects.push(o);
      cache=next;
      return objects;
    }};
  }
  return {pack,open,cell,inventory,eligibleRoomBytes,roomEntry,roomCellIndex,roomCells,roomWindow,roomSectorGroups,sectorFits,sectorCatalogFits,aheadWindow,aheadLimits,aheadRows,diagonalVia,aheadStages};
})();
