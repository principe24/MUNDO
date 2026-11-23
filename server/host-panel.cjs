"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { spawn } = require("node:child_process");
const { openRoomSource, readRoomSource, byteLimit } = require("./room-source.cjs");
const { roomFromSource, createHost, playerInvitation } = require("./room.cjs");
const { inspectPreparedZones } = require("./zone-preview.cjs");

const { invitationRows } = require("./seat-qr.cjs");
const network = require("./panel-network.cjs");

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/panel.js", ["panel.js", "text/javascript; charset=utf-8"]],
  ["/route-map.js", ["route-map.js", "text/javascript; charset=utf-8"]],
  ["/ahead-usage.js", ["ahead-usage.js", "text/javascript; charset=utf-8"]],
  ["/timing-panel.js", ["timing-panel.js", "text/javascript; charset=utf-8"]],
  ["/panel.css", ["panel.css", "text/css; charset=utf-8"]]
].map(([route, [name, type]]) => [route, {type, data: fs.readFileSync(path.join(__dirname, "panel", name))}]));

// Only these authoring files are readable on the loopback administrator listener.
const studioFiles = [
  "studio/Mundos.html", "studio/Mundo_Studio.html", "studio/preview.js", "studio/component-inspector.js", "studio/plugin-panel.js","studio/editor.js", "studio/ahead-inspector.js", "studio/ahead-usage-panel.js", "studio/course-timing-panel.js", "studio/district-panel.js",
  "studio/circuit-tools.js", "studio/grid-panel.js", "studio/circuit-panel.js", "studio/project-panel.js", "studio/publications.js", "studio/tools.js", "studio/vehicle.js",
  "web/creator-mesh.js", "web/model-room.js", "web/obj-import.js", "studio/creator-assets.js", "web/creator-surface-materials.js", "studio/creator-material-panel.js", "studio/creator-model-panel.js",
  "studio/studio.css", "studio/vehicle-model.js", "studio/patio-template.js", "web/world.js", "web/starting-content.js", "web/geometry.js",
  "web/zones.js", "web/view.js", "web/meeting.js", "web/room-file.js", "web/circuit.js","web/component-record.js","web/plugin-registry.js","web/project.js","web/experience-look.js","web/bruma-look.js",
  "web/audio-scene.js","web/audio-clips.js","web/audio-library.js","web/audio-dsp.js","web/audio-output.js","studio/audio-panel.js",
  "web/npc-routes.js","web/navigation-3d.js","studio/npc-preflight.js","studio/npc-panel.js",
  "web/interface.css", "web/ahead-report.js", "web/course-timing.js", "mundo/drive.js", "mundo/walk.js"
];
for (const file of studioFiles) {
  const ext = path.extname(file);
  const type = {".html":"text/html", ".js":"text/javascript", ".css":"text/css"}[ext];
  let data = fs.readFileSync(path.join(__dirname, "..", file));
  if (ext === ".html") data = Buffer.from(data.toString("utf8").replace("connect-src 'none'", "connect-src 'self'"));
  assets.set("/"+file, {type:type+"; charset=utf-8", data});
}

function reject(status, message) {
  throw Object.assign(new Error(message), {status});
}

async function prepareSource(filename, source) {
  const room = await roomFromSource(source);
  return {room, filename, models:source.models, publication: source.publication, selected: source.vehicleRoot !== undefined};
}

async function uploadedSource(req) {
  if (req.headers["content-type"] !== "application/octet-stream") reject(415, "Envía un archivo de Studio.");
  let filename;
  try { filename = decodeURIComponent(req.headers["x-mundo-file"] || ""); } catch {}
  if (!filename || filename.length > 255 || /[\\/\x00-\x1f\x7f]/u.test(filename) || !/\.(mroomaudio|mroom3d|mroom|mworld|mproject)$/i.test(filename))
    reject(400, "Selecciona un proyecto .mproject, una sala .mroom, .mroomaudio o .mroom3d, o un .mworld.");
  const limit = byteLimit(filename);
  if (Number(req.headers["content-length"]) > limit) reject(413, "El archivo supera el tamaño admitido.");
  const parts = [];
  let total = 0;
  for await (const part of req) {
    total += part.length;
    if (total > limit) reject(413, "El archivo supera el tamaño admitido.");
    parts.push(part);
  }
  try {
    const source = readRoomSource(filename, Buffer.concat(parts, total));
    return await prepareSource(filename, source);
  } catch (error) {
    reject(422, "No se pudo preparar la escena. " + error.message);
  }
}

// Only the local operator can select the executable at startup.
function configuredPlayer() {
  const exe = process.env.MUNDO_PLAYER_EXE;
  if (process.platform !== "win32" || !exe || !/^[A-Za-z]:[\\/]/.test(exe) ||
      !/^MUNDO(?:_Propietario)?\.exe$/i.test(path.basename(exe))) return null;
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

function openNativePlayer(exe, link) {
  return new Promise((resolve, rejectLaunch) => {
    const child = spawn(exe, ["--host-seat"], {
      cwd: path.dirname(exe), env: {...process.env, MUNDO_HOST_SEAT: link},
      detached: true, stdio: "ignore", shell: false
    });
    child.once("error", rejectLaunch);
    child.once("spawn", () => { child.unref(); resolve(child); });
  });
}

function createPanel(initialFile) {
  const playerExe = configuredPlayer();
  const secret = randomBytes(32).toString("hex");
  let origin, pending = null, active = null, version = 0, busy = false;
  let commandDone = Promise.resolve(), starting = null, stopping = null, stopRequested = false;
  let zoneScan = null;
  let sessionNumber = 0, preparationNumber = 0;
  let lastUsage = null;
  let initialMessage = "";
  const initial=initialFile?(async()=>{
    try {
      if (!/\.(mroomaudio|mroom3d|mroom|mworld|mproject)$/i.test(initialFile)) throw Error("Selecciona un proyecto .mproject, una sala .mroom, .mroomaudio o .mroom3d, o un .mworld.");
      pending = await prepareSource(path.basename(initialFile), openRoomSource(initialFile));
      pending.preparation=++preparationNumber;
    } catch {
      initialMessage = "No se pudo preparar el archivo de arranque. Puedes seleccionar otra publicación.";
    }
  })():Promise.resolve();
  function describe(source,view) {
    const {room, filename, publication, selected} = source;
    const state = room.moderation.status(view);
    const vehicle = state.vehicle;
    return {filename, preparation:source.preparation, audioClipCount:source.room.audioClips?.size??0, modelCount:source.models?.size??0, modelNames:source.models ? Array.from(source.models.values(),m=>m.name) : [], title: room.name, characterLook:room.characterLook, usesBruma:room.usesBruma, publication:room.project?room.source.publication:publication,
      hash: room.revision, selected:room.project?room.source.vehicleRoot!==null:selected, project:state.project,
      course:state.course, checkpoint:active?.source === source ? state.checkpoint : null,
      ...(view==="preview"?{}:{track:state.track}),
      zones:pending === source ? source.zones ?? null : null,
      meetingPoint: room.meetingPoint, meetingSeats: room.meetingSeats,
      car: vehicle && {root: vehicle.root, driver: vehicle.driver, passenger: vehicle.passenger},
      seats: state.seats.map(seat => ({...seat, localPlayerOpen: active?.launched.has(seat.number) || false})),
      admissionsOpen: state.admissionsOpen};
  }
  function state() {
    const room = active && (active.closingView ?? describe(active.source,"live"));
    const ahead = active ? {session: active.number, finished: false, summary: active.source.room.moderation.aheadSummary()}
      : lastUsage && {session: lastUsage.number, finished: true, summary: lastUsage.summary};
    const identity = active ? active.source.room.moderation.courseTimingIdentity() : lastUsage?.timing;
    const timing = identity ? {session: active?.number ?? lastUsage.number, finished: !active,
      revision: identity.revision, publication: identity.publication ?? null, carRoot: identity.carRoot,
      parked: identity.parked, key: timingKey(identity)} : null;
    return {version, nativePlayer: Boolean(playerExe), initialMessage, preview: pending && describe(pending,"preview"), room,
      ahead, timing, shareInes: Boolean(active?.shareInes), shareBruma:Boolean(active?.shareBruma), shareModels:Boolean(active?.shareModels),
      endpoint: active ? active.origin : null, addresses: active ? [] : network.choices(),
      network: active ? active.host : (process.env.MUNDO_ROOM_ORIGIN ? "internet" : process.env.MUNDO_ROOM_IP || "127.0.0.1")};
  }
  function timingKey(identity) {
    return [identity.context, identity.revision, identity.publication ?? "-", identity.carRoot].join("/");
  }
  function finishRoom() {
    const room = active.source.room, {moderation} = room;
    const report = moderation.courseTiming();
    const timing = report && {...moderation.courseTimingIdentity(),report};
    lastUsage = {number: active.number, summary: moderation.aheadSummary(), snapshot: moderation.aheadUsage(), timing};
    active = null;
  }
  async function command(route, req) {
    if (stopRequested) reject(503, "El panel se está cerrando.");
    if (route === "/api/state") return state();
    if (route === "/api/ahead/usage" || route === "/api/circuit/timing") {
      const number = active?.number ?? lastUsage?.number;
      if (!number || req.headers["x-mundo-session"] !== String(number))
        reject(409, "La sala cambió. Vuelve a abrir el informe.");
      if (active?.closingView) reject(409, "Se está cerrando la sala. El registro final estará disponible al terminar.");
      if (route === "/api/ahead/usage") return active ? active.source.room.moderation.aheadUsage() : lastUsage.snapshot;
      const identity = active ? active.source.room.moderation.courseTimingIdentity() : lastUsage.timing;
      if (!identity || req.headers["x-mundo-circuit"] !== timingKey(identity)) reject(409, "El mundo del circuito ha cambiado.");
      if (!active) return lastUsage.timing.report;
      const report = active.source.room.moderation.courseTiming();
      if (!report) reject(409, "Este mundo carece de circuito activo.");
      return report;
    }
    if (req.headers["x-mundo-version"] !== String(version) || busy)
      reject(409, "El panel ha cambiado. Revisa el estado actual.");
    busy = true;
    let finishCommand;
    commandDone = new Promise(resolve => { finishCommand = resolve; });
    try {
      if (route === "/api/prepare") {
        if (active) reject(409, "Cierra la sala antes de preparar otra.");
        const source = await uploadedSource(req);
        source.preparation=++preparationNumber;
        pending = source;
        initialMessage = "";
      } else if (route === "/api/zones/inspect") {
        if (!pending || active) reject(409, "Prepara el mundo antes de calcular el inventario de zonas.");
        if (!pending.zones) {
          zoneScan = new AbortController();
          try { pending.zones = await inspectPreparedZones(pending.room.source, zoneScan.signal); }
          catch { reject(422, "No se pudo calcular el inventario espacial de este mundo. La revisión sigue preparada."); }
          finally { zoneScan = null; }
        }
      } else if (route === "/api/start") {
        if (!pending || active) reject(409, "Prepara una revisión antes de abrir la sala.");
        const address = req.headers["x-mundo-address"];
        const actor = req.headers["x-mundo-actor"];
        if (actor !== undefined && actor !== "ines-bajamar-1") reject(400, "Selección de personaje desconocida.");
        const shareInes = actor === "ines-bajamar-1";
        const carArt = req.headers["x-mundo-car-art"];
        if (carArt !== undefined && carArt !== "bruma-1") reject(400, "Selección de carrocería desconocida.");
        const shareBruma = carArt === "bruma-1";
        const modelChoice=req.headers["x-mundo-creator-models"];
        if (modelChoice!==undefined && (modelChoice!=="mesh-1" || !pending.models?.size))
          reject(400,"Esta revisión carece de un inventario de modelos que autorizar.");
        const shareModels=modelChoice==="mesh-1";
        let settings;
        try { settings = network.settings(address); } catch (error) { reject(400, error.message); }
        let host, gameOrigin;
        try {
          host = createHost(pending.room, {...settings, shareInes, shareBruma, creatorModels:shareModels?pending.models:null});
          gameOrigin = await host.start();
        } catch (error) {
          if (error.code === "EADDRINUSE") reject(409, "El puerto de juego 8787 está ocupado. La revisión sigue preparada.");
          if (error.status) throw error;
          reject(400, "No se pudo abrir la sala. Revisa la IP de juego, el certificado y su clave en el anfitrión.");
        }
        active = {number: ++sessionNumber, source: pending, listener: host, origin: gameOrigin, host: address, shareInes, shareBruma, shareModels, launched: new Map()};
        lastUsage = null;
        pending = null;
      } else if (route === "/api/discard") {
        if (!pending) reject(409, "No hay revisión preparada.");
        pending = null;
      } else {
        if (!active) reject(409, "La sala ya no está abierta.");
        const {room} = active.source;
        if (route === "/api/close") {
          // Polling the panel normally advances the room. Freeze its displayed state
          // while the listener drains requests and commits the final checkpoint.
          active.closingView = describe(active.source,"closing");
          try {
            const {checkpoint} = await active.listener.close();
            initialMessage = ["unavailable", "invalid", "busy"].includes(checkpoint?.state)
              ? "Sala cerrada. No se confirmó el guardado final de esta partida."
              : "Sala cerrada. Ya puedes preparar otra revisión.";
          } catch (error) {
            if (active.listener.server.listening) {
              delete active.closingView;
              reject(503, "No se pudo cerrar la sala. Consulta el estado del guardado y vuelve a intentarlo.");
            }
            finishRoom();
            version++;
            initialMessage = "La sala se cerró. No se confirmó el guardado final de la partida.";
            reject(503, initialMessage);
          }
          finishRoom();
        } else if (route === "/api/checkpoint/save") {
          await room.moderation.saveCheckpoint();
        } else if (route === "/api/circuit/record") {
          await room.moderation.retryRecord(req.headers["x-mundo-circuit"]);
        } else if (route === "/api/circuit/restart") {
          room.moderation.restartCourse(req.headers["x-mundo-circuit"]);
        } else if (route === "/api/pause" || route === "/api/resume") {
          room.moderation.setAdmissions(route === "/api/resume");
        } else {
          const match = /^\/api\/seat\/([12])\/(invite|qr|renew|revoke|play)$/.exec(route);
          if (!match) reject(404, "Acción desconocida.");
          const number = Number(match[1]);
          if (match[2] === "invite" || match[2] === "qr") {
            const {inviteSeconds} = room.moderation.status().seats[number - 1];
            const link = playerInvitation(active.origin, room.moderation.invitation(number));
            if (match[2] === "invite") return {link, inviteSeconds};
            if (active.host === "127.0.0.1") reject(409, "Para escanear desde otro equipo, abre la sala en la red local.");
            return {rows: invitationRows(link), inviteSeconds};
          }
          if (match[2] === "play") {
            if (!playerExe) reject(409, "El anfitrión no tiene configurado el reproductor de Windows.");
            const {admissionsOpen} = room.moderation.status();
            if (!admissionsOpen) reject(409, "Reanuda las admisiones antes de abrir MUNDO en esta PC.");
            const link = playerInvitation(active.origin, room.moderation.invitation(number));
            const launched = active.launched;
            if (launched.has(number)) reject(409, "MUNDO ya está abierto para esta plaza en la PC.");
            let child;
            try { child = await openNativePlayer(playerExe, link); }
            catch { reject(503, "No se pudo iniciar MUNDO. Revisa MUNDO_PLAYER_EXE en la PC anfitriona."); }
            launched.set(number, child.pid);
            child.once("exit", () => {
              if (launched.get(number) === child.pid) launched.delete(number);
            });
          } else if (match[2] === "renew") {
            try { room.moderation.issue(number); } catch (error) { reject(409, error.message); }
            active.launched.delete(number);
          } else {
            room.moderation.revoke(number);
            active.launched.delete(number);
          }
        }
      }
      version++;
      return state();
    } finally { busy = false; finishCommand(); }
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, data, type = "application/json") => {
      if (res.destroyed) return;
      res.writeHead(code, {"Content-Type": type});
      res.end(type === "application/json" ? JSON.stringify(data) : data);
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      if (!origin || req.headers.host !== new URL(origin).host) reject(403, "Destino inválido.");
      if (req.method === "GET" && assets.has(req.url)) {
        const asset = assets.get(req.url);
        return send(200, asset.data, asset.type);
      }
      if (req.method !== "POST" || !req.url.startsWith("/api/")) reject(404, "Ruta desconocida.");
      const credential = Buffer.from(req.headers["x-mundo-host"] || "");
      if (req.headers.origin !== origin || credential.length !== secret.length ||
          !timingSafeEqual(credential, Buffer.from(secret))) reject(403, "Vuelve a abrir el panel privado del anfitrión.");
      if (req.url !== "/api/prepare" && (req.headers["transfer-encoding"] || Number(req.headers["content-length"] || 0) !== 0))
        reject(400, "Esta acción no admite archivos.");
      send(200, await command(req.url, req));
    } catch (error) {
      send(error.status || 500, {error: error.status ? error.message : "No se pudo completar la operación."});
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.maxConnections = 12;
  async function listen() {
    await initial;
    if (stopRequested) return null;
    return new Promise((resolve, rejectStart) => {
      server.once("error", rejectStart);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", rejectStart);
        origin = "http://127.0.0.1:" + server.address().port;
        resolve(origin + "/#host=" + secret);
      });
    });
  }
  async function shutdown() {
    if (starting) await starting.catch(() => {});
    const panelClosed = server.listening ? new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }) : Promise.resolve();
    // A game listener may have bound its port while its start request is awaiting
    // disk recovery. Let the command take ownership before closing that listener.
    await commandDone;
    try {
      return active ? await active.listener.close() : null;
    } finally {
      active = null;
      await panelClosed;
    }
  }
  return {
    start() { return starting ??= listen(); },
    close() {
      stopRequested = true;
      zoneScan?.abort();
      return stopping ??= shutdown();
    }
  };
}

if (require.main === module) {
  const panel = createPanel(process.argv[2] === "--open" ? process.argv[3] : process.argv[2]);
  let stopping = false;
  const report = error => { console.error(error.message); process.exitCode = 1; };
  function stop() {
    if (stopping) return;
    stopping = true;
    panel.close().then(result => {
      if (["unavailable", "invalid", "busy"].includes(result?.checkpoint?.state))
        report(Error("El panel se cerró. No se confirmó el guardado final de la partida."));
    }).catch(report);
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  panel.start().then(url => {
    if (!url || stopping) return;
    console.log("Panel privado del anfitrión (solo en este equipo)\n" + url);
    if (process.platform === "win32" && process.argv.includes("--open")) {
      const opener = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {detached: true, stdio: "ignore"});
      opener.once("error", () => console.error("Abre la dirección del panel en un navegador de este equipo."));
      opener.unref();
    }
  }).catch(report);
}
