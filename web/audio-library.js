"use strict";
// Private Studio catalog. Publication is an explicit operation over a sealed room.
globalThis.MundoAudioLibrary = (() => {
  const metadata="catalog", media="recordings", musicMetadata="music-catalog", musicMedia="music-segments";
  const maxCatalogBytes=32*1024*1024, maxRecordings=128;
  function open() {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open("mundo-studio-audio",2);
      request.onupgradeneeded=()=>{
        const names=request.result.objectStoreNames,missing=name=>!names?.contains||!names.contains(name);
        if(missing(metadata))request.result.createObjectStore(metadata,{keyPath:"key"});
        if(missing(media))request.result.createObjectStore(media,{keyPath:"key"});
        if(missing(musicMetadata))request.result.createObjectStore(musicMetadata,{keyPath:"id"});
        if(missing(musicMedia))request.result.createObjectStore(musicMedia,{keyPath:"id"});
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
  async function musicTransaction(mode,run){
    const db=await open();
    try{return await new Promise((resolve,reject)=>{
      const tx=db.transaction([musicMetadata,musicMedia],mode);let result,failure;
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||tx.error||Error("No se pudo guardar el catálogo musical."));
      const abort=error=>{failure=error;tx.abort();};
      run(tx.objectStore(musicMetadata),tx.objectStore(musicMedia),value=>{result=value;},abort);
    });}finally{db.close();}
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
  const listMusic=()=>musicTransaction("readonly",(meta,_files,done)=>{
    const request=meta.getAll();request.onsuccess=()=>done(request.result.map(({id,name,segments,duration})=>({id,name,segments,duration})));
  });
  const getMusic=id=>musicTransaction("readonly",(meta,files,done)=>{
    const record=meta.get(String(id)),content=files.get(String(id));
    content.onsuccess=()=>done(record.result&&content.result?{...record.result,segments:content.result.segments}:null);
  });
  async function importMusicFile(file){
    if(!file||!Number.isSafeInteger(file.size)||file.size<44||file.size>64*1024*1024)
      throw Error("Selecciona una pista WAV de hasta 64 MiB.");
    const prepared=await MundoAudioClips.prepareMusic(new Uint8Array(await file.arrayBuffer()));
    const name=String(file.name||"Música").split(/[\\/]/).pop().replace(/\.wav$/iu,"")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu,"").trim().slice(0,80)||"Música";
    const duration=prepared.segments.reduce((sum,item)=>sum+(item.bytes.length-44)/2/MundoAudioClips.rate,0);
    return musicTransaction("readwrite",(meta,files,done,abort)=>{
      const all=meta.getAll();all.onsuccess=()=>{try{
        const previous=all.result.find(item=>item.id===prepared.id);
        if(previous){
          if(previous.digest!==prepared.digest)throw Error("Dos pistas distintas tienen la misma identidad corta.");
          done({...previous,segments:prepared.segments.length});return;
        }
        const total=all.result.reduce((sum,item)=>sum+item.size,0)+prepared.segments.reduce((sum,item)=>sum+item.bytes.length,0);
        if(all.result.length>=16||total>128*1024*1024)throw Error("Se alcanzó el espacio del catálogo musical privado.");
        const record={id:prepared.id,key:prepared.id,name,digest:prepared.digest,size:total-(all.result.reduce((sum,item)=>sum+item.size,0)),
          segments:prepared.segments.length,duration};
        meta.put(record);files.put({id:prepared.id,key:prepared.id,segments:prepared.segments.map(item=>({...item,bytes:new Uint8Array(item.bytes)}))});
        done({...record,segments:prepared.segments.length});
      }catch(error){abort(error);}};
    });
  }
  async function restoreMusic(input,name){
    const prepared=await MundoAudioMusic.verify(input),size=prepared.segments.reduce((sum,item)=>sum+item.bytes.length,0);
    const duration=prepared.segments.reduce((sum,item)=>sum+(item.bytes.length-44)/2/MundoAudioClips.rate,0);
    return musicTransaction("readwrite",(meta,files,done,abort)=>{
      const all=meta.getAll();all.onsuccess=()=>{try{
        const previous=all.result.find(item=>item.id===prepared.id);
        if(previous){if(previous.digest!==prepared.digest)throw Error("Conflicto en el catálogo musical.");done(previous);return;}
        if(all.result.length>=16||all.result.reduce((sum,item)=>sum+item.size,0)+size>128*1024*1024)
          throw Error("Se alcanzó el espacio del catálogo musical privado.");
        const record={id:prepared.id,key:prepared.id,name:String(name||"Música").slice(0,80),digest:prepared.digest,size,
          segments:prepared.segments.length,duration};
        meta.put(record);files.put({id:prepared.id,key:prepared.id,segments:prepared.segments.map(item=>({...item,bytes:new Uint8Array(item.bytes)}))});done(record);
      }catch(error){abort(error);}};
    });
  }
  async function packMusicRoom(input){
    const base=await contents(input);let room=base;
    if(String.fromCharCode(...room.subarray(0,8)).startsWith("MWAUDIO"))room=MundoAudioClips.unpack(room).room;
    if(MundoAudioClips.hasModels(room))room=MundoModelRoom.unpack(room).room;
    const info=await MundoRoomFile.verify(room),world=MundoWorld.decode(info.world),marker=MundoAudioScene.readMusic(world);
    if(!marker)return base;
    const item=await getMusic(marker.streamId);
    if(!item)throw Error("Falta la pista musical "+marker.streamId+" en el catálogo privado.");
    return MundoAudioMusic.pack(base,{id:item.id,digest:item.digest,segments:item.segments});
  }
  async function contents(input) {
    if(input instanceof Blob && input.size>MundoAudioClips.maxRoomBytes)throw Error("Archivo de sala demasiado grande.");
    return input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : new Uint8Array(input);
  }
  async function readBase(base) {
    const models=MundoAudioClips.hasModels(base)?MundoModelRoom.unpack(base):null;
    const room=models?models.room:base;
    const info=await MundoRoomFile.verify(room),world=MundoWorld.decode(info.world);
    if(models){
      MundoModelRoom.match(world,models.items);
      for(const item of models.items){
        if(await MundoRoomFile.digest(item.bytes)!==item.digest)throw Error("La malla adjunta difiere de su huella.");
      }
    }
    return {room,world,info,models};
  }
  async function packRoom(input) {
    const base=await contents(input),{world}=await readBase(base);
    const sources=MundoAudioScene.read(world);
    const keys=new Set(sources.map(s=>s.preset).filter(MundoAudioScene.isClip));
    const items=[];
    for(const key of keys){
      const item=await get(key);
      if(!item)throw Error("Falta la grabación "+key+" en el catálogo privado.");
      items.push(item);
    }
    MundoAudioClips.match(sources,items);
    return MundoAudioClips.pack(base,items);
  }
  async function openRoom(input) {
    const {room:base,items}=MundoAudioClips.unpack(await contents(input));
    const {room,info,world,models}=await readBase(base);
    const sources=MundoAudioScene.read(world);
    MundoAudioClips.match(sources,items);
    const pending=[];
    for(const item of items){
      await MundoAudioClips.verify(item.key,item.bytes,item.digest);
      pending.push({...item,name:sources.find(s=>s.preset===item.key).label});
    }
    // Both content-addressed sets have been verified before either private catalog is updated.
    // The catalogs use separate databases. On a quota error it is safe to retry either import.
    if(models)await MundoCreatorAssets.restore(models.items);
    await save(pending);
    return {room,info,world,hasModels:Boolean(models)};
  }
  async function openProject(file,accept) {
    if (!(file instanceof Blob) || file.size > MundoAudioMusicProject.maxBytes)
      throw Error("Archivo de proyecto con audio demasiado grande.");
    const bytes=new Uint8Array(await file.arrayBuffer()),magic=String.fromCharCode(...bytes.subarray(0,8));
    const loaded=magic===MundoAudioMusicProject.magic
      ?await MundoAudioMusicProject.open(bytes):await MundoAudioProject.open(bytes);
    if (!accept(loaded.index)) return null;
    // Verify the complete package before updating either content-addressed catalog.
    // A quota failure is safe to retry because an existing digest is immutable.
    if(loaded.items.length)await save(loaded.items);
    for(const stream of loaded.streams??[]){
      const marker=[...loaded.musicByWorld.values()].find(item=>item?.streamId===stream.id);
      await restoreMusic(stream,marker?.label||"Música del mundo");
    }
    return loaded.index;
  }
  return Object.freeze({list,get,importFile,listMusic,getMusic,importMusicFile,restoreMusic,packMusicRoom,packRoom,openRoom,openProject});
})();
