"use strict";
// Private Studio catalog. Publication is an explicit operation over a sealed room.
globalThis.MundoAudioLibrary = (() => {
  const metadata="catalog", media="recordings";
  const maxCatalogBytes=32*1024*1024, maxRecordings=128;
  function open() {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open("mundo-studio-audio",1);
      request.onupgradeneeded=()=>{
        request.result.createObjectStore(metadata,{keyPath:"key"});
        request.result.createObjectStore(media,{keyPath:"key"});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>reject(Error("Cierra las otras ventanas de Studio para actualizar el catálogo sonoro."));
    });
  }
  async function transaction(mode,run) {
    const db=await open();
    try {
      return await new Promise((resolve,reject)=>{
        const tx=db.transaction([metadata,media],mode);
        let result, failure;
        tx.oncomplete=()=>resolve(result);
        tx.onabort=()=>reject(failure || tx.error || Error("No se pudo guardar el catálogo sonoro."));
        const abort=err=>{failure=err;tx.abort();};
        run(tx.objectStore(metadata),tx.objectStore(media),value=>{result=value;},abort);
      });
    } finally {db.close();}
  }
  const list=()=>transaction("readonly",(meta,_media,done)=>{
    const req=meta.getAll();req.onsuccess=()=>done(req.result.map(({key,name})=>({key,name})));
  });
  const get=key=>transaction("readonly",(meta,files,done)=>{
    const record=meta.get(key), content=files.get(key);
    content.onsuccess=()=>done(record.result && content.result ?
      {key,name:record.result.name,bytes:content.result.bytes}:null);
  });
  function save(items) {
    return transaction("readwrite",(meta,files,done,abort)=>{
      const req=meta.getAll();
      req.onsuccess=()=>{
        try {
          const byKey=new Map(req.result.map(r=>[r.key,r]));
          let size=req.result.reduce((n,r)=>n+r.size,0);
          const names=[];
          for(const item of items) {
            const prior=byKey.get(item.key);
            if(prior && prior.digest!==item.digest)throw Error("Dos sonidos distintos tienen la misma clave corta.");
            if(prior){names.push({key:prior.key,name:prior.name});continue;}
            size+=item.bytes.length;
            if(size>maxCatalogBytes || byKey.size>=maxRecordings)throw Error("Se alcanzó el espacio del catálogo privado de audio.");
            const record={key:item.key,name:item.name,digest:item.digest,size:item.bytes.length};
            byKey.set(item.key,record);meta.put(record);
            // Copy a subarray so the catalog never retains the entire imported package.
            files.put({key:item.key,bytes:new Uint8Array(item.bytes)});
            names.push({key:item.key,name:item.name});
          }
          done(names);
        } catch(err){abort(err);}
      };
    });
  }
  async function importFile(file) {
    if(!file || !Number.isSafeInteger(file.size) || file.size<44 || file.size>16*1024*1024)
      throw Error("Selecciona una grabación WAV de hasta 16 MiB.");
    const prepared=await MundoAudioClips.prepare(new Uint8Array(await file.arrayBuffer()));
    const base=String(file.name || "Grabación").split(/[\\/]/).pop().replace(/\.wav$/iu,"")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu,"").trim().slice(0,80) || "Grabación";
    return (await save([{...prepared,name:base}]))[0];
  }
  async function contents(input) {
    if(input instanceof Blob && input.size>MundoAudioClips.maxRoomBytes)throw Error("Archivo de sala demasiado grande.");
    return input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : new Uint8Array(input);
  }
  async function packRoom(input) {
    const room=await contents(input),info=await MundoRoomFile.verify(room);
    const sources=MundoAudioScene.read(MundoWorld.decode(info.world));
    const keys=new Set(sources.map(s=>s.preset).filter(MundoAudioScene.isClip));
    const items=[];
    for(const key of keys){
      const item=await get(key);
      if(!item)throw Error("Falta la grabación "+key+" en el catálogo privado.");
      items.push(item);
    }
    MundoAudioClips.match(sources,items);
    return MundoAudioClips.pack(room,items);
  }
  async function openRoom(input) {
    const {room,items}=MundoAudioClips.unpack(await contents(input));
    const info=await MundoRoomFile.verify(room),world=MundoWorld.decode(info.world);
    const sources=MundoAudioScene.read(world);
    MundoAudioClips.match(sources,items);
    const pending=[];
    for(const item of items){
      await MundoAudioClips.verify(item.key,item.bytes,item.digest);
      pending.push({...item,name:sources.find(s=>s.preset===item.key).label});
    }
    await save(pending);
    return {room,info,world};
  }
  return Object.freeze({list,get,importFile,packRoom,openRoom});
})();
