"use strict";
const MundoCreatorMesh = (() => {
  const header="MWCMESH1", headerBytes=40, maxTriangles=60000;
  const isCreatorKey=key => typeof key==="bigint" && (key>>60n)===12n;
  const keyOf=digest => "c"+digest.slice(0,15);
  function describe(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length<headerBytes ||
        String.fromCharCode(...bytes.subarray(0,8))!==header) throw Error("Cabecera de modelo inválida.");
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const vertices=view.getUint32(8,true), indices=view.getUint32(12,true);
    const size=[0,1,2].map(i => view.getFloat64(16+8*i,true));
    if (vertices<3 || vertices>indices || indices%3 || indices>3*maxTriangles ||
        bytes.length!==headerBytes+vertices*24+indices*4 || size.some(x => !(x>=.0001 && x<=10000)))
      throw Error("Dimensiones o longitud de modelo inválidas.");
    return {vertices,triangles:indices/3,size};
  }

  function forDrawing(bytes) {
    const {vertices,triangles}=describe(bytes), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const first=headerBytes+vertices*24, out=new Float32Array(triangles*3*11);
    for (let i=0; i<triangles*3; ++i) {
      const vertex=view.getUint32(first+4*i,true);
      if (vertex>=vertices) throw Error("Índice fuera del catálogo local.");
      const dest=i*11;
      for (let k=0; k<6; ++k) {
        const value=view.getFloat32(headerBytes+vertex*24+k*4,true);
        if (!Number.isFinite(value) || Math.abs(value)>(k<3 ? .5 : 1)) throw Error("Atributo de modelo inválido.");
        out[dest+k]=value;
      }
      // A negative surface tag uses the editable color and roughness on each world instance.
      out[dest+9]=-1;
    }
    return [out,out,out];
  }
  // Reorder indices, never vertices, so all triangles of a named surface can be drawn
  // together. All instances using this layout share the index buffer, regardless of color.
  function surfaceIndex(layout,triangles) {
    if (!Number.isSafeInteger(triangles) || triangles < 1 || triangles > maxTriangles)
      throw Error("Número de triángulos inválido para las superficies.");
    const ranges=layout.ranges.length ? layout.ranges : [{first:0,count:triangles,surface:null}];
    const sections=new Map();
    let total=0;
    for (const range of ranges) {
      if (range.first!==total || !Number.isSafeInteger(range.count) ||
          range.count<=0 || range.count>triangles-total) throw Error("Distribución de superficies inválida.");
      const old=sections.get(range.surface);
      if (old) old.count+=range.count*3;
      else sections.set(range.surface,{surface:range.surface,count:range.count*3,first:0});
      total+=range.count;
    }
    if (total!==triangles) throw Error("La distribución no cubre todos los triángulos.");
    const groups=Array.from(sections.values());
    if (ranges.length===groups.length) {
      let first=0;
      for (const group of groups) {group.first=first;first+=group.count;}
      return {groups,indices:null};
    }
    const indices=triangles*3>65535 ? new Uint32Array(triangles*3) : new Uint16Array(triangles*3);
    const cursor=new Map();
    let start=0;
    for (const group of groups) {
      group.first=start;cursor.set(group.surface,start);start+=group.count;
    }
    for (const range of ranges) {
      let write=cursor.get(range.surface);
      const end=(range.first+range.count)*3;
      for (let read=range.first*3;read<end;++read) indices[write++]=read;
      cursor.set(range.surface,write);
    }
    return {groups,indices};
  }
  function wireframe(bytes) {
    const {vertices,triangles,size}=describe(bytes), count=Math.min(2500,triangles);
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const first=headerBytes+vertices*24, points=new Float32Array(count*9);
    for (let i=0; i<count; ++i) {
      const tri=Math.floor(i*triangles/count);
      for (let c=0; c<3; ++c) {
        const v=view.getUint32(first+(tri*3+c)*4,true);
        if (v>=vertices) throw Error("Índice inválido en la vista de malla.");
        for (let k=0; k<3; ++k) {
          const x=view.getFloat32(headerBytes+v*24+k*4,true);
          if (!Number.isFinite(x) || Math.abs(x)>.5) throw Error("Posición inválida en la vista de malla.");
          points[i*9+c*3+k]=x*size[k];
        }
      }
    }
    return {points,size,triangles,count};
  }
  function validate(bytes) {
    const layout=describe(bytes), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for (let i=0; i<layout.vertices; ++i) {
      const start=headerBytes+i*24;
      let squared=0;
      for (let k=0; k<6; ++k) {
        const x=view.getFloat32(start+k*4,true);
        if (!Number.isFinite(x) || Math.abs(x)>(k<3 ? .5 : 1)) throw Error("Atributo de modelo fuera de rango.");
        if (k>=3) squared+=x*x;
      }
      if (Math.abs(squared-1)>.001) throw Error("Normal de modelo inválida.");
    }
    const start=headerBytes+layout.vertices*24;
    for (let i=0; i<layout.triangles*3; ++i)
      if (view.getUint32(start+4*i,true)>=layout.vertices) throw Error("Índice de modelo fuera de rango.");
    return layout;
  }
  return Object.freeze({header,headerBytes,maxTriangles,maxBytes:headerBytes+maxTriangles*3*28,
    isCreatorKey,keyOf,describe,validate,forDrawing,surfaceIndex,wireframe});
})();
if (typeof module!=="undefined" && module.exports) module.exports=MundoCreatorMesh;
