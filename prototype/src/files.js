export class VirtualFiles {
  #files = new Map();
  #normalize(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Absolute path required');
    const parts = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!parts.length) throw new Error('Path escapes root'); parts.pop(); }
      else parts.push(part);
    }
    if (!parts.length) throw new Error('File path required');
    return '/' + parts.join('/');
  }
  write(path, content) {
    if (typeof content !== 'string') throw new TypeError('Content must be text');
    this.#files.set(this.#normalize(path), content);
  }
  read(path) {
    const key = this.#normalize(path);
    if (!this.#files.has(key)) throw new Error('File not found');
    return this.#files.get(key);
  }
  exists(path) { return this.#files.has(this.#normalize(path)); }
  remove(path) { return this.#files.delete(this.#normalize(path)); }
  list(prefix = '/') {
    if (prefix !== '/') prefix = this.#normalize(prefix).replace(/\/$/, '') + '/';
    return [...this.#files.keys()].filter(path => path.startsWith(prefix)).sort();
  }
  snapshot() { return Object.fromEntries([...this.#files].sort(([a],[b]) => a.localeCompare(b))); }
}
