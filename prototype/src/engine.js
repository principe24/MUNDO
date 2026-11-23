export class Engine {
  #systems = new Map();
  #running = false;
  #last = null;
  register(name, system) {
    if (!name || this.#systems.has(name) || typeof system?.update !== 'function') throw new Error('Invalid or duplicate system');
    this.#systems.set(name, system);
    return this;
  }
  async start() {
    if (this.#running) return;
    const started = [];
    try {
      for (const system of this.#systems.values()) {
        await system.start?.();
        started.push(system);
      }
      this.#running = true;
      this.#last = null;
    } catch (error) {
      for (const system of started.reverse()) await system.stop?.().catch?.(() => {});
      throw error;
    }
  }
  async tick(now) {
    if (!this.#running || !Number.isFinite(now)) throw new Error('Engine not running or invalid time');
    const dt = this.#last === null ? 0 : Math.min(0.1, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    for (const system of this.#systems.values()) await system.update(dt);
    return dt;
  }
  async stop() {
    if (!this.#running) return;
    this.#running = false;
    const systems = [...this.#systems.values()].reverse();
    const errors = [];
    for (const system of systems) { try { await system.stop?.(); } catch (e) { errors.push(e); } }
    this.#last = null;
    if (errors.length) throw new AggregateError(errors, 'Failed to stop systems');
  }
  get running() { return this.#running; }
}
