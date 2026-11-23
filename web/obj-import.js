"use strict";
// Static creator meshes use metres and a Y-up coordinate system. No external resources are opened.
globalThis.MundoObj = (() => {
  const limits = Object.freeze({bytes: 6 * 1024 * 1024, attributes: 90000, triangles: MundoCreatorMesh.maxTriangles,
    surfaceRanges: 4096, surfaceNameBytes: 160, faceCorners: 64, lines: 300000, lineLength: 8192, polygonWork: 3500000});
  const {header,headerBytes}=MundoCreatorMesh;
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  function unit(v) {
    const n = Math.hypot(...v);
    return n ? v.map(x => x / n) : null;
  }
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub = (a,b) => a.map((x,i) => x-b[i]);

  function faceNormal(points, fail) {
    // Work relative to a corner so a small object far from the origin keeps its precision.
    const local = points.map(p => sub(p, points[0]));
    let span = 0;
    for (const p of local) span = Math.max(span, ...p.map(Math.abs));
    if (!span) fail("La cara tiene área nula.");
    for (const p of local) for (let k=0; k<3; ++k) p[k] /= span;
    const area = [0,0,0];
    for (let i=1; i+1<local.length; ++i) {
      const n = cross(local[i],local[i+1]);
      for (let k=0; k<3; ++k) area[k] += n[k];
    }
    const n = unit(area);
    if (!n || Math.hypot(...area)<1e-13) fail("La cara tiene área nula.");
    if (local.length>3) {
      if (local.some(v => Math.abs(dot(n,v))>1e-6)) fail("Triangula la cara no plana antes de importarla.");
      // Strict half planes exclude crossed loops, concave corners and overlapping edges.
      for (let i=0; i<local.length; ++i) {
        const end=(i+1)%local.length, edge=sub(local[end],local[i]);
        for (let j=0; j<local.length; ++j) {
          if (j===i || j===end) continue;
          if (dot(n,cross(edge,sub(local[j],local[i])))<=1e-13)
            fail("Triangula las caras cóncavas o con esquinas alineadas antes de importarlas.");
        }
      }
    }
    return {normal:n, area:area.map(x => x*span*span)};
  }

  function read(bytes, collectSurfaces) {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length>limits.bytes)
      throw Error("Elige un OBJ de texto de hasta 6 MiB.");
    let text;
    try { text = new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/\r\n?/g,"\n"); }
    catch { throw Error("El archivo OBJ debe estar codificado en UTF-8."); }
    const positions=[], normals=[], faces=[], smoothNormals=new Map();
    const low=[Infinity,Infinity,Infinity], high=[-Infinity,-Infinity,-Infinity];
    let texcoords=0, group="", triangles=0, work=0, line=0, surface=null;
    const ranges=[], encoder=new TextEncoder();
    function fail(message) { throw Error("OBJ, línea "+line+". "+message); }
    function number(token) {
      const v=Number(token);
      if (!decimal.test(token) || !Number.isFinite(v) || Math.abs(v)>1e12) fail("Coordenada fuera de rango.");
      return v;
    }
    function index(token,count) {
      if (!/^[+-]?\d+$/.test(token)) fail("Índice de cara inválido.");
      const n=Number(token), i=n<0 ? count+n : n-1;
      if (!Number.isSafeInteger(i) || !n || i<0 || i>=count) fail("La cara apunta a un vértice, UV o normal inexistente.");
      return i;
    }
    for (let start=0; start<text.length;) {
      ++line;
      const end=text.indexOf("\n",start), stop=end<0 ? text.length : end;
      if (line>limits.lines || stop-start>limits.lineLength) fail("El archivo supera el límite de líneas o de longitud por línea.");
      const source=text.slice(start,stop).split("#",1)[0].trim();
      start=stop+1;
      if (!source) continue;
      const [kind,...words]=source.split(/\s+/u);
      if (kind==="v" || kind==="vn" || kind==="vt") {
        const cap=kind==="v" ? positions.length : kind==="vn" ? normals.length : texcoords;
        if (cap>=limits.attributes) fail("Hay demasiados atributos de vértice.");
        if (kind==="vt") {
          if (words.length<1 || words.length>3) fail("La coordenada UV necesita entre uno y tres valores.");
          words.forEach(number); ++texcoords; continue;
        }
        if (words.length!==3 && !(kind==="v" && words.length===4)) fail("Se esperaban tres coordenadas.");
        const values=words.map(number);
        if (kind==="vn") {
          const n=unit(values);
          if (!n) fail("Una normal tiene longitud cero.");
          normals.push(n);
        } else {
          const w=values[3]??1;
          if (!w) fail("La coordenada homogénea no puede ser cero.");
          const p=values.slice(0,3).map(x => x/w);
          if (p.some(x => !Number.isFinite(x) || Math.abs(x)>1e12)) fail("Posición fuera de rango.");
          positions.push(p);
        }
        continue;
      }
      if (kind==="s") {
        if (words.length!==1 || words[0].length>48) fail("Grupo de suavizado inválido.");
        group=words[0]==="off" || words[0]==="0" ? "" : words[0]==="on" ? "1" : words[0];
        continue;
      }
      if (kind==="usemtl") {
        if (collectSurfaces) {
          surface=source.slice(kind.length).trim();
          if (!surface || /[\u0000-\u001f\u007f-\u009f]/u.test(surface) || encoder.encode(surface).length>limits.surfaceNameBytes)
            fail("El nombre de la superficie debe tener entre 1 y 160 bytes UTF-8.");
        }
        continue;
      }
      if (["g","o","mtllib"].includes(kind)) continue;
      if (kind!=="f") fail("Directiva no admitida en una malla estática: "+kind.slice(0,30));
      if (words.length<3 || words.length>limits.faceCorners) fail("Una cara debe tener entre 3 y 64 esquinas.");
      work+=words.length*words.length;
      if (work>limits.polygonWork || triangles+words.length-2>limits.triangles) fail("La malla supera el presupuesto de importación.");
      const corners=words.map(word => {
        const parts=word.split("/");
        if (parts.length>3 || (parts.length>1 && !parts.at(-1))) fail("Esquina de cara inválida.");
        const p=index(parts[0],positions.length);
        if (parts[1]) index(parts[1],texcoords);
        return {p,n:parts[2] ? index(parts[2],normals.length) : -1};
      });
      const points=corners.map(c => positions[c.p]), face=faceNormal(points,fail);
      for (const c of corners) {
        const v=positions[c.p];
        for (let k=0; k<3; ++k) {low[k]=Math.min(low[k],v[k]);high[k]=Math.max(high[k],v[k]);}
        if (group) {
          const key=c.p+"/"+group, sum=smoothNormals.get(key)??[0,0,0];
          for (let k=0; k<3; ++k) sum[k]+=face.area[k];
          smoothNormals.set(key,sum);
        }
      }
      const count=corners.length-2;
      if (collectSurfaces) {
        const last=ranges[ranges.length-1];
        if (last && last.surface===surface) last.count+=count;
        else {
          if (ranges.length>=limits.surfaceRanges) fail("La malla supera 4096 tramos de superficies.");
          ranges.push({first:triangles,count,surface});
        }
      }
      triangles+=count;
      faces.push({corners,group,normal:face.normal});
    }
    if (!triangles) throw Error("El OBJ no contiene caras.");
    const extent=high.map((x,i) => x-low[i]);
    if (extent.some(x => x>10000)) throw Error("El modelo supera los 10 000 metros por eje. Expórtalo en metros.");
    const size=extent.map(x => Math.max(.0001,x));
    const vertexMap=new Map(), vertices=[], indices=[];
    for (let f=0; f<faces.length; ++f) {
      const face=faces[f];
      const polygon=face.corners.map(({p,n}) => {
        const smoothKey=p+"/"+face.group;
        const key=p+"|"+(n>=0 ? "n"+n : face.group ? "s"+face.group : "f"+f);
        if (vertexMap.has(key)) return vertexMap.get(key);
        const authored=n>=0 ? normals[n] : (face.group && unit(smoothNormals.get(smoothKey))) || face.normal;
        // The renderer applies the inverse transpose of instance scale to these local normals.
        const normal=unit(authored.map((x,i) => x*size[i]));
        const coord=positions[p].map((x,i) => ((x-low[i])-extent[i]/2)/size[i]);
        const id=vertices.length/6;
        vertices.push(...coord,...normal); vertexMap.set(key,id); return id;
      });
      for (let i=1; i+1<polygon.length; ++i) indices.push(polygon[0],polygon[i],polygon[i+1]);
    }
    const buffer=new ArrayBuffer(headerBytes+vertices.length*4+indices.length*4), view=new DataView(buffer);
    new Uint8Array(buffer).set(new TextEncoder().encode(header));
    view.setUint32(8,vertices.length/6,true); view.setUint32(12,indices.length,true);
    size.forEach((x,i) => view.setFloat64(16+i*8,x,true));
    vertices.forEach((x,i) => view.setFloat32(headerBytes+i*4,x===0 ? 0 : x,true));
    const first=headerBytes+vertices.length*4;
    indices.forEach((x,i) => view.setUint32(first+i*4,x,true));
    const geometry=new Uint8Array(buffer);
    if (!collectSurfaces) return geometry;
    return {bytes:geometry,ranges:ranges.length===1 && ranges[0].surface===null ? [] : ranges};
  }

  return Object.freeze({limits,cook:bytes=>read(bytes,false),withSurfaces:bytes=>read(bytes,true)});
})();
