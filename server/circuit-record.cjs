"use strict";
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {randomUUID}=require("node:crypto");

function defaultRoot(){
  if(process.platform==="win32")
    return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),"MundoEngie","circuitos");
  if(process.platform==="darwin")return path.join(os.homedir(),"Library","Application Support","MundoEngie","circuitos");
  return path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),".local","state"),"mundo-engie","circuitos");
}
const filename=seq=>"marca-"+String(seq).padStart(16,"0")+".json";
const missing=error=>error.code==="ENOENT";
function validSplits(splits,ms){
  if(!Array.isArray(splits) || splits.length<1 || splits.length>32 || splits[splits.length-1]!==ms)return false;
  let previous=0;
  for(const time of splits){
    if(!Number.isSafeInteger(time) || time<previous)return false;
    previous=time;
  }
  return true;
}
function preferred(first,second){
  if(first===null)return second;
  if(second===null)return first;
  if(second.ms<first.ms || (second.ms===first.ms && first.splits===null && second.splits!==null))return second;
  return first;
}

// Readers see only complete, immutable records. Two local hosts competing for the
// next sequence use an exclusive hard link within the same directory.
class CircuitRecord {
  constructor(hash,root=defaultRoot()){
    if(!/^[0-9a-f]{64}$/.test(hash))throw Error("Huella de publicación inválida.");
    this.hash=hash;this.dir=path.join(root,hash.slice(0,2),hash);
    this.saved=null;this.pending=null;this.writing=null;this.problem=false;
  }
  get best(){return this.saved?.ms??null;}
  get splits(){return this.saved?.splits?.slice()??null;}
  get busy(){return this.writing!==null;}
  async exists(seq){
    try{await fs.lstat(path.join(this.dir,filename(seq)));return true;}
    catch(error){if(missing(error))return false;throw error;}
  }
  async latest(){
    let lo=0,hi=1;
    while(await this.exists(hi)){
      lo=hi;
      if(hi>Math.floor(Number.MAX_SAFE_INTEGER/2))throw Error("Historial de circuito agotado.");
      hi*=2;
    }
    while(hi-lo>1){
      const mid=lo+Math.floor((hi-lo)/2);
      if(await this.exists(mid))lo=mid;else hi=mid;
    }
    if(!lo)return {seq:0,ms:null,splits:null};
    const file=await fs.open(path.join(this.dir,filename(lo)),"r");
    try{
      const stat=await file.stat();
      if(!stat.isFile() || stat.size<2 || stat.size>1024)throw Error("Registro local ilegible.");
      const bytes=Buffer.alloc(stat.size);
      let offset=0;
      while(offset<bytes.length){
        const read=await file.read(bytes,offset,bytes.length-offset,offset);
        if(!read.bytesRead)throw Error("Registro local incompleto.");
        offset+=read.bytesRead;
      }
      const data=JSON.parse(bytes.toString("utf8"));
      if(!data || (data.version!==1 && data.version!==2) || data.hash!==this.hash || data.seq!==lo ||
         !Number.isSafeInteger(data.ms) || data.ms<0 ||
         (data.version===2 && data.splits!==null && !validSplits(data.splits,data.ms)))
        throw Error("Registro local incompatible.");
      return {seq:lo,ms:data.ms,splits:data.version===1?null:data.splits};
    }finally{await file.close();}
  }
  async append(seq,mark){
    const dest=path.join(this.dir,filename(seq)),temp=path.join(this.dir,"."+randomUUID()+".tmp");
    const file=await fs.open(temp,"wx",0o600);
    try{
      try{
        await file.writeFile(JSON.stringify({version:2,hash:this.hash,seq,ms:mark.ms,splits:mark.splits}),"utf8");
        await file.sync();
      }finally{await file.close();}
      try{await fs.link(temp,dest);}
      catch(error){if(error.code==="EEXIST")return false;throw error;}
      if(process.platform!=="win32"){
        const folder=await fs.open(this.dir,"r");
        try{await folder.sync();}finally{await folder.close();}
      }
      return true;
    }finally{await fs.unlink(temp).catch(()=>{});}
  }
  async load(){
    try{
      const latest=await this.latest();
      if(latest.ms!==null)this.saved=preferred(latest,this.saved);
      this.problem=false;
    }
    catch{this.problem=true;}
  }
  offer(ms,splits=null){
    if(!Number.isSafeInteger(ms) || ms<0)return;
    this.pending=preferred(this.pending,{ms,splits:validSplits(splits,ms)?splits.slice():null});
    if(!this.busy)void this.flush();
  }
  flush(){
    if(!this.writing)this.writing=this.writePending();
    return this.writing;
  }
  async writePending(){
    try{
      if(this.pending===null){await this.load();if(this.pending===null)return;}
      await fs.mkdir(this.dir,{recursive:true,mode:0o700});
      for(let attempts=0;this.pending!==null && attempts<16;attempts++){
        const latest=await this.latest();
        if(latest.ms!==null){
          this.saved=preferred(latest,this.saved);
          if(preferred(latest,this.pending)===latest){this.pending=null;break;}
        }
        const candidate=this.pending;
        if(await this.append(latest.seq+1,candidate)){
          this.saved=preferred(this.saved,candidate);
          if(candidate===this.pending)this.pending=null;
        }
      }
      this.problem=this.pending!==null;
    }catch{this.problem=true;}
    finally{this.writing=null;}
  }
  status(){
    return {state:this.busy?"saving":this.problem?"unavailable":this.best===null?"empty":"saved",bestMs:this.best};
  }
}
module.exports={CircuitRecord};
