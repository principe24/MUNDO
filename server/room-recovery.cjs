"use strict";

// One coordinator per running host. Preparing a publication in Studio never
// acquires its writer lock. Only server-owned state reaches the storage layer.
class RoomRecovery {
  constructor(store, capture, restore) {
    this.store = store;
    this.capture = capture;
    this.restore = restore;
    this.writable = false;
    this.restored = false;
    this.active = false;
    this.lastAttempt = 0;
    this.lastScene = null;
    this.lastRun = null;
    this.lastPassed = null;
    this.lastPhase = null;
  }

  async open(now) {
    if (!this.store) return;
    const data = await this.store.open();
    this.active = true;
    const start = now();
    if (data !== null) {
      try { this.restored = this.restore(data, start); }
      catch { this.restored = false; }
      if (!this.restored) this.store.markInvalid();
    }
    this.writable = ["empty", "saved"].includes(this.store.status().state);
    this.lastAttempt = start;
  }

  status() {
    if (!this.active) return {state:"off", restored:false, savedAt:null, canSave:false};
    const {state, savedAt} = this.store.status();
    const canSave = this.writable && this.store.writable;
    const detail = state === "unavailable" && !canSave
      ? "Cierra la sala y vuelve a abrir la misma publicación para reintentar la recuperación." : undefined;
    return {state:state === "empty" ? "ready" : state, restored:this.restored, savedAt, canSave, detail};
  }

  offer(now) {
    if (!this.writable || !this.store.writable) return false;
    this.lastAttempt = now;
    return this.store.offer(this.capture(now));
  }

  observe(scene, now, occupied) {
    if (!this.writable) return;
    const course = scene.course;
    const phase = course?.finished != null ? "finished" : course?.started != null ? "running" : "ready";
    const changed = this.lastScene !== null && (scene !== this.lastScene ||
      this.lastRun !== course?.run || this.lastPassed !== course?.passed || this.lastPhase !== phase);
    this.lastScene = scene;
    this.lastRun = course?.run;
    this.lastPassed = course?.passed;
    this.lastPhase = phase;
    if (changed || (occupied && now - this.lastAttempt >= 2000)) this.offer(now);
  }

  async save(now) {
    return this.offer(now) && await this.store.flush();
  }

  async close(now) {
    if (!this.active) return this.status();
    let saved = false;
    let status;
    try {
      if (this.writable) saved = await this.save(now);
    } finally {
      status = this.status();
      this.writable = false;
      try {
        const closed = await this.store.close();
        if ((!closed || !saved) && ["ready","saved","saving"].includes(status.state)) status.state = "unavailable";
      } finally { this.active = false; }
    }
    return status;
  }
}

module.exports = {RoomRecovery};
