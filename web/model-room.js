"use strict";
// MROOM3D1 encloses the exact .mroom. Only meshes referenced by its scene may accompany it.
const MundoModelRoom = (() => {
  const mesh=typeof module!=="undefined" && module.exports ? require("./creator-mesh.js") : MundoCreatorMesh;
  const magic="MROOM3D1", prefix=16, entryHeader=37, maxCount=64, maxTriangles=180000;
  const maxRoom=24*1024*1024+2068, maxAssets=12*1024*1024, maxBytes=prefix+maxRoom+maxAssets;
  const encoder=new TextEncoder(), decoder=new TextDecoder("utf-8",{fatal:true});
  function requireValue(ok,message) {if (!ok) throw Error(message);}
  function cleanName(name) {
    requireValue(typeof name==="string" && name.trim().length && !/[\u0000-\u001f\u007f-\u009f]/u.test(name) &&
      encoder.encode(name).length<=95,"Nombre de modelo inválido.");
    return name;
  }
  function references(world) {
    const keys=new Set();
    for (const n of world.nodes.values()) if (mesh.isCreatorKey(n.visual)) keys.add(n.visual.toString(16));
    return keys;
  }
  function match(world,items) {
    const keys=references(world);
    requireValue(keys.size===items.length && items.every(item=>keys.delete(item.key)),"Los modelos adjuntos no corresponden a las referencias de esta escena.");
  }
  function unpack(bytes) {
    requireValue(bytes instanceof Uint8Array && bytes.length>=prefix && bytes.length<=maxBytes &&
      String.fromCharCode(...bytes.subarray(0,8))===magic,"Cabecera del paquete de sala 3D inválida.");
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const n=view.getUint32(8,true), count=view.getUint32(12,true);
    requireValue(n>=20 && n<=maxRoom && n<=bytes.length-prefix && bytes.length-prefix-n<=maxAssets &&
      count>=1 && count<=maxCount,"Tamaño o inventario de sala 3D inválido.");
    const room=bytes.subarray(prefix,prefix+n), items=[];
    let at=prefix+n, triangles=0, previous="";
    for (let i=0; i<count; ++i) {
      requireValue(at+entryHeader<=bytes.length,"Registro de modelo truncado.");
      const digest=Array.from(bytes.subarray(at,at+32),x=>x.toString(16).padStart(2,"0")).join("");
      const key=mesh.keyOf(digest), label=bytes[at+32], length=view.getUint32(at+33,true);
      at+=entryHeader;
      requireValue(key>previous && label>0 && label<=95 && length<=mesh.maxBytes &&
        at+label+length<=bytes.length,"Modelo desordenado, repetido o truncado.");
      const name=cleanName(decoder.decode(bytes.subarray(at,at+label)));at+=label;
      const data=bytes.subarray(at,at+length);at+=length;
      const shape=mesh.validate(data);triangles+=shape.triangles;
      requireValue(triangles<=maxTriangles,"La sala supera los 180 000 triángulos únicos de autor.");
      items.push({key,digest,name,bytes:data,...shape}); previous=key;
    }
    requireValue(at===bytes.length,"El paquete de modelos tiene datos sobrantes.");
    return {room,items};
  }
  function pack(room,items) {
    requireValue(room instanceof Uint8Array && room.length>=20 && room.length<=maxRoom &&
      items.length>=1 && items.length<=maxCount,"La publicación necesita entre uno y 64 modelos.");
    const sorted=items.slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    let total=0,triangles=0,previous="";
    for (const item of sorted) {
      requireValue(/^[0-9a-f]{64}$/.test(item.digest) && item.key===mesh.keyOf(item.digest) && item.key>previous,
        "Identidad de modelo repetida o inválida.");
      const length=encoder.encode(cleanName(item.name)).length;
      triangles+=mesh.describe(item.bytes).triangles;
      total+=entryHeader+length+item.bytes.length;previous=item.key;
    }
    requireValue(total<=maxAssets && triangles<=maxTriangles,"El inventario supera 12 MiB o 180 000 triángulos únicos.");
    const out=new Uint8Array(prefix+room.length+total), view=new DataView(out.buffer);
    out.set(encoder.encode(magic));view.setUint32(8,room.length,true);view.setUint32(12,sorted.length,true);
    out.set(room,prefix);let at=prefix+room.length;
    for (const item of sorted) {
      const name=encoder.encode(item.name);
      for (let i=0; i<32; ++i) out[at+i]=parseInt(item.digest.slice(2*i,2*i+2),16);
      out[at+32]=name.length;view.setUint32(at+33,item.bytes.length,true);at+=entryHeader;
      out.set(name,at);at+=name.length;out.set(item.bytes,at);at+=item.bytes.length;
    }
    return out;
  }
  return Object.freeze({maxBytes,maxAssets,maxTriangles,maxCount,references,match,pack,unpack});
})();
if (typeof module!=="undefined" && module.exports) module.exports=MundoModelRoom;
