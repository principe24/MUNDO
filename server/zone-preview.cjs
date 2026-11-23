"use strict";
const {createHash} = require("node:crypto");
const {Worker,isMainThread,parentPort,workerData} = require("node:worker_threads");
const {indexReuseRanges} = require("./world-reuse.cjs");

const maxWorldBytes = 24 * 1024 * 1024;
const maxPackageBytes = 32 * 1024 * 1024;
const previewTimeMs = 120_000;
const workerJob = "mundo-prepared-zone-inventory";
const entryJob = "mundo-room-entry-zones";
const cellJob = "mundo-room-cell-index";
const sectorJob = "mundo-room-sector-catalog";
const entryTimeMs = 12_000;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// The directory is indexed by signed (X,Z), with the global bucket always first.
// One transferred allocation for all world documents avoids thousands of worker
// messages. Bit 31 of the private node count marks a potential wheel support.
function sectorCatalog(api,world,original,vehicleRoot,sourceVersion) {
  const ordered=api.MundoZones.roomSectorGroups(world,original,vehicleRoot);
  if (!ordered) return null;
  const table=Buffer.allocUnsafeSlow(52*ordered.length),parts=[];
  let size=0;
  for (let i=0;i<ordered.length;++i) {
    const {x,z,world:model,road}=ordered[i],bytes=api.MundoWorld.encode(model,sourceVersion);
    const at=i*52;
    table.writeInt32LE(x,at);table.writeInt32LE(z,at+4);
    table.writeUInt32LE(size,at+8);table.writeUInt32LE(bytes.byteLength,at+12);
    table.writeUInt32LE(model.nodes.size+(road?0x80000000:0),at+16);
    createHash("sha256").update(bytes).digest().copy(table,at+20);
    size+=bytes.byteLength;
    if (!api.MundoZones.sectorCatalogFits(i===0?bytes.byteLength:parts[0].byteLength,size,ordered.length)) return null;
    parts.push(bytes);
  }
  const bytes=new Uint8Array(size);
  let at=0;
  for (const part of parts) {bytes.set(part,at);at+=part.byteLength;}
  return {bytes,table};
}

function arrival(api, world, vehicleRoot, meetingPoint) {
  if (meetingPoint) return [meetingPoint[0],meetingPoint[2]];
  const scene = api.MundoGeometry.flatten(world);
  const car = api.MundoDriving.roomCar(scene,vehicleRoot);
  const solids = car ? scene.objects.filter(object => !car.partIds.has(object.n.id)) : scene.objects;
  const spawn = new api.MundoWalk(solids,false).spawn;
  return [spawn[0],spawn[2]];
}

async function inspect({bytes,revision,vehicleRoot,meetingPoint,job,profile,focusXZ}) {
  if (sha256(bytes) !== revision) throw Error("El mundo preparado ya no coincide con su revisión.");
  const api = require("./room-runtime.cjs");
  const original = api.MundoWorld.decode(bytes);
  if (job === cellJob || job === sectorJob) {
    // Studio serializes ascending IDs. Most releases can use their decoded
    // world directly without producing and hashing a second 24 MiB document.
    let last=0n,sorted=true;
    for (const id of original.nodes.keys()) {
      if (id<=last) { sorted=false; break; }
      last=id;
    }
    const snapshot=sorted?original:api.MundoWorld.decode(api.MundoWorld.encode(original));
    if (job===sectorJob) {
      const version=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8,true);
      return sectorCatalog(api,snapshot,original,vehicleRoot,version);
    }
    const index=api.MundoZones.roomCellIndex(snapshot,original,revision,vehicleRoot);
    return index?{bytes:index}:null;
  }
  const canonical = api.MundoWorld.encode(original);
  const worldSha256 = sha256(canonical);
  const snapshot = worldSha256 === revision ? original : api.MundoWorld.decode(canonical);
  if (job === entryJob) {
    const focus = focusXZ ?? arrival(api,original,vehicleRoot,meetingPoint);
    const sourceVersion = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8,true);
    const selected = api.MundoZones.roomEntry(snapshot,profile,focus,bytes.byteLength,sourceVersion);
    if (!selected) return null;
    return {bytes:selected.bytes, hash:sha256(selected.bytes), focus, cells:selected.cells,
      ranges:indexReuseRanges(bytes,selected.bytes)};
  }
  const file = api.MundoZones.pack(snapshot);
  if (file.size > maxPackageBytes) throw Error("El paquete de zonas supera el límite de 32 MiB.");
  // Older documents may store entities in a different order. The host chooses
  // its first supporting floor from the original bytes. Studio exports sorted IDs.
  const focus = arrival(api,original,vehicleRoot,meetingPoint);
  const studioFocus = snapshot === original || meetingPoint ? focus : arrival(api,snapshot,vehicleRoot,null);
  const inventory = await api.MundoZones.inventory(file,worldSha256,focus);
  return {
    worldSha256,preparedSha256:revision,packageSha256:inventory.packageSha256,packageBytes:inventory.packageBytes,
    directoryBytes:inventory.directoryBytes,cellSize:inventory.cellSize,focus:inventory.focus,
    profiles:inventory.profiles,globalBytes:inventory.entries[0].bytes,regions:inventory.entries.length-1,
    ...(focus[0]!==studioFocus[0] || focus[1]!==studioFocus[1] ? {studioFocus} : {})
  };
}

async function runWorker(def, signal, job, profile, focusXZ) {
  if (signal?.aborted) throw Error("Se canceló el inventario de zonas.");
  if (!(def?.bytes instanceof Uint8Array) || def.bytes.byteLength < 24 || def.bytes.byteLength > maxWorldBytes ||
      typeof def.revision !== "string" || !/^[0-9a-f]{64}$/.test(def.revision))
    throw Error("Elige un mundo preparado de hasta 24 MiB con una revisión válida.");
  const vehicleRoot = def.vehicleRoot ?? null, meetingPoint = def.meetingPoint ?? null;
  if (vehicleRoot !== null && (typeof vehicleRoot !== "string" || !/^[1-9][0-9]{0,19}$/.test(vehicleRoot)))
    throw Error("El turismo elegido es inválido.");
  if (meetingPoint !== null && (!Array.isArray(meetingPoint) || meetingPoint.length !== 3 ||
      ![0,1,2].every(i => Number.isFinite(meetingPoint[i]) && Math.abs(meetingPoint[i]) <= 1e6)))
    throw Error("El punto de encuentro de esta revisión es inválido.");

  // A Buffer may be a view of an upload or a shared slab. Transfer only a fresh
  // copy of the selected world's bytes. The published copy stays usable in the room.
  const bytes = new Uint8Array(def.bytes);
  const worker = new Worker(__filename,{
    workerData:{job,bytes,revision:def.revision,vehicleRoot,meetingPoint,profile,focusXZ},
    transferList:[bytes.buffer],execArgv:[],env:{},
    resourceLimits:{maxOldGenerationSizeMb:384,maxYoungGenerationSizeMb:32}
  });
  return new Promise((resolve,reject) => {
    let failure,reply,received = false;
    function stop(error) {
      if (failure) return;
      failure=error;
      void worker.terminate().catch(()=>{});
    }
    const abort = () => stop(Error("Se canceló el inventario de zonas."));
    const timer = setTimeout(() => stop(Error("Se agotó el tiempo para inspeccionar esta revisión.")),
      job===workerJob?previewTimeMs:entryTimeMs);
    worker.once("message",result => {
      if (result && Object.hasOwn(result,"value")) { received=true; reply=result.value; }
      else stop(Error(result?.error || "El inventario local está incompleto."));
    });
    worker.once("error",() => stop(Error("No se pudo preparar el inventario de zonas en el equipo anfitrión.")));
    // Resolve after exit so cancellation cannot overlap the next queued worker.
    worker.once("exit",code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort",abort);
      if (failure) reject(failure);
      else if (!received || code!==0) reject(Error("El proceso de inventario terminó antes de entregar su resultado."));
      else resolve(reply);
    });
    signal?.addEventListener("abort",abort,{once:true});
    if (signal?.aborted) abort();
  });
}

function inspectPreparedZones(def, signal) {
  return runWorker(def,signal,workerJob);
}
function prepareCellIndex(def, signal) {
  return runWorker(def,signal,cellJob);
}
function prepareSectorCatalog(def, signal) {
  return runWorker(def,signal,sectorJob);
}
function prepareEntryZones(def, profile, focusXZ, signal) {
  if (profile!=="mobile" && profile!=="pc") throw Error("Perfil de entrada desconocido.");
  if (focusXZ!=null && (!Array.isArray(focusXZ) || focusXZ.length!==2 || !focusXZ.every(Number.isFinite)))
    throw Error("Punto de entrada inválido.");
  return runWorker(def,signal,entryJob,profile,focusXZ);
}

if (!isMainThread && [workerJob,entryJob,cellJob,sectorJob].includes(workerData?.job)) {
  inspect(workerData).then(
    value => {
      const transfer=value?.bytes?[value.bytes.buffer]:[];
      if (value?.ranges) transfer.push(value.ranges.buffer);
      if (value?.table) transfer.push(value.table.buffer);
      parentPort.postMessage({value},transfer);
    },
    error => parentPort.postMessage({error:String(error?.message || "Inventario de zonas inválido.").slice(0,240)})
  );
}
module.exports = {inspectPreparedZones,prepareEntryZones,prepareCellIndex,prepareSectorCatalog};
