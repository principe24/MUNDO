"use strict";

// A .mprojectmusic package wraps the immutable guest project, including its
// optional short-recording bank, and every distinct long track referenced by
// its worlds. Tracks are content addressed and shared when several worlds use
// the same stream id.
globalThis.MundoAudioMusicProject = (() => {
  const common=typeof module!=="undefined"&&module.exports;
  const P=common?require("../server/room-runtime.cjs").MundoProject:globalThis.MundoProject;
  const audioProject=common?require("./audio-project.js"):globalThis.MundoAudioProject;
  const music=common?require("./audio-music.js"):globalThis.MundoAudioMusic;
  const clips=common?require("./audio-clips.js"):globalThis.MundoAudioClips;
  const magic="MPMUSIC1",headerBytes=24,trackHeaderBytes=48,entryBytes=36;
  const maxTracks=8,maxMusicBytes=128*1024*1024,maxBaseBytes=audioProject.maxBytes;
  const maxBytes=headerBytes+maxBaseBytes+maxTracks*trackHeaderBytes+
    maxTracks*music.maxSegments*entryBytes+maxMusicBytes;
  const check=(value,message)=>{if(!value)throw Error(message);};
  const bin=value=>value instanceof Uint8Array?value:new Uint8Array(value);
  const text=(bytes,at,count)=>String.fromCharCode(...bytes.subarray(at,at+count));
  const ascii=(bytes,at,value)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i);};
  const hex=bytes=>Array.from(bytes,n=>n.toString(16).padStart(2,"0")).join("");
  const hashBytes=hash=>Uint8Array.from({length:32},(_,i)=>parseInt(hash.slice(i*2,i*2+2),16));

  async function bytesOf(input){
    if(input instanceof Blob)return new Uint8Array(await input.arrayBuffer());
    return new Uint8Array(bin(input));
  }
  function baseMagic(base){return text(base,0,8);}
  function validBase(base){return base.length>=80&&base.length<=maxBaseBytes&&
    ["MUNDOPRJ","MPRAUD01"].includes(baseMagic(base));}

  async function verifyStreams(input){
    check(Array.isArray(input)&&input.length>0&&input.length<=maxTracks,"Inventario musical de proyecto inválido.");
    const streams=[];let total=0,previous=0n;
    for(const source of input){
      const stream=await music.verify(source),id=BigInt(stream.id);
      check(id>previous,"Las pistas del proyecto están repetidas o desordenadas.");
      total+=stream.segments.reduce((sum,item)=>sum+item.bytes.length,0);
      check(total<=maxMusicBytes,"La música del proyecto supera 128 MiB.");
      streams.push(stream);previous=id;
    }
    return streams;
  }

  async function pack(input,collection){
    const base=await bytesOf(input);
    check(validBase(base),"El proyecto base de la música es inválido.");
    const sorted=[...collection].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);
    const streams=await verifyStreams(sorted);
    const details=await detailsOf(base);
    check(details.hasMusic,"El proyecto adjunto no referencia música larga.");match(details,streams);
    const payload=streams.reduce((sum,stream)=>sum+trackHeaderBytes+
      stream.segments.reduce((n,item)=>n+entryBytes+item.bytes.length,0),0);
    const bytes=new Uint8Array(headerBytes+base.length+payload),view=new DataView(bytes.buffer);
    ascii(bytes,0,magic);view.setUint32(8,base.length,true);view.setUint32(12,streams.length,true);
    view.setUint32(16,payload,true);view.setUint32(20,0,true);bytes.set(base,headerBytes);
    let at=headerBytes+base.length;
    for(const stream of streams){
      const start=at;view.setBigUint64(at,BigInt(stream.id),true);
      view.setUint32(at+8,stream.segments.length,true);view.setUint32(at+12,0,true);
      bytes.set(hashBytes(stream.digest),at+16);at+=trackHeaderBytes;
      for(const item of stream.segments){
        bytes.set(hashBytes(item.digest),at);view.setUint32(at+32,item.bytes.length,true);at+=entryBytes;
        bytes.set(item.bytes,at);at+=item.bytes.length;
      }
      view.setUint32(start+12,at-start,true);
    }
    check(at===bytes.length,"No se pudo cerrar el proyecto musical.");
    return bytes;
  }

  function unpack(input){
    const bytes=bin(input);
    check(bytes.length>=headerBytes+80&&bytes.length<=maxBytes&&text(bytes,0,8)===magic,
      "Archivo musical de proyecto inválido.");
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const baseSize=view.getUint32(8,true),count=view.getUint32(12,true),payload=view.getUint32(16,true);
    check(view.getUint32(20,true)===0&&count>0&&count<=maxTracks&&baseSize>=80&&baseSize<=maxBaseBytes&&
      headerBytes+baseSize+payload===bytes.length,"Directorio musical de proyecto inválido.");
    const base=bytes.subarray(headerBytes,headerBytes+baseSize);
    check(validBase(base),"La cabecera del proyecto adjunto es inválida.");
    const streams=[];let at=headerBytes+baseSize,total=0,previous=0n;
    for(let track=0;track<count;track++){
      check(at+trackHeaderBytes<=bytes.length,"Cabecera de pista incompleta.");
      const start=at,id=view.getBigUint64(at,true),segments=view.getUint32(at+8,true),size=view.getUint32(at+12,true);
      const digest=hex(bytes.subarray(at+16,at+48));
      check(id>previous&&segments>0&&segments<=music.maxSegments&&size>=trackHeaderBytes+segments*entryBytes&&
        start+size<=bytes.length,"Entrada de pista inválida.");
      at+=trackHeaderBytes;const items=[];
      for(let index=0;index<segments;index++){
        check(at+entryBytes<=start+size,"Entrada de segmento incompleta.");
        const partDigest=hex(bytes.subarray(at,at+32)),length=view.getUint32(at+32,true);at+=entryBytes;total+=length;
        check(length>=46&&length<=clips.maxClipBytes&&total<=maxMusicBytes&&at+length<=start+size,
          "Tamaño de segmento musical inválido.");
        items.push({index,key:"s"+partDigest.slice(0,16),digest:partDigest,
          bytes:new Uint8Array(bytes.subarray(at,at+length))});at+=length;
      }
      check(at===start+size,"Datos sobrantes en una pista del proyecto.");
      streams.push({id:String(id),digest,segments:items});previous=id;
    }
    check(at===bytes.length,"Datos sobrantes en el proyecto musical.");
    return {base:new Uint8Array(base),streams};
  }

  async function detailsOf(base){
    if(baseMagic(base)==="MPRAUD01")return audioProject.open(base,{allowMusic:true});
    const index=await P.open(new Blob([base])),details=await audioProject.inventory(index);
    return {index,...details,items:[]};
  }
  function match(details,streams){
    const byId=new Map(streams.map(stream=>[stream.id,stream])),referenced=new Set();
    for(const marker of details.musicByWorld.values()){
      if(!marker)continue;
      check(byId.has(marker.streamId),"Falta una pista musical de un mundo del proyecto.");
      referenced.add(marker.streamId);
    }
    check(referenced.size===byId.size,"El proyecto contiene pistas musicales sin referencia.");
  }
  async function open(input){
    const view=input instanceof Uint8Array?input:new Uint8Array(input);
    check(view.length<=maxBytes,"El proyecto musical supera el tamaño permitido.");
    const data=unpack(new Uint8Array(view)),streams=await verifyStreams(data.streams),details=await detailsOf(data.base);
    check(details.hasMusic,"El proyecto adjunto no referencia música larga.");
    match(details,streams);
    return {...details,streams,base:data.base};
  }
  async function exportProject(index,getClip,getMusic){
    const snapshot=await audioProject.exportSnapshot(index,getClip,{allowMusic:true});
    if(!snapshot.details.hasMusic)return {blob:snapshot.blob,hasAudio:snapshot.hasAudio,hasMusic:false};
    if(!getMusic)throw Error("Autoriza las pistas referenciadas para preparar este proyecto.");
    const ids=[...new Set([...snapshot.details.musicByWorld.values()].filter(Boolean).map(item=>item.streamId))]
      .sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    check(ids.length<=maxTracks,"El proyecto admite hasta 8 pistas largas distintas.");
    const streams=[];
    for(const id of ids){
      const item=await getMusic(id);
      if(!item||item.id!==id)throw Error("Falta la pista musical "+id+" en el catálogo privado.");
      streams.push({id:item.id,digest:item.digest,segments:item.segments});
    }
    const base=new Uint8Array(await snapshot.blob.arrayBuffer()),bytes=await pack(base,streams);
    return {blob:new Blob([bytes],{type:"application/vnd.mundo.music-project"}),hasAudio:snapshot.hasAudio,hasMusic:true};
  }
  return Object.freeze({magic,maxBytes,maxTracks,maxMusicBytes,pack,unpack,open,exportProject});
})();
if(typeof module!=="undefined"&&module.exports)module.exports=globalThis.MundoAudioMusicProject;
