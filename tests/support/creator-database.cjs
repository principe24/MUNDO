"use strict";
const assert = require("node:assert/strict");

// Only the two model stores, their transaction commit/abort, and origin reopening
// are simulated. All importer, binary, hash, and model catalog logic is production code.
function memoryDatabase(data) {
  const clone=value=>structuredClone(value);
  function transaction(names, mode="readonly") {
    const snapshot=clone(data.stores);
    let pending=0, aborted=false;
    const tx={
      abort() {aborted=true; tx.onabort?.();},
      objectStore(name) {
        assert([names].flat().includes(name));
        const store=snapshot.get(name);
        function read(value) {
          const request={};
          ++pending;
          queueMicrotask(() => {
            if (aborted) return;
            request.result=clone(value);
            request.onsuccess?.();
            if (!--pending && !aborted) {
              if (mode === "readwrite") data.stores=snapshot;
              tx.oncomplete?.();
            }
          });
          return request;
        }
        return {get:key=>read(store.get(key)),getAll:()=>read([...store.values()]),
          put:(value,key=value.key)=>store.set(key,clone(value))};
      }
    };
    return tx;
  }
  return {open(name,version) {
    const request={};
    queueMicrotask(() => {
      assert.equal(name,"mundo-studio-creator-meshes");
      request.result={transaction,close(){},createObjectStore(key) {
        assert(!data.stores.has(key)); data.stores.set(key,new Map());
      }};
      if (data.version<version) {
        request.onupgradeneeded({oldVersion:data.version});
        data.version=version;
      }
      request.onsuccess();
    });
    return request;
  }};
}

module.exports = {memoryDatabase};
