"use strict";
(() => {
  function adminCredential() {
    if (location.protocol !== "http:" || location.hostname !== "127.0.0.1" ||
        !location.pathname.startsWith("/studio/")) return null;
    try {
      const token = sessionStorage.getItem("mundo.host.session");
      return /^[0-9a-f]{64}$/.test(token || "") ? token : null;
    } catch { return null; }
  }
  async function capture(state) {
    if (state.publication) {
      const base=await MundoPublications.roomDownload(state.publication);
      return state.world ? MundoPublications.withModels(base,state.world) : base;
    }
    const title = (state.project?.name || state.title || "Mi mundo").trim();
    const name = title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0,65) || "Mundo";
    if (state.project) {
      const result=await MundoAudioProject.exportProject(state.project,state.includeAudio?MundoAudioLibrary.get:null);
      return {blob:result.blob,filename:name+(result.hasAudio?".mprojectaudio":".mproject")};
    }
    const bytes = MundoWorld.encode(state.world);
    const info = {title, revision:1, vehicleRoot:state.vehicleRoot ?? null,
      meetingPoint:MundoRoomFile.copyMeetingPoint(state.meetingPoint), hash:await MundoRoomFile.digest(bytes)};
    const file = await MundoRoomFile.seal(info, bytes);
    const base={blob:new Blob([file],{type:"application/octet-stream"}),filename:name+".mroom"};
    return typeof MundoModelRoom!=="undefined" && typeof MundoCreatorAssets!=="undefined"
      ? MundoPublications.withModels(base,state.world) : base;
  }
  async function call(route, token, version, file) {
    const headers = {"x-mundo-host":token, "x-mundo-version":String(version)};
    if (file) {
      headers["content-type"] = "application/octet-stream";
      headers["x-mundo-file"] = encodeURIComponent(file.filename);
    }
    const response = await fetch("/api/"+route,{method:"POST", headers, body:file?.blob,
      credentials:"omit", redirect:"error", cache:"no-store", referrerPolicy:"no-referrer"});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "No se pudo preparar la sala.");
    return result;
  }
  function download(file) {
    const url = URL.createObjectURL(file.blob), anchor = document.createElement("a");
    try {
      anchor.href=url; anchor.download=file.filename; document.body.append(anchor); anchor.click();
    } finally { anchor.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000); }
  }
  window.MundoPrepararSala = (button, snapshot, say) => {
    let busy=false,openPanel=null;
    function offerPanel(){
      if(!openPanel){
        openPanel=document.createElement("button");
        openPanel.type="button";openPanel.textContent="Revisar e invitar en el panel";
        openPanel.onclick=()=>{
          // A same-origin tab inherits the current operator session. The draft stays open.
          const panel=window.open("/","_blank");
          if(panel)panel.opener=null;
          else say("El navegador bloqueó el panel. Ábrelo desde la ventana del anfitrión.");
        };
        button.after(openPanel);
      }
    }
    button.onclick=async () => {
      if(busy)return;
      busy=true; button.setAttribute("aria-busy","true");
      try {
        const selection=snapshot(), token=adminCredential();
        // Capture editor data before yielding control to another authoring gesture.
        const file=await capture(selection);
        if(!token) {
          download(file); say("En el panel del anfitrión, elige Preparar archivo y selecciona "+file.filename+"."); return;
        }
        const state=await call("state",token,-1);
        if(state.room)throw Error("Ya hay una sala abierta. Ciérrala en el panel antes de preparar otra.");
        if(state.preview && !window.confirm("¿Sustituir la revisión preparada «"+state.preview.title+"»?"))return;
        await call("prepare",token,state.version,file);
        offerPanel();say("Revisión preparada. Ábrela en el panel para elegir la red y crear las invitaciones.");
      } catch(error) { say(error.message || "No se pudo preparar la sala."); }
      finally {busy=false;button.removeAttribute("aria-busy");}
    };
  };
})();
