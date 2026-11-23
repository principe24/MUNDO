"use strict";
window.MundoComponentInspector = function(edit, selection) {
  const byId = id => document.getElementById(id);
  const fields = byId("componentFields"), list = byId("componentList"), source = byId("componentJson");
  const remove = byId("componentRemove");
  let shown = null;
  const records = MundoComponentRecords;
  function pick() {
    const value = list.value;
    const items = shown?.components || records.empty;
    const item = items.find(text => records.describe(text).key === value);
    source.value = item ?? "";
    remove.disabled = item === undefined;
  }
  list.onchange = pick;
  function show(node, preferred) {
    const same = shown && node && node.id === shown.id;
    const key = preferred ?? (same ? list.value : "");
    shown = node;
    fields.disabled = !node;
    list.replaceChildren(new Option("Nuevo componente",""));
    for (const text of node?.components || records.empty) {
      const record = records.describe(text);
      list.add(new Option(record.key + " · v" + record.version,record.key));
    }
    list.value = key;
    if (list.selectedIndex < 0) list.selectedIndex = 0;
    pick();
  }
  function change(removing) {
    if (!shown || selection() !== shown.id) return;
    const currentKey = list.value, raw = source.value, id = shown.id;
    let nextKey = "";
    const error = edit(world => {
      const node = world.nodes.get(id), items = Array.from(node.components || records.empty);
      const index = items.findIndex(text => records.describe(text).key === currentKey);
      if (removing) {
        if (index < 0) throw Error("Selecciona el componente que quieres quitar.");
        items.splice(index,1);
      } else {
        nextKey = records.describe(raw).key;
        if (index >= 0 && currentKey !== nextKey) throw Error("Conserva la clave al actualizar el componente.");
        if (index >= 0) items[index] = raw;
        else items.push(raw);
      }
      world.nodes.set(id,{...node,components:Object.freeze(items)});
      return id;
    }, removing ? "Componente retirado del borrador." : "Componente guardado en el borrador.");
    if (!error && shown?.id === id) show(shown,nextKey);
  }
  byId("componentSave").onclick = () => change(false);
  remove.onclick = () => change(true);
  const plugins = MundoPluginPanel(template => {
    if (!shown || selection() !== shown.id) throw Error("Selecciona la pieza que recibirá el componente.");
    const id = shown.id;
    const error = edit(world => {
      const node = world.nodes.get(id), items = node.components || records.empty;
      if (items.some(text => records.describe(text).key === template.key))
        throw Error("La pieza ya tiene este componente. Puedes editar sus datos en el inspector.");
      world.nodes.set(id,{...node,components:Object.freeze([...items,template.record])});
      return id;
    },"Plantilla de plugin aplicada.");
    if (error) throw error;
    show(shown,template.key);
  });
  return {show,plugins};
};
