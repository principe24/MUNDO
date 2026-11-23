"use strict";
// Local authoring and playback share the native MWENGIE document format (revisions 1 and 2).
window.MundoWorld = (() => {
  const HEADER = [77,87,69,78,71,73,69,0];
  const MAX_BYTES = 24 * 1024 * 1024, MAX_NODES = 65536, MAX_ID = (1n << 64n) - 1n;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true});
  const empty = () => ({nodes:new Map(), next:1n});
  function check(ok, message) { if (!ok) throw new Error(message); }
  function fresh(id, name, shape=1, parent=0n) {
    return {id, parent, name, shape, p:[0,0,0], q:[0,0,0,1], s:[1,1,1],
      color:[.15,.54,.49], rough:.56, metal:0, visual:0n};
  }
  const unit = n => Number.isFinite(n) && n>=0 && n<=1;
  function vector(a, length, predicate) {
    return Array.isArray(a) && a.length===length && a.every(predicate);
  }
  function validatedVersion(world) {
    check(world.nodes instanceof Map && world.nodes.size<=MAX_NODES &&
      typeof world.next==="bigint" && world.next>=1n && world.next<=MAX_ID,"El mundo supera los límites del formato.");
    const children = new Map();
    let version=1;
    for (const [id,n] of world.nodes) {
      check(typeof id==="bigint" && id===n.id && id>0n && id<world.next && typeof n.parent==="bigint" && n.parent>=0n &&
        (n.parent===0n || world.nodes.has(n.parent)),"Hay un identificador o una relación de piezas inválidos.");
      check(typeof n.name==="string" && n.name.length>0 && n.name.length<=95 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(n.name),"El nombre debe usar caracteres visibles.");
      const name = encoder.encode(n.name);
      check(name.length<=95 && decoder.decode(name)===n.name,"El nombre debe ocupar como máximo 95 bytes UTF-8.");
      check(Number.isInteger(n.shape) && n.shape>=0 && n.shape<=3 && typeof n.visual==="bigint" && n.visual>=0n && n.visual<=MAX_ID,
        "La forma o la clave de apariencia son inválidas.");
      if(n.visual!==0n)version=2;
      check(vector(n.p,3,x=>Number.isFinite(x)&&Math.abs(x)<=1e12) &&
        vector(n.s,3,x=>Number.isFinite(x)&&x>=.0001&&x<=10000) && vector(n.q,4,Number.isFinite) &&
        Math.abs(n.q.reduce((sum,x)=>sum+x*x,0)-1)<=1e-5,"Posición, orientación o escala fuera de rango.");
      check(vector(n.color,3,unit) && unit(n.rough) && unit(n.metal),"El material contiene valores inválidos.");
      if (!children.has(n.parent)) children.set(n.parent,[]);
      children.get(n.parent).push(id);
    }
    let count=0;
    const pending=[[0n,0]];
    while (pending.length) {
      const [id,depth]=pending.pop();
      check(depth<=64,"Se superó la profundidad de 64 niveles.");
      if (id) ++count;
      for (const child of children.get(id)||[]) pending.push([child,depth+1]);
    }
    check(count===world.nodes.size,"La jerarquía contiene un ciclo.");
    return version;
  }
  function validate(world) {
    validatedVersion(world);
    return world;
  }
  function decode(buffer) {
    const input=buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    check(input.byteLength>=24 && input.byteLength<=MAX_BYTES && HEADER.every((b,i)=>b===input[i]),
      "El archivo requiere una cabecera .mworld válida y un tamaño de hasta 24 MiB.");
    const v=new DataView(input.buffer,input.byteOffset,input.byteLength);
    let at=8;
    function take(bytes) { const old=at; at+=bytes; check(at<=input.byteLength,"El archivo está incompleto."); return old; }
    const u8=()=>v.getUint8(take(1)), u32=()=>v.getUint32(take(4),true), u64=()=>v.getBigUint64(take(8),true);
    const f32=()=>v.getFloat32(take(4),true), f64=()=>v.getFloat64(take(8),true);
    const version=u32(), count=u32(), next=u64();
    check((version===1||version===2) && count<=MAX_NODES && count*(119+(version===2?8:0))<=input.byteLength-at,
      "La versión o el número de piezas son inválidos.");
    const nodes=new Map();
    for (let i=0;i<count;++i) {
      const id=u64(), parent=u64(), shape=u8(), size=u8();
      check(size>0 && size<=95 && !nodes.has(id),"Nombre o identificador inválido.");
      const start=take(size), name=decoder.decode(input.subarray(start,start+size));
      nodes.set(id,{id,parent,shape,name,p:[f64(),f64(),f64()],q:[f64(),f64(),f64(),f64()],
        s:[f64(),f64(),f64()],color:[f32(),f32(),f32()],rough:f32(),metal:f32(),visual:version===2?u64():0n});
    }
    check(at===input.byteLength,"El archivo contiene datos adicionales.");
    return validate({nodes,next});
  }
  function encode(world,minimumVersion=1) {
    check(minimumVersion===1 || minimumVersion===2,"Versión de codificación de mundo desconocida.");
    const version=Math.max(minimumVersion,validatedVersion(world));
    const nodes=Array.from(world.nodes.values()).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    const names=nodes.map(n=>encoder.encode(n.name));
    const bytes=new Uint8Array(24+names.reduce((sum,n)=>sum+118+n.length+(version===2?8:0),0));
    bytes.set(HEADER); const v=new DataView(bytes.buffer); let at=8;
    const u8=x=>{v.setUint8(at,x);++at;}, u32=x=>{v.setUint32(at,x,true);at+=4;};
    const u64=x=>{v.setBigUint64(at,x,true);at+=8;}, f32=x=>{v.setFloat32(at,x,true);at+=4;};
    const f64=x=>{v.setFloat64(at,x,true);at+=8;};
    u32(version); u32(nodes.length); u64(world.next);
    nodes.forEach((n,i)=>{
      u64(n.id); u64(n.parent); u8(n.shape); u8(names[i].length); bytes.set(names[i],at); at+=names[i].length;
      n.p.forEach(f64); n.q.forEach(f64); n.s.forEach(f64); n.color.forEach(f32); f32(n.rough); f32(n.metal);
      if (version===2) u64(n.visual);
    });
    return bytes;
  }
  function fork(world) { return {nodes:new Map(world.nodes),next:world.next}; }
  // Callers replace entire node records when editing. Shared records remain immutable between revisions.
  function add(world, name, shape, parent=0n) {
    check(world.next<MAX_ID && world.nodes.size<MAX_NODES,"Se alcanzó el límite de piezas.");
    const node=fresh(world.next++,name,shape,parent);
    world.nodes.set(node.id,node);
    return node;
  }
  function place(world, source, name, position) {
    check(source.nodes.size && source.nodes.size+1+world.nodes.size<=MAX_NODES &&
      world.next+BigInt(source.nodes.size)+1n<=MAX_ID,"El objeto está vacío o no cabe en el mundo.");
    const group=add(world,name,0); group.p=position.slice();
    const remap=new Map([[0n,group.id]]);
    for (const id of source.nodes.keys()) remap.set(id,world.next++);
    for (const n of source.nodes.values()) {
      const id=remap.get(n.id);
      world.nodes.set(id,{...n,id,parent:remap.get(n.parent)});
    }
    return group.id;
  }
  function subtree(world,id) {
    const kids=new Map();
    for (const n of world.nodes.values()) {
      if (!kids.has(n.parent)) kids.set(n.parent,[]);
      kids.get(n.parent).push(n.id);
    }
    const out=[], pending=[id];
    while (pending.length) {
      const key=pending.pop(); out.push(key);
      for (const child of kids.get(key)||[]) pending.push(child);
    }
    return out;
  }
  function duplicate(world,id,rootPosition=null) {
    const parts=subtree(world,id), remap=new Map();
    for(const oldId of parts){
      const old=world.nodes.get(oldId);
      const fresh=add(world,old.name,old.shape,oldId===id?old.parent:remap.get(old.parent));
      remap.set(oldId,fresh.id);
      const p=oldId===id?(rootPosition??[old.p[0]+1,old.p[1],old.p[2]]):old.p;
      world.nodes.set(fresh.id,{...old,id:fresh.id,parent:fresh.parent,p});
    }
    return remap.get(id);
  }
  // The decoder has already validated the header. Keep the source file's encoding for byte estimates.
  function sourceInfo(bytes,hash) {
    const header=ArrayBuffer.isView(bytes)?new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength):new DataView(bytes);
    return {hash,version:header.getUint32(8,true),bytes:header.byteLength};
  }
  async function fileBytes(file) {
    check(file && file.size>=24 && file.size<=MAX_BYTES,"Selecciona un archivo .mworld de hasta 24 MiB.");
    return file.arrayBuffer();
  }
  async function readFile(file) { return decode(await fileBytes(file)); }
  function worldFile(world,name) {
    const safe=(name||"Mi_mundo").replace(/[^\p{L}\p{N}_-]+/gu,"_").slice(0,65);
    return new File([encode(world)],safe+".mworld",{type:"application/vnd.mundo.world"});
  }
  function download(world,name) {
    const file=worldFile(world,name);
    const a=document.createElement("a"); const url=URL.createObjectURL(file);
    a.href=url; a.download=file.name;
    document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  const from64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  const linear=n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4;
  const fromHex=hex=>[1,3,5].map(i=>linear(parseInt(hex.slice(i,i+2),16)/255));
  const toHex=color=>"#"+color.map(c=>Math.round(255*(c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055)).toString(16).padStart(2,"0")).join("");
  return Object.freeze({empty,add,fresh,validate,validatedVersion,decode,encode,fork,place,subtree,duplicate,sourceInfo,fileBytes,readFile,worldFile,download,from64,fromHex,toHex});
})();
