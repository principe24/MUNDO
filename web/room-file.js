"use strict";
// A Studio room export contains one published revision and its original .mworld bytes.
const MundoRoomFile = (() => {
  const magic = new Uint8Array([77, 82, 79, 79, 77, 13, 10, 26]);
  const headerSize = 20, maxMetadata = 2048, maxWorld = 24 * 1024 * 1024;
  const maxBytes = headerSize + maxMetadata + maxWorld;
  const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
  function validRoot(value) {
    return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
  }
  // Snapshot the three world-space coordinates before asynchronous publication.
  function copyMeetingPoint(value) {
    if (value == null) return null;
    if (!Array.isArray(value) || value.length !== 3)
      throw new Error("El punto de encuentro necesita tres coordenadas.");
    const point = [value[0], value[1], value[2]];
    if (!point.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6))
      throw new Error("Coordenadas del punto de encuentro fuera de rango.");
    return point;
  }

  function selectionBytes(info) {
    checkInfo(info);
    const point = copyMeetingPoint(info.meetingPoint);
    if (info.vehicleRoot != null && !validRoot(info.vehicleRoot))
      throw new Error("El ID del turismo de la sala es inválido.");
    if (point)
      return encoder.encode(JSON.stringify(["MUNDO-room-3",info.title,info.revision,info.hash,info.vehicleRoot ?? null,point]));
    if (!validRoot(info.vehicleRoot)) throw new Error("Falta la selección de la sala.");
    return encoder.encode(JSON.stringify(["MUNDO-room-2",info.title,info.revision,info.hash,info.vehicleRoot]));
  }

  function checkInfo(info) {
    if (!info || typeof info.title !== "string" || !info.title.trim() ||
        info.title.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(info.title) ||
        !Number.isSafeInteger(info.revision) || info.revision < 1 ||
        typeof info.hash !== "string" || !/^[a-f0-9]{64}$/.test(info.hash))
      throw new Error("Nombre, número de versión o huella de la publicación inválidos.");
  }

  function pack(info, world) {
    checkInfo(info);
    if (!(world instanceof Uint8Array) || world.byteLength < 24 || world.byteLength > maxWorld)
      throw new Error("Tamaño de mundo inválido.");
    const point = copyMeetingPoint(info.meetingPoint);
    const version = point ? 3 : info.vehicleRoot == null ? 1 : 2;
    const fields = {title: info.title, revision: info.revision, hash: info.hash};
    if (info.vehicleRoot != null) {
      if (!validRoot(info.vehicleRoot)) throw new Error("El ID del turismo de la sala es inválido.");
      fields.vehicleRoot = info.vehicleRoot;
    }
    if (point) fields.meetingPoint = point;
    if (version >= 2) {
      if (typeof info.selectionHash !== "string" || !/^[a-f0-9]{64}$/.test(info.selectionHash))
        throw new Error("La publicación requiere la huella de su selección.");
      fields.selectionHash = info.selectionHash;
    }
    const metadata = encoder.encode(JSON.stringify(fields));
    if (metadata.byteLength > maxMetadata) throw new Error("Metadatos de sala demasiado largos.");
    const file = new Uint8Array(headerSize + metadata.byteLength + world.byteLength);
    file.set(magic);
    const view = new DataView(file.buffer);
    view.setUint32(8, version, true);
    view.setUint32(12, metadata.byteLength, true);
    view.setUint32(16, world.byteLength, true);
    file.set(metadata, headerSize);
    file.set(world, headerSize + metadata.byteLength);
    return file;
  }

  function unpack(file) {
    if (!(file instanceof Uint8Array) || file.byteLength < headerSize || file.byteLength > maxBytes ||
        !magic.every((v, i) => file[i] === v))
      throw new Error("Cabecera de .mroom inválida.");
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const metadataSize = view.getUint32(12, true), worldSize = view.getUint32(16, true);
    const version = view.getUint32(8, true);
    if ((version < 1 || version > 3) || metadataSize > maxMetadata || worldSize < 24 ||
        worldSize > maxWorld || headerSize + metadataSize + worldSize !== file.byteLength)
      throw new Error("Versión o longitud de .mroom incompatible.");
    const offset = headerSize + metadataSize;
    const info = JSON.parse(decoder.decode(file.subarray(headerSize, offset)));
    checkInfo(info);
    const result = {title: info.title, revision: info.revision, hash: info.hash, world: file.subarray(offset)};
    if (version === 3) {
      result.meetingPoint = copyMeetingPoint(info.meetingPoint);
      if (!result.meetingPoint) throw new Error("Falta el punto de encuentro de la revisión.");
    } else if ("meetingPoint" in info) {
      throw new Error("Esta versión de sala no admite un punto de encuentro.");
    }
    if (version === 2 || "vehicleRoot" in info) {
      if (version === 1 || !validRoot(info.vehicleRoot)) throw new Error("Selección de turismo inválida.");
      result.vehicleRoot = info.vehicleRoot;
    }
    if (version >= 2) {
      if (typeof info.selectionHash !== "string" || !/^[a-f0-9]{64}$/.test(info.selectionHash))
        throw new Error("Huella de selección inválida.");
      result.selectionHash = info.selectionHash;
    } else if ("selectionHash" in info) {
      throw new Error("La cabecera de la sala no coincide con su selección.");
    }
    return result;
  }
  async function digest(bytes) {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
  }
  async function seal(info, bytes) {
    const metadata = {...info, meetingPoint:copyMeetingPoint(info.meetingPoint)};
    if (metadata.vehicleRoot != null || metadata.meetingPoint)
      metadata.selectionHash = await digest(selectionBytes(metadata));
    return pack(metadata, bytes);
  }
  async function verify(bytes) {
    const info = unpack(bytes);
    if (await digest(info.world) !== info.hash) throw Error("La escena recibida no coincide con la revisión.");
    if (info.selectionHash !== undefined && await digest(selectionBytes(info)) !== info.selectionHash)
      throw Error("La selección de sala no coincide con la revisión.");
    return info;
  }
  return Object.freeze({pack, unpack, maxBytes, selectionBytes, copyMeetingPoint, digest, seal, verify});
})();

if (typeof module !== "undefined" && module.exports) module.exports = MundoRoomFile;
