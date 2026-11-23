"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Owner-controlled selection. Only the two cooked meshes and their colour atlas
// are part of MAVATAR1; a scene, a client or a publication cannot supply a path.
function inesPackage() {
  const header = Buffer.alloc(20);
  header.write("MAVATAR1", 0, "ascii");
  const names = ["ines-ligera.mesh", "ines.mesh", "ines-color.webp"];
  try {
    const parts = names.map((name, i) => {
      const asset = path.join(__dirname, "../owner/bajamar/media", name);
      const length = fs.statSync(asset).size;
      if (length <= 0 || length > 2 * 1024 * 1024) throw Error();
      const data = fs.readFileSync(asset);
      if (data.length !== length) throw Error();
      header.writeUInt32LE(length, 8 + i * 4);
      return data;
    });
    const length = parts.reduce((sum, data) => sum + data.length, header.length);
    if (length > 4 * 1024 * 1024) throw Error();
    return Buffer.concat([header, ...parts], length);
  } catch {
    throw Object.assign(Error("Faltan los recursos privados de Inés. Revisa el ZIP antes de ofrecerla en esta sala."), {status: 422});
  }
}

module.exports = {inesPackage};
