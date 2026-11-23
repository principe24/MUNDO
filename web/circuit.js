"use strict";
// A root group carries the ordered trigger. Its children are ordinary public scene pieces.
globalThis.MundoCircuit = (() => {
  const prefix = "MUNDO/Circuito/v1/", limit = 32, labelBytes = 48;
  const flyingMarker = "MUNDO/Carrera/v1/SalidaLanzada";
  const gridMarker = "MUNDO/Carrera/v1/Parrilla";
  const utf8 = new TextEncoder();
  function fail(message) { throw Error(message); }
  function validLabel(label) {
    return typeof label === "string" && label === label.trim() && label.length > 0 &&
      utf8.encode(label).length <= labelBytes && !/[\u0000-\u001f\u007f-\u009f]/u.test(label);
  }
  function validate(fields) {
    if (!validLabel(fields.label)) fail("Usa un nombre de puerta visible de hasta 48 bytes UTF-8.");
    if (!Array.isArray(fields.point) || fields.point.length !== 3 ||
        !fields.point.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))
      fail("Las tres coordenadas deben estar entre −1 000 000 y 1 000 000 m.");
    if (!(fields.width >= 2 && fields.width <= 48 && fields.height >= 2 && fields.height <= 20) ||
        ![fields.width,fields.height,fields.bearing].every(Number.isFinite))
      fail("El paso debe medir entre 2 y 48 m de ancho y entre 2 y 20 m de alto. Escribe un rumbo válido.");
  }
  function validateGrid(point,bearing) {
    if (!Array.isArray(point) || point.length!==3 ||
        ![0,1,2].every(i=>Number.isFinite(point[i]) && Math.abs(point[i])<=1e6) ||
        !Number.isFinite(bearing))
      fail("La parrilla necesita un rumbo válido y tres coordenadas entre −1 000 000 y 1 000 000 m.");
  }
  function gridNode(world) {
    let result=null;
    for(const node of world.nodes.values()){
      if(node.name!==gridMarker)continue;
      if(result || node.parent!==0n || node.shape!==0 || node.visual!==0n ||
          ![0,1,2].every(i=>node.s[i]===1) || node.q[0]!==0 || node.q[2]!==0 ||
          !Number.isFinite(node.q[1]) || !Number.isFinite(node.q[3]) ||
          Math.abs(node.q[1]*node.q[1]+node.q[3]*node.q[3]-1)>1e-5)
        fail("La parrilla debe ser un único grupo raíz vacío, vertical y de escala 1.");
      result=node;
    }
    if(result){
      for(const node of world.nodes.values())if(node.parent===result.id)
        fail("El punto de salida del turismo no admite piezas hijas.");
    }
    return result;
  }
  function readGrid(world) {
    const node=gridNode(world);
    if(!node)return null;
    // Vehicle yaw increases towards +X. Scene rotation about +Y has the opposite sign.
    const angle=-2*Math.atan2(node.q[1],node.q[3]);
    const yaw=Math.atan2(Math.sin(angle),Math.cos(angle));
    const bearing=(yaw*180/Math.PI+360)%360;
    validateGrid(node.p,bearing);
    return {point:node.p.slice(),bearing,yaw};
  }
  function writeGrid(world,pose) {
    const previous=gridNode(world);
    if(pose===null){
      if(previous)world.nodes.delete(previous.id);
      return null;
    }
    validateGrid(pose?.point,pose?.bearing);
    const half=-(pose.bearing%360)*Math.PI/360;
    const node=previous??globalThis.MundoWorld.add(world,gridMarker,0);
    // Forked drafts share records; replace instead of changing an existing node.
    world.nodes.set(node.id,{...node,p:pose.point.slice(),q:[0,Math.sin(half),0,Math.cos(half)]});
    return node.id;
  }
  function read(world) {
    const gates = [], slots = new Set();
    let marker=null;
    for (const n of world.nodes.values()) {
      if(n.name===flyingMarker){
        if(marker!==null || n.parent!==0n || n.shape!==0 || n.visual!==0n)
          fail("La salida lanzada requiere un único grupo raíz vacío.");
        marker=n.id;
      }
      if (n.parent !== 0n || !n.name.startsWith(prefix)) continue;
      const rest = n.name.slice(prefix.length), slot = Number(rest.slice(0,2)), label = rest.slice(3);
      if (!/^\d\d\//u.test(rest) || slot < 1 || slot > limit || slots.has(slot) ||
          n.shape !== 0 || n.visual !== 0n || n.q[0] !== 0 || n.q[2] !== 0 || n.s[2] !== 1)
        fail("Grupo de circuito inválido o con orden repetido (pieza " + n.id + ").");
      const angle = 2 * Math.atan2(n.q[1],n.q[3]);
      const bearing = ((-angle * 180 / Math.PI) % 360 + 360) % 360;
      const gate = {id:n.id,slot,label,point:n.p.slice(),width:n.s[0],height:n.s[1],bearing,
        rightX:Math.cos(angle),rightZ:-Math.sin(angle),forwardX:-Math.sin(angle),forwardZ:-Math.cos(angle)};
      validate(gate);
      slots.add(slot); gates.push(gate);
    }
    if(marker!==null){
      if(gates.length<2)fail("La salida lanzada necesita una puerta de salida y otra de meta.");
      for(const node of world.nodes.values())if(node.parent===marker)fail("El marcador de salida lanzada no admite piezas hijas.");
    }
    return {gates:gates.sort((a,b) => a.slot - b.slot),startMode:marker===null?"movement":"flying",grid:readGrid(world)};
  }
  return Object.freeze({read,scan:world=>read(world).gates,startMode:world=>read(world).startMode,
    validate,limit,prefix,flyingMarker,gridMarker,readGrid,writeGrid});
})();
