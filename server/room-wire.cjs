"use strict";
const mediaType = "application/vnd.mundo.room-v1";
const mediaTypeV2 = "application/vnd.mundo.room-v2";
const mediaTypeV3 = "application/vnd.mundo.room-v3";
const maxEntityId = (1n << 64n) - 1n;

// All integers and IEEE 754 doubles are little endian. The revision is the raw SHA-256 digest.
function encodeJoin({id, ack, revision, name, project=false}) {
  if ((id !== 0 && id !== 1) || !Number.isSafeInteger(ack) || ack < 0 ||
      typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision) || typeof name !== "string")
    throw new RangeError("Entrada de sala inválida.");
  const title = Buffer.alloc(255);
  // Buffer.write ends on a whole UTF-8 character when the title exceeds the field.
  const length = title.write(name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim() || "MUNDO");
  const body = Buffer.alloc(46 + length);
  body.write(project?"MWJ2":"MWJ1", 0, "ascii");
  body.writeUInt8(id, 4);
  body.writeBigUInt64LE(BigInt(ack), 5);
  Buffer.from(revision, "hex").copy(body, 13);
  body.writeUInt8(length, 45);
  title.copy(body, 46, 0, length);
  return body;
}

function encodeSnapshot({ack, players}) {
  if (!Number.isSafeInteger(ack) || ack < 1 || !Array.isArray(players) ||
      players.length < 1 || players.length > 2) throw new RangeError("Estado de sala inválido.");
  const seats = new Set();
  for (const p of players) {
    if (!p || (p.id !== 0 && p.id !== 1) || seats.has(p.id) ||
        typeof p.grounded !== "boolean" || !Array.isArray(p.position) || p.position.length !== 3 ||
        !p.position.every(n => Number.isFinite(n) && Math.abs(n) <= 1e15) ||
        !Number.isFinite(p.yaw) || Math.abs(p.yaw) > Math.PI + .000001 || !Number.isFinite(p.vy))
      throw new RangeError("Pose de jugador inválida.");
    seats.add(p.id);
  }
  const body = Buffer.alloc(13 + 42 * players.length);
  body.write("MWS1", 0, "ascii");
  body.writeUInt8(players.length, 4);
  body.writeBigUInt64LE(BigInt(ack), 5);
  let at = 13;
  for (const player of players) {
    body.writeUInt8(player.id, at++);
    body.writeUInt8(player.grounded ? 1 : 0, at++);
    for (const value of [...player.position, player.yaw, player.vy]) {
      body.writeDoubleLE(value, at);
      at += 8;
    }
  }
  return body;
}

// V2 preserves the player record, then adds a presence byte and one optional car.
function encodeSnapshotV2(state) {
  const players = encodeSnapshot(state);
  const car = state.car;
  const body = Buffer.alloc(players.length + 1 + (car == null ? 0 : 57));
  players.copy(body);
  body.write("MWS2", 0, "ascii");
  if (car == null) return body;
  if (typeof car.root !== "string" || !/^[1-9][0-9]{0,19}$/.test(car.root) ||
      BigInt(car.root) > maxEntityId ||
      (car.driver !== null && !state.players.some(p => p.id === car.driver)) ||
      ![car.x, car.z, car.yaw, car.speed, car.steer, car.distance].every(Number.isFinite) ||
      Math.abs(car.x) > 1e15 || Math.abs(car.z) > 1e15 || Math.abs(car.distance) > 1e15 ||
      car.speed < -4.000001 || car.speed > 14.000001 || Math.abs(car.steer) > .470001)
    throw new RangeError("Estado del vehículo inválido.");
  let at = players.length;
  body[at++] = 1;
  body.writeBigUInt64LE(BigInt(car.root), at);
  at += 8;
  body[at++] = car.driver === null ? 255 : car.driver;
  const yaw = Math.atan2(Math.sin(car.yaw), Math.cos(car.yaw));
  for (const value of [car.x, car.z, yaw, car.speed, car.steer, car.distance]) {
    body.writeDoubleLE(value, at);
    at += 8;
  }
  return body;
}

// V3 appends a passenger seat to a present car. The two seat bytes must name different players.
function encodeSnapshotV3(state) {
  const previous = encodeSnapshotV2(state);
  previous.write("MWS3", 0, "ascii");
  if (!state.car) return previous;
  const {driver, passenger} = state.car;
  if (passenger !== null && (passenger === driver || !state.players.some(p => p.id === passenger)))
    throw new RangeError("Plaza de pasajero inválida.");
  return Buffer.concat([previous, Buffer.from([passenger === null ? 255 : passenger])]);
}
// Only sent to v3 peers that explicitly requested the circuit extension. The
// fixed 36-byte trailer carries IDs from the hashed world, never names or geometry.
function encodeCircuit(state,course,withSplits=false,flying=false) {
  const base=encodeSnapshotV3(state);
  if(!course)return base;
  const flags=["ready","running","finished"];
  const extension=Buffer.alloc(36);
  extension.writeBigUInt64LE(BigInt(course.run),0);
  extension[8]=course.passed;extension[9]=course.total;
  extension[10]=flags.indexOf(course.phase);extension[11]=Number(course.bestMs!==null);
  extension.writeBigUInt64LE(BigInt(course.elapsedMs),12);
  extension.writeBigUInt64LE(BigInt(course.bestMs??0),20);
  extension.writeBigUInt64LE(BigInt(course.nextId??0),28);
  if(!withSplits){
    base.write("MWS4",0,"ascii");
    return Buffer.concat([base,extension]);
  }
  // Zero is a valid crossing time. Only the flag announces a known value.
  const trailer=Buffer.alloc(17);
  if(course.split){
    const {atMs,referenceMs}=course.split;
    if(!course.passed || !Number.isSafeInteger(atMs) || atMs<0 || atMs>course.elapsedMs ||
       (course.phase==="finished" && atMs!==course.elapsedMs) ||
       (referenceMs!==null && (!Number.isSafeInteger(referenceMs) || referenceMs<0)))
      throw new RangeError("Parcial de circuito inválido.");
    trailer[0]=referenceMs===null?1:3;
    trailer.writeBigUInt64LE(BigInt(atMs),1);
    if(referenceMs!==null)trailer.writeBigUInt64LE(BigInt(referenceMs),9);
  }
  base.write(flying?"MWS6":"MWS5",0,"ascii");
  return Buffer.concat([base,extension,trailer]);
}
function encodeRoute(info) {
  const prefix=Buffer.alloc(45);
  prefix.write("MWT1",0,"ascii");prefix[4]=info.phase;
  prefix.writeBigUInt64LE(BigInt(info.epoch),5);prefix.writeBigUInt64LE(BigInt(info.world),13);
  prefix.writeBigUInt64LE(BigInt(info.root??0),21);Buffer.from(info.lease,"hex").copy(prefix,29);
  return Buffer.concat([prefix,encodeJoin(info)]);
}
// Negotiated envelope keeps the existing snapshot intact, including its circuit trailer.
function encodeNpcs(base,npcs){
  if(!Array.isArray(npcs) || npcs.length>8 || base.length>65535)
    throw new RangeError("Estado de NPC demasiado grande.");
  if(!npcs.length)return base;
  const {NPC_STATES}=require("./npc-simulation.cjs");
  const body=Buffer.alloc(7+base.length+41*npcs.length);
  body.write("MWN1",0,"ascii");
  body.writeUInt16LE(base.length,4);
  base.copy(body,6);
  let at=base.length+6;
  body[at++]=npcs.length;
  const ids=new Set();
  for(const npc of npcs){
    const state=NPC_STATES.indexOf(npc.state);
    if(typeof npc.id!=="string" || !/^[1-9][0-9]{0,19}$/.test(npc.id) ||
       BigInt(npc.id)>maxEntityId || ids.has(npc.id) || state<0 ||
       !Array.isArray(npc.position) || npc.position.length!==3 ||
       !npc.position.every(n=>Number.isFinite(n) && Math.abs(n)<=1e12) ||
       !Number.isFinite(npc.yaw) || Math.abs(npc.yaw)>Math.PI+.000001)
      throw new RangeError("Pose de NPC inválida.");
    ids.add(npc.id);
    body.writeBigUInt64LE(BigInt(npc.id),at);at+=8;
    for(const n of [...npc.position,npc.yaw]){body.writeDoubleLE(n,at);at+=8;}
    body[at++]=state;
  }
  return body;
}
module.exports = {encodeNpcs,encodeCircuit,encodeRoute,mediaType, mediaTypeV2, mediaTypeV3, encodeJoin, encodeSnapshot, encodeSnapshotV2, encodeSnapshotV3};
