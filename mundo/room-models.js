"use strict";
// Optional appearance delivery never blocks the authoritative movement or sector loop.
globalThis.MundoRoomModels = function(view,link,report) {
  const mesh=MundoCreatorMesh, installed=new Set(), retries=new Map();
  let scope=null,scene=null,wanted=[],flight=null,used=0,pauseUntil=0,message="";
  function status(text) {
    if (message!==text) {message=text;report(text);}
  }
  function clear() {
    scope=null;scene=null;wanted=[];used=0;pauseUntil=0;retries.clear();
    flight?.abort();flight=null;
    if (installed.size) {
      const next=new Map(view.catalog);
      for (const key of installed) next.delete(BigInt("0x"+key));
      view.setCatalog(next);installed.clear();
    }
    status("");
  }
  function update() {
    if (!link.modelsOffered || !link.lease || !link.revision || link.project) {if(scope)clear();return;}
    if (!scope || scope.lease!==link.lease || scope.revision!==link.revision) {
      clear();scope={lease:link.lease,revision:link.revision};
    }
    if (scene!==view.scene) {
      scene=view.scene;
      const usedHere=new Set();
      for (const entry of scene.objects) {
        if (mesh.isCreatorKey(entry.n.visual)) usedHere.add(entry.n.visual.toString(16));
        // A valid publication is capped at 64 distinct creator meshes.
        if (usedHere.size>=64) break;
      }
      wanted=Array.from(usedHere);
    }
    const now=performance.now();
    if (flight || now<pauseUntil) return;
    const key=wanted.find(id=>!installed.has(id) && (retries.get(id)?.after??0)<=now);
    if (!key) {
      status(wanted.some(id=>!installed.has(id) && retries.get(id)?.after===Infinity)
        ? "Algunos modelos de esta sala se muestran con su forma provisional." : "");
      return;
    }
    const ticket=scope, request=flight=new AbortController();
    const current=()=>scope===ticket && link.modelsOffered && link.lease===ticket.lease && link.revision===ticket.revision;
    const timeout=setTimeout(()=>request.abort(),20000);
    async function download() {
      const response=await link.call("model",{...ticket,key},null,request.signal,true);
      const digest=response.headers.get("x-mundo-model-digest");
      if (!digest || !/^[0-9a-f]{64}$/.test(digest) || mesh.keyOf(digest)!==key) throw mundoRoomError("Identidad de modelo inválida.");
      const bytes=await mundoRoomBytes(response,mesh.maxBytes);
      if (!current()) return;
      if (await MundoRoomFile.digest(bytes)!==digest) throw mundoRoomError("El modelo no coincide con la publicación.");
      if (!current()) return;
      const {triangles}=mesh.validate(bytes);
      if (installed.size>=64 || used+triangles>180000) throw mundoRoomError("El inventario de modelos supera el presupuesto de sala.");
      const next=new Map(view.catalog);
      next.set(BigInt("0x"+key),mesh.forDrawing(bytes));
      view.setCatalog(next);installed.add(key);used+=triangles;retries.delete(key);
    }
    void download().catch(error=>{
      if (!current()) return;
      if (error.status===429) {pauseUntil=performance.now()+5500;return;}
      const count=(retries.get(key)?.count??0)+1;
      const done=count>=3 || [400,403,404,409,410,422].includes(error.status);
      retries.set(key,{count,after:done?Infinity:performance.now()+2000*count});
    }).finally(()=>{
      clearTimeout(timeout);
      if (flight===request) flight=null;
    });
  }
  return Object.freeze({update,clear});
};
