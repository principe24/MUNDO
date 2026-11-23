"use strict";

// The .mprojectaudio envelope carries a guest projection and only the recordings
// referenced by its maps. Studio's private component records stay in its .mproject.
globalThis.MundoAudioProject = (() => {
  const common = typeof module !== "undefined" && module.exports;
  const P = common ? require("../server/room-runtime.cjs").MundoProject : globalThis.MundoProject;
  const scene = common ? require("./audio-scene.js") : globalThis.MundoAudioScene;
  const clips = common ? require("./audio-clips.js") : globalThis.MundoAudioClips;
  const maxBytes = 16+64*1024*1024+clips.maxBankBytes+36*16;

  async function inventory(index) {
    const sourcesByWorld = new Map(), names = new Map();
    for (const entry of index.worlds) {
      const sources = scene.read((await P.load(entry)).world);
      sourcesByWorld.set(entry.id,sources);
      for (const source of sources) {
        if (scene.isClip(source.preset) && !names.has(source.preset)) names.set(source.preset,source.label);
      }
      if (names.size > 16) throw Error("El proyecto admite hasta 16 grabaciones distintas.");
    }
    return {sourcesByWorld,names};
  }

  async function inspect(project) {
    const index = await P.open(new Blob([project]));
    // Compare the serialized projection, including its manifest hash. This also
    // rejects unexpected metadata that a guest reader would otherwise ignore.
    const guest = new Uint8Array(await (await P.packForRoom(index)).arrayBuffer());
    if (guest.length !== project.length || !guest.every((byte,i) => byte===project[i]))
      throw Error("Exporta una copia para invitados antes de incluir las grabaciones.");
    return {index,...await inventory(index)};
  }

  function unpack(input) {
    return clips.unpackProjectBank(input);
  }

  function match(names, items) {
    clips.match(Array.from(names.keys(),preset => ({preset})),items);
  }

  async function pack(project,items) {
    const bytes = await clips.packProjectBank(project,items);
    const bank = unpack(bytes), {names} = await inspect(bank.project);
    match(names,bank.items);
    return bytes;
  }

  async function open(input) {
    // Own a bounded snapshot until verification and any catalog transaction finish.
    const view = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (view.length > maxBytes) throw Error("El proyecto con grabaciones supera el tamaño admitido.");
    const data = unpack(new Uint8Array(view)), details = await inspect(data.project);
    match(details.names,data.items);
    for (const item of data.items) {
      await clips.verify(item.key,item.bytes,item.digest);
      item.name = details.names.get(item.key);
    }
    return {index:details.index,sourcesByWorld:details.sourcesByWorld,items:data.items};
  }

  async function exportProject(index,getClip) {
    // Capture immutable entries, portal definitions and the title before the first await.
    const blob = await P.packForRoom(index);
    const guest = await P.open(blob);
    const {names} = await inventory(guest);
    if (!names.size) return {blob,hasAudio:false};
    if (!getClip) throw Error("Autoriza las grabaciones referenciadas para preparar este proyecto.");
    const items = [];
    let total = 0;
    for (const key of names.keys()) {
      const item = await getClip(key);
      if (!item || item.key !== key) throw Error("Falta la grabación "+key+" en el catálogo privado.");
      total += item.bytes.length;
      if (total > clips.maxBankBytes) throw Error("El proyecto admite hasta 8 MiB de grabaciones.");
      items.push(item);
    }
    const project = new Uint8Array(await blob.arrayBuffer());
    const bytes = await clips.packProjectBank(project,items);
    return {blob:new Blob([bytes],{type:"application/vnd.mundo.audio-project"}),hasAudio:true};
  }
  return Object.freeze({pack,unpack,open,inventory,exportProject,maxBytes});
})();
if (typeof module!=="undefined" && module.exports) module.exports=globalThis.MundoAudioProject;
