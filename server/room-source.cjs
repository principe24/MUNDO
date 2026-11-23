"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const roomFile = require("../web/room-file.js");
const modelRoom = require("../web/model-room.js");

const audioRoom = require("../web/audio-clips.js");
const audioScene = require("../web/audio-scene.js");

function openRoomSource(filename) {
  const limit = byteLimit(filename);
  const fd = fs.openSync(filename, "r");
  let data;
  try {
    const file = fs.fstatSync(fd);
    if (!file.isFile() || file.size < 24 || file.size > limit) throw Error("Archivo incompatible.");
    data = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, null);
      if (!count) throw Error("Lectura incompleta.");
      offset += count;
    }
  } finally { fs.closeSync(fd); }
  return readRoomSource(filename, data);
}

function byteLimit(filename) {
  const ext=path.extname(filename).toLowerCase();
  if(ext===".mprojectaudio")return require("../web/audio-project.js").maxBytes;
  return ext===".mroomaudio" ? audioRoom.maxRoomBytes : ext===".mroom3d" ? modelRoom.maxBytes : ext===".mproject" ? 64*1024*1024 : ext===".mroom" ? roomFile.maxBytes : 24*1024*1024;
}

function readRoomSource(filename, data) {
  if (data.length < 24 || data.length > byteLimit(filename)) throw Error("Tamaño de archivo incompatible.");
  if(path.extname(filename).toLowerCase()===".mprojectaudio"){
    const {project,items}=require("../web/audio-project.js").unpack(data);
    const audioClips=new Map();
    for(const item of items){
      if(createHash("sha256").update(item.bytes).digest("hex")!==item.digest)
        throw Error("La grabación del proyecto no coincide con su huella.");
      audioClips.set(item.key,item);
    }
    return {projectData:Buffer.from(project),audioClips,publication:null};
  }
  if (path.extname(filename).toLowerCase() === ".mroomaudio") {
    const {room,items}=audioRoom.unpack(data);
    const source=readRoomSource(audioRoom.hasModels(room)?"revision.mroom3d":"revision.mroom",room);
    const {MundoWorld}=require("./room-runtime.cjs");
    audioRoom.match(audioScene.read(MundoWorld.decode(source.bytes)),items);
    const audioClips=new Map();
    for(const item of items){
      if(createHash("sha256").update(item.bytes).digest("hex")!==item.digest)
        throw Error("La grabación no coincide con su huella.");
      audioClips.set(item.key,item);
    }
    return {...source,audioClips};
  }
  if (path.extname(filename).toLowerCase() === ".mroom3d") {
    const {room,items}=modelRoom.unpack(data);
    const source=readRoomSource("revision.mroom",room);
    const {MundoWorld}=require("./room-runtime.cjs");
    modelRoom.match(MundoWorld.decode(source.bytes),items);
    const models=new Map();
    for (const item of items) {
      if (createHash("sha256").update(item.bytes).digest("hex")!==item.digest)
        throw Error("Los datos del modelo no coinciden con su huella.");
      models.set(item.key,{digest:item.digest,bytes:item.bytes,name:item.name});
    }
    return {...source,models};
  }
  if (path.extname(filename).toLowerCase() === ".mproject")return {projectData:data,publication:null};
  if (path.extname(filename).toLowerCase() !== ".mroom")
    return {bytes: data, title: path.parse(filename).name, publication: null};
  const source = roomFile.unpack(data);
  if (createHash("sha256").update(source.world).digest("hex") !== source.hash)
    throw Error("La escena no coincide con la huella de la publicación de Studio.");
  const result = {publicationHash:createHash("sha256").update(data).digest("hex"),bytes: source.world, title: source.title + " · v" + source.revision, publication: source.revision};
  if (source.selectionHash !== undefined &&
      createHash("sha256").update(roomFile.selectionBytes(source)).digest("hex") !== source.selectionHash)
    throw Error("La selección de sala no coincide con la revisión publicada.");
  if (source.vehicleRoot !== undefined) result.vehicleRoot = source.vehicleRoot;
  if (source.meetingPoint !== undefined) result.meetingPoint = source.meetingPoint;
  return result;
}

module.exports = {openRoomSource, readRoomSource, byteLimit};
