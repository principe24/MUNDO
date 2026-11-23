"use strict";

const PART_SIZE = 1024 * 1024;
const HEADER_SIZE = 16;
const MAX_WORLD_SIZE = 24 * PART_SIZE;
const digest = /^[0-9a-f]{64}$/;
const leaseId = /^[0-9a-f]{32}$/;

function reject(status, message) {
  throw Object.assign(new Error(message), {status});
}

// The caller selects the immutable scene for the authorized seat and epoch.
// Its SHA-256 was checked on publication load. A part uses that same identity.
function validateWorldRequest(msg, project, part=false) {
  const keys = project ? ["revision", "epoch", "lease"] : ["revision"];
  if (part) keys.push("offset");
  if (!msg || typeof msg !== "object" ||
      (Object.getPrototypeOf(msg) !== Object.prototype && Object.getPrototypeOf(msg) !== null) ||
      Reflect.ownKeys(msg).length !== keys.length || !keys.every(key => Object.hasOwn(msg, key)) ||
      typeof msg.revision !== "string" || msg.revision.length !== 64 || !digest.test(msg.revision) ||
      (part && typeof msg.offset !== "number") ||
      (project && (!Number.isSafeInteger(msg.epoch) || msg.epoch < 1 ||
        typeof msg.lease !== "string" || msg.lease.length !== 32 || !leaseId.test(msg.lease)))) {
    reject(400, part?"La solicitud del fragmento tiene un formato inválido.":"La consulta de revisión tiene un formato inválido.");
  }
}
function validatePartRequest(msg, project) {
  validateWorldRequest(msg,project,true);
}
function worldPart(bytes, revision, msg) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > MAX_WORLD_SIZE ||
      typeof revision !== "string" || revision.length !== 64 || !digest.test(revision)) {
    throw new Error("El anfitrión carece de una escena válida para la descarga.");
  }
  if (msg.revision !== revision) reject(412, "La revisión solicitada cambió.");
  const total = bytes.byteLength, offset = msg.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total || offset % PART_SIZE !== 0) {
    reject(416, "El desplazamiento del fragmento está fuera del intervalo permitido.");
  }
  const length = Math.min(PART_SIZE, total - offset);
  const result = Buffer.allocUnsafe(HEADER_SIZE + length);
  result.write("MWC1", 0, 4, "ascii");
  result.writeUInt32LE(total, 4);
  result.writeUInt32LE(offset, 8);
  result.writeUInt32LE(length, 12);
  result.set(bytes.subarray(offset, offset + length), HEADER_SIZE);
  return result;
}

module.exports = {worldPart, validatePartRequest, validateWorldRequest, PART_SIZE, HEADER_SIZE, MAX_WORLD_SIZE};
