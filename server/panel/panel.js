"use strict";
const el = id => document.getElementById(id);
const keyName = "mundo.host.session";
let token = new URLSearchParams(location.hash.slice(1)).get("host");
try {
  if (token) sessionStorage.setItem(keyName, token);
  else token = sessionStorage.getItem(keyName);
  if (token) history.replaceState(null, "", "/");
} catch { /* The fragment still lets this tab work without browser storage. */ }

let state = null;
let working = false;
let polling = false;
let epoch = 0;
const seats = new Map();
const tracking = MundoHostMap();
const usage = MundoHostAheadUsage((session, signal) => request("ahead/usage", undefined, undefined, {session, signal}));
const timing = MundoHostCourseTiming(async (context, signal) => {
  const report = await request("circuit/timing", undefined, context.key, {session: context.session, signal});
  if (report.revision !== context.revision || (report.publication ?? null) !== context.publication ||
      report.carRoot !== context.carRoot) throw Error("La publicación o el turismo del circuito han cambiado.");
  return report;
});
const announce = message => { el("message").textContent = message; };
const metres = new Intl.NumberFormat("es", {maximumFractionDigits: 3, useGrouping: false});
const byteCount = new Intl.NumberFormat("es", {style:"unit",unit:"byte",unitDisplay:"short"});
function entryLine(entry, destination) {
  if (!entry) return "";
  const target = (destination ? "Destino «" : "Mundo «") + entry.world + "»";
  const profile = entry.profile === "mobile" ? "móvil" : "PC";
  let detail;
  switch (entry.phase) {
    case "preparing": detail = "preparando la zona inicial"; break;
    case "available": detail = "zona inicial disponible para envío"; break;
    case "sending": detail = "enviando la zona inicial · " + byteCount.format(entry.sent) + " de " + byteCount.format(entry.total); break;
    case "sent": detail = "zona inicial enviada · " + byteCount.format(entry.total); break;
    default: return "";
  }
  const reuse = entry.savedBytes > 0 ? " · " + byteCount.format(entry.savedBytes) + " evitados al completar el mundo" : "";
  return target + " · " + profile + " · " + detail + reuse;
}
function coordinates(point) {
  return "X " + metres.format(point[0]) + " · Y " + metres.format(point[1]) +
    " · Z " + metres.format(point[2]) + " m";
}

async function request(route, file, courseKey, options) {
  const headers = {"x-mundo-host": token || "", "x-mundo-version": String(state?.version ?? -1)};
  if (courseKey) headers["x-mundo-circuit"] = courseKey;
  if (options?.session) headers["x-mundo-session"] = String(options.session);
  if (route === "start") {
    headers["x-mundo-address"] = el("address").value;
    if (el("shareInes").checked) headers["x-mundo-actor"] = "ines-bajamar-1";
    if (!el("creatorChoice").hidden && el("shareModels").checked) headers["x-mundo-creator-models"]="mesh-1";
    if (!el("brumaChoice").hidden && el("shareBruma").checked) headers["x-mundo-car-art"] = "bruma-1";
  }
  if (file) {
    headers["content-type"] = "application/octet-stream";
    headers["x-mundo-file"] = encodeURIComponent(file.name);
  }
  const response = await fetch("/api/" + route, {method: "POST", headers, body: file,
    cache: "no-store", credentials: "omit", redirect: "error", signal: options?.signal});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Falló la operación.");
  return data;
}

function downloadHostFile(body, filename, type) {
  const url = URL.createObjectURL(new Blob([body], {type}));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

let displayedSeat = null;
let expiryTimer = null;
function forgetDisplayedSeat() {
  clearTimeout(expiryTimer);
  expiryTimer = null;
  displayedSeat = null;
}
function closeCopy() {
  forgetDisplayedSeat();
  if (el("qrDialog").open) el("qrDialog").close();
  wipeQr();
  if (el("manual").open) el("manual").close();
  el("link").value = "";
}
async function readSeatInvitation(base, format) {
  const requested = performance.now();
  const invitation = await request(base + format);
  // The host reports whole seconds. Measure from before the request so that
  // network latency cannot extend the visible lifetime of the credential.
  const expires = requested + Math.max(0, invitation.inviteSeconds - 1) * 1000;
  if (!Number.isFinite(expires) || expires <= performance.now())
    throw Error("La invitación está a punto de caducar. Crea una nueva.");
  return {...invitation, expires};
}
function trackDisplayedSeat(number, expires) {
  forgetDisplayedSeat();
  const remaining = expires - performance.now();
  if (remaining <= 0) throw Error("La invitación ha caducado. Crea una nueva.");
  displayedSeat = number;
  expiryTimer = setTimeout(() => {
    closeCopy();
    announce("Terminó el plazo para mostrar esta invitación. Crea una nueva para el jugador " + number + ".");
    void refresh();
  }, remaining);
}
let addressList = null;
function showNetwork(current) {
  const picker = el("address");
  if (!current.room) {
    const signature = JSON.stringify(current.addresses);
    if (signature !== addressList) {
      const selection = addressList === null ? current.network : picker.value;
      picker.replaceChildren(...current.addresses.map(item => new Option(item.label, item.address)));
      // A lost interface requires a new deliberate choice.
      picker.value = selection;
      addressList = signature;
    }
  }
  const address = current.room ? current.network : picker.value;
  if (!address) return "Selecciona una interfaz disponible para abrir la sala.";
  if (address === "127.0.0.1") return "Juego en este equipo. Para invitar a un móvil elige una interfaz de red local.";
  if (address === "internet") return current.room ? "Dirección de juego · "+current.endpoint : "Los jugadores recibirán el dominio HTTPS configurado por el anfitrión.";
  if (current.room) return "Dirección de juego · " + current.endpoint + ". Los dispositivos deben confiar en el certificado del anfitrión.";
  return "Red local · " + address + ". Se usarán el certificado y la clave configurados en el anfitrión.";
}
const checkpointDate = new Intl.DateTimeFormat("es", {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit"
});
function showCheckpoint(checkpoint) {
  const group = el("checkpoint");
  group.hidden = !checkpoint || checkpoint.state === "off";
  if (group.hidden) return;
  const messages = {
    ready: "La sala está preparada para guardar el progreso en este equipo.",
    saving: "Guardando la partida en este equipo…",
    saved: "Hay una copia de esta partida en el equipo anfitrión.",
    unavailable: "El guardado local no está disponible. Puedes reintentarlo mientras la sala siga abierta.",
    busy: "Otro anfitrión controla el guardado de esta revisión. El progreso de esta sala está en memoria.",
    invalid: "No se pudo recuperar la copia guardada de esta revisión."
  };
  const message = checkpoint.detail || messages[checkpoint.state] || "Estado del guardado desconocido.";
  el("recoveryOrigin").hidden = !checkpoint.restored;
  const status = el("checkpointState");
  if (status.textContent !== message) status.textContent = message;
  const time = el("checkpointTime");
  time.hidden = !Number.isFinite(checkpoint.savedAt) || Math.abs(checkpoint.savedAt) > 8640000000000000;
  if (!time.hidden) time.textContent = "Última copia en disco · " + checkpointDate.format(checkpoint.savedAt);
  const save = el("saveCheckpoint");
  save.disabled = working || checkpoint.canSave === false || !["ready", "saved", "unavailable"].includes(checkpoint.state);
  save.textContent = checkpoint.state === "unavailable" ? "Reintentar guardar la partida" : "Guardar partida ahora";
}
function display(next) {
  if (state && next.version < state.version) return;
  if (!next.preview || !state?.preview || state.preview.hash !== next.preview.hash || state.preview.filename !== next.preview.filename || state.preview.preparation !== next.preview.preparation) {
    el("shareInes").checked = false;
    el("shareBruma").checked = false;
    el("shareModels").checked = false;
  }
  if (state?.version !== next.version ||
      (displayedSeat !== null && next.room?.seats.find(seat => seat.number === displayedSeat)?.state !== "disponible"))
    closeCopy();
  state = next;
  tracking.update(state.room?.track);
  usage.update(state.ahead);
  timing.update(state.timing);
  const info = state.room || state.preview;
  el("source").hidden = Boolean(state.room);
  el("details").hidden = !info;
  el("players").hidden = !state.room;
  el("actorNotice").hidden = !state.room || !state.shareInes;
  el("creatorChoice").hidden=!state.preview?.modelCount;
  el("creatorInventory").textContent=state.preview?.modelNames?.join(" · ") || "";
  el("creatorNotice").hidden=!state.room || !state.shareModels;
  if (state.room && state.shareModels) el("creatorNotice").textContent=state.room.modelCount+" modelo(s) de esta publicación autorizados para la sala web.";
  el("brumaChoice").hidden = !state.preview || (!state.preview.usesBruma && !state.preview.project);
  el("brumaNotice").hidden = !state.room || !state.shareBruma;
  el("recommendedInes").hidden = !state.preview || state.preview.characterLook !== "ines-bajamar-1";
  el("network").hidden = false;
  el("network").textContent = showNetwork(state);
  showCheckpoint(state.room?.checkpoint);
  if (info) {
    el("phase").textContent = state.room ? "Sala abierta" : "Revisión preparada";
    el("title").textContent = info.title;
    el("filename").textContent = info.filename;
    el("audioLabel").hidden=el("audioCount").hidden=!info.audioClipCount;
    if(info.audioClipCount)el("audioCount").textContent=String(info.audioClipCount);
    const course=info.course, summary=el("courseInfo"), replay=el("restartCourse");
    summary.hidden=!course;replay.hidden=!state.room || !course;
    replay.disabled=working || !course?.canRestart || Boolean(info.project?.destination);
    const record=course?.record, recordLine=el("courseRecord"), retry=el("retryRecord");
    recordLine.hidden=!record;retry.hidden=!state.room || record?.state!=="unavailable";
    retry.disabled=working || Boolean(info.project?.destination);
    if(record){
      const messages={empty:"Aún no hay marca guardada.",saving:"Guardando la marca en este equipo…",
        unavailable:"Archivo de marcas no disponible. La vuelta sigue en la memoria de la sala.",
        saved:"Mejor marca guardada en este equipo: "+((record.bestMs??0)/1000).toFixed(3)+" s"};
      recordLine.textContent=messages[record.state];
    }
    if(course){
      const time=ms=>(ms/1000).toFixed(2)+" s";
      const line="Vuelta "+course.run+" · "+course.passed+"/"+course.total+" puertas · "+
        (course.phase==="finished"?"Meta · "+time(course.elapsedMs):"Siguiente: "+course.nextLabel)+
        " · "+MundoCourseTiming.startLabel(course.startMode)+(course.bestMs===null?"":" · Mejor: "+time(course.bestMs));
      if(summary.textContent!==line)summary.textContent=line;
    }
    const route=el("projectRoute"),project=info.project;
    route.hidden=!project;
    if(project){
      const trip=project.destination?" · Preparando "+project.destination+" · "+project.ready+"/"+project.required+" plazas listas":project.notice?" · "+project.notice:"";
      const label=project.name+" · Mundo #"+project.current+" · "+project.worlds+" mundos"+trip;
      if(route.textContent!==label)route.textContent=label;
    }
    el("publication").textContent = info.publication === null ? "Mundo editable sin número de publicación" : "Revisión " + info.publication;
    el("car").textContent = info.car ? "ID " + info.car.root + (info.selected ? " · elegido en Studio" : " · selección automática") : "Partida a pie";
    el("meeting").textContent = info.meetingPoint ? coordinates(info.meetingPoint) : "Aparición automática";
    el("arrivals").hidden = el("arrivalsLabel").hidden = !info.meetingSeats;
    if (info.meetingSeats) {
      el("arrivalOne").textContent = "Plaza 1 · " + coordinates(info.meetingSeats[0]);
      el("arrivalTwo").textContent = "Plaza 2 · " + coordinates(info.meetingSeats[1]);
    }
    el("hash").textContent = info.hash;
    el("previewActions").hidden = !state.preview;
    const zones=state.preview?.zones;
    el("inspectZones").hidden=Boolean(zones);
    el("inspectZones").disabled=working;
    el("zoneSummary").hidden=!zones;
    if(zones){
      const {mobile,pc}=zones.profiles;
      el("zoneBytes").textContent="Carga prevista por zonas · Móvil "+byteCount.format(mobile.bytes)+
        " · PC "+byteCount.format(pc.bytes)+" · Paquete completo "+byteCount.format(zones.packageBytes);
      const point=([x,z])=>"X "+metres.format(x)+" m · Z "+metres.format(z)+" m";
      el("zoneOrigin").textContent="Punto de entrada de la sala · "+point(zones.focus)+
        (zones.studioFocus?". Al reexportar este archivo en Studio, la aparición pasa a "+point(zones.studioFocus)+".":"");
      el("zoneDigest").textContent=zones.packageSha256;
    }
  }
  if (state.room) {
    el("admissions").textContent = info.admissionsOpen ? "Admisión de jugadores abierta" : "Admisión de jugadores suspendida";
    el("admit").textContent = info.admissionsOpen ? "Suspender entradas" : "Reanudar entradas";
    const trip = info.project?.destination != null;
    const ready = info.seats.filter(seat => seat.scene === "ready").length;
    const summary = trip ? "Destino «" + info.project.destination + "» listo en " + info.project.ready + " de " + info.project.required + " plazas."
      : ready === 2 ? "Ambos jugadores tienen la revisión lista." : "Revisión lista en " + ready + " de 2 plazas.";
    if (el("readyCount").textContent !== summary) el("readyCount").textContent = summary;
    const stages = {loading: "cargando la revisión", ready: "revisión lista", idle: "en pausa",
      stale: "sin señal reciente", unknown: "carga sin confirmar"};
    for (const seat of info.seats) {
      const ui = seats.get(seat.number);
      const id = seat.number - 1;
      const role = info.car?.driver === id ? " · al volante" : info.car?.passenger === id ? " · pasajero" : "";
      const available = seat.state === "disponible";
      let invitation = "";
      if (available && Number.isFinite(seat.inviteSeconds)) {
        invitation = seat.inviteSeconds < 60 ? "caduca en menos de un minuto"
          : "caduca en " + Math.ceil(seat.inviteSeconds / 60) + " min como máximo";
      } else if (seat.state === "caducado") invitation = "crea una nueva invitación para este jugador";
      let stage = stages[seat.scene];
      if (trip && seat.scene !== "stale") {
        stage = seat.destinationReady === true ? "destino listo" : seat.destinationReady === false ? "preparando el destino" : "";
      }
      ui.status.textContent = [seat.state, stage, invitation].filter(Boolean).join(" · ") + role;
      const transfer = entryLine(seat.entry, trip);
      ui.transfer.hidden = !transfer;
      if (ui.transfer.textContent !== transfer) ui.transfer.textContent = transfer;
      ui.play.hidden = !state.nativePlayer;
      ui.play.disabled = working || !info.admissionsOpen || seat.state !== "disponible" || seat.localPlayerOpen;
      ui.play.textContent = seat.localPlayerOpen ? "MUNDO abierto en esta PC" : "Jugar en esta PC";
      ui.copy.disabled = working || !available;
      ui.qr.disabled = working || !available || state.network === "127.0.0.1";
      ui.renew.disabled = working || seat.state === "ocupado";
      ui.revoke.disabled = working || seat.state === "cerrado";
    }
  }
  for (const id of ["file", "start", "discard", "admit", "close"]) el(id).disabled = working;
  el("address").disabled = working;
  el("shareInes").disabled = working;
  el("shareBruma").disabled = working;
  el("shareModels").disabled = working;
  el("start").disabled = working || !el("address").value;
  el("prepare").disabled = working || !el("file").files.length;
}

async function action(work) {
  if (working || !state) return;
  working = true;
  ++epoch;
  display(state);
  try { await work(); }
  catch (error) {
    closeCopy();
    announce(error.message);
    try { display(await request("state")); } catch { offline(); }
  }
  finally { working = false; if (state) display(state); }
}
function mutate(route, message, file, courseKey) {
  return action(async () => {
    display(await request(route, file, courseKey));
    if (file) el("file").value = "";
    announce(message);
  });
}
function offline() {
  state = null;
  tracking.update(null);
  usage.update(null);
  timing.update(null);
  closeCopy();
  for (const id of ["source", "details", "players", "network"]) el(id).hidden = true;
}
async function refresh() {
  if (working || polling) return;
  polling = true;
  const ticket = epoch;
  try {
    const next = await request("state");
    if (ticket !== epoch) return;
    if (!state) {
      const message = next.room ? "Sala conectada." : next.preview ? "Revisa el mundo antes de abrir la sala."
        : "Elige una publicación de Studio para invitar a dos jugadores.";
      announce(next.initialMessage || message);
    }
    display(next);
  } catch (error) {
    if (ticket === epoch) { offline(); announce(error.message); }
  } finally { polling = false; }
}

function wipeQr() {
  const canvas = el("qrCanvas");
  canvas.width = canvas.height = 1;
}
function showQr(rows, number) {
  const canvas = el("qrCanvas");
  const margin = 4, unit = 8;
  canvas.width = canvas.height = (rows.length + margin * 2) * unit;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("El navegador no permite dibujar el código. Usa Copiar invitación.");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black";
  rows.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      if (line[col] === "1") ctx.fillRect((col + margin) * unit, (row + margin) * unit, unit, unit);
    }
  });
  el("qrLabel").textContent = "Invitación del jugador " + number;
  el("qrWorld").textContent = state.room.title;
  el("qrDialog").showModal();
}
function seatControl(number) {
  const article = document.createElement("article");
  const heading = document.createElement("h3");
  heading.textContent = "Jugador " + number;
  const status = document.createElement("p");
  const transfer = document.createElement("p");
  transfer.hidden = true;
  const buttons = document.createElement("div");
  buttons.className = "actions";
  article.append(heading, status, transfer, buttons);
  el("seats").append(article);
  function button(label, style, click) {
    const control = document.createElement("button");
    control.textContent = label;
    control.className = style;
    control.addEventListener("click", click);
    buttons.append(control);
    return control;
  }
  const base = "seat/" + number + "/";
  const copy = button("Copiar invitación", "", () => action(async () => {
    const {link, expires} = await readSeatInvitation(base, "invite");
    if (document.hidden) return;
    try {
      await navigator.clipboard.writeText(link);
      announce(performance.now() < expires ? "Invitación del jugador " + number + " copiada."
        : "La invitación caducó mientras se copiaba. Crea una nueva.");
    } catch {
      // A clipboard permission prompt can outlive both a token and a seat.
      if (document.hidden) return;
      const current = await readSeatInvitation(base, "invite");
      if (document.hidden) return;
      trackDisplayedSeat(number, current.expires);
      el("copyLabel").textContent = "Invitación del jugador " + number;
      el("link").value = current.link;
      el("manual").showModal();
      el("link").focus();
      el("link").select();
      announce("El enlace está listo para copiar manualmente.");
    }
  }));
  const play = button("Jugar en esta PC", "secondary", () =>
    mutate(base + "play", "Se inició MUNDO para el jugador " + number + ". El panel mostrará cuándo cargue la revisión."));
  const qr = button("Mostrar QR", "secondary", () => action(async () => {
    const {rows, expires} = await readSeatInvitation(base, "qr");
    if (!document.hidden) {
      trackDisplayedSeat(number, expires);
      showQr(rows, number);
    }
  }));
  const renew = button("Nueva invitación", "secondary", () => {
    if (window.confirm("¿Crear otra invitación para el jugador " + number + "? La anterior caducará."))
      mutate(base + "renew", "Invitación renovada. Ya puedes copiarla.");
  });
  const revoke = button("Cerrar plaza", "danger", () => {
    if (window.confirm("¿Cerrar la plaza del jugador " + number + "? Si está jugando, saldrá de la sala."))
      mutate(base + "revoke", "Plaza cerrada e invitación revocada.");
  });
  seats.set(number, {status, transfer, copy, play, qr, renew, revoke});
}

seatControl(1);
seatControl(2);
el("address").onchange = () => { if (state) display(state); };
el("file").onchange = () => { if (state) display(state); };
el("prepare").onclick = () => {
  const file = el("file").files[0];
  if (file) mutate("prepare", "Revisa el mundo antes de abrir la sala.", file);
};
el("start").onclick = () => mutate("start", "Sala abierta. Copia una invitación para cada jugador.");
el("inspectZones").onclick = () => action(async () => {
  announce("Calculando los tamaños y las huellas de las zonas del mundo preparado…");
  display(await request("zones/inspect"));
  announce("Inventario calculado para el mundo preparado.");
});
el("discard").onclick = () => mutate("discard", "Revisión descartada.");
el("saveCheckpoint").onclick = () => action(async () => {
  display(await request("checkpoint/save"));
  announce(state.room?.checkpoint?.state === "saved"
    ? "Partida guardada en el equipo anfitrión." : "Consulta el estado de la recuperación de la partida.");
});
el("retryRecord").onclick=()=>{
  const course=state?.room?.course;
  if(course)mutate("circuit/record","Estado del archivo de marcas actualizado.",undefined,course.key);
};
el("restartCourse").onclick=async()=>{
  const course=state?.room?.course;
  if(!course || working || !window.confirm("¿Reiniciar esta vuelta para todos los ocupantes del turismo?"))return;
  await mutate("circuit/restart","Nueva vuelta preparada.",undefined,course.key);
};
el("admit").onclick = () => mutate(state.room.admissionsOpen ? "pause" : "resume", "Admisiones actualizadas.");
el("close").onclick = () => {
  if (window.confirm("¿Cerrar la sala, desconectar a los jugadores y caducar ambas invitaciones?"))
    action(async () => {
      display(await request("close"));
      announce(state.initialMessage);
    });
};
el("hideQr").onclick = () => el("qrDialog").close();
el("qrDialog").addEventListener("close", wipeQr);
el("done").onclick = closeCopy;
el("manual").addEventListener("close", () => { el("link").value = ""; });
for (const id of ["qrDialog", "manual"]) el(id).addEventListener("close", () => {
  if (!el("manual").open && !el("qrDialog").open) forgetDisplayedSeat();
});
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
document.addEventListener("visibilitychange", () => { if (document.hidden) closeCopy(); else refresh(); });
