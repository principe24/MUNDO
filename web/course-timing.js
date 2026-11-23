"use strict";

window.MundoCourseTiming = (() => {
  const maxFileBytes = 256 * 1024;
  const utf8 = new TextEncoder();
  const control = /[\u0000-\u001f\u007f-\u009f]/u;
  const phases = new Set(["ready", "running", "finished"]);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const natural = value => Number.isSafeInteger(value) && value >= 0;
  const digest = value => typeof value === "string" && value.length === 64 && !/[^a-f0-9]/u.test(value);
  const sameSeries = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

  function requireValue(condition, detail) {
    if (!condition) throw new Error(detail);
  }

  function entityId(value) {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) return false;
    const id = BigInt(value);
    return id <= 0xffffffffffffffffn && String(id) === value;
  }

  function readGates(items, count) {
    requireValue(Array.isArray(items) && items.length === count, "La lista de puertas está incompleta.");
    const ids = new Set();
    let lastSlot = 0;
    return items.map(gate => {
      requireValue(object(gate) && entityId(gate.id) && !ids.has(gate.id) &&
        Number.isInteger(gate.slot) && gate.slot > lastSlot && gate.slot <= 32,
        "Las puertas deben tener identificadores únicos y estar en orden de paso.");
      const label = gate.label;
      requireValue(typeof label === "string" && label.length > 0 && label === label.trim() &&
        !control.test(label) && utf8.encode(label).length <= 48, "El nombre de una puerta es incompatible.");
      ids.add(gate.id);
      lastSlot = gate.slot;
      return {id: gate.id, slot: gate.slot, label};
    });
  }

  function series(values, count, ceiling, isFinish) {
    const message = "Las marcas de paso son incompatibles con el tiempo de la vuelta.";
    requireValue(Array.isArray(values) && values.length === count, message);
    let previous = 0;
    for (const value of values) {
      if (value === null) continue;
      requireValue(ceiling !== null && natural(value) && value >= previous && value <= ceiling, message);
      previous = value;
    }
    if (isFinish && values[count - 1] !== null) requireValue(values[count - 1] === ceiling, message);
    return values.slice();
  }

  function readLap(item, passed, total, finished) {
    requireValue(object(item) && natural(item.run) && item.run > 0 && natural(item.elapsedMs) &&
      (item.referenceTotalMs === null || natural(item.referenceTotalMs)), "La vuelta contiene tiempos incompatibles.");
    return {
      run: item.run,
      elapsedMs: item.elapsedMs,
      splits: series(item.splits, passed, item.elapsedMs, finished),
      reference: series(item.reference, total, item.referenceTotalMs, true),
      referenceTotalMs: item.referenceTotalMs
    };
  }

  function parse(text) {
    requireValue(typeof text === "string" && text.length <= maxFileBytes && utf8.encode(text).length <= maxFileBytes,
      "El informe supera el límite de 256 KiB.");
    let input;
    try { input = JSON.parse(text); }
    catch { throw new Error("El archivo no contiene JSON válido."); }
    requireValue(object(input) && input.format === "MUNDO-course-timing" && input.version === 1,
      "Se necesita un informe de tiempos de circuito de la versión 1.");
    const {revision, carRoot, worldName, phase, passed, total, bestMs} = input;
    const startMode=Object.hasOwn(input,"startMode")?input.startMode:"movement";
    requireValue(startMode==="movement" || (startMode==="flying" && total>=2), "El modo de salida del circuito es incompatible.");
    // The revision identifies .mworld bytes. The publication identifies the room
    // whose selected car and meeting point scope its persisted circuit record.
    const publication = input.publication ?? null;
    requireValue(digest(revision) && (publication === null || digest(publication)) &&
      entityId(carRoot) && typeof worldName === "string" && worldName.length <= 160 && worldName.trim().length > 0 &&
      !control.test(worldName), "El mundo, la publicación o el turismo son incompatibles.");
    requireValue(Number.isInteger(total) && total > 0 && total <= 32 && natural(passed) && passed <= total &&
      phases.has(phase) && (bestMs === null || natural(bestMs)), "El estado del circuito es incompatible.");
    const gates = readGates(input.gates, total);
    const finished = phase === "finished";
    const lap = readLap(input, passed, total, finished);
    const validStart=lap=>startMode!=="flying" ||
      ([lap.splits[0],lap.reference[0]].every(time=>time==null || time===0));
    requireValue(validStart(lap) && (startMode!=="flying" || phase!=="running" || passed>0),
      "La primera puerta debe iniciar la salida lanzada en cero.");
    const knownReference = target => target === null || (bestMs !== null && bestMs <= target);
    requireValue(knownReference(lap.referenceTotalMs), "La referencia es incompatible con la mejor vuelta conocida.");
    requireValue(finished === (passed === total) && (!finished || (bestMs !== null && bestMs <= lap.elapsedMs)) &&
      (phase !== "ready" || (passed === 0 && lap.elapsedMs === 0)), "El estado de la vuelta no coincide con sus pasos.");
    requireValue(Array.isArray(input.history) && input.history.length <= 8, "El historial supera las ocho vueltas.");
    let lastRun = 0;
    const history = input.history.map(item => {
      const entry = readLap(item, total, total, true);
      requireValue(validStart(entry) && entry.run > lastRun && entry.run <= lap.run && bestMs !== null && bestMs <= entry.elapsedMs &&
        knownReference(entry.referenceTotalMs),
        "El historial contiene vueltas o tiempos incompatibles.");
      if (entry.run === lap.run) {
        requireValue(finished && entry.elapsedMs === lap.elapsedMs && entry.referenceTotalMs === lap.referenceTotalMs &&
          sameSeries(entry.splits, lap.splits) && sameSeries(entry.reference, lap.reference),
          "La vuelta actual difiere de la registrada en el historial.");
      }
      lastRun = entry.run;
      return entry;
    });
    return {format: input.format, version: 1, revision, publication, carRoot, worldName, gates, startMode,
      ...lap, phase, passed, total, bestMs, history};
  }

  // A finished lap records a finish-line crossing even if its original checkpoint
  // only had the total. Earlier missing gates stay unknown. A live clock is not a split.
  function finishTime(lap, total) {
    return lap.splits.length === total ? lap.elapsedMs : null;
  }

  function rows(report, lap = report, referenceLap = null) {
    const total = report.gates.length;
    const finish = finishTime(lap, total);
    const reference = referenceLap ? referenceLap.splits : lap.reference;
    const referenceFinish = referenceLap ? finishTime(referenceLap, total) : lap.referenceTotalMs;
    const difference = (a, b) => a === null || b === null ? null : a - b;
    let previous = 0, previousReference = 0;
    return report.gates.map((gate, i) => {
      const last = i === total - 1;
      const atMs = lap.splits[i] ?? (last ? finish : null);
      const referenceMs = reference[i] ?? (last ? referenceFinish : null);
      const legMs = difference(atMs, previous);
      const referenceLegMs = difference(referenceMs, previousReference);
      previous = atMs;
      previousReference = referenceMs;
      return {...gate, atMs, legMs, referenceMs, referenceLegMs, deltaMs: difference(atMs, referenceMs),
        legDeltaMs: difference(legMs, referenceLegMs)};
    });
  }

  const startLabel=mode=>mode==="flying"?"Salida lanzada en la primera puerta":"Salida al mover el turismo";
  return Object.freeze({parse, rows, maxFileBytes, startLabel});
})();
