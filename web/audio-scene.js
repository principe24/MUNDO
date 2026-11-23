"use strict";

// Audio sources are leaf groups in the existing MWENGIE world. Everything
// needed by a guest is in the marker; no asset path or executable code is read.
globalThis.MundoAudioScene = (() => {
  const prefix = "MUNDO/Audio/v1/";
  const presets = Object.freeze(["brisa", "agua", "maquina"]);
  const extendedPrefix = "MUNDO/Audio/v2/";
  const musicPrefix = "MUNDO/Music/v1/";
  const groups = Object.freeze(["ambiente","efectos","musica","voces"]);
  const maxSources = 16;
  const isClip = key => typeof key === "string" && /^s[0-9a-f]{16}$/.test(key);
  const configured = fields => ({spatial:"3d", playbackRate:1, loop:true, group:"ambiente", ...fields});
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true});
  const tag = /^(brisa|agua|maquina)\/(0|[1-9][0-9]{0,4})\/(0|[1-9][0-9]{0,3})\/(.+)$/su;

  const extendedTag = /^(brisa|agua|maquina|s[0-9a-f]{16})\/(0|[1-9][0-9]{0,4})\/(0|[1-9][0-9]{0,3})\/(2d|3d)\/([1-9][0-9]{0,2})\/(loop|once)\/(ambiente|efectos|musica|voces)\/(.+)$/su;

  function validate(fields) {
    if (!fields || (!presets.includes(fields.preset) && !isClip(fields.preset))) throw Error("Elige un ambiente sonoro disponible.");
    const {label, position, radius, volume, spatial, playbackRate, loop, group} = fields;
    if (!["2d","3d"].includes(spatial) || !groups.includes(group) || typeof loop !== "boolean" ||
        !Number.isFinite(playbackRate) || playbackRate < .25 || playbackRate > 4 ||
        Math.abs(playbackRate * 100 - Math.round(playbackRate * 100)) > 1e-8)
      throw Error("Modo, grupo o velocidad de reproducción inválidos.");
    if (typeof label !== "string" || !label || label !== label.trim() || label.length > 32 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(label) ||
        encoder.encode(label).length > 32 || decoder.decode(encoder.encode(label)) !== label)
      throw Error("Usa un nombre visible de hasta 32 bytes para la fuente sonora.");
    if (!Array.isArray(position) || position.length !== 3 ||
        ![0,1,2].every(i => Number.isFinite(position[i]) && Math.abs(position[i]) <= 1e6))
      throw Error("La fuente necesita tres coordenadas válidas entre −1 000 000 y 1 000 000 m.");
    if (!Number.isFinite(radius) || radius < .5 || radius > 256 ||
        Math.abs(radius * 100 - Math.round(radius * 100)) > 1e-8)
      throw Error("El alcance sonoro debe estar entre 0,50 y 256 m con hasta dos decimales.");
    if (!Number.isFinite(volume) || volume < 0 || volume > 1 ||
        Math.abs(volume * 1000 - Math.round(volume * 1000)) > 1e-8)
      throw Error("El volumen debe estar entre 0 y 1 con hasta tres decimales.");
  }

  function read(world) {
    const sources = [], ids = new Set();
    for (const n of world.nodes.values()) {
      const extended = n.name.startsWith(extendedPrefix);
      if (!extended && !n.name.startsWith(prefix)) continue;
      if (sources.length >= maxSources) throw Error("Una sala admite hasta 16 fuentes sonoras.");
      const match = (extended ? extendedTag : tag).exec(n.name.slice(extended ? extendedPrefix.length : prefix.length));
      if (!match || n.parent !== 0n || n.shape !== 0 || n.visual !== 0n ||
          !n.s.every(v => v === 1) || n.q[0] !== 0 || n.q[1] !== 0 ||
          n.q[2] !== 0 || Math.abs(n.q[3]) !== 1)
        throw Error("Marcador de audio inválido en la pieza " + n.id + ".");
      const source = configured({id:String(n.id), preset:match[1], radius:Number(match[2]) / 100,
        volume:Number(match[3]) / 1000, label:extended ? match[8] : match[4], position:n.p.slice(),
        ...(extended ? {spatial:match[4], playbackRate:Number(match[5]) / 100, loop:match[6] === "loop", group:match[7]} : {})});
      validate(source);
      sources.push(source);
      ids.add(n.id);
    }
    if (ids.size) {
      for (const n of world.nodes.values()) {
        if (ids.has(n.parent)) throw Error("Una fuente sonora no admite piezas hijas.");
      }
    }
    return sources.sort((a,b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function nameFor(fields) {
    const source = configured(fields);
    validate(source);
    const extended = isClip(source.preset) || source.spatial !== "3d" || source.playbackRate !== 1 ||
      !source.loop || source.group !== "ambiente";
    const tokens = [source.preset, Math.round(source.radius * 100), Math.round(source.volume * 1000)];
    if (extended) tokens.push(source.spatial, Math.round(source.playbackRate * 100),
      source.loop ? "loop" : "once", source.group);
    tokens.push(source.label);
    const name = (extended ? extendedPrefix : prefix) + tokens.join("/");
    if (encoder.encode(name).length > 95) throw Error("Acorta el nombre de esta fuente sonora.");
    return name;
  }

  function add(world, fields) {
    if (read(world).length >= maxSources) throw Error("Una sala admite hasta 16 fuentes sonoras.");
    const name = nameFor(fields);
    const factory = globalThis.MundoWorld || require("../server/room-runtime.cjs").MundoWorld;
    const n = factory.add(world, name, 0);
    n.p = fields.position.slice();
    return n.id;
  }

  function existing(world, id) {
    const found = read(world).find(item => item.id === String(id));
    if (!found) throw Error("Selecciona una fuente sonora del mundo actual.");
    return BigInt(found.id);
  }

  function update(world, id, fields) {
    const key = existing(world, id), n = world.nodes.get(key), name = nameFor(fields);
    world.nodes.set(key, {...n, name, p:fields.position.slice()});
    return key;
  }

  function remove(world, id) {
    world.nodes.delete(existing(world, id));
  }

  function musicFields(fields) {
    const id=String(fields?.streamId??""),label=fields?.label,loop=fields?.loop;
    if(!/^[1-9][0-9]{0,19}$/.test(id)||BigInt(id)>0xffffffffffffffffn)
      throw Error("Identificador de música inválido.");
    if(typeof loop!=="boolean"||typeof label!=="string"||!label||label!==label.trim()||
       /[\u0000-\u001f\u007f-\u009f/]/u.test(label)||encoder.encode(label).length>32)
      throw Error("Usa un nombre visible de hasta 32 bytes para la música.");
    return {streamId:id,label,loop};
  }
  function readMusic(world) {
    let result=null,nodeId=null;
    for(const n of world.nodes.values()){
      if(!n.name.startsWith(musicPrefix))continue;
      if(result)throw Error("Un mundo admite una pista musical larga.");
      const match=/^([1-9][0-9]{0,19})\/(loop|once)\/(.+)$/su.exec(n.name.slice(musicPrefix.length));
      if(!match||n.parent!==0n||n.shape!==0||n.visual!==0n||!n.s.every(v=>v===1)||
         n.q[0]!==0||n.q[1]!==0||n.q[2]!==0||Math.abs(n.q[3])!==1||n.p.some(v=>v!==0))
        throw Error("Marcador de música inválido en la pieza "+n.id+".");
      result={id:String(n.id),...musicFields({streamId:match[1],loop:match[2]==="loop",label:match[3]})};nodeId=n.id;
    }
    if(nodeId!==null)for(const n of world.nodes.values())if(n.parent===nodeId)
      throw Error("La música del mundo no admite piezas hijas.");
    return result;
  }
  function setMusic(world,fields) {
    const value=musicFields(fields),prior=readMusic(world);
    const name=musicPrefix+[value.streamId,value.loop?"loop":"once",value.label].join("/");
    if(encoder.encode(name).length>95)throw Error("Acorta el nombre de la pista musical.");
    if(prior){
      const key=BigInt(prior.id),node=world.nodes.get(key);
      world.nodes.set(key,{...node,name});return key;
    }
    const factory=globalThis.MundoWorld||require("../server/room-runtime.cjs").MundoWorld;
    return factory.add(world,name,0).id;
  }
  function removeMusic(world){
    const prior=readMusic(world);
    if(prior)world.nodes.delete(BigInt(prior.id));
  }

  return Object.freeze({prefix,extendedPrefix,musicPrefix,presets,groups,isClip,maxSources,read,add,update,remove,
    readMusic,setMusic,removeMusic});
})();
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.MundoAudioScene;
