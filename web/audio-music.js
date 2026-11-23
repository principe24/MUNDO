"use strict";

// A music publication wraps an already sealed room and an ordered set of
// canonical PCM segments. The player requests one segment at a time and keeps
// no more than the two accepted by the mixer.
globalThis.MundoAudioMusic = (() => {
  const clips=typeof module!=="undefined"&&module.exports?require("./audio-clips.js"):globalThis.MundoAudioClips;
  const magic="MWMUSIC1", headerBytes=24, entryBytes=36;
  const maxSegments=80, maxMusicBytes=48*1024*1024;
  const maxBaseBytes=clips.maxRoomBytes;
  const maxBytes=headerBytes+maxBaseBytes+entryBytes*maxSegments+maxMusicBytes;
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  const bin=value=>value instanceof Uint8Array?value:new Uint8Array(value);
  const text=(bytes,at,count)=>String.fromCharCode(...bytes.subarray(at,at+count));
  const ascii=(bytes,at,value)=>{for(let i=0;i<value.length;i++)bytes[at+i]=value.charCodeAt(i);};
  const hex=bytes=>Array.from(bytes,n=>n.toString(16).padStart(2,"0")).join("");
  const bytesOf=hash=>Uint8Array.from({length:32},(_,i)=>parseInt(hash.slice(i*2,i*2+2),16));
  const keyOf=hash=>"s"+hash.slice(0,16);
  function idFromDigest(hash){
    const value=BigInt("0x"+hash.slice(0,16));
    return String(value||1n);
  }
  async function manifestDigest(segments){
    const source=new TextEncoder().encode("MUNDO/music/v1\n"+segments.map(item=>item.digest).join("\n")+"\n");
    return clips.digest(source);
  }
  async function verify(stream){
    check(stream&&Array.isArray(stream.segments)&&stream.segments.length>0&&stream.segments.length<=maxSegments,
      "Inventario de música inválido.");
    let total=0;
    for(let i=0;i<stream.segments.length;i++){
      const item=stream.segments[i];
      check(item.index===i&&item.key===keyOf(item.digest)&&/^[a-f0-9]{64}$/.test(item.digest),
        "Orden o identidad de segmento inválidos.");
      const bytes=clips.canonical(item.bytes);total+=bytes.length;
      check(total<=maxMusicBytes&&await clips.digest(bytes)===item.digest,"El segmento musical no coincide con su huella.");
    }
    const digest=await manifestDigest(stream.segments),id=idFromDigest(digest);
    check(stream.id===id&&(stream.digest===undefined||stream.digest===digest),"La pista musical no coincide con su inventario.");
    return {...stream,digest,id};
  }
  async function pack(input,prepared){
    const base=bin(input),stream=await verify(prepared);
    check(base.length>=24&&base.length<=maxBaseBytes,"La sala base de la música es inválida.");
    const total=stream.segments.reduce((sum,item)=>sum+item.bytes.length,0);
    const bytes=new Uint8Array(headerBytes+base.length+entryBytes*stream.segments.length+total);
    const view=new DataView(bytes.buffer);
    ascii(bytes,0,magic);view.setUint32(8,base.length,true);view.setUint32(12,stream.segments.length,true);
    view.setBigUint64(16,BigInt(stream.id),true);bytes.set(base,headerBytes);
    let at=headerBytes+base.length;
    for(const item of stream.segments){
      bytes.set(bytesOf(item.digest),at);view.setUint32(at+32,item.bytes.length,true);at+=entryBytes;
      bytes.set(item.bytes,at);at+=item.bytes.length;
    }
    return bytes;
  }
  function unpack(input){
    const bytes=bin(input);
    check(bytes.length>=headerBytes&&bytes.length<=maxBytes&&text(bytes,0,8)===magic,"Archivo musical de sala inválido.");
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const baseSize=view.getUint32(8,true),count=view.getUint32(12,true),id=String(view.getBigUint64(16,true));
    check(baseSize>=24&&baseSize<=maxBaseBytes&&count>0&&count<=maxSegments&&id!=="0"&&
      headerBytes+baseSize+entryBytes*count<=bytes.length,"Directorio musical inválido.");
    const base=bytes.subarray(headerBytes,headerBytes+baseSize),segments=[];
    let at=headerBytes+baseSize,total=0;
    for(let index=0;index<count;index++){
      check(at+entryBytes<=bytes.length,"Entrada musical incompleta.");
      const digest=hex(bytes.subarray(at,at+32)),size=view.getUint32(at+32,true);at+=entryBytes;total+=size;
      check(size>=46&&size<=clips.maxClipBytes&&total<=maxMusicBytes&&at+size<=bytes.length,"Tamaño de segmento musical inválido.");
      segments.push({index,key:keyOf(digest),digest,bytes:clips.canonical(bytes.subarray(at,at+size))});at+=size;
    }
    check(at===bytes.length,"Datos sobrantes en la sala musical.");
    return {base,stream:{id,segments}};
  }
  return Object.freeze({magic,maxBytes,maxSegments,maxMusicBytes,pack,unpack,verify,idFromDigest,manifestDigest});
})();
if(typeof module!=="undefined"&&module.exports)module.exports=globalThis.MundoAudioMusic;
