"use strict";
const fs=require("node:fs");
const path=require("node:path");

// Supply the cooked catalog from this installation. A world cannot select a file path.
function readBruma(){
  const file=path.join(__dirname,"../authoring/bruma/vault/bruma.mlook");
  let fd;
  try{
    fd=fs.openSync(file,"r");
    const stat=fs.fstatSync(fd);
    if(!stat.isFile() || stat.size<13 || stat.size>4*1024*1024)throw Error();
    const bytes=Buffer.alloc(stat.size);
    for(let offset=0;offset<bytes.length;){
      const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);
      if(count===0)throw Error();
      offset+=count;
    }
    if(bytes.toString("ascii",0,8)!=="MWLOOK01" || bytes[8]!==1 || bytes.readUInt32LE(9)!==6)throw Error();
    return bytes;
  }catch{
    throw Object.assign(Error("No se pudo abrir el modelo de distribución de Bruma en el archivo privado."),{status:422});
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={readBruma};
