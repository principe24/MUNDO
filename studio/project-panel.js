"use strict";
window.MundoProjectPanel = function({captureDraft, selectedPublication, beginEdit, plugins}) {
  const el = id => document.getElementById(id);
  const name = el("projectName"), list = el("projectWorlds"), fileInput = el("projectFile");
  let worlds = [], portals = [], start = null, busy = false, studioPlugins;
  const share = el("projectShare");
  const hostedPractices = el("projectControls").querySelectorAll("a[data-room-sha256]");
  const systemShare = typeof navigator.share === "function" && typeof navigator.canShare === "function" &&
    typeof File === "function";
  let shareGeneration = 0, shareFile = null;
  const fileName = (value,extension=".mproject") => (value.replace(/[^\p{L}\p{N}_-]+/gu,"_").slice(0,65) || "Juego") + extension;
  const selected = () => worlds.find(entry => entry.id === Number(list.value));
  const title = () => name.value.trim();
  function status(message) { el("projectStatus").textContent = message; }
  // Prepare the immutable file before the user's tap. System share sheets require
  // an active gesture, which can expire while awaiting the index digest.
  function prepareShare() {
    const generation = ++shareGeneration;
    shareFile = null;
    share.hidden = true;
    if (!systemShare || !worlds.length || !title()) return;
    const snapshot = {name:title(), start, worlds, portals, studioPlugins};
    MundoProject.pack(snapshot).then(blob => {
      if (generation !== shareGeneration) return;
      const file = new File([blob],fileName(snapshot.name),{type:"application/vnd.mundo.project"});
      if (navigator.canShare({files:[file]})) {
        shareFile = file;
        share.hidden = false;
      }
    }).catch(() => { /* Guardar proyecto remains available. */ });
  }
  share.onclick = () => run(async () => {
    if (!shareFile) return;
    try {
      await navigator.share({files:[shareFile]});
      status("El sistema recibió el proyecto. Puedes abrirlo desde MUNDO.");
    } catch (error) {
      if (error.name !== "AbortError") status("Usa Guardar proyecto y elige el archivo desde MUNDO.");
    }
  });
  const tileList=el("portalTile"), targetList=el("portalTarget");
  function selectedLink() {
    return portals.find(link => link.from === selected()?.id && link.tile === tileList.value);
  }
  const tileFilter=el("portalFilter");
  function renderTiles(tileId) {
    const origin=selected(), tiles=origin?.tiles ?? [];
    const targets=worlds.filter(row => origin && row.id !== origin.id);
    const titles=new Map(targets.map(row => [row.id,row.title+" · #"+row.id]));
    const assigned=new Map(portals.filter(link => link.from===origin?.id).map(link => [link.tile,link.to]));
    tileFilter.hidden=el("portalFilterLabel").hidden=tiles.length<=100;
    const filter=tileFilter.hidden?"":tileFilter.value.trim().toLocaleLowerCase();
    const options=document.createDocumentFragment();
    let listed=0, hasSelection=false, truncated=false;
    for(const tile of tiles){
      if(filter && !tile.id.includes(filter) && !tile.name.toLocaleLowerCase().includes(filter))continue;
      if(listed>=100 && tile.id!==tileId){truncated=true;continue;}
      options.append(new Option(tile.name+" · #"+tile.id+
        (assigned.has(tile.id)?" → "+titles.get(assigned.get(tile.id)):" · Sin destino"),tile.id));
      hasSelection ||= tile.id===tileId;++listed;
    }
    tileList.replaceChildren(options);
    if(!listed)tileList.add(new Option(tiles.length?"Sin coincidencias":"Sin baldosas en esta copia",""));
    if(truncated){
      const hint=new Option("Busca por nombre o ID para ver otras baldosas","");
      hint.disabled=true;tileList.add(hint);
    }
    if(hasSelection)tileList.value=tileId;
    targetList.replaceChildren(...targets.map(row => new Option(titles.get(row.id),String(row.id))));
    if (!targets.length) targetList.add(new Option("Añade otro mundo al proyecto",""));
    if (selectedLink()) targetList.value=String(selectedLink().to);
    sync();
  }
  tileFilter.oninput=()=>renderTiles();
  tileList.onchange=()=>{const link=selectedLink();if(link)targetList.value=String(link.to);sync();};
  targetList.onchange=()=>sync();
  function sync() {
    const chosen = selected();
    el("projectControls").disabled = busy;
    list.disabled = !worlds.length;
    tileList.disabled = !tileList.value;
    targetList.disabled = tileList.disabled || worlds.length < 2;
    el("portalLink").disabled = targetList.disabled || selectedLink()?.to === Number(targetList.value);
    el("portalUnlink").disabled = !selectedLink();
    el("projectDraft").disabled = worlds.length >= MundoProject.maxWorlds;
    el("projectRelease").disabled = worlds.length >= MundoProject.maxWorlds || !selectedPublication();
    for (const id of ["projectEdit","projectUpdate","projectRemove"]) el(id).disabled = !chosen;
    el("projectStart").disabled = !chosen || chosen.id === start;
    el("projectSave").disabled = el("projectSaveAudio").disabled = !worlds.length || !title();
    el("projectPlay").hidden = busy || !worlds.length || !title();
    for (const link of hostedPractices) link.hidden = busy || chosen?.hash !== link.dataset.roomSha256;
  }
  function render(id) {
    list.replaceChildren(...worlds.map(entry => {
      const origin = entry.source === "draft" ? "borrador" : "publicación v" + entry.revision;
      const label = (entry.id === start ? "Inicial · " : "") + entry.title + " · " + origin + " · #" + entry.id +
        (entry.gateCount ? " · "+entry.gateCount+" puerta(s) · "+MundoCourseTiming.startLabel(entry.startMode) : "");
      return new Option(label,String(entry.id));
    }));
    if (id != null) list.value = String(id);
    tileFilter.value="";renderTiles();prepareShare();
  }
  async function run(work) {
    if (busy) return;
    busy = true; sync();
    try { await work(); }
    catch (error) { status(error.message || "No se pudo completar la operación del proyecto."); }
    finally { busy = false; sync(); }
  }
  function writeEntry(entry, replace, nextLinks=portals) {
    const next = replace ? worlds.map(item => item.id === entry.id ? entry : item) : [...worlds,entry];
    const first = start ?? entry.id;
    MundoProject.check({name:title(), start:first, worlds:next, portals:nextLinks, studioPlugins});
    worlds = next; start = first; portals=nextLinks;
    render(entry.id);
  }
  function nextId() {
    let id = 1;
    while (worlds.some(entry => entry.id === id)) ++id;
    return id;
  }
  list.onchange = () => {tileFilter.value="";renderTiles();};
  function changeLink(remove) {
    const origin=selected(), tile=tileList.value;
    if (!origin || !tile || busy) return;
    run(async()=>{
      const links=portals.filter(link => link.from!==origin.id || link.tile!==tile);
      if (!remove) links.push({from:origin.id,tile,to:Number(targetList.value)});
      MundoProject.check({name:title(),start,worlds,portals:links,studioPlugins});
      portals=links;renderTiles(tile);prepareShare();
      status(remove?"Enlace retirado. La baldosa sigue en el mundo.":"Destino guardado. Guarda el proyecto para llevarlo a MUNDO.");
    });
  }
  el("portalLink").onclick=()=>changeLink(false);
  el("portalUnlink").onclick=()=>changeLink(true);
  name.oninput = () => { prepareShare(); sync(); };
  function setProfile(capture) {
    if (busy) return;
    run(async () => {
      const next = capture ? plugins.captureProfile() : undefined;
      if (worlds.length) MundoProject.check({name:title(),start,worlds,portals,studioPlugins:next});
      plugins.useProfile(next);
      studioPlugins = next;
      prepareShare();
      status(capture ? "Perfil de plugins fijado. Guarda el proyecto." : "El proyecto vuelve a usar el catálogo local.");
    });
  }
  el("projectPluginCapture").onclick = () => setProfile(true);
  el("projectPluginClear").onclick = () => setProfile(false);
  el("projectDraft").onclick = () => run(async () => {
    const entry = await captureDraft(nextId());
    writeEntry(entry,false);
    status("Borrador añadido al proyecto: " + entry.title + ".");
  });
  el("projectRelease").onclick = () => run(async () => {
    const info = selectedPublication();
    if (!info) throw Error("Selecciona una publicación guardada.");
    const {blob} = await MundoPublications.roomDownload(info);
    const entry = await MundoProject.publication(nextId(),blob);
    writeEntry(entry,false);
    status("Publicación añadida al proyecto: " + entry.title + " · v" + entry.revision + ".");
  });
  el("projectUpdate").onclick = () => run(async () => {
    const old = selected();
    if (!old || !window.confirm("¿Sustituir la copia de «" + old.title + "» del proyecto con el borrador actual?")) return;
    const entry = await captureDraft(old.id);
    const kept=new Set(entry.gates.map(gate=>gate.id));
    const removed=old.gates.filter(gate=>!kept.has(gate.id));
    if(removed.length && !window.confirm("La nueva copia retira "+removed.length+" puerta(s), entre ellas «"+
      removed[0].label+"». ¿Sustituir la pista del proyecto?"))return;
    const outgoing=portals.filter(link=>link.from===old.id);
    const tiles=new Set(entry.tiles.map(tile=>tile.id));
    const nextLinks=portals.filter(link=>link.from!==old.id || tiles.has(link.tile));
    if(outgoing.length && old.hash!==entry.hash && !window.confirm(
      "Hay "+outgoing.length+" enlace(s) de salida. Se conservarán los que tengan el mismo ID de baldosa en el borrador. "+
      "Se retirarán "+(portals.length-nextLinks.length)+". ¿Aplicar la sustitución?")) return;
    writeEntry(entry,true,nextLinks);
    status("Copia actualizada con el borrador. Guarda el proyecto para descargar los cambios.");
  });
  el("projectEdit").onclick = () => run(async () => {
    const entry = selected();
    if (!entry) return;
    const install = beginEdit();
    const room = await MundoProject.load(entry);
    install(room);
    status("Mundo abierto para editar. Deshacer recupera el borrador anterior.");
  });
  el("projectStart").onclick = () => {
    const entry = selected();
    if (!entry) return;
    start = entry.id; render(start); status("La partida comenzará en «" + entry.title + "».");
  };
  el("projectRemove").onclick = () => {
    const entry = selected();
    if (!entry) return;
    const links=portals.filter(link=>link.from!==entry.id && link.to!==entry.id);
    const count=portals.length-links.length;
    if (!window.confirm("¿Quitar «"+entry.title+"» del proyecto?"+(count?" También se retirarán "+count+" enlace(s) de portal.":""))) return;
    portals=links;
    worlds = worlds.filter(item => item !== entry);
    if (entry.id === start) start = worlds[0]?.id ?? null;
    render(start); status("Mundo retirado del proyecto.");
  };
  el("projectOpen").onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const file = fileInput.files[0]; fileInput.value = "";
    if (!file) return;
    run(async () => {
      const accept = index => !worlds.length || window.confirm("¿Abrir «" + index.name + "» y sustituir la colección actual del proyecto?");
      const magic = await file.slice(0,8).text();
      let next;
      if (magic === "MPRAUD01" || magic === "MPMUSIC1") {
        next = await MundoAudioLibrary.openProject(file,accept);
        if (!next) return;
      } else {
        next = await MundoProject.open(file);
        if (!accept(next)) return;
      }
      worlds = next.worlds; portals=next.portals; start = next.start; name.value = next.name;
      el("projectPlayAudio").checked=false;
      studioPlugins = next.studioPlugins; plugins.useProfile(studioPlugins);
      render(start);
      status("Proyecto abierto. «Editar mundo elegido» abre una copia en el borrador.");
    });
  };
  function download(blob,filename) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    try {
      a.href = url;
      a.download = filename;
      document.body.append(a); a.click(); status("Descarga solicitada. Puedes prepararlo en el panel del anfitrión.");
    } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url),60000); }
  }
  const current = () => ({name:title(),start,worlds,portals,studioPlugins});
  el("projectSave").onclick = () => run(async () => {
    const project = current();
    download(shareFile || await MundoProject.pack(project),fileName(project.name));
  });
  el("projectSaveAudio").onclick = () => run(async () => {
    const project = current(), result = await MundoAudioMusicProject.exportProject(project,MundoAudioLibrary.get,MundoAudioLibrary.getMusic);
    if (!result.hasAudio&&!result.hasMusic) throw Error("Añade una grabación o música larga para exportar el audio del proyecto.");
    download(result.blob,fileName(project.name,result.hasMusic?".mprojectmusic":".mprojectaudio"));
  });
  MundoPrepararSala(el("projectPlay"),()=>{
    if(busy || !worlds.length)throw Error("Añade un mundo al proyecto.");
    return {project:{name:title(),start,worlds:worlds.slice(),portals:portals.slice()},
      includeAudio:el("projectPlayAudio").checked};
  },status);
  renderTiles();
  return {sync};
};
