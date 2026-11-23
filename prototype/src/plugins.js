export class PluginManager {
  #plugins = new Map();
  #active = new Set();
  register(plugin) {
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id || this.#plugins.has(plugin.id) || typeof plugin.activate !== 'function') throw new Error('Invalid or duplicate plugin');
    this.#plugins.set(plugin.id, plugin);
  }
  async activate(id, context) {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new Error('Unknown plugin');
    if (this.#active.has(id)) return;
    await plugin.activate(context);
    this.#active.add(id);
  }
  async deactivate(id) {
    if (!this.#active.has(id)) return;
    await this.#plugins.get(id).deactivate?.();
    this.#active.delete(id);
  }
  async shutdown() {
    const errors = [];
    for (const id of [...this.#active].reverse()) {
      try { await this.deactivate(id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin shutdown failures');
  }
  get active() { return [...this.#active]; }
}
