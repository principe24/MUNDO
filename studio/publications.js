"use strict";
// Catalog metadata and immutable scene bytes commit together. The editor keeps its separate draft.
window.MundoPublications=(()=>{
  let opening;
  function database(){
    if(!opening)opening=new Promise((resolve,reject)=>{
      const request=indexedDB.open("mundo-studio-private-releases",1);
      request.onupgradeneeded=()=>{
        const db=request.result;
        const catalog=db.createObjectStore("catalog",{keyPath:"id",autoIncrement:true});
        catalog.createIndex("worldRevision",["title","revision"],{unique:true});
        db.createObjectStore("scenes");
      };
      request.onsuccess=()=>{
        const db=request.result;
        db.onversionchange=()=>{db.close();opening=null;};
        resolve(db);
      };
      request.onerror=()=>reject(request.error);
    }).catch(error=>{opening=null;throw error;});
    return opening;
  }
  function samePoint(a,b){
    if(a==null || b==null)return a==null && b==null;
    return a.length===b.length && a[0]===b[0] && a[1]===b[1] && a[2]===b[2];
  }
  async function publish(world,name,vehicleRoot=null,meetingPoint=null){
    const {gates,grid}=MundoCircuit.read(world);
    const point=MundoRoomFile.copyMeetingPoint(meetingPoint);
    if(point || vehicleRoot!==null || gates.length || grid){
      const scene=MundoGeometry.flatten(world);
      MundoMeeting.validatePublication(world,scene,vehicleRoot,point,gates.length>0);
    }
    const title=name.trim()||"Mi mundo",bytes=MundoWorld.encode(world);
    const hash=await MundoRoomFile.digest(bytes),db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(["catalog","scenes"],"readwrite"),catalog=tx.objectStore("catalog");
      const range=IDBKeyRange.bound([title,0],[title,Number.MAX_SAFE_INTEGER]);
      const latest=catalog.index("worldRevision").openCursor(range,"prev");
      let result;
      latest.onsuccess=()=>{
        const previous=latest.result?.value;
        if(previous?.hash===hash && (previous.vehicleRoot??null)===vehicleRoot && samePoint(previous.meetingPoint,point)){
          result={id:previous.id,created:false};return;
        }
        const revision=(previous?.revision||0)+1;
        const insert=catalog.add({title,revision,hash,vehicleRoot,meetingPoint:point});
        insert.onsuccess=()=>{
          tx.objectStore("scenes").add(bytes,insert.result);
          result={id:insert.result,created:true};
        };
      };
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(tx.error||new Error("Publicación interrumpida."));
    });
  }
  async function query(store,operation){
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store),request=operation(tx.objectStore(store));
      tx.oncomplete=()=>resolve(request.result);
      tx.onabort=()=>reject(tx.error||new Error("Lectura interrumpida."));
    });
  }
  async function bytesOf(info){
    const bytes=await query("scenes",store=>store.get(info.id));
    if(!(bytes instanceof Uint8Array)||await MundoRoomFile.digest(bytes)!==info.hash)
      throw new Error("No se pudo verificar la copia publicada.");
    return bytes;
  }
  async function load(info){return MundoWorld.decode(await bytesOf(info));}
  async function roomDownload(info){
    const metadata={...info,meetingPoint:MundoRoomFile.copyMeetingPoint(info.meetingPoint)};
    const bytes=await bytesOf(metadata);
    const packed=await MundoRoomFile.seal(metadata,bytes);
    const stem=metadata.title.replace(/[^\p{L}\p{N}_-]+/gu,"_").slice(0,65);
    return {
      filename:stem+"-v"+metadata.revision+".mroom",
      blob:new Blob([packed],{type:"application/vnd.mundo.room-file"})
    };
  }
  async function withModels(roomFile,world) {
    const keys=MundoModelRoom.references(world);
    if (!keys.size) return roomFile;
    if (keys.size>MundoModelRoom.maxCount) throw Error("Publica hasta 64 modelos distintos por sala 3D.");
    const records=new Map((await MundoCreatorAssets.list()).map(info=>[info.key,info])), items=[];
    let used=0,triangles=0;
    for (const key of keys) {
      const info=records.get(key);
      if (!info) throw Error("Falta la malla "+key+". Importa su OBJ antes de empaquetar la sala.");
      const byteLength=MundoCreatorMesh.headerBytes+24*info.vertices+12*info.triangles;
      used+=37+new TextEncoder().encode(info.name).length+byteLength;
      triangles+=info.triangles;
      if (used>MundoModelRoom.maxAssets || triangles>MundoModelRoom.maxTriangles) throw Error("La selección supera el presupuesto de recursos de la sala.");
      items.push({...info,bytes:await MundoCreatorAssets.load(info)});
    }
    const room=new Uint8Array(await roomFile.blob.arrayBuffer()), packed=MundoModelRoom.pack(room,items);
    return {filename:roomFile.filename+"3d",blob:new Blob([packed],{type:"application/octet-stream"})};
  }
  async function audioDraft(world,title,vehicleRoot,meetingPoint){
    const bytes=MundoWorld.encode(world);
    const info={title,revision:1,vehicleRoot,meetingPoint,hash:await MundoRoomFile.digest(bytes)};
    const room=await MundoRoomFile.seal(info,bytes);
    const packed=await MundoAudioLibrary.packRoom(room,world);
    const stem=title.replace(/[^\p{L}\p{N}_-]+/gu,"_").slice(0,65)||"Mundo";
    return {filename:stem+".mroomaudio",blob:new Blob([packed],{type:"application/octet-stream"})};
  }
  async function openRoomFile(file){
    if(/\.mroomaudio$/i.test(file.name)){
      if(file.size>MundoAudioClips.maxRoomBytes)throw Error("La sala de audio excede el tamaño permitido.");
      const {info,world}=await MundoAudioLibrary.openRoom(new Uint8Array(await file.arrayBuffer()));
      if(info.vehicleRoot!==undefined)MundoDriving.roomCar(MundoGeometry.flatten(world),info.vehicleRoot);
      return {hasAudio:true,world,worldSource:MundoWorld.sourceInfo(info.world,info.hash),title:info.title,
        vehicleRoot:info.vehicleRoot??null,meetingPoint:info.meetingPoint??null,revision:info.revision};
    }
    const wrapped=/\.mroom3d$/i.test(file.name);
    if(file.size>(wrapped ? MundoModelRoom.maxBytes : MundoRoomFile.maxBytes))throw new Error("La sala excede el tamaño permitido.");
    const raw=new Uint8Array(await file.arrayBuffer()), bundle=wrapped ? MundoModelRoom.unpack(raw) : null;
    const info=await MundoRoomFile.verify(bundle ? bundle.room : raw);
    const world=MundoWorld.decode(info.world);
    if(info.vehicleRoot!==undefined)MundoDriving.roomCar(MundoGeometry.flatten(world),info.vehicleRoot);
    if(bundle){MundoModelRoom.match(world,bundle.items);await MundoCreatorAssets.restore(bundle.items);}
    return {hasModels:Boolean(bundle),world,worldSource:MundoWorld.sourceInfo(info.world,info.hash),title:info.title,vehicleRoot:info.vehicleRoot??null,meetingPoint:info.meetingPoint??null,revision:info.revision};
  }
  return {publish,load,bytesOf,roomDownload,openRoomFile,withModels,audioDraft,
    get:id=>query("catalog",store=>store.get(id)),list:()=>query("catalog",store=>store.getAll())};
})();
