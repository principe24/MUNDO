"use strict";

function MundoHostCourseTiming(readReport) {
  const el = id => document.getElementById(id);
  const section = el("timingSection"), details = el("timingDetails"), picker = el("timingLap");
  const notice = el("timingNotice"), controls = el("timingControls"), exportStatus = el("timingExportStatus");
  const jsonButton = el("timingJson"), csvButton = el("timingCsv");
  let context = null, snapshot = null, reading = null, exporting = null;
  let optionsKey = "";

  function time(ms, signed = false) {
    if (ms === null) return "—";
    const n = Math.abs(ms), seconds = Math.floor(n / 1000);
    const stamp = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0") +
      "," + String(n % 1000).padStart(3, "0");
    return (ms < 0 ? "−" : signed && ms > 0 ? "+" : "") + stamp;
  }
  function lapByNumber(report, run) {
    return !run || report.run === run ? report : report.history.find(lap => lap.run === run);
  }
  function drawLap() {
    if (!snapshot) return;
    const lap = lapByNumber(snapshot, Number(picker.value));
    if (!lap) return;
    const current = lap === snapshot;
    const phase = current ? {ready:"Preparada", running:"En curso", finished:"Terminada"}[snapshot.phase] : "Terminada";
    const passed = current ? snapshot.passed : snapshot.total;
    el("timingSummary").textContent = snapshot.worldName + " · " + MundoCourseTiming.startLabel(snapshot.startMode) +
      " · Vuelta " + lap.run + " · " + phase + " · " +
      passed + "/" + snapshot.total + " puertas · " + time(lap.elapsedMs) +
      (lap.referenceTotalMs === null ? " · Sin marca de referencia" : " · Referencia " + time(lap.referenceTotalMs));
    const table = el("timingTable").tBodies[0];
    table.replaceChildren(...MundoCourseTiming.rows(snapshot, lap).map((row, i) => {
      const tr = document.createElement("tr"), title = document.createElement("th");
      title.scope = "row"; title.textContent = row.slot + " · " + row.label;
      tr.append(title);
      const observed = row.atMs === null ? (i < passed ? "Sin dato" : "Pendiente") : time(row.atMs);
      for (const value of [time(row.legMs), time(row.legDeltaMs, true), observed, time(row.referenceMs), time(row.deltaMs, true)]) {
        const td = document.createElement("td"); td.textContent = value; tr.append(td);
      }
      return tr;
    }));
  }
  function display(report) {
    snapshot = report;
    const older = report.history.filter(lap => lap.run !== report.run).reverse();
    const key = [report.run, ...older.map(lap => lap.run)].join("/");
    if (key !== optionsKey) {
      optionsKey = key;
      const previous = picker.value;
      picker.replaceChildren(new Option("Vuelta actual · " + report.run, ""),
        ...older.map(lap => new Option("Vuelta " + lap.run + " · " + time(lap.elapsedMs), String(lap.run))));
      if (older.some(lap => String(lap.run) === previous)) picker.value = previous;
    }
    controls.hidden = false;
    notice.textContent = "";
    drawLap();
  }

  function canRead() { return context && details.open && !document.hidden; }
  function cancelRead() { reading?.abort(); reading = null; }
  function cancelExport() {
    exporting?.abort(); exporting = null;
    jsonButton.disabled = csvButton.disabled = false;
  }
  async function refresh() {
    if (!canRead() || reading || ((context.finished || context.parked) && snapshot)) return;
    const request = reading = new AbortController();
    if (!snapshot) notice.textContent = "Cargando tiempos por puerta…";
    try {
      const report = await readReport(context, request.signal);
      if (reading === request && canRead()) display(report);
    } catch (error) {
      if (reading === request && !request.signal.aborted) notice.textContent = error.message;
    } finally { if (reading === request) reading = null; }
  }

  function csv(report, lap) {
    // Gate labels are user content. Quoting alone does not suppress formulas in a spreadsheet.
    const textCell = value => {
      const safe = /^[\s\uFEFF]*[=+@\-＝＋＠－]/u.test(value) ? "'" + value : value;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const lines = ["Mundo,Revisión,Publicación,Turismo,Inicio del cronómetro,Vuelta,Orden,ID de puerta,Nombre,Acumulado ms,Tramo ms,Referencia acumulada ms,Referencia tramo ms,Diferencia acumulada ms,Diferencia tramo ms"];
    for (const row of MundoCourseTiming.rows(report, lap)) {
      lines.push([textCell(report.worldName), textCell(report.revision), textCell(report.publication ?? ""), textCell(report.carRoot),
        textCell(MundoCourseTiming.startLabel(report.startMode)), lap.run, row.slot, textCell(row.id), textCell(row.label), row.atMs, row.legMs, row.referenceMs,
        row.referenceLegMs, row.deltaMs, row.legDeltaMs].join(","));
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }
  async function download(kind) {
    if (!canRead() || !snapshot || exporting) return;
    const request = exporting = new AbortController();
    const session = context.session, run = Number(picker.value) || snapshot.run;
    jsonButton.disabled = csvButton.disabled = true;
    exportStatus.textContent = "Preparando descarga…";
    try {
      const report = await readReport(context, request.signal);
      if (exporting !== request) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const stem = "Mundo_Parciales_Sala_" + session + "_" + stamp;
      if (kind === "csv") {
        const lap = lapByNumber(report, run);
        if (!lap) throw Error("La vuelta elegida ya salió del historial de esta sala.");
        downloadHostFile(csv(report, lap), stem + "_Vuelta_" + run + ".csv", "text/csv;charset=utf-8");
      } else {
        downloadHostFile(JSON.stringify(report, null, 2) + "\n", stem + ".json", "application/json");
      }
      exportStatus.textContent = "Descarga solicitada.";
    } catch (error) {
      if (exporting === request && !request.signal.aborted) exportStatus.textContent = error.message;
    } finally { if (exporting === request) cancelExport(); }
  }
  jsonButton.addEventListener("click", () => download("json"));
  csvButton.addEventListener("click", () => download("csv"));
  picker.addEventListener("change", drawLap);
  details.addEventListener("toggle", () => {
    if (details.open) void refresh();
    else { cancelRead(); cancelExport(); exportStatus.textContent = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelRead(); });

  function update(next) {
    const changed = context?.session !== next?.session || context?.key !== next?.key;
    if (changed || context?.finished !== next?.finished || context?.parked !== next?.parked) {
      cancelRead(); cancelExport();
      snapshot = null; optionsKey = ""; controls.hidden = true;
      notice.textContent = exportStatus.textContent = "";
      if (changed) { details.open = false; picker.replaceChildren(); }
    }
    context = next;
    section.hidden = !next;
    if (!next) return;
    el("timingScope").textContent = next.finished ? "Sala cerrada. El informe sigue disponible hasta abrir otra sala o cerrar el anfitrión."
      : next.parked ? "Último circuito visitado. Los tiempos corresponden al momento de salir de ese mundo."
      : "Vuelta en curso e historial de hasta ocho vueltas terminadas.";
    void refresh();
  }
  return {update};
}
