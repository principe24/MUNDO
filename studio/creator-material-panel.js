"use strict";
globalThis.MundoCreatorMaterialPanel = function({edit, selection, findModel, preferredLayout}) {
  const el = id => document.getElementById("creatorMaterial"+id);
  const fields=el("Fields"), layout=el("Layout"), surface=el("Surface"), status=el("Status");
  const useColor=el("UseColor"), useRough=el("UseRough"), color=el("Color"), rough=el("Rough");
  const apply=el("Apply"), inherit=el("Inherit"), reset=el("Reset");
  const materials=MundoCreatorSurfaceMaterials;
  let shown=null, info=null, record=null, currentNames=[];

  function toggles() {
    color.disabled=!useColor.checked;
    rough.disabled=!useRough.checked;
  }
  useColor.onchange=toggles;
  useRough.onchange=toggles;
  function showSurface() {
    const chosen=currentNames[surface.selectedIndex];
    const applied=record?.overrides.find(item=>item.surface===chosen);
    useColor.checked=applied?.color!==undefined;
    useRough.checked=applied?.rough!==undefined;
    color.value=applied?.color ?? MundoWorld.toHex(shown.color);
    rough.value=String(applied?.rough ?? shown.rough);
    inherit.disabled=!applied;
    toggles();
  }
  function showLayout(preferred) {
    const distribution=info.surfaceLayouts.find(item=>item.id===layout.value);
    if (!distribution) return;
    currentNames=materials.names(distribution);
    surface.replaceChildren(...currentNames.map((name,i)=>new Option(name ?? (distribution.id==="uniform"?"Superficie uniforme":"Sin material asignado"),String(i))));
    const index=currentNames.indexOf(preferred);
    surface.selectedIndex=index<0?0:index;
    showSurface();
  }
  function show(node) {
    const same=!!node && !!shown && node.id===shown.id && node.visual===shown.visual;
    const oldLayout=same?layout.value:null, oldName=same?currentNames[surface.selectedIndex]:undefined;
    shown=node; info=null;record=null;currentNames=[];
    status.textContent="";
    fields.hidden=!MundoCreatorMesh.isCreatorKey(node?.visual);
    fields.disabled=true;
    if (fields.hidden) return;
    try {record=materials.get(node);}
    catch (error) {status.textContent=error.message;return;}
    info=findModel(node.visual.toString(16));
    if (!info || (record && info.digest!==record.digest)) {
      status.textContent="Reimporta el OBJ de esta instancia para editar sus superficies. Sus ajustes siguen en el proyecto.";
      return;
    }
    layout.replaceChildren(...info.surfaceLayouts.map(l=>new Option(l.name+" · "+(l.id==="uniform"?"uniforme":l.id.slice(0,10)),l.id)));
    const selected=record?.layoutId ?? oldLayout ?? preferredLayout(info.key) ?? info.surfaceLayouts[0].id;
    const available=info.surfaceLayouts.some(item=>item.id===selected);
    if (record && !available) {
      status.textContent="Reimporta el OBJ que contiene la distribución guardada. Sus ajustes siguen en el proyecto.";
      return;
    }
    layout.value=available?selected:info.surfaceLayouts[0].id;
    fields.disabled=false;
    layout.disabled=!!record || info.surfaceLayouts.length<2;
    reset.disabled=!record;
    showLayout(oldName);
  }
  surface.onchange=()=>{status.textContent="";showSurface();};
  layout.onchange=()=>{status.textContent="";showLayout();};

  function change(action) {
    if (!shown || fields.disabled || shown.id!==selection() || !info) return;
    const id=shown.id, source=info, selectedLayout=layout.value, name=currentNames[surface.selectedIndex];
    const patch={};
    if (action==="apply" && useColor.checked) patch.color=color.value;
    if (action==="apply" && useRough.checked) {
      if (!rough.validity.valid || !Number.isFinite(rough.valueAsNumber)) {
        status.textContent="Introduce una rugosidad entre 0 y 1.";
        rough.focus();
        return;
      }
      patch.rough=rough.valueAsNumber;
    }
    let updated;
    try {
      updated=action==="reset"?materials.clear(shown):materials.set(shown,source,selectedLayout,name,patch);
    } catch (error) {status.textContent=error.message;return;}
    if (updated===shown) {status.textContent="La superficie ya tiene estos valores.";return;}
    const error=edit(world=>{
      world.nodes.set(id,updated);
      return id;
    },"Acabado de la instancia actualizado.");
    status.textContent=error?error.message:action==="apply"?"Acabado aplicado a esta instancia.":"Valores de la instancia restablecidos.";
  }
  apply.onclick=()=>change("apply");
  inherit.onclick=()=>change("inherit");
  reset.onclick=()=>change("reset");
  return {show,refresh:()=>show(shown)};
};
