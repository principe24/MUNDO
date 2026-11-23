"use strict";
// The hosted format contains a sealed room followed by canonical WAV files.
// It carries no source filenames, URLs, executable content or filesystem paths.
globalThis.MundoAudioClips = (() => {
  const rate=24000, maxFrames=rate*16, maxClipBytes=44+2*maxFrames;
  const maxBankBytes=8*1024*1024, maxBase=25*1024*1024, maxSources=16;
  // The combined package permits one MROOM3D1 base, with that format's own 12 MiB mesh budget.
  const maxModelBase=16+24*1024*1024+2068+12*1024*1024;
  const maxRoomBytes=16+maxModelBase+maxBankBytes+36*maxSources;
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const bin=value=>value instanceof Uint8Array?value:new Uint8Array(value);
  const txt=(b,at,n)=>String.fromCharCode(...b.subarray(at,at+n));
  const ascii=(b,at,s)=>{for(let i=0;i<s.length;i++)b[at+i]=s.charCodeAt(i);};
  const hex=b=>Array.from(b,n=>n.toString(16).padStart(2,"0")).join("");
  const keyOf=digest=>"s"+digest.slice(0,16);
  function layout(input,limits={bytes:16*1024*1024,seconds:16}){
    const b=bin(input), v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    check(b.length>=44 && b.length<=limits.bytes && txt(b,0,4)==="RIFF" &&
      v.getUint32(4,true)===b.length-8 && txt(b,8,4)==="WAVE","El archivo debe ser un WAV RIFF completo.");
    let fmt=null, data=null, at=12;
    while(at<b.length){
      check(at+8<=b.length,"Cabecera de bloque WAV incompleta.");
      const name=txt(b,at,4),size=v.getUint32(at+4,true);at+=8;
      check(size<=b.length-at && at+size+(size%2)<=b.length,"Tamaño de bloque WAV inválido.");
      if(name==="fmt "){
        check(!fmt && (size===16 || (size===18 && v.getUint16(at+16,true)===0)),"Formato WAV repetido o incompatible.");
        fmt={format:v.getUint16(at,true),channels:v.getUint16(at+2,true),sampleRate:v.getUint32(at+4,true),
          byteRate:v.getUint32(at+8,true),stride:v.getUint16(at+12,true),bits:v.getUint16(at+14,true)};
      }else if(name==="data"){
        check(!data && size>0,"El WAV debe contener un único bloque de muestras.");
        data={at,size};
      }
      at+=size+(size%2);
    }
    check(fmt && data,"Faltan el formato o las muestras del WAV.");
    const {format,channels,sampleRate,byteRate,stride,bits}=fmt;
    check((format===1 && [8,16,24,32].includes(bits) || format===3 && bits===32) &&
      (channels===1 || channels===2) && sampleRate>=8000 && sampleRate<=96000 &&
      stride===bits/8*channels && byteRate===sampleRate*stride && data.size%stride===0,
      "Usa WAV PCM mono o estéreo de 8 a 96 kHz.");
    const frames=data.size/stride;
    check(frames>0 && frames<=sampleRate*limits.seconds,
      limits.seconds===16?"Cada grabación admite hasta 16 segundos.":"La pista musical supera el tiempo admitido.");
    return {v,fmt,data,frames};
  }
  function decode(input,limits){
    const {v,fmt,data,frames}=layout(input,limits), samples=new Float32Array(frames);
    let at=data.at;
    for(let i=0;i<frames;i++){
      let sum=0;
      for(let c=0;c<fmt.channels;c++,at+=fmt.bits/8){
        let n;
        if(fmt.format===3)n=v.getFloat32(at,true);
        else if(fmt.bits===8)n=(v.getUint8(at)-128)/128;
        else if(fmt.bits===16)n=v.getInt16(at,true)/32768;
        else if(fmt.bits===24)n=((v.getUint8(at)<<8 | v.getUint8(at+1)<<16 | v.getUint8(at+2)<<24)>>8)/8388608;
        else n=v.getInt32(at,true)/2147483648;
        check(Number.isFinite(n),"El WAV contiene una muestra no finita.");
        sum+=Math.max(-1,Math.min(1,n));
      }
      samples[i]=sum/fmt.channels;
    }
    return {sampleRate:fmt.sampleRate,samples};
  }
  function canonical(input){
    const b=bin(input),{fmt,data}=layout(b);
    check(fmt.format===1 && fmt.channels===1 && fmt.bits===16 && fmt.sampleRate===rate &&
      b.length===44+data.size && data.at===44 && txt(b,12,4)==="fmt " && txt(b,36,4)==="data",
      "La grabación de sala requiere PCM mono de 24 kHz.");
    return b;
  }
  // Windowed-sinc low pass before decimation. Precompute fractional phases
  // once per conversion so the cost per output frame is bounded.
  function resample(input,hz){
    if(hz===rate)return input;
    const cutoff=Math.min(1,rate/hz), radius=Math.ceil(12/cutoff), phases=128;
    const taps=Array.from({length:phases},(_,phase)=>{
      const w=new Float64Array(radius*2);let total=0;
      for(let k=0;k<w.length;k++){
        const x=k-radius+1-phase/phases,u=Math.PI*x*cutoff;
        w[k]=Math.abs(x)>=radius?0:cutoff*(u===0?1:Math.sin(u)/u)*(.5+.5*Math.cos(Math.PI*x/radius));
        total+=w[k];
      }
      return w.map(v=>v/total);
    });
    const out=new Float32Array(Math.max(1,Math.round(input.length*rate/hz)));
    for(let i=0;i<out.length;i++){
      const x=i*hz/rate,base=Math.floor(x),w=taps[Math.floor((x-base)*phases)];let sum=0;
      for(let k=0;k<w.length;k++)sum+=w[k]*input[Math.max(0,Math.min(input.length-1,base+k-radius+1))];
      out[i]=sum;
    }
    return out;
  }
  function encodeMono(samples){
    check(Number.isInteger(samples?.length) && samples.length>=1 && samples.length<=maxFrames,"Grabación fuera del límite por fuente.");
    const b=new Uint8Array(44+samples.length*2),v=new DataView(b.buffer);
    ascii(b,0,"RIFF");v.setUint32(4,b.length-8,true);ascii(b,8,"WAVEfmt ");v.setUint32(16,16,true);
    v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);
    v.setUint16(32,2,true);v.setUint16(34,16,true);ascii(b,36,"data");v.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++){
      const value=samples[i];
      check(Number.isFinite(value),"La muestra de salida debe ser finita.");
      v.setInt16(44+2*i,Math.max(-32768,Math.min(32767,Math.round(value*32768))),true);
    }
    return b;
  }
  async function digest(bytes){
    const subtle=globalThis.crypto?.subtle??(typeof require==="function"?require("node:crypto").webcrypto.subtle:null);
    check(subtle,"El catálogo requiere SHA-256 disponible.");
    return hex(new Uint8Array(await subtle.digest("SHA-256",bytes)));
  }
  async function prepare(input){
    const source=decode(input),bytes=encodeMono(resample(source.samples,source.sampleRate)),hash=await digest(bytes);
    return {key:keyOf(hash),digest:hash,bytes};
  }
  async function prepareMusic(input){
    const source=decode(input,{bytes:64*1024*1024,seconds:960});
    const samples=resample(source.samples,source.sampleRate), segmentFrames=rate*12, segments=[];
    check(samples.length<=rate*960,"La pista musical admite hasta 16 minutos.");
    for(let at=0;at<samples.length;at+=segmentFrames){
      const bytes=encodeMono(samples.subarray(at,Math.min(samples.length,at+segmentFrames)));
      const hash=await digest(bytes);
      segments.push({index:segments.length,key:keyOf(hash),digest:hash,bytes});
    }
    const manifest=new TextEncoder().encode("MUNDO/music/v1\n"+segments.map(item=>item.digest).join("\n")+"\n");
    const hash=await digest(manifest), raw=BigInt("0x"+hash.slice(0,16));
    return {id:String(raw||1n),digest:hash,segments};
  }
  async function verify(key,input,expected){
    // The caller may edit or recycle the input while the asynchronous digest runs.
    const bytes=new Uint8Array(canonical(input)), hash=await digest(bytes);
    check(keyOf(hash)===key && (expected===undefined || expected===hash),"La grabación no coincide con su huella.");
    return decode(bytes);
  }
  function hasModels(base) {return txt(base,0,8)==="MROOM3D1";}
  const maxProjectBase=64*1024*1024;
  function unpackBank(input,project){
    const b=bin(input);
    const magic=txt(b,0,8), combined=magic==="MWAUDIO2";
    check(b.length>=16 && b.length<=(project?16+maxProjectBase+maxBankBytes+36*maxSources:maxRoomBytes) && (project?magic==="MPRAUD01":combined || magic==="MWAUDIO1"),"Archivo de sala con audio inválido.");
    const v=new DataView(b.buffer,b.byteOffset,b.byteLength),base=v.getUint32(8,true),count=v.getUint32(12,true);
    check(base>=24 && base<=(project?maxProjectBase:combined?maxModelBase:maxBase) && count>0 && count<=maxSources && 16+base+count*36<=b.length,"Directorio de audio inválido.");
    const room=b.subarray(16,16+base), items=[];let at=16+base,previous="",total=0;
    check(project?txt(room,0,8)==="MUNDOPRJ":hasModels(room)===combined,"La cabecera de audio no coincide con la sala adjunta.");
    for(let i=0;i<count;i++){
      check(at+36<=b.length,"Entrada de audio incompleta.");
      const hash=hex(b.subarray(at,at+32)), key=keyOf(hash), size=v.getUint32(at+32,true);at+=36;total+=size;
      check(key>previous && size<=maxClipBytes && total<=maxBankBytes && size<=b.length-at,"Contenido repetido o tamaño de audio inválido.");
      items.push({key,digest:hash,bytes:canonical(b.subarray(at,at+size))});previous=key;at+=size;
    }
    check(at===b.length,"Datos sobrantes en la sala con audio.");
    return {room,items};
  }
  async function packBank(input,collection,project){
    const room=bin(input),items=[...collection].sort((a,b)=>a.key.localeCompare(b.key));
    const combined=hasModels(room);
    check(room.length>=24 && room.length<=(project?maxProjectBase:combined?maxModelBase:maxBase) && (!project || txt(room,0,8)==="MUNDOPRJ") && items.length && items.length<=maxSources,"Elige una sala con grabaciones.");
    const total=items.reduce((n,item)=>n+item.bytes.length,0);check(total<=maxBankBytes,"La sala admite hasta 8 MiB de grabaciones.");
    const b=new Uint8Array(16+room.length+36*items.length+total),v=new DataView(b.buffer);
    ascii(b,0,project?"MPRAUD01":combined?"MWAUDIO2":"MWAUDIO1");v.setUint32(8,room.length,true);v.setUint32(12,items.length,true);b.set(room,16);
    let at=16+room.length,previous="";
    const entries=[];
    // Freeze payloads and metadata before the first asynchronous hash. The bank
    // itself holds the snapshot, so validating it requires no second payload copy.
    for(const item of items){
      const bytes=canonical(item.bytes), key=item.key;
      check(typeof key==="string" && /^s[0-9a-f]{16}$/.test(key) && key>previous,"Conflicto en el catálogo de sonidos.");
      const header=at;
      v.setUint32(at+32,bytes.length,true);at+=36;b.set(bytes,at);
      entries.push({key,digest:item.digest,header,bytes:b.subarray(at,at+bytes.length)});
      at+=bytes.length;previous=key;
    }
    for(const item of entries){
      const hash=await digest(item.bytes);
      check(keyOf(hash)===item.key && (item.digest===undefined || item.digest===hash),"Conflicto en el catálogo de sonidos.");
      for(let j=0;j<32;j++)b[item.header+j]=parseInt(hash.slice(j*2,j*2+2),16);
    }
    return b;
  }
  const pack=(input,items)=>packBank(input,items,false), unpack=input=>unpackBank(input,false);
  const packProjectBank=(input,items)=>packBank(input,items,true);
  function unpackProjectBank(input){const {room,items}=unpackBank(input,true);return {project:room,items};}
  function match(sources,items){
    const keys=new Set(sources.map(s=>s.preset).filter(p=>/^s[0-9a-f]{16}$/.test(p)));
    check(keys.size===items.length && items.every(item=>keys.delete(item.key)) && keys.size===0,"Las grabaciones deben corresponder exactamente a las fuentes de la sala.");
  }
  return Object.freeze({decode,canonical,encodeMono,prepare,prepareMusic,verify,digest,pack,unpack,packProjectBank,unpackProjectBank,match,hasModels,maxClipBytes,maxRoomBytes,maxBankBytes,rate});
})();
if(typeof module!=="undefined" && module.exports)module.exports=globalThis.MundoAudioClips;
