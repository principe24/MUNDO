"use strict";

const {prepareEntryZones,prepareCellIndex,prepareSectorCatalog} = require("./zone-preview.cjs");
const {MundoZones} = require("./room-runtime.cjs");

const cacheBudget = 16 * 1024 * 1024;
const cacheEntries = 4;
const maxJobs = 3;                 // One worker and at most two queued worlds.
const maxWaitMs = 1500;            // The full-world path remains available.
const retryErrorMs = 30_000;

function eligible(def) {
  return def?.bytes instanceof Uint8Array && MundoZones.eligibleRoomBytes(def.bytes.byteLength) &&
    typeof def.revision==="string" && def.revision.length===64 && /^[0-9a-f]{64}$/.test(def.revision);
}
function selection(def,profile,focusXZ) {
  if ((profile!=="mobile" && profile!=="pc") || !eligible(def)) return null;
  // Only the room chooses focus. A stored meeting point needs no spawn calculation.
  const focus=focusXZ??(def.meetingPoint?[def.meetingPoint[0],def.meetingPoint[2]]:null);
  if (focus && (!Array.isArray(focus) || focus.length!==2 || !focus.every(Number.isFinite))) return null;
  const cell=focus?.map(MundoZones.cell)??null;
  if (cell && !cell.every(Number.isSafeInteger)) return null;
  return {key:JSON.stringify([def.revision,def.vehicleRoot??null,profile,cell]),focus:focus?.slice()??null};
}

// Part uploads reference this immutable buffer until the HTTP response completes.
// The focus in a descriptor is the actual authorized arrival, even on a hit from
// an earlier arrival within the same spatial cell.
function atFocus(value,focus) {
  return value?{bytes:value.bytes, hash:value.hash, focus:(focus??value.focus).slice(),
    cells:value.cells, ranges:value.ranges}:null;
}

class EntryZones {
  constructor() {
    this.cache=new Map();
    this.catalogs=new Map();        // At most two complete catalogs of <=26 MiB.
    this.bytes=0;
    this.jobs=new Map();
    this.queue=[];
    this.active=null;
    this.closed=false;
  }

  remove(key) {
    const entry=this.cache.get(key);
    if (entry) {
      this.bytes-=entry.size;
      this.cache.delete(key);
    }
  }

  // A cached null is distinct from a miss. Worlds that already fit in the
  // startup radius should not schedule another full partition on every join.
  cached(key,store=this.cache) {
    const entry=store.get(key);
    if (!entry) return undefined;
    if (entry.retryAfter && performance.now()>=entry.retryAfter) {
      if(store===this.cache)this.remove(key);else store.delete(key);
      return undefined;
    }
    store.delete(key);
    store.set(key,entry);
    return entry.value;
  }

  remember(key,value,error) {
    const size=(value?.bytes.byteLength??0)+(value?.ranges?.byteLength??0);
    if (size>cacheBudget) return;
    this.remove(key);
    while (this.cache.size>=cacheEntries || this.bytes+size>cacheBudget)
      this.remove(this.cache.keys().next().value);
    this.cache.set(key,{value,size,retryAfter:error?performance.now()+retryErrorMs:0});
    this.bytes+=size;
  }

  peek(def,profile,focusXZ=null) {
    if (this.closed) return null;
    const selected=selection(def,profile,focusXZ);
    return selected?atFocus(this.cached(selected.key),selected.focus):null;
  }

  async get(def,profile,focusXZ=null) {
    if (this.closed) return null;
    const selected=selection(def,profile,focusXZ);
    if (!selected) return null;
    const value=await this.acquire(def,profile,selected);
    return atFocus(value,selected.focus);
  }

  async directory(def) {
    if (this.closed || !eligible(def)) return null;
    const key=JSON.stringify([def.revision,def.vehicleRoot??null,"directory"]);
    const value=await this.acquire(def,null,{key});
    return value?.bytes??null;
  }

  catalogKey(def) {
    return JSON.stringify([def.revision,def.vehicleRoot??null,"sectors"]);
  }
  peekCatalog(def) {
    return this.closed?null:this.cached(this.catalogKey(def),this.catalogs);
  }
  async catalog(def) {
    if(this.closed || !eligible(def))return null;
    return this.acquire(def,"sectors",{key:this.catalogKey(def)});
  }

  async acquire(def,profile,selected) {
    const cached=this.cached(selected.key,profile==="sectors"?this.catalogs:this.cache);
    if (cached!==undefined) return cached;

    let job=this.jobs.get(selected.key);
    if (!job) {
      if (this.jobs.size>=maxJobs) return null;
      let resolve;
      const visible=new Promise(done=>{resolve=done;});
      job={def,profile,...selected,visible,resolve,controller:new AbortController()};
      // A coalesced request has a single wait timer, including any queue time.
      job.timer=setTimeout(()=>resolve(null),maxWaitMs);
      job.timer.unref();
      this.jobs.set(job.key,job);
      this.queue.push(job);
      this.pump();
    }
    return job.visible;
  }

  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const job=this.queue.shift();
    this.active=job;
    job.finished=this.run(job);
  }

  async run(job) {
    let value=null, failed=false;
    try {
      const result=job.profile==="sectors"?await prepareSectorCatalog(job.def,job.controller.signal):
        job.profile===null?await prepareCellIndex(job.def,job.controller.signal):
        await prepareEntryZones(job.def,job.profile,job.focus,job.controller.signal);
      if (result) {
        const raw=result.bytes;
        value={...result,bytes:Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength)};
        if(result.table){
          const t=result.table;
          value.table=Buffer.from(t.buffer,t.byteOffset,t.byteLength);
        }
      }
    } catch { failed=true; }
    finally {
      clearTimeout(job.timer);
      this.jobs.delete(job.key);
      if (!this.closed && job.profile==="sectors") {
        if(this.catalogs.size>=2)this.catalogs.delete(this.catalogs.keys().next().value);
        this.catalogs.set(job.key,{value,retryAfter:failed?performance.now()+retryErrorMs:0});
      } else if (!this.closed) this.remember(job.key,value,failed);
      job.resolve(this.closed?null:value);
      this.active=null;
      this.pump();
    }
  }

  async close() {
    this.closed=true;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      job.resolve(null);
      job.controller.abort();
    }
    this.queue=[];
    this.jobs.clear();
    this.cache.clear();
    this.catalogs.clear();
    this.bytes=0;
    await this.active?.finished;
  }
}

module.exports={EntryZones};
