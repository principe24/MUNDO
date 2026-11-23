"use strict";
const assert = require("node:assert/strict");
const {resolveObjectURL} = require("node:buffer");
const {webcrypto} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {setImmediate: turn} = require("node:timers/promises");
const vm = require("node:vm");

function readPage(pagePath) {
  const html = fs.readFileSync(pagePath, "utf8");
  const scripts = [...html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)].map(match => {
    const file = match[1];
    const code = file ? fs.readFileSync(path.resolve(path.dirname(pagePath), file), "utf8") : match[2];
    return {name: file || "Studio portátil", code};
  });
  return {html, scripts};
}

async function until(label, predicate) {
  const limit = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > limit) throw Error("Sin señal de " + label);
    await turn();
  }
}

// Only plugin storage persists between mounts. Other Studio catalogs are intentionally
// unavailable in this scenario, as they may be on a file URL or in private browsing.
function pluginDatabase(persisted) {
  function transaction(store, mode) {
    assert.equal(store, "catalog");
    let aborted = false;
    const tx = {
      objectStore() {
        return {
          get(key) {
            const read = {};
            queueMicrotask(() => {
              read.result = structuredClone(persisted[key]);
              read.onsuccess();
              if (!aborted) tx.oncomplete();
            });
            return read;
          },
          put(value, key) {
            assert.equal(mode, "readwrite");
            persisted[key] = structuredClone(value);
          },
        };
      },
      abort() {
        aborted = true;
        tx.onabort();
      },
    };
    return tx;
  }

  return {
    open(name, version) {
      const request = {};
      queueMicrotask(() => {
        if (name !== "MundoStudioPlugins") {
          request.error = Error("Otra base local no disponible en esta prueba.");
          request.onerror?.();
          return;
        }
        assert.equal(version, 2);
        const oldVersion = persisted.version || 0;
        request.result = {
          createObjectStore(key) {
            assert.equal(key, "catalog");
            assert(!persisted.created, "La migración no puede volver a crear el almacén existente.");
            persisted.created = true;
          },
          close() {},
          transaction,
        };
        if (oldVersion < version) request.onupgradeneeded({oldVersion});
        persisted.version = version;
        assert(persisted.created);
        request.onsuccess();
      });
      return request;
    },
  };
}

function mount(persisted, {pagePath = process.argv[2] || path.join(__dirname, "../../studio/Mundos.html"), modelDatabase} = {}) {
  const {html, scripts} = readPage(pagePath);
  let download;
  const fields = new Map();
  const events = new Map();

  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.selectedIndex = -1;
      this.current = "";
      this.textContent = "";
      this.dataset = {};
      this.style = {};
      this.classList = {toggle() {}};
    }
    get value() {
      if (this.tag === "select") return this.options[this.selectedIndex]?.value ?? "";
      return this.current;
    }
    set value(value) {
      if (this.tag === "select") {
        this.selectedIndex = this.options.findIndex(item => item.value === String(value));
      } else {
        this.current = String(value);
      }
    }
    get valueAsNumber() { return this.value.trim() ? Number(this.value) : NaN; }
    get validity() {
      if (this.type !== "number") return {valid: true};
      const n = this.valueAsNumber;
      const min = this.min === undefined ? -Infinity : Number(this.min);
      const max = this.max === undefined ? Infinity : Number(this.max);
      const step = this.step === "any" ? 0 : Number(this.step ?? 1);
      const offset = Number.isFinite(min) ? min : 0;
      const ticks = (n - offset) / step;
      return {valid: Number.isFinite(n) && n >= min && n <= max &&
        (!step || Math.abs(ticks - Math.round(ticks)) < 1e-8)};
    }
    get options() {
      return this.children.flatMap(node => node.tag === "optgroup" ? node.children : [node]);
    }
    get tBodies() { return this.bodies ??= [new Element("tbody")]; }
    setAttribute(key, value) { this[key] = value; }
    removeAttribute(key) { delete this[key]; }
    replaceChildren(...nodes) {
      this.children = [];
      this.selectedIndex = -1;
      this.append(...nodes);
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tag === "fragment") this.append(...node.children);
        else this.children.push(node);
        if (node.id) fields.set(node.id, node);
      }
      if (this.tag === "select" && this.children.length && this.selectedIndex < 0) this.selectedIndex = 0;
    }
    add(option) { this.append(option); }
    addEventListener(name, callback) { this["on" + name] = callback; }
    querySelectorAll() { return []; }
    getContext() { return null; }
    click() {
      if (this.disabled) throw Error("Control deshabilitado: " + this.id);
      if (this.tag === "a") download = {blob: resolveObjectURL(this.href), name: this.download};
      else return this.onclick?.();
    }
    focus() {}
    remove() {}
    after() {}
  }

  class Option extends Element {
    constructor(label, value) {
      super("option");
      this.textContent = label;
      this.value = value;
    }
  }

  for (const [, tag, attributes, id] of html.matchAll(/<(\w+)\b([^>]*?\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(tag);
    element.id = id;
    for (const [, key, value] of attributes.matchAll(/\b(type|min|max|step)="([^"]*)"/g)) element[key] = value;
    element.disabled = /(?:^|\s)disabled\b/i.test(attributes);
    const initial = attributes.match(/\bvalue="([^"]*)"/);
    if (initial) element.value = initial[1];
    fields.set(id, element);
  }
  // A select exposes choices inside its optgroups through the same options list.
  for (const [, id, contents] of html.matchAll(/<select\b[^>]*?\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const select = fields.get(id);
    for (const match of contents.matchAll(/<option\b[^>]*?value="([^"]*)"[^>]*>([^<]*)<\/option>|<optgroup\b[^>]*?id="([^"]+)"[^>]*>/g)) {
      if (match[3]) select.append(fields.get(match[3]));
      else select.append(new Option(match[2], match[1]));
    }
  }
  for (const [, id, text] of html.matchAll(/<template id="([^"]+)">([^<]*)<\/template>/g)) {
    fields.get(id).content = {textContent: text};
  }
  const block = new Element("button");
  block.dataset.shape = "1";
  const element = id => fields.get(id) || null;
  const document = {
    addEventListener() {},
    getElementById: element,
    createElement: tag => new Element(tag),
    createDocumentFragment: () => new Element("fragment"),
    querySelectorAll: query => query === "[data-shape]" ? [block] : [],
    body: new Element("body"),
  };
  const plugins = pluginDatabase(persisted);
  const indexedDB = {open(name, version) {
    if (modelDatabase && name === "mundo-studio-creator-meshes") return modelDatabase.open(name, version);
    return plugins.open(name, version);
  }};
  const context = vm.createContext({
    document, Option, indexedDB,
    navigator: {userAgent: "Studio QA", platform: "Linux"},
    addEventListener: (name, callback) => events.set(name, callback),
    URL, Blob, TextEncoder, TextDecoder, atob, btoa, Uint8Array, crypto: webcrypto,
    requestAnimationFrame: () => 1, performance, console,
    setTimeout: (callback, ms) => setTimeout(callback, ms).unref(), clearTimeout,
    location: {protocol: "file:", hostname: "", pathname: "/"}, confirm: () => true,
  });
  context.window = context;
  for (const {code, name} of scripts) vm.runInContext(code, context, {filename: name});
  return {element, block, events, getDownload: () => download};
}

async function manifestOf(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString(), "MUNDOPRJ");
  return JSON.parse(bytes.subarray(80, 80 + bytes.readUInt32LE(12)).toString("utf8"));
}
async function save(studio) {
  await until("escritura del proyecto", () => !studio.element("projectControls").disabled);
  const before = studio.getDownload();
  await studio.element("projectSave").click();
  assert.notEqual(studio.getDownload(), before, studio.element("projectStatus").textContent);
  return studio.getDownload().blob;
}
async function open(studio, blob, name) {
  const el = studio.element;
  el("projectFile").files = [blob];
  el("projectFile").onchange();
  await until("apertura de " + name, () => el("projectName").value === name);
  assert.equal(el("projectWorlds").value, "1");
}


module.exports = {mount, until, manifestOf, save, open};
