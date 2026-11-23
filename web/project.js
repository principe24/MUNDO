"use strict";
// A project stores immutable room snapshots, independent of the device's Studio catalog.
window.MundoProject = (() => {
  const maxBytes = 64 * 1024 * 1024, maxWorlds = 32, maxManifest = 16 * 1024;
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", {fatal:true});
  const magic = encoder.encode("MUNDOPRJ");
  // magic, little-endian version and manifest size, then the manifest's 64 ASCII hash digits
  const headerSize = 80;
  const verifiedBlobs = new WeakMap();
  function requireValue(ok, message) {
    if (!ok) throw Error(message);
  }
  function checkName(name) {
    requireValue(typeof name === "string" && name.trim() && name.length <= 128 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(name), "El nombre del proyecto es inválido.");
  }
  function layout(name, start, rows) {
    checkName(name);
    requireValue(Array.isArray(rows) && rows.length && rows.length <= maxWorlds, "Un proyecto admite entre 1 y 32 mundos.");
    const ids = new Set();
    let total = 0;
    for (const row of rows) {
      requireValue(row && Number.isSafeInteger(row.id) && row.id > 0 && !ids.has(row.id) &&
        (row.source === "draft" || row.source === "publication") && Number.isSafeInteger(row.size) &&
        row.size >= 44 && row.size <= MundoRoomFile.maxBytes &&
        typeof row.hash === "string" && /^[a-f0-9]{64}$/.test(row.hash), "El índice de mundos es inválido.");
      ids.add(row.id);
      total += row.size;
    }
    requireValue(ids.has(start), "Elige un mundo inicial del proyecto.");
    requireValue(total <= maxBytes - headerSize, "El proyecto supera 64 MiB.");
    return total;
  }
  // Tiles are editable public blocks. Only a project can give them a destination.
  const tilePrefix = "Portal/";
  function portalTile(node) {
    const [width,height,depth] = node.s;
    if (node.parent !== 0n || node.shape !== 1 || node.visual !== 0n ||
        !node.name.startsWith(tilePrefix) || node.name.length === tilePrefix.length ||
        node.q[0] !== 0 || node.q[2] !== 0 || width < 1 || width > 12 || depth < 1 || depth > 12 ||
        height < .04 || height > .2) return null;
    const angle = 2 * Math.atan2(node.q[1],node.q[3]);
    return Object.freeze({id:String(node.id), name:node.name.slice(tilePrefix.length),
      x:node.p[0], top:node.p[1]+height/2, z:node.p[2], halfX:width/2, halfZ:depth/2,
      cos:Math.cos(angle), sin:Math.sin(angle)});
  }
  function tileIndex(world) {
    const tiles = [];
    for (const node of world.nodes.values()) {
      const tile = portalTile(node);
      if (tile) tiles.push(tile);
    }
    return Object.freeze(tiles);
  }
  function checkPortals(links,worlds) {
    requireValue(Array.isArray(links) && links.length <= 64,"Un proyecto admite hasta 64 enlaces de portal.");
    const ids = new Map(worlds.map(entry => [entry.id,entry]));
    const seen = new Set();
    for (const link of links) {
      requireValue(link && ids.has(link.from) && ids.has(link.to) && link.from !== link.to &&
        typeof link.tile === "string" && /^[1-9][0-9]{0,19}$/.test(link.tile),"Destino u origen de portal inválido.");
      const key = link.from + "/" + link.tile;
      const anchors = verifiedBlobs.get(ids.get(link.from).blob)?.tiles;
      requireValue(anchors?.some(tile => tile.id === link.tile),"Una baldosa de portal falta o cambió de forma.");
      requireValue(!seen.has(key),"Una baldosa solo puede tener un destino.");
      seen.add(key);
    }
  }
  function crossing(project,entry) {
    const links = new Map((project.portals ?? []).filter(link => link.from === entry.id)
      .map(link => [link.tile,link.to]));
    const pads = entry.tiles.filter(tile => links.has(tile.id)).sort((a,b) =>
      a.id.length-b.id.length || (a.id<b.id?-1:a.id>b.id?1:0));
    let ready = false, awaitingGround = true;
    return function(feet,grounded,prime=false) {
      if (prime) awaitingGround=true;
      if (!grounded) return null;
      const pad = pads.find(p => {
        const dx = feet[0]-p.x, dz = feet[2]-p.z;
        return Math.abs(feet[1]-p.top) <= .065 &&
          Math.abs(p.cos*dx-p.sin*dz) <= p.halfX && Math.abs(p.sin*dx+p.cos*dz) <= p.halfZ;
      });
      if (awaitingGround) { awaitingGround=false; ready=!pad; return null; }
      if (!pad) { ready=true; return null; }
      if (!ready) return null;
      ready=false;
      return links.get(pad.id);
    };
  }
  async function readRoom(blob, hash, source) {
    requireValue(blob.size <= MundoRoomFile.maxBytes, "La sala supera el tamaño admitido.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const actual = await MundoRoomFile.digest(bytes);
    if (hash) requireValue(actual === hash, "La sala no coincide con el índice del proyecto.");
    const info = await MundoRoomFile.verify(bytes);
    requireValue(source !== "draft" || info.revision === 1, "La versión interna del borrador es inválida.");
    const world = MundoWorld.decode(info.world);
    const vehicleRoot = info.vehicleRoot ?? null, meetingPoint = info.meetingPoint ?? null;
    const {gates,startMode,grid}=MundoCircuit.read(world);
    if (meetingPoint || vehicleRoot || gates.length || grid) {
      const scene=MundoGeometry.flatten(world);
      MundoMeeting.validatePublication(world,scene,vehicleRoot,meetingPoint,gates.length>0);
    }
    return {world, gates, startMode, worldSource:MundoWorld.sourceInfo(info.world,info.hash), title:info.title, revision:info.revision, vehicleRoot, meetingPoint, hash:actual};
  }
  async function entry(id, source, blob, hash, records = []) {
    const room = await readRoom(blob, hash, source);
    const tiles = tileIndex(room.world), gateCount = room.gates.length;
    const components = Array.isArray(records) && records.length === 0 ? Object.freeze([]) : MundoComponentRecords.normalize(room.world,records);
    // Authoring records belong to this project entry. A separately inserted
    // publication may use the exact same room bytes with different records.
    if (verifiedBlobs.has(blob)) blob = blob.slice(0, blob.size, blob.type);
    verifiedBlobs.set(blob,{hash:room.hash,tiles,components});
    // This count is derived from verified scene bytes; the project manifest never supplies it.
    const npcCount=globalThis.MundoNpcRoutes?.definitions(room.world).length??0;
    return Object.freeze({id, source, blob, tiles, npcCount, gates:room.gates, startMode:room.startMode, gateCount, title:room.title, revision:room.revision, size:blob.size, hash:room.hash});
  }
  async function draft(id, world, title, vehicleRoot, meetingPoint) {
    // Capture all mutable fields before the first asynchronous operation.
    const bytes = MundoWorld.encode(world);
    const components = MundoComponentRecords.snapshot(world);
    const info = {title, revision:1, vehicleRoot, meetingPoint:MundoRoomFile.copyMeetingPoint(meetingPoint)};
    info.hash = await MundoRoomFile.digest(bytes);
    const packed = await MundoRoomFile.seal(info, bytes);
    return entry(id, "draft", new Blob([packed]), undefined, components);
  }
  function manifestOf(project, includeComponents = true) {
    const rows = project.worlds.map(({id, source, blob, size, hash}) => {
      requireValue(blob instanceof Blob && blob.size === size && verifiedBlobs.get(blob)?.hash === hash,
        "El mundo debe conservar su copia verificada antes de guardar.");
      const row = {id, source, size, hash};
      const records = verifiedBlobs.get(blob).components;
      if (includeComponents && records.length) row.components = records;
      return row;
    });
    const total = layout(project.name, project.start, rows);
    const links = project.portals ?? [];
    checkPortals(links,project.worlds);
    const index = {name:project.name, start:project.start, worlds:rows};
    if (includeComponents && project.studioPlugins !== undefined)
      index.studioPlugins = MundoComponentRecords.pluginPins(project.studioPlugins);
    if (links.length) index.portals = links.map(({from,tile,to}) => ({from,tile,to}));
    const manifest = encoder.encode(JSON.stringify(index));
    requireValue(manifest.length <= maxManifest && headerSize + manifest.length + total <= maxBytes, "El proyecto supera 64 MiB.");
    return {manifest,version:links.length ? 2 : 1};
  }
  async function pack(project, includeComponents = true) {
    const {manifest,version} = manifestOf(project,includeComponents), blobs = project.worlds.map(entry => entry.blob);
    const header = new Uint8Array(headerSize), view = new DataView(header.buffer);
    header.set(magic); view.setUint32(8, version, true); view.setUint32(12, manifest.length, true);
    header.set(encoder.encode(await MundoRoomFile.digest(manifest)), 16);
    return new Blob([header, manifest, ...blobs], {type:"application/vnd.mundo.project"});
  }
  async function open(file) {
    requireValue(file.size >= headerSize && file.size <= maxBytes, "El archivo de proyecto debe ocupar hasta 64 MiB.");
    const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer()), view = new DataView(header.buffer);
    const length = view.getUint32(12, true), version = view.getUint32(8,true);
    requireValue(magic.every((v,i) => header[i] === v) && (version === 1 || version === 2) &&
      length > 0 && length <= maxManifest && headerSize + length <= file.size, "Cabecera de proyecto incompatible.");
    const bytes = new Uint8Array(await file.slice(headerSize,headerSize+length).arrayBuffer());
    requireValue(await MundoRoomFile.digest(bytes) === decoder.decode(header.subarray(16)), "El índice del proyecto está dañado.");
    const manifest = JSON.parse(decoder.decode(bytes));
    requireValue(version === 1 ? !Object.prototype.hasOwnProperty.call(manifest ?? {},"portals") :
      Array.isArray(manifest?.portals) && manifest.portals.length > 0 && manifest.portals.length <= 64,
      "Los portales no corresponden a la versión del proyecto.");
    const total = layout(manifest?.name, manifest?.start, manifest?.worlds);
    const studioPlugins = Object.hasOwn(manifest,"studioPlugins") ? MundoComponentRecords.pluginPins(manifest.studioPlugins) : undefined;
    let offset = headerSize + length;
    requireValue(offset + total === file.size, "La longitud del proyecto no coincide con su índice.");
    const worlds = [];
    for (const row of manifest.worlds) {
      const blob = file.slice(offset, offset + row.size);
      worlds.push(await entry(row.id, row.source, blob, row.hash, row.components));
      offset += row.size;
    }
    const portals = manifest.portals ?? [];
    checkPortals(portals,worlds);
    const project = {name:manifest.name, start:manifest.start, worlds, portals};
    if (studioPlugins !== undefined) project.studioPlugins = studioPlugins;
    return project;
  }
  async function load(item) {
    const room = await readRoom(item.blob,item.hash,item.source);
    const records = verifiedBlobs.get(item.blob)?.components;
    if (records?.length) MundoComponentRecords.apply(room.world,records);
    return room;
  }
  return Object.freeze({draft, publication:(id,blob) => entry(id,"publication",blob), pack, open, maxWorlds,
    crossing, tilePrefix, check:project => manifestOf(project).manifest, load, packForRoom:project => pack(project,false)});
})();
