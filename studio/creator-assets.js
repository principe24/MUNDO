"use strict";
// Creator meshes and owner-supplied art use independent catalogs. Worlds store only unsigned visual keys.
globalThis.MundoCreatorAssets = (() => {
  const idPattern=/^c[0-9a-f]{15}$/, hashPattern=/^[0-9a-f]{64}$/;
  const {isCreatorKey,keyOf}=MundoCreatorMesh;
  let pending=null;
  function database() {
    if (pending) return pending;
    const opening=new Promise((resolve,reject) => {
      if (!globalThis.indexedDB) throw Error("Este navegador no ofrece almacenamiento local de modelos.");
      const request=indexedDB.open("mundo-studio-creator-meshes",2);
      let blocked=false;
      request.onblocked=() => {
        blocked=true; reject(Error("Cierra la otra pestaña de Studio que mantiene ocupado el catálogo y vuelve a intentarlo."));
      };
      request.onupgradeneeded=event => {
        if (event.oldVersion!==0) return;
        const db=request.result;
        db.createObjectStore("models",{keyPath:"key"});
        db.createObjectStore("meshBytes");
      };
      request.onerror=() => reject(request.error);
      request.onsuccess=() => {
        const db=request.result;
        if (blocked) {db.close(); return;}
        db.onversionchange=() => {db.close(); pending=null;};
        db.onclose=() => {pending=null;};
        resolve(db);
      };
    });
    pending=opening;
    opening.catch(() => {if (pending===opening) pending=null;});
    return opening;
  }

  function modelName(filename) {
    const value=String(filename).replace(/\.obj$/i,"").replace(/[\u0000-\u001f\u007f-\u009f]/gu," ").trim();
    const enc=new TextEncoder(), parts=[];
    let length=0;
    for (const c of value) {
      const n=enc.encode(c).length;
      if (length+n>95) break;
      length+=n; parts.push(c);
    }
    return parts.join("").trim() || "Modelo 3D";
  }
  const uniformId="uniform", maxLayouts=32, maxRangesPerModel=16384;
  const encoder=new TextEncoder();
  function validLabel(name,limit) {
    return typeof name==="string" && name.length>0 && name===name.trim() &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(name) && encoder.encode(name).length<=limit;
  }
  function validateRanges(ranges,triangles) {
    if (!Array.isArray(ranges) || ranges.length>MundoObj.limits.surfaceRanges)
      throw Error("Intervalos de superficies inválidos.");
    let end=0, previous;
    const checked=ranges.map(r => {
      if (!r || r.first!==end || !Number.isSafeInteger(r.count) || r.count<=0 ||
          r.count>triangles-end || r.surface===previous ||
          (r.surface!==null && !validLabel(r.surface,MundoObj.limits.surfaceNameBytes)))
        throw Error("Los tramos de superficies deben cubrir los triángulos en orden.");
      end+=r.count; previous=r.surface;
      return {first:r.first,count:r.count,surface:r.surface};
    });
    if (checked.length && (end!==triangles || checked.length===1 && checked[0].surface===null))
      throw Error("La distribución de superficies está incompleta o es redundante.");
    return checked;
  }
  function uniform(name) { return {id:uniformId,name,ranges:[]}; }
  async function makeLayout(ranges,triangles,name) {
    const checked=validateRanges(ranges,triangles);
    if (!checked.length) return uniform(name);
    const serialized="mundo.surface-layout/1\n"+JSON.stringify(checked.map(r => [r.first,r.count,r.surface]));
    return {id:await MundoRoomFile.digest(encoder.encode(serialized)),name,ranges:checked};
  }
  function checkedLayouts(info) {
    if (!Object.hasOwn(info,"surfaceLayouts")) return [uniform(info.name)];
    const layouts=info.surfaceLayouts;
    if (!Array.isArray(layouts) || !layouts.length || layouts.length>maxLayouts)
      throw Error("Una geometría admite entre una y 32 distribuciones de superficies.");
    const ids=new Set();
    let total=0;
    return layouts.map(layout => {
      if (!layout || !validLabel(layout.name,95) || typeof layout.id!=="string" || ids.has(layout.id))
        throw Error("Distribución de superficies inválida o repetida.");
      const ranges=validateRanges(layout.ranges,info.triangles);
      if (ranges.length ? !hashPattern.test(layout.id) : layout.id!==uniformId)
        throw Error("La identidad de la distribución de superficies es inválida.");
      ids.add(layout.id); total+=ranges.length;
      if (total>maxRangesPerModel) throw Error("La geometría supera 16384 tramos guardados.");
      return {id:layout.id,name:layout.name,ranges};
    });
  }
  function checkInfo(info) {
    if (!info || !idPattern.test(info.key) || !hashPattern.test(info.digest) || info.key!==keyOf(info.digest) ||
        typeof info.name!=="string" || !info.name.length || /[\u0000-\u001f\u007f-\u009f]/u.test(info.name) || new TextEncoder().encode(info.name).length>95 ||
        !Number.isInteger(info.triangles) || info.triangles<1 || info.triangles>MundoObj.limits.triangles ||
        !Number.isInteger(info.vertices) || info.vertices<3 || info.vertices>info.triangles*3 ||
        !Array.isArray(info.size) || info.size.length!==3 || !info.size.every(x => x>=.0001 && x<=10000))
      throw Error("La ficha de un modelo local es inválida.");
    return {...info,surfaceLayouts:checkedLayouts(info)};
  }
  async function store(items) {
    const db=await database();
    return new Promise((resolve,reject) => {
      const tx=db.transaction(["models","meshBytes"],"readwrite"), table=tx.objectStore("models");
      const saved=[];
      let failure=null;
      for (const {bytes,layout,...proposed} of items) {
        const lookup=table.get(proposed.key);
        lookup.onsuccess=() => {
          if (failure) return;
          try {
            const old=lookup.result;
            if (old && old.digest!==proposed.digest) throw Error("La clave identifica otro modelo en este catálogo.");
            const surfaceLayouts=old ? checkInfo(old).surfaceLayouts : [];
            const incoming=layout || (!old && uniform(proposed.name));
            if (incoming) {
              const prior=surfaceLayouts.find(item=>item.id===incoming.id);
              if (!prior) surfaceLayouts.push(incoming);
              else if (JSON.stringify(prior.ranges)!==JSON.stringify(incoming.ranges))
                throw Error("La huella identifica otra distribución en este catálogo.");
            }
            const info=checkInfo({...proposed,name:old?.name ?? proposed.name,surfaceLayouts});
            table.put(info);
            // Keep only this model, even when it came from a slice of a larger room package.
            tx.objectStore("meshBytes").put(bytes.byteLength===bytes.buffer.byteLength ? bytes : bytes.slice(),info.key);
            saved.push(info);
          } catch (error) {failure=error;tx.abort();}
        };
      }
      tx.onabort=()=>reject(failure || tx.error || Error("Se interrumpió el guardado de modelos."));
      tx.oncomplete=()=>resolve(saved);
    });
  }
  async function save(bytes,filename,ranges=[]) {
    if (!globalThis.crypto?.subtle) throw Error("Abre el Studio privado en un contexto que permita SHA-256.");
    const shape=MundoCreatorMesh.describe(bytes),digest=await MundoRoomFile.digest(bytes);
    const name=modelName(filename), layout=await makeLayout(ranges,shape.triangles,name);
    const [info]=await store([{key:keyOf(digest),digest,name,...shape,bytes,layout}]);
    return {...info,importedLayoutId:layout.id};
  }
  async function restore(items) {
    const recovered=[], seen=new Set();
    for (const item of items) {
      const {key,digest,name,bytes}=checkInfo(item);
      if (seen.has(key)) throw Error("La sala repite una clave de geometría.");
      seen.add(key);
      if (await MundoRoomFile.digest(bytes)!==digest) throw Error("La malla adjunta difiere de su huella.");
      const shape=MundoCreatorMesh.describe(bytes);
      if (shape.triangles!==item.triangles || shape.vertices!==item.vertices || shape.size.some((n,i)=>n!==item.size[i]))
        throw Error("La ficha recuperada y los datos de geometría difieren.");
      recovered.push({key,digest,name,...shape,bytes});
    }
    return store(recovered);
  }
  async function list() {
    const db=await database();
    return new Promise((resolve,reject) => {
      const tx=db.transaction("models"), request=tx.objectStore("models").getAll();
      tx.onabort=() => reject(tx.error || Error("No se pudo abrir el catálogo."));
      tx.oncomplete=() => {
        try {resolve(request.result.map(checkInfo));} catch (error) {reject(error);}
      };
    });
  }
  async function load(info) {
    checkInfo(info);
    const db=await database();
    const bytes=await new Promise((resolve,reject) => {
      const tx=db.transaction("meshBytes"), request=tx.objectStore("meshBytes").get(info.key);
      tx.onabort=() => reject(tx.error || Error("Lectura de modelo interrumpida."));
      tx.oncomplete=() => resolve(request.result);
    });
    if (!(bytes instanceof Uint8Array) || !globalThis.crypto?.subtle || await MundoRoomFile.digest(bytes)!==info.digest)
      throw Error("Vuelve a importar el OBJ original para recuperar sus datos.");
    const shape=MundoCreatorMesh.describe(bytes);
    if (info.vertices!==shape.vertices || info.triangles!==shape.triangles || info.size.some((x,i) => x!==shape.size[i]))
      throw Error("La ficha y las dimensiones guardadas del modelo difieren.");
    return bytes;
  }
  return Object.freeze({isCreatorKey,save,list,load,restore});
})();
