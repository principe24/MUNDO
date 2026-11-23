"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { createHash } = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const MAX_PAYLOAD = 64 * 1024;
const MAX_RECORD = MAX_PAYLOAD + 512;
const DIGEST = /^[0-9a-f]{64}$/;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
class InvalidCheckpoint extends Error {}

function defaultRoot() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "MundoEngie", "continuidad");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "MundoEngie", "continuidad");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "mundo-engie", "continuidad");
}

// The kernel releases the endpoint on process death. No stale PID file and no
// takeover timeout: a suspended writer keeps its lease. Fallback port collisions
// also block writes, even if the conflicting listener belongs to a different app.
function leaseAddress(hash) {
  if (process.platform === "linux") return { path: "\0mundo-engie-checkpoint-" + hash };
  if (process.platform === "win32") return { path: "\\\\.\\pipe\\mundo-engie-checkpoint-" + hash };
  const port = 49152 + (parseInt(hash.slice(0, 8), 16) % 16384);
  return { host: "127.0.0.1", port };
}

async function acquire(hash, lost) {
  const lease = net.createServer(socket => {
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    lease.once("error", reject);
    lease.listen({ ...leaseAddress(hash), exclusive: true }, () => {
      lease.removeListener("error", reject);
      lease.on("error", lost);
      lease.on("close", lost);
      resolve();
    });
  });
  lease.unref();
  return lease;
}

function checksum(hash, savedAt, body) {
  return createHash("sha256").update(hash + "\n" + savedAt + "\n").update(body).digest("hex");
}

function encodePayload(payload) {
  if (!isObject(payload)) throw new InvalidCheckpoint();
  const body = JSON.stringify(payload, (_key, value) => {
    if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
        (typeof value === "number" && !Number.isFinite(value))) throw new InvalidCheckpoint();
    return value;
  });
  if (Buffer.byteLength(body) > MAX_PAYLOAD) throw new InvalidCheckpoint();
  return body;
}

async function readRecord(file, hash) {
  let metadata;
  try { metadata = await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!metadata.isFile()) throw new InvalidCheckpoint();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECORD) throw new InvalidCheckpoint();
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new InvalidCheckpoint();
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== bytes.length) throw new InvalidCheckpoint();
  } finally { await handle.close(); }
  try {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isObject(data) || data.version !== 1 || data.publication !== hash ||
        !Number.isSafeInteger(data.savedAt) || data.savedAt < 0) throw new InvalidCheckpoint();
    const body = encodePayload(data.payload);
    if (data.checksum !== checksum(hash, data.savedAt, body)) throw new InvalidCheckpoint();
    return { body, payload: data.payload, savedAt: data.savedAt };
  } catch { throw new InvalidCheckpoint(); }
}

class SessionCheckpoint {
  constructor(hash, root = defaultRoot()) {
    if (typeof hash !== "string" || hash.length !== 64 || !DIGEST.test(hash)) {
      throw new Error("Huella de publicación inválida.");
    }
    this.hash = hash;
    this.dir = path.join(root, hash.slice(0, 2), hash);
    this.file = path.join(this.dir, "partida.json");
    this.lease = null;
    this.state = "closed";
    this.savedAt = null;
    this.lastBody = null;
    this.pending = null;
    this.opening = null;
    this.worker = null;
    this.closing = null;
    this.writable = false;
  }

  open() {
    if (this.closing) return Promise.resolve(null);
    if (!this.opening) this.opening = this.load();
    return this.opening;
  }

  async load() {
    try {
      this.lease = await acquire(this.hash, () => {
        this.writable = false;
        if (!this.closing) this.state = "unavailable";
      });
    } catch (error) {
      this.state = error.code === "EADDRINUSE" ? "busy" : "unavailable";
      return null;
    }
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const stored = await readRecord(this.file, this.hash);
      if (!this.lease.listening) throw new Error("El bloqueo del anfitrión se perdió.");
      this.writable = true;
      this.state = stored ? "saved" : "empty";
      this.savedAt = stored?.savedAt ?? null;
      this.lastBody = stored?.body ?? null;
      return stored?.payload ?? null;
    } catch (error) {
      this.state = error instanceof InvalidCheckpoint ? "invalid" : "unavailable";
      return null;
    }
  }

  // Call before accepting any input if the simulation rejects the loaded payload.
  markInvalid() {
    this.writable = false;
    this.pending = null;
    this.state = "invalid";
  }

  // Caller builds a fresh allowlisted payload; this captures it by value before
  // the simulation or the next tick can mutate its fields.
  offer(payload) {
    if (!this.writable || this.closing) return false;
    let body;
    try { body = encodePayload(payload); }
    catch { return false; }
    this.pending = body;
    void this.flush();
    return true;
  }

  flush() {
    if (!this.writable) return Promise.resolve(false);
    if (this.worker) return this.worker;
    if (this.pending === null) return Promise.resolve(true);
    this.worker = this.drain();
    return this.worker;
  }

  async drain() {
    await Promise.resolve(); // Install the shared worker promise before draining.
    try {
      while (this.pending !== null && this.writable) {
        const body = this.pending;
        this.pending = null;
        if (body !== this.lastBody) {
          this.state = "saving";
          try { this.savedAt = await this.replace(body); }
          catch {
            // Directory sync can fail after rename already installed the candidate.
            // Even a return to the previous pose now needs a fresh replacement.
            this.lastBody = null;
            if (this.writable) {
              this.pending ??= body;
              this.state = "unavailable";
            }
            return false;
          }
          this.lastBody = body;
        }
        if (this.writable) this.state = "saved";
      }
      return this.writable;
    } finally { this.worker = null; }
  }

  async replace(body) {
    const savedAt = Date.now();
    const data = JSON.stringify({ version: 1, publication: this.hash, savedAt,
      checksum: checksum(this.hash, savedAt, body), payload: JSON.parse(body) });
    const temp = path.join(this.dir, "partida.next");
    // One lease owner, one fixed temporary name. A crash leaves at most one
    // partial candidate; readers use only partida.json.
    await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
    const file = await fs.open(temp, "wx", 0o600);
    try {
      await file.writeFile(data, "utf8");
      await file.sync();
    } finally { await file.close(); }
    if (!this.writable || !this.lease?.listening) throw new Error("El bloqueo del anfitrión se perdió.");
    await fs.rename(temp, this.file);
    if (process.platform !== "win32") {
      const dir = await fs.open(this.dir, "r");
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return savedAt;
  }

  status() {
    return { state: this.state, savedAt: this.savedAt };
  }

  close() {
    if (!this.closing) this.closing = this.release();
    return this.closing;
  }

  async release() {
    await this.opening;
    let ok = this.pending === null && !this.worker;
    try {
      if (this.writable) ok = await this.flush();
    } finally {
      this.writable = false;
      if (this.lease?.listening) await new Promise(resolve => this.lease.close(resolve));
      this.state = "closed";
    }
    return ok;
  }
}

module.exports = { SessionCheckpoint, MAX_PAYLOAD };
