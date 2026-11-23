"use strict";

function MundoHostAheadUsage(readReport) {
  const get = id => document.getElementById(id);
  const section = get("usageSection");
  const details = get("usageDetails");
  const picker = get("usageSelect");
  const download = get("usageExport");
  const fetchStatus = get("usageFetchStatus");
  const exportStatus = get("usageExportStatus");
  const count = new Intl.NumberFormat("es", {useGrouping: true});
  const states = {
    unreported: "Sin informe del reproductor", active: "En curso", crossed: "Cruce completado",
    turned: "Giro o inversión de marcha observados", changed: "Cambió el destino de precarga", released: "Precarga liberada"
  };
  let context = null;
  let snapshot = null;
  let fetching = null;
  let exporting = null;
  let menuKey = "";

  function canShow() { return context && details.open && !document.hidden; }
  function emptyMessage() {
    return context.finished ? "La sala cerró sin ofrecer una precarga." : "Todavía no se ha ofrecido una precarga en esta sala.";
  }

  function selectRow() {
    const entries = snapshot?.entries ?? [];
    const selected = entries.find(entry => String(entry.ordinal) === picker.value) ?? entries.at(-1);
    get("usageOffer").hidden = !selected;
    if (!selected) return;
    const profile = selected.profile === "mobile" ? "Móvil" : "PC";
    const trip = selected.epoch ? " · Época " + selected.epoch : "";
    const car = selected.carRoot === null ? "" : " · Turismo #" + selected.carRoot;
    const state = context.finished && selected.state === "active" ? "Último informe parcial" : states[selected.state];
    const at = (x, z) => "(" + x + ", " + z + ")";
    const middle = selected.via === "x" ? at(selected.cx, selected.fromZ)
      : selected.via === "z" ? at(selected.fromX, selected.cz) : null;
    const route = [at(selected.fromX, selected.fromZ), middle, at(selected.cx, selected.cz)].filter(Boolean).join(" → ");
    get("usageRoute").textContent = "Oferta " + selected.ordinal + " · Plaza " + selected.seat + " · " + profile +
      " · Celdas " + route + " · " + (state ?? selected.state) + car + trip;
    const bytes = value => count.format(value) + " B";
    const declared = value => value === null ? "Sin informe" : bytes(value);
    get("usageRequired").textContent = bytes(selected.requiredBytes);
    get("usagePlanned").textContent = bytes(selected.plannedBytes);
    get("usageServed").textContent = bytes(selected.servedBytes);
    get("usageUnique").textContent = bytes(selected.uniqueServedBytes);
    get("usageRepeat").textContent = bytes(selected.servedBytes - selected.uniqueServedBytes);
    get("usageInterrupted").textContent = count.format(selected.interruptedPages);
    get("usageVerified").textContent = declared(selected.verifiedBytes);
    get("usageUsed").textContent = declared(selected.usedBytes);
    let firstStage = "El registro carece de desglose por etapas";
    let lastStage = firstStage;
    if (snapshot.version === 2) {
      if (selected.state === "unreported") {
        firstStage = lastStage = "Sin informe del reproductor";
      } else {
        const diagonal = selected.fromX !== selected.cx && selected.fromZ !== selected.cz;
        firstStage = middle ? declared(selected.middleBytes) + " · instalada en " + middle + ", primero por " + selected.via.toUpperCase()
          : diagonal ? "Sin instalación intermedia declarada" : "Cruce de un solo eje";
        lastStage = selected.state === "crossed" ? declared(selected.finalBytes) + " · instalación declarada"
          : declared(selected.finalBytes) + " · sin instalación final declarada";
      }
    }
    get("usageMiddle").textContent = firstStage;
    get("usageFinal").textContent = lastStage;
    get("usageDiscarded").textContent = selected.discardedBytes === null ? "Sin informe final" : bytes(selected.discardedBytes);
    get("usageRevision").textContent = selected.revision;
  }

  function displayReport(report) {
    snapshot = report;
    const entries = report.entries;
    const key = [entries.length, entries[0]?.ordinal, entries.at(-1)?.ordinal].join("/");
    if (menuKey !== key) {
      menuKey = key;
      const previous = picker.value;
      const options = entries.slice().reverse().map(row => new Option(
        "#" + row.ordinal + " · Plaza " + row.seat + " · (" + row.fromX + ", " + row.fromZ + ") → (" + row.cx + ", " + row.cz + ")",
        String(row.ordinal)));
      picker.replaceChildren(new Option("Seguir la oferta más reciente", ""), ...options);
      if (options.some(option => option.value === previous)) picker.value = previous;
    }
    selectRow();
    fetchStatus.textContent = entries.length ? "" : emptyMessage();
  }

  async function refresh() {
    if (!canShow() || fetching || (context.finished && snapshot)) return;
    if (!context.summary.totalOffers) {
      fetchStatus.textContent = emptyMessage();
      return;
    }
    const request = fetching = new AbortController();
    if (!snapshot) fetchStatus.textContent = "Cargando ofertas…";
    try {
      const report = await readReport(context.session, request.signal);
      if (fetching === request && canShow()) displayReport(report);
    } catch (error) {
      if (fetching === request && !request.signal.aborted) fetchStatus.textContent = error.message;
    } finally {
      if (fetching === request) fetching = null;
    }
  }

  function cancelRead() {
    fetching?.abort();
    fetching = null;
  }

  function cancelExport() {
    exporting?.abort();
    exporting = null;
    download.disabled = false;
  }

  download.addEventListener("click", async () => {
    if (!canShow() || exporting) return;
    const session = context.session;
    const request = exporting = new AbortController();
    download.disabled = true;
    exportStatus.textContent = "Preparando el registro…";
    try {
      const report = await readReport(session, request.signal);
      if (exporting !== request) return;
      const name = "Mundo_Registro_Precarga_Sala_" + session + "_" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
      downloadHostFile(JSON.stringify(report, null, 2) + "\n", name, "application/json");
      exportStatus.textContent = "Descarga solicitada · " + report.entries.length + " ofertas incluidas.";
    } catch (error) {
      if (exporting === request && !request.signal.aborted) exportStatus.textContent = error.message;
    } finally {
      if (exporting === request) { exporting = null; download.disabled = false; }
    }
  });

  picker.addEventListener("change", selectRow);
  details.addEventListener("toggle", () => {
    if (details.open) void refresh();
    else { cancelRead(); cancelExport(); exportStatus.textContent = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelRead(); });

  function update(next) {
    const changed = context?.session !== next?.session;
    if (changed || context?.finished !== next?.finished) {
      cancelRead();
      cancelExport();
      snapshot = null;
      menuKey = "";
      get("usageOffer").hidden = true;
      fetchStatus.textContent = "";
      exportStatus.textContent = "";
      if (changed) { details.open = false; picker.replaceChildren(); }
    }
    context = next;
    section.hidden = !next;
    if (!next) return;
    const summary = next.summary;
    get("usageSummary").textContent = (next.finished ? "Sala cerrada" : "Sala abierta") + " · " +
      count.format(summary.totalOffers) + " ofertas en total · " + summary.retainedOffers + " conservadas · " +
      summary.closed + " con informe final · " + summary.active + " con informe parcial · " + summary.unreported + " sin informe.";
    get("usageScope").textContent = "Se conservan las últimas 256 ofertas. Se omitieron " +
      count.format(summary.omittedOffers) + " ofertas anteriores. " + (next.finished
        ? "Puedes descargar el registro hasta que abras otra sala o cierres el anfitrión."
        : "El archivo recoge el estado en el momento de la descarga.");
    void refresh();
  }
  return {update};
}
