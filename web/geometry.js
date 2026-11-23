"use strict";
window.MundoGeometry = (() => {
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  function unit(v) { const n=Math.hypot(...v)||1; return v.map(x=>x/n); }
  function multiply(a,b) {
    const out=new Array(16);
    for(let c=0;c<4;c++) for(let r=0;r<4;r++)
      out[4*c+r]=a[r]*b[4*c]+a[4+r]*b[4*c+1]+a[8+r]*b[4*c+2]+a[12+r]*b[4*c+3];
    return out;
  }
  function local(n) {
    const norm=Math.hypot(...n.q), [x,y,z,w]=n.q.map(a=>a/norm), [sx,sy,sz]=n.s;
    return [(1-2*(y*y+z*z))*sx,2*(x*y+z*w)*sx,2*(x*z-y*w)*sx,0,
      2*(x*y-z*w)*sy,(1-2*(x*x+z*z))*sy,2*(y*z+x*w)*sy,0,
      2*(x*z+y*w)*sz,2*(y*z-x*w)*sz,(1-2*(x*x+y*y))*sz,0,...n.p,1];
  }
  function flatten(world) {
    const kids=new Map(), objects=[], byId=new Map();
    for(const n of world.nodes.values()) {
      if(!kids.has(n.parent)) kids.set(n.parent,[]);
      kids.get(n.parent).push(n);
    }
    const pending=[{id:0n,m:identity}];
    while(pending.length) {
      const parent=pending.pop();
      for(const n of kids.get(parent.id)||[]) {
        const m=multiply(parent.m,local(n));
        if(!m.every(Number.isFinite)) continue;
        pending.push({id:n.id,m});
        const extent=[0,1,2].map(i=>(Math.abs(m[i])+Math.abs(m[4+i])+Math.abs(m[8+i]))*.5);
        const entry={n,m,center:m.slice(12,15),extent,radius:Math.hypot(...extent)};
        byId.set(n.id,entry);
        if((n.shape || n.visual) && m.every(x=>Math.abs(x)<=1e19)) objects.push(entry);
      }
    }
    return {objects,byId};
  }
  function camera(eye,target,aspect,fov) {
    const forward=unit(target.map((v,i)=>v-eye[i]));
    let right=unit(cross(forward,[0,1,0]));
    if(Math.hypot(...right)<.01) right=[1,0,0];
    const up=unit(cross(right,forward));
    const ty=Math.tan(fov*Math.PI/360), tx=ty*aspect, near=.08,far=3000;
    const view=[right[0],up[0],-forward[0],0,right[1],up[1],-forward[1],0,right[2],up[2],-forward[2],0,0,0,0,1];
    const projection=[1/tx,0,0,0,0,1/ty,0,0,0,0,-(far+near)/(far-near),-1,0,0,-2*far*near/(far-near),0];
    return {eye,forward,right,up,tx,ty,near,far,matrix:new Float32Array(multiply(projection,view))};
  }
  function rayHit(entries,cam,x,y) {
    const ray=unit(cam.forward.map((v,i)=>v+x*cam.tx*cam.right[i]+y*cam.ty*cam.up[i]));
    let best=Infinity, entry=null;
    for(const o of entries) {
      let low=0, high=best;
      for(let i=0;i<3 && low<=high;i++) {
        const origin=cam.eye[i]-o.center[i], radius=o.extent[i];
        if(Math.abs(ray[i])<1e-9) { if(Math.abs(origin)>radius) high=-1; continue; }
        const a=(-radius-origin)/ray[i], b=(radius-origin)/ray[i];
        low=Math.max(low,Math.min(a,b)); high=Math.min(high,Math.max(a,b));
      }
      if(low<=high && high>=0 && low<best) {best=low; entry=o;}
    }
    return entry ? {entry, point:cam.eye.map((origin,i)=>origin+best*ray[i])} : null;
  }
  function rayPick(entries,cam,x,y) {
    return rayHit(entries,cam,x,y)?.entry.n.id ?? null;
  }
  // Cast against the displayed mesh. The transformed local direction is deliberately
  // unnormalised so a triangle's ray parameter remains a world-space distance.
  function meshSurface(o,vertices,eye,ray,near,far) {
    let lo=near,hi=far;
    for(let i=0;i<3;i++){
      const d=eye[i]-o.center[i],r=o.extent[i];
      if(ray[i]===0){if(Math.abs(d)>r)return null;continue;}
      const a=(-r-d)/ray[i],b=(r-d)/ray[i];
      lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
      if(lo>hi)return null;
    }
    const m=o.drawMatrix??o.m;
    const x=m.slice(0,3),y=m.slice(4,7),z=m.slice(8,11);
    const rows=[cross(y,z),cross(z,x),cross(x,y)],det=dot(x,rows[0]);
    if(!Number.isFinite(det)||det===0)return null;
    const offset=eye.map((n,i)=>n-o.center[i]);
    const [ox,oy,oz]=rows.map(row=>dot(row,offset)/det);
    const [dx,dy,dz]=rows.map(row=>dot(row,ray)/det);
    let hit=null;
    for(let i=0;i<vertices.length;i+=33){
      const ax=vertices[i],ay=vertices[i+1],az=vertices[i+2];
      const bx=vertices[i+11]-ax,by=vertices[i+12]-ay,bz=vertices[i+13]-az;
      const cx=vertices[i+22]-ax,cy=vertices[i+23]-ay,cz=vertices[i+24]-az;
      const px=dy*cz-dz*cy,py=dz*cx-dx*cz,pz=dx*cy-dy*cx;
      const divisor=bx*px+by*py+bz*pz;
      if(!divisor)continue;
      const tx=ox-ax,ty=oy-ay,tz=oz-az;
      const u=(tx*px+ty*py+tz*pz)/divisor;
      if(u<0||u>1)continue;
      const qx=ty*bz-tz*by,qy=tz*bx-tx*bz,qz=tx*by-ty*bx;
      const v=(dx*qx+dy*qy+dz*qz)/divisor;
      if(v<0||u+v>1)continue;
      const t=(cx*qx+cy*qy+cz*qz)/divisor;
      if(!(t>=near&&t<far))continue;
      far=t;
      // Cofactor rows transform the face normal, including scaled or skewed parents.
      const nx=by*cz-bz*cy,ny=bz*cx-bx*cz,nz=bx*cy-by*cx;
      const normal=[0,1,2].map(k=>nx*rows[0][k]+ny*rows[1][k]+nz*rows[2][k]);
      const point=eye.map((value,k)=>value+t*ray[k]);
      const top=o.center[1]+o.extent[1];
      const flat=Math.hypot(normal[0],normal[2])<=Math.abs(normal[1])*1e-7;
      // A mesh may have a shelf below the top of its walking proxy.
      const placeable=o.n.shape && ray[1]<0 && flat && Math.abs(point[1]-top)<=.001;
      hit={distance:t,feet:placeable?[point[0],top,point[2]]:null};
    }
    return hit;
  }
  const plain=[1,1,1,-1,0];
  function primitive(shape,segments) {
    const values=[];
    function vertex(p,n) {values.push(...p,...n,...plain);}
    if(shape===1) {
      const points=[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
      for(const face of [[3,2,1,0],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4]]) {
        const [a,b,c]=face.map(i=>points[i]);
        const n=unit(cross(b.map((p,i)=>p-a[i]),c.map((p,i)=>p-a[i])));
        for(const j of [0,1,2,0,2,3]) vertex(points[face[j]],n);
      }
    } else if(shape===2) {
      function circle(i){const a=2*Math.PI*i/segments;return [Math.cos(a),0,Math.sin(a)];}
      for(let i=0;i<segments;i++) {
        const a=circle(i),b=circle(i+1);
        for(const [d,y] of [[a,-.5],[a,.5],[b,-.5],[b,-.5],[a,.5],[b,.5]]) vertex([d[0]/2,y,d[2]/2],d);
        for(const sign of [-1,1]) {
          vertex([0,sign*.5,0],[0,sign,0]);
          for(const d of sign>0?[b,a]:[a,b]) vertex([d[0]/2,sign*.5,d[2]/2],[0,sign,0]);
        }
      }
    } else {
      const rows=Math.max(4,segments/2);
      const sphere=(r,c)=>{const p=Math.PI*r/rows,a=2*Math.PI*c/segments;return [Math.sin(p)*Math.cos(a),Math.cos(p),Math.sin(p)*Math.sin(a)];};
      const put=(r,c)=>{const n=sphere(r,c);vertex(n.map(x=>x*.5),n);};
      for(let r=0;r<rows;r++) for(let c=0;c<segments;c++) {
        if(r>0){put(r,c);put(r,c+1);put(r+1,c);}
        if(r+1<rows){put(r,c+1);put(r+1,c+1);put(r+1,c);}
      }
    }
    return new Float32Array(values);
  }
  // Worlds refer to art by key. Only edition-owned catalogs reach this decoder.
  function readCatalog(bytes, expectedStyle) {
    const reject=()=>{throw new Error("Catálogo de apariencias inválido o demasiado grande.");};
    if(bytes.length<13 || bytes.length>64*1024*1024 ||
       String.fromCharCode(...bytes.subarray(0,8))!=="MWLOOK01" || bytes[8]!==expectedStyle) reject();
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), result=new Map();
    let at=9, expanded=0;
    function take(n) {const start=at;at+=n;if(at>bytes.length)reject();return start;}
    const u32=()=>v.getUint32(take(4),true);
    const f32=()=>v.getFloat32(take(4),true);
    const count=u32();
    if(!count||count>2048)reject();
    for(let m=0;m<count;m++) {
      const key=v.getBigUint64(take(8),true), levels=[];
      if(!key||result.has(key))reject();
      for(let level=0;level<3;level++) {
        const nv=u32(),ni=u32(),ns=u32();
        expanded+=ni*44;
        if(nv<3||nv>250000||ni<3||ni>750000||ni%3||!ns||ns>64||
           nv*24+ni*4+ns*28>bytes.length-at||expanded>128*1024*1024)reject();
        const verts=new Float32Array(nv*6),indices=new Uint32Array(ni);
        for(let i=0;i<verts.length;i++){
          const value=f32();
          if(!Number.isFinite(value)||(i%6<3 && Math.abs(value)>.5))reject();
          verts[i]=value;
        }
        for(let i=0;i<ni;i++){indices[i]=u32();if(indices[i]>=nv)reject();}
        const out=new Float32Array(ni*11);
        let next=0;
        for(let i=0;i<ns;i++) {
          const first=u32(),length=u32(), material=[f32(),f32(),f32(),f32(),f32()];
          if(first!==next||!length||length%3||length>ni-first||!material.every(x=>x>=0&&x<=1))reject();
          next+=length;
          for(let p=first;p<next;p++) {
            const start=indices[p]*6;
            out.set(verts.subarray(start,start+6),p*11);out.set(material,p*11+6);
          }
        }
        if(next!==ni)reject();
        levels.push(out);
      }
      result.set(key,levels);
    }
    if(at!==bytes.length)reject();
    return result;
  }
  const blockCatalog=bytes=>readCatalog(bytes,0);
  return Object.freeze({dot,cross,unit,flatten,camera,rayHit,rayPick,meshSurface,primitive,blockCatalog,readCatalog});
})();
