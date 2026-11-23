"use strict";
globalThis.MundoCreatorModelPanel = function(view,edit,selection) {
  const el=id => document.getElementById(id), assets=MundoCreatorAssets, select=el("catalogObject");
  const group=el("creatorOptions"), fileInput=el("creatorFile"), notice=el("creatorStatus");
  const meshDetails=el("creatorInspector"), wireCanvas=el("creatorWireframe");
  const format=new Intl.NumberFormat("es",{maximumFractionDigits:4});
  const maxTriangles=240000, optionKey=key => "creator:"+key;
  let records=new Map(), wanted=new Set(), owned=new Set(), listRevision=0, sceneRevision=0;
  let syncing=false, initialized=false, inspectRevision=0, preview=null;
  function selected() {
    return select.value.startsWith("creator:") ? records.get(select.value.slice(8)) : null;
  }
  const layoutSelect=el("creatorSurfaceLayout"), rangeSelect=el("creatorSurfaceRange"), viewedLayouts=new Map();
  const materialPanel=MundoCreatorMaterialPanel({edit,selection,findModel:key=>records.get(key),preferredLayout:key=>viewedLayouts.get(key)});
  function showRanges() {
    const info=selected(), layout=info?.surfaceLayouts.find(item=>item.id===layoutSelect.value);
    const ranges=layout?.ranges || [];
    rangeSelect.replaceChildren(...ranges.map(r => {
      const start=format.format(r.first+1), end=format.format(r.first+r.count);
      return new Option((r.surface ?? "Sin material asignado")+" · "+(r.count===1 ? "triángulo "+start : "triángulos "+start+"–"+end),String(r.first));
    }));
    if (!ranges.length && info) rangeSelect.append(new Option("Superficie uniforme · toda la malla",""));
    rangeSelect.disabled=!ranges.length;
  }
  function showLayouts(info) {
    const layouts=info?.surfaceLayouts || [];
    layoutSelect.replaceChildren(...layouts.map(l=>new Option(l.name+" · "+(l.id==="uniform" ? "uniforme" : l.id.slice(0,10)),l.id)));
    if (info && layouts.some(l=>l.id===viewedLayouts.get(info.key))) layoutSelect.value=viewedLayouts.get(info.key);
    layoutSelect.disabled=layouts.length<2;
    showRanges();
  }
  layoutSelect.onchange=() => {
    const info=selected();
    if (info) viewedLayouts.set(info.key,layoutSelect.value);
    showRanges();
  };
  function previewMessage(message) {el("creatorWireStatus").textContent=message;}
  function drawWire() {
    if (!preview || !meshDetails.open) return;
    const ctx=wireCanvas.getContext("2d");
    if (!ctx) {previewMessage("La vista de malla necesita un lienzo 2D.");return;}
    const axes={front:[0,1],side:[2,1],top:[0,2]}[el("creatorAxis").value];
    const {points,size,count,triangles}=preview,[u,v]=axes;
    const w=wireCanvas.width,h=wireCanvas.height, scale=Math.min((w-24)/size[u],(h-24)/size[v]);
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle="#7cdbcb";ctx.lineWidth=1.1;ctx.beginPath();
    for (let i=0; i<points.length; i+=9) {
      ctx.moveTo(w/2+points[i+u]*scale,h/2-points[i+v]*scale);
      ctx.lineTo(w/2+points[i+3+u]*scale,h/2-points[i+3+v]*scale);
      ctx.lineTo(w/2+points[i+6+u]*scale,h/2-points[i+6+v]*scale);ctx.closePath();
    }
    ctx.stroke();wireCanvas.hidden=false;
    previewMessage(count<triangles ? "Vista alámbrica de "+format.format(count)+" triángulos de "+format.format(triangles)+"." : "");
  }
  async function inspect() {
    const turn=++inspectRevision, info=selected();
    showLayouts(info);
    meshDetails.hidden=!info; preview=null; wireCanvas.hidden=true; previewMessage("");
    el("creatorDimensions").textContent=info
      ? format.format(info.vertices)+" vértices · "+format.format(info.triangles)+" triángulos · "+info.size.map(x=>format.format(x)).join(" × ")+" m"
      : "";
    if (!info || !meshDetails.open) return;
    try {
      const bytes=await assets.load(info);
      if (turn!==inspectRevision) return;
      preview=MundoCreatorMesh.wireframe(bytes);drawWire();
    } catch (error) {if (turn===inspectRevision) previewMessage(error.message);}
  }
  select.addEventListener("change",inspect);
  meshDetails.addEventListener("toggle",inspect);
  el("creatorAxis").addEventListener("change",drawWire);

  function schedule() {
    ++sceneRevision;
    if (!syncing && initialized) void synchronize();
  }
  async function synchronize() {
    syncing=true;
    try {
      for (;;) {
        const turn=sceneRevision, keep=new Map(), missing=[], damaged=[], deferred=[];
        let used=0;
        for (const key of wanted) {
          const info=records.get(key);
          if (!info) {missing.push(key);continue;}
          if (used+info.triangles>maxTriangles) {deferred.push(info.name);continue;}
          const numeric=BigInt("0x"+key);
          try {
            let levels=view.catalog.get(numeric);
            if (!levels) {
              const bytes=await assets.load(info);
              if (turn!==sceneRevision) break;
              levels=MundoCreatorMesh.forDrawing(bytes);
            }
            keep.set(numeric,levels);used+=info.triangles;
          } catch {damaged.push(info.name);}
        }
        if (turn!==sceneRevision) continue;
        // Merge against the live catalog: an owner appearance may have finished loading during the await.
        const next=new Map(view.catalog);
        let changed=false;
        for (const id of owned) if (!keep.has(id)) {next.delete(id);changed=true;}
        for (const [id,levels] of keep) if (next.get(id)!==levels) {next.set(id,levels);changed=true;}
        if (changed) view.setCatalog(next);
        owned=new Set(keep.keys());
        const status=[];
        if (missing.length) status.push("Faltan "+missing.length+" modelo(s) en este navegador ("+missing.slice(0,3).join(", ")+"). Importa el OBJ original para recuperar cada forma.");
        if (damaged.length) status.push("Vuelve a importar los datos de "+damaged.slice(0,3).join(", ")+".");
        if (deferred.length) status.push(deferred.length+" modelo(s) superan el presupuesto visible de la escena.");
        if (status.length) status.push("Sus instancias conservan el tamaño y la posición y se muestran como cajas.");
        el("creatorMissing").textContent=status.join(" ");
        break;
      }
    } finally {syncing=false;}
  }
  function setWorld(world) {
    const keys=new Set();
    for (const node of world.nodes.values()) if (assets.isCreatorKey(node.visual)) keys.add(node.visual.toString(16));
    if (keys.size===wanted.size && [...keys].every(key=>wanted.has(key))) return;
    wanted=keys;schedule();
  }
  function renderOptions(preferred) {
    view.setCreatorSurfaceModels?.(records);
    materialPanel.refresh();
    const before=select.value, options=[];
    for (const info of [...records.values()].sort((a,b)=>a.name.localeCompare(b.name,"es") || a.key.localeCompare(b.key))) {
      const option=new Option(info.name+" · "+info.key.slice(-6),optionKey(info.key));options.push(option);
    }
    group.replaceChildren(...options);
    const value=preferred ? optionKey(preferred) : before;
    if (Array.from(select.options).some(opt=>opt.value===value)) select.value=value;
    void inspect();
  }
  async function refreshList() {
    const ticket=++listRevision;
    try {
      const list=await assets.list();
      if (ticket!==listRevision) return;
      records=new Map(list.map(info=>[info.key,info]));renderOptions();
      notice.textContent=list.length ? list.length+" modelo(s) guardados en este navegador." : "";
    } catch (error) {if (ticket===listRevision) notice.textContent="Catálogo local no disponible. "+error.message;}
    finally {if (ticket===listRevision) {initialized=true;schedule();}}
  }
  async function importSource(read,name) {
    fileInput.disabled=true; el("creatorSample").disabled=true;
    notice.textContent="Importando geometría…";
    try {
      const {bytes,ranges}=MundoObj.withSurfaces(await read()), info=await assets.save(bytes,name,ranges);
      viewedLayouts.set(info.key,info.importedLayoutId);
      // Invalidate a listing started before this transaction; merge against a committed, complete list.
      ++listRevision;
      const list=await assets.list();
      records=new Map(list.map(item=>[item.key,item]));records.set(info.key,info);initialized=true;
      renderOptions(info.key);schedule();
      notice.textContent=info.name+" guardado. Elige una superficie o añádelo al centro.";
    } catch (error) {
      notice.textContent="No se pudo importar. "+(error.name==="QuotaExceededError" ? "El almacenamiento de este navegador está lleno." : error.message);
    } finally {fileInput.disabled=false;el("creatorSample").disabled=false;}
  }
  fileInput.onchange=() => {
    const file=fileInput.files?.[0];fileInput.value="";
    if (!file) return;
    if (!file.size || file.size>MundoObj.limits.bytes) {notice.textContent="Elige un archivo OBJ de hasta 6 MiB.";return;}
    void importSource(async()=>new Uint8Array(await file.arrayBuffer()),file.name);
  };
  const sample=el("creatorSampleObj");
  if (sample) {
    const button=el("creatorSample");button.hidden=false;
    button.onclick=()=>void importSource(()=>new TextEncoder().encode(sample.content.textContent),"Lámpara Duna.obj");
  }
  el("creatorReload").onclick=()=>void refreshList();
  function place(world,point) {
    const info=selected();
    if (!info) throw Error("Selecciona un modelo de tu catálogo.");
    const n=MundoWorld.add(world,info.name,1);
    n.visual=BigInt("0x"+info.key);n.s=info.size.slice();
    n.p=[point[0],point[1]+n.s[1]/2,point[2]];
    n.color=MundoWorld.fromHex("#bcb2a3");n.rough=.57;n.metal=0;return n.id;
  }
  void refreshList();
  return Object.freeze({setWorld,place,refreshList,showInstance:materialPanel.show});
};
