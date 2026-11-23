"use strict";
const os = require("node:os");
const path = require("node:path");
const { privateIPv4, roomNetwork } = require("./room.cjs");

function choices() {
  const addresses = new Map([["127.0.0.1", "Solo este equipo"]]);
  // A sandbox can allow loopback sockets while denying network enumeration.
  // Keep the local administrative workflow available in that environment.
  let interfaces;
  try { interfaces = os.networkInterfaces(); }
  catch (error) {
    if (!["ERR_SYSTEM_ERROR","EPERM","EACCES"].includes(error.code)) throw error;
    interfaces = {};
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const item of entries || []) {
      if (!item.internal && privateIPv4(item.address))
        addresses.set(item.address, name + " · " + item.address);
    }
  }
  if(process.env.MUNDO_ROOM_ORIGIN)addresses.set("internet","Dominio HTTPS del anfitrión");
  return Array.from(addresses, ([address, label]) => ({address, label}));
}

function settings(address) {
  if (!choices().some(item => item.address === address))
    throw Error("La interfaz elegida ya no está disponible. Vuelve a seleccionar la red de juego.");
  if (address === "127.0.0.1") return {host: address, tls: null};
  const folder = path.join(os.homedir(), "MundoEngie", "sala");
  const certPath = process.env.MUNDO_ROOM_CERT || path.join(folder, "cert.pem");
  const keyPath = process.env.MUNDO_ROOM_KEY || path.join(folder, "clave.pem");
  try {
    return roomNetwork({MUNDO_ROOM_IP:address==="internet"?(process.env.MUNDO_ROOM_IP||"127.0.0.1"):address,
      MUNDO_ROOM_ORIGIN:address==="internet"?process.env.MUNDO_ROOM_ORIGIN:undefined,
      MUNDO_ROOM_CERT:certPath,MUNDO_ROOM_KEY:keyPath});
  } catch(error) {
    if(error.code)throw Error("Revisa el certificado y la clave en las rutas del anfitrión.");
    throw error;
  }
}

module.exports = {choices, settings};
