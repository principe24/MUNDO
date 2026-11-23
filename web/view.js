"use strict";
window.MundoView=(() => {
  const G=MundoGeometry, W=MundoWorld;
  const mobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1) || navigator.userAgentData?.mobile===true;
  const family=mobile?"mobile":"pc", key="mundo.local.video.1."+family;
  const defaults=()=>({resolution:0,cap:0,detail:"auto"});
  function validSettings(s) {
    return s && [0,720,1080,1440,2160,4320].includes(s.resolution) && Number.isInteger(s.cap) &&
      s.cap>=0 && s.cap<=10000 && ["auto","economy","balanced","ultra"].includes(s.detail);
  }
  function preferences() {
    try {const s=JSON.parse(localStorage.getItem(key));if(validSettings(s)) return s;} catch {}
    return defaults();
  }
  function save(p) {try {localStorage.setItem(key,JSON.stringify(p));return true;} catch {return false;}}
  const vertexShader = '#version 300 es\n'+
  'layout(location=0) in vec3 p; layout(location=1) in vec3 normal; layout(location=2) in vec3 artColor; layout(location=3) in vec2 artSurface;\n'+
  'layout(location=4) in mat4 model; layout(location=8) in vec4 colorRough; layout(location=9) in vec2 flags;\n'+
  'uniform mat4 camera; uniform bool instancePaint; out vec3 N; out vec3 V; out vec3 tint; out vec2 surface;\n'+
  'void main(){vec4 pos=model*vec4(p,1.); gl_Position=camera*pos; mat3 m=mat3(model);'+
  'N=mat3(cross(m[1],m[2]),cross(m[2],m[0]),cross(m[0],m[1]))*normal; V=-pos.xyz;'+
  'bool art=artSurface.x>=0.; vec3 paint=instancePaint?artColor*colorRough.rgb:artColor; tint=mix(art?paint:colorRough.rgb,vec3(1.,.52,.16),flags.y*.42);'+
  'surface=art?artSurface:vec2(colorRough.w,flags.x);}';
  const fragmentShader = '#version 300 es\nprecision highp float; in vec3 N; in vec3 V; in vec3 tint; in vec2 surface; out vec4 outColor;\n'+
  'void main(){vec3 n=normalize(N);vec3 light=normalize(vec3(-.45,.88,.37));vec3 v=normalize(V);float nl=max(dot(n,light),0.);'+
  'vec3 h=normalize(light+v);float rough=clamp(surface.x,.06,1.),metal=clamp(surface.y,0.,1.);'+
  'vec3 sky=mix(vec3(.23,.22,.20),vec3(.61,.72,.80),n.y*.5+.5);'+
  'vec3 diffuse=tint*(sky+vec3(1.,.91,.75)*nl*.90)*(1.-metal*.64);'+
  'float highlight=pow(max(dot(n,h),0.),mix(130.,5.,rough))*nl;vec3 color=diffuse+mix(vec3(.08),tint,metal)*highlight;'+
  'float fog=1.-exp(-length(V)*.004);color=mix(color,vec3(.58,.74,.80),fog);'+
  'outColor=vec4(pow(clamp(color,0.,1.),vec3(1./2.2)),1.);}';

  function makeProgram(gl) {
    function compile(kind,text) {
      const s=gl.createShader(kind); gl.shaderSource(s,text); gl.compileShader(s);
      if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) {gl.deleteShader(s);throw new Error("El dispositivo no pudo preparar los materiales del visor.");}
      return s;
    }
    const program=gl.createProgram(), vs=compile(gl.VERTEX_SHADER,vertexShader),fs=compile(gl.FRAGMENT_SHADER,fragmentShader);
    gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){gl.deleteProgram(program);throw new Error("Material gráfico incompatible.");}
    return program;
  }
  class View {
    constructor(canvas,onStats,onError) {
      this.canvas=canvas;this.onStats=onStats;this.onError=onError;this.settings=preferences();
      this.scene={objects:[],byId:new Map()};this.selected=null;this.look={eye:[24,19,30],target:[0,1,0]};
      this.scale=mobile ? .8 : 1;this.fast=0;this.slow=0;this.levels=new Map();
      this.timer=0;this.previous=0;this.deadline=0;this.lastDraw=0;this.reportTime=0;this.frames=0;
      this.periods=[];this.refresh=16.67;this.slowerSince=0;this.gpuReady=false;
      this.catalog=G.blockCatalog(W.from64(MundoPublic.look));
      canvas.addEventListener("webglcontextlost", e=>{e.preventDefault();this.gpuReady=false;this.peopleLayer?.contextLost();this.fallback();});
      canvas.addEventListener("webglcontextrestored",()=>{try{this.init();this.peopleLayer?.contextRestored();this.onError("");}catch(e){this.onError(e.message);}});
      try{this.init();}catch(e){this.fallback(e.message);}
      document.addEventListener("visibilitychange",()=>{this.previous=0;});
      this.step=this.step.bind(this);
      this.timer=requestAnimationFrame(this.step);
    }
    init() {
      const gl=this.canvas.getContext("webgl2",{antialias:false,alpha:false,powerPreference:mobile?"default":"high-performance"});
      if(!gl) throw new Error("El visor 3D requiere WebGL 2. Puedes seguir editando y guardando el archivo.");
      this.gl=gl;this.program=makeProgram(gl);this.cameraUniform=gl.getUniformLocation(this.program,"camera");
      this.paintUniform=gl.getUniformLocation(this.program,"instancePaint");
      this.meshes=new Map();this.groups=new Map();
      this.clearSurfaceMaterials();
      this.viewportMax=gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      this.bufferMax=Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE),gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      gl.enable(gl.DEPTH_TEST);gl.clearColor(.78,.87,.90,1);this.gpuReady=true;
      this.reportTime=this.frames=0;
      if(this.mapCanvas)this.mapCanvas.hidden=true;
    }
    fallback(reason) {
      this.mapProjection=null;this.reportTime=this.frames=0;
      if(!this.mapCanvas) {
        this.mapCanvas=document.createElement("canvas");this.mapCanvas.className="fallback-map";
        this.mapCanvas.setAttribute("aria-hidden","true");this.canvas.after(this.mapCanvas);
        this.mapBrush=this.mapCanvas.getContext("2d");
      }
      this.mapCanvas.hidden=false;
      this.onError(this.mapBrush?"Vista ligera 2D activa.":reason||"El dispositivo no pudo abrir el visor.");
    }
    drawMap(time,dt) {
      if(!this.mapBrush)return;
      const c=this.mapCanvas,w=Math.max(1,this.canvas.clientWidth),h=Math.max(1,this.canvas.clientHeight);
      const [rw,rh]=this.renderSize(7680,7680);
      if(c.width!==rw || c.height!==rh){c.width=rw;c.height=rh;}
      this.mapBrush.setTransform(rw/w,0,0,rh/h,0,0);
      const brush=this.mapBrush,eye=this.look.eye,target=this.look.target;
      const radius=this.onMove?18:Math.max(3,Math.hypot(...eye.map((x,i)=>x-target[i]))*.53);
      const center=this.onMove?eye:target, scale=Math.min(w,h)/(2*radius);
      const x=point=>(point-center[0])*scale+w/2, z=point=>(point-center[2])*scale+h/2;
      brush.fillStyle="#bccdba";brush.fillRect(0,0,w,h);
      const shapes=[];
      for(const o of this.scene.objects){
        if(shapes.length>=5000)break;
        const [cx,,cz]=o.center,[sx,,sz]=o.extent;
        if(x(cx+sx)<0||x(cx-sx)>w||z(cz+sz)<0||z(cz-sz)>h)continue;
        shapes.push(o);
      }
      shapes.sort((a,b)=>(a.center[1]+a.extent[1])-(b.center[1]+b.extent[1]));
      this.mapShapes=shapes;
      for(const o of shapes){
        const cx=x(o.center[0]),cz=z(o.center[2]),sx=Math.max(1,o.extent[0]*scale),sz=Math.max(1,o.extent[2]*scale);
        brush.fillStyle=o.n.id===this.selected?"#f2a756":W.toHex(o.n.color);
        if(o.n.shape>=2){brush.beginPath();brush.ellipse(cx,cz,sx,sz,0,0,Math.PI*2);brush.fill();}
        else brush.fillRect(cx-sx,cz-sz,2*sx,2*sz);
      }
      for(const [i,feet] of (this.seatMarkers||[]).entries()){
        brush.fillStyle=i===0?"#026c68":"#923d10";brush.beginPath();
        brush.arc(x(feet[0]),z(feet[2]),Math.max(4,scale*.23),0,Math.PI*2);brush.fill();
      }
      if(this.startGrid){
        const {point,yaw}=this.startGrid;
        brush.save();brush.translate(x(point[0]),z(point[2]));brush.rotate(yaw);
        brush.strokeStyle="#473709";brush.fillStyle="#ffbf28";brush.lineWidth=1.5;
        brush.beginPath();brush.moveTo(0,-10);brush.lineTo(6,-2);brush.lineTo(2,-2);
        brush.lineTo(2,8);brush.lineTo(-2,8);brush.lineTo(-2,-2);brush.lineTo(-6,-2);
        brush.closePath();brush.fill();brush.stroke();brush.restore();
      }
      for(const feet of this.npcPositions||[]){
        brush.fillStyle="#7554bb";brush.beginPath();
        brush.arc(x(feet[0]),z(feet[2]),4,0,Math.PI*2);brush.fill();
      }
      if(this.peerPosition){
        brush.fillStyle="#dd753b";brush.beginPath();
        brush.arc(x(this.peerPosition[0]),z(this.peerPosition[2]),5,0,Math.PI*2);brush.fill();
      }
      if(this.onMove){
        const cx=x(eye[0]),cy=z(eye[2]),angle=Math.atan2(target[2]-eye[2],target[0]-eye[0]);
        brush.save();brush.translate(cx,cy);brush.rotate(angle);brush.fillStyle="#193a3c";brush.beginPath();
        brush.moveTo(10,0);brush.lineTo(-6,5);brush.lineTo(-4,0);brush.lineTo(-6,-5);brush.closePath();brush.fill();brush.restore();
      }
      this.mapProjection={center:center.slice(),scale,w,h,scene:this.scene};
      this.reportFrame(time,rw,rh,"2D");this.adjustScale(dt);
    }
    setWorld(world) {
      this.scene=G.flatten(world);this.levels.clear();
      if (this.creatorSurfaceModels) this.clearSurfaceMaterials();
    }
    setCreatorSurfaceModels(records) {
      if (this.creatorSurfaceModels===records) return;
      this.clearSurfaceMaterials();
      this.creatorSurfaceModels=records;
    }
    clearSurfaceMaterials() {
      if (this.gpuReady && this.surfaceLayouts) {
        for (const layout of this.surfaceLayouts.values()) if (layout.buffer) this.gl.deleteBuffer(layout.buffer);
      }
      this.surfaceLayouts=new Map();
      this.surfaceFinishes=new Map();
      this.nodeFinishes=new WeakMap();
      if (this.groups) for (const [name,group] of this.groups) if (group.finish) this.groups.delete(name);
    }
    surfaceMaterial(node,mesh) {
      if (!this.creatorSurfaceModels || !node.components?.length) return null;
      if (this.nodeFinishes.has(node)) return this.nodeFinishes.get(node);
      let finish=null;
      const info=this.creatorSurfaceModels.get(node.visual.toString(16));
      if (info && mesh.count===3*info.triangles) {
        // Future versions or stale local layouts still use the base material.
        let material;
        try { material=MundoCreatorSurfaceMaterials.get(node); } catch {}
        const layout=material && material.digest===info.digest && info.surfaceLayouts.find(l=>l.id===material.layoutId);
        if (layout && material.overrides.length) {
          const identity=JSON.stringify([material.digest,layout.id,material.overrides]);
          finish=this.surfaceFinishes.get(identity);
          if (!finish) {
            let shared=this.surfaceLayouts.get(layout);
            if (!shared) {
              const gl=this.gl, {groups,indices}=MundoCreatorMesh.surfaceIndex(layout,info.triangles);
              shared={groups,buffer:null,stride:0,type:0};
              if (indices) {
                shared.buffer=gl.createBuffer();
                if (!shared.buffer) return null;
                shared.stride=indices.BYTES_PER_ELEMENT;
                shared.type=shared.stride===2 ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
                gl.bindVertexArray(null);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,shared.buffer);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,null);
              }
              this.surfaceLayouts.set(layout,shared);
            }
            const overrides=new Map(material.overrides.map(row=>[row.surface,row]));
            const passes=[];
            for (const group of shared.groups) {
              const row=overrides.get(group.surface), last=passes[passes.length-1];
              if (last && last.color===row?.color && last.rough===row?.rough) last.count+=group.count;
              else passes.push({first:group.first,count:group.count,color:row?.color,
                rgb:row?.color ? W.fromHex(row.color) : null,rough:row?.rough});
              overrides.delete(group.surface);
            }
            if (!overrides.size) {
              finish={id:this.surfaceFinishes.size,shared,passes};
              this.surfaceFinishes.set(identity,finish);
            }
          }
        }
      }
      this.nodeFinishes.set(node,finish);
      return finish;
    }
    setCatalog(next) {
      if(next===this.catalog)return;
      if (this.creatorSurfaceModels) this.clearSurfaceMaterials();
      // Primitive meshes are shared. A visual key may now point to different vertices.
      if(this.gpuReady){
        for(const [key,mesh] of this.meshes){
          if(!key.startsWith("v") || next.get(mesh.visual)?.[mesh.lod]===mesh.vertices)continue;
          this.gl.deleteVertexArray(mesh.vao);
          this.gl.deleteBuffer(mesh.vertex);
          this.gl.deleteBuffer(mesh.instance);
          this.meshes.delete(key);
          this.groups.delete(key);
        }
      }
      this.catalog=next;
      this.levels.clear();
    }
    applySettings(s) {
      if(!validSettings(s)) throw new Error("El límite de FPS debe ser un entero entre 0 y 10000.");
      this.settings={...s};this.fast=this.slow=this.deadline=0;
      return save(s);
    }
    renderSize(maxWidth,maxHeight) {
      const c=this.canvas, dpr=window.devicePixelRatio||1;
      const w=Math.max(1,Math.round(c.clientWidth*dpr)),h=Math.max(1,Math.round(c.clientHeight*dpr));
      const short=this.settings.resolution||4320, long=Math.round(short*16/9);
      let ratio=Math.min(1,long/Math.max(w,h),short/Math.min(w,h),maxWidth/w,maxHeight/h);
      if(this.settings.detail==="auto") ratio*=this.scale;
      return [Math.max(1,Math.floor(w*ratio)),Math.max(1,Math.floor(h*ratio))];
    }
    resize() {
      const c=this.canvas;
      const [rw,rh]=this.renderSize(Math.min(this.viewportMax[0],this.bufferMax),Math.min(this.viewportMax[1],this.bufferMax));
      if(c.width!==rw||c.height!==rh){c.width=rw;c.height=rh;}
    }
    videoDimensions() {
      const c=this.canvas,dpr=window.devicePixelRatio||1;
      const w=this.gpuReady?this.gl.drawingBufferWidth:this.mapProjection?this.mapCanvas.width:0;
      const h=this.gpuReady?this.gl.drawingBufferHeight:this.mapProjection?this.mapCanvas.height:0;
      if(!w || !h)return "Dimensiones disponibles después del primer cuadro.";
      return "Área del juego "+Math.round(c.clientWidth*dpr)+" × "+Math.round(c.clientHeight*dpr)+
        " px · "+(this.gpuReady?"Búfer 3D ":"Lienzo 2D ")+w+" × "+h+" px.";
    }
    reportFrame(time,width,height,mode,drawn,triangles,calls) {
      if(!this.reportTime){this.reportTime=time;this.frames=0;return;}
      ++this.frames;
      const elapsed=time-this.reportTime;
      if(elapsed<800)return;
      this.onStats({fps:Math.round(this.frames*1000/elapsed),width,height,mode,drawn,triangles,calls});
      this.frames=0;this.reportTime=time;
    }
    mesh(key,node,lod,visual=node.visual) {
      if(this.meshes.has(key)) return this.meshes.get(key);
      const gl=this.gl,vertices=this.catalog.get(visual)?.[lod] || G.primitive(node.shape,[8,16,32][lod]);
      const mesh={vertices,visual,lod,vao:gl.createVertexArray(),vertex:gl.createBuffer(),instance:gl.createBuffer(),count:vertices.length/11,capacity:0};
      gl.bindVertexArray(mesh.vao);gl.bindBuffer(gl.ARRAY_BUFFER,mesh.vertex);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
      for(const [loc,size,offset] of [[0,3,0],[1,3,3],[2,3,6],[3,2,9]]) {
        gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,44,offset*4);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER,mesh.instance);
      for(const [loc,size,off] of [[4,4,0],[5,4,4],[6,4,8],[7,4,12],[8,4,16],[9,2,20]]){
        gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,88,off*4);gl.vertexAttribDivisor(loc,1);
      }
      gl.bindVertexArray(null);this.meshes.set(key,mesh);return mesh;
    }
    draw(time,dt) {
      this.resize();
      const gl=this.gl, w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
      if(!w||!h) return;
      const cam=G.camera(this.look.eye,this.look.target,this.canvas.clientWidth/Math.max(1,this.canvas.clientHeight),55);
      this.camera=cam;
      gl.viewport(0,0,w,h);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      const people=this.peopleLayer?.draw(gl,cam,this.actorParts,time,this.settings.detail);
      gl.useProgram(this.program);gl.uniformMatrix4fv(this.cameraUniform,false,cam.matrix);
      const ceiling=this.settings.detail==="economy"?0:this.settings.detail==="balanced"?1:2;
      const candidates=[];
      for(const objects of [this.scene.objects,this.actorParts||[]]) for(const o of objects) {
        if(people?.rigs.has(o.actorRig))continue;
        if(!o.n.shape && !this.catalog.has(o.n.visual)) continue;
        const d=o.center.map((x,i)=>x-cam.eye[i]),depth=G.dot(d,cam.forward),r=o.radius;
        if(depth+r<cam.near || depth-r>cam.far || Math.abs(G.dot(d,cam.right))>depth*cam.tx+r*Math.hypot(1,cam.tx) ||
          Math.abs(G.dot(d,cam.up))>depth*cam.ty+r*Math.hypot(1,cam.ty)) continue;
        const pixels=h*r/(cam.ty*Math.max(cam.near,depth-r)), old=this.levels.get(o.n.id);
        const lod=Math.min(ceiling,pixels>=(old===2?180:232)?2:pixels>=(old>=1?42:56)?1:0);
        candidates.push({o,depth:Math.max(0,depth-r),lod});
      }
      candidates.sort((a,b)=>a.depth-b.depth);
      for(const g of this.groups.values()) g.items.length=0;
      let drawn=people?.rigs.size??0,triangles=people?.triangles??0,calls=drawn;
      const maxObjects=mobile?4200:9500, maxTriangles=mobile?450000:1600000;
      for(const {o,lod} of candidates) {
        if(drawn>=maxObjects) break;
        const visual=o.appearanceKey??o.n.visual, authored=this.catalog.has(visual);
        const source=authored?this.catalog.get(visual):null;
        // Creator models with a single mesh share its GPU buffer at every projected size.
        const level=source?(source[lod]===source[0]?0:lod):o.n.shape===1?0:lod;
        const key=authored?(o.appearanceKey!==undefined?"vt":"v")+visual+"-"+level:o.n.shape+"-"+level;
        const mesh=this.mesh(key,o.n,level,visual);
        if(triangles+mesh.count/3>maxTriangles) continue;
        const finish=authored && o.appearanceKey===undefined ? this.surfaceMaterial(o.n,mesh) : null;
        const batch=finish ? key+"@"+finish.id : key;
        if(!this.groups.has(batch)) this.groups.set(batch,{mesh,finish,items:[],data:null});
        this.groups.get(batch).items.push(o);this.levels.set(o.n.id,lod);++drawn;triangles+=mesh.count/3;
      }
      for(const bucket of this.groups.values()) {
        const {mesh,items,finish}=bucket;if(!items.length) continue;
        if(!bucket.data || bucket.data.length<items.length*22) bucket.data=new Float32Array(22*2**Math.ceil(Math.log2(items.length)));
        const data=bucket.data;
        items.forEach((o,i)=>{
          const start=i*22;data.set(o.drawMatrix??o.m,start);
          for(let k=0;k<3;k++) data[start+12+k]=o.center[k]-cam.eye[k];
          data.set(o.n.color,start+16);data[start+19]=o.n.rough;data[start+20]=o.n.metal;data[start+21]=o.n.id===this.selected?1:0;
        });
        gl.bindVertexArray(mesh.vao);gl.bindBuffer(gl.ARRAY_BUFFER,mesh.instance);
        if(mesh.capacity<data.byteLength){gl.bufferData(gl.ARRAY_BUFFER,data.byteLength,gl.DYNAMIC_DRAW);mesh.capacity=data.byteLength;}
        const first=items[0],paint=first.appearanceKey!==undefined && !first.originalFinish && this.catalog.has(first.appearanceKey);
        gl.uniform1i(this.paintUniform,paint?1:0);
        if (!finish) {
          gl.bufferSubData(gl.ARRAY_BUFFER,0,data,0,items.length*22);
          gl.drawArraysInstanced(gl.TRIANGLES,0,mesh.count,items.length);++calls;
          continue;
        }
        const {shared,passes}=finish;
        if (shared.buffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,shared.buffer);
        for (const pass of passes) {
          items.forEach((o,i)=>{
            data.set(pass.rgb ?? o.n.color,i*22+16);
            data[i*22+19]=pass.rough ?? o.n.rough;
          });
          gl.bufferSubData(gl.ARRAY_BUFFER,0,data,0,items.length*22);
          if (shared.buffer) gl.drawElementsInstanced(gl.TRIANGLES,pass.count,shared.type,pass.first*shared.stride,items.length);
          else gl.drawArraysInstanced(gl.TRIANGLES,pass.first,pass.count,items.length);
          ++calls;
        }
        if (shared.buffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,null);
      }
      this.drawnScene=this.scene;
      gl.bindVertexArray(null);
      this.reportFrame(time,w,h,"",drawn,triangles,calls);this.adjustScale(dt);
    }
    adjustScale(dt) {
      if(this.settings.detail==="auto" && dt>0 && dt<250) {
        const target=this.settings.cap?Math.max(this.refresh,1000/this.settings.cap):this.refresh;
        if(dt>target*1.20){this.slow+=Math.min(dt,60);this.fast=0;}
        else if(dt<target*1.10){this.fast+=dt;this.slow=Math.max(0,this.slow-dt);}
        else{this.slow=Math.max(0,this.slow-dt*.5);this.fast=0;}
        if(this.slow>(mobile?520:360)){this.scale=Math.max(.4,this.scale-.08);this.slow=this.fast=0;}
        if(this.fast>(mobile?8500:5200)){this.scale=Math.min(1,this.scale+.05);this.slow=this.fast=0;}
      }
    }
    step(time) {
      this.timer=requestAnimationFrame(this.step);
      const elapsed=time-this.previous;
      if(document.hidden || !this.previous){this.previous=time;this.lastDraw=0;this.deadline=0;this.reportTime=0;this.frames=0;return;}
      this.previous=time;
      if(elapsed>=1 && elapsed<=50){
        this.periods.push(elapsed);
        if(this.periods.length===60){
          const periods=this.periods.sort((a,b)=>a-b);
          const measured=Math.max(1,periods[6]);
          if(measured<=this.refresh*1.12){this.refresh=measured;this.slowerSince=0;}
          else if(periods[45]<measured*1.12){
            if(!this.slowerSince)this.slowerSince=time;
            if(time-this.slowerSince>12000){this.refresh=measured;this.slowerSince=0;}
          } else this.slowerSince=0;
          this.periods=[];
        }
      }
      if(this.onMove) this.onMove(Math.min(.2,elapsed/1000));
      if(this.allowDraw && !this.allowDraw()){
        this.lastDraw=this.deadline=this.reportTime=this.frames=0;
        return;
      }
      const cap=this.settings.cap,interval=cap?1000/cap:0;
      if(interval && this.deadline>time+.4)return;
      if(interval)this.deadline=!this.deadline||time-this.deadline>=interval?time+interval:this.deadline+interval;
      const dt=this.lastDraw?time-this.lastDraw:0;this.lastDraw=time;
      if(this.gpuReady)this.draw(time,dt);else this.drawMap(time,dt);
    }
    mapHit(x,y) {
      const p=this.mapProjection;if(!p || p.scene!==this.scene)return null;
      const wx=p.center[0]+x*p.w/(2*p.scale),wz=p.center[2]-y*p.h/(2*p.scale);
      for(let i=this.mapShapes.length;i-->0;){
        const o=this.mapShapes[i];
        const sx=Math.max(1,o.extent[0]*p.scale),sz=Math.max(1,o.extent[2]*p.scale);
        const dx=(wx-o.center[0])*p.scale/sx,dz=(wz-o.center[2])*p.scale/sz;
        const inside=o.n.shape>=2?dx*dx+dz*dz<=1:Math.abs(dx)<=1&&Math.abs(dz)<=1;
        if(inside)return {entry:o,point:[wx,o.center[1]+o.extent[1],wz]};
      }
      return null;
    }
    pick(x,y) {
      if(this.gpuReady)return this.camera?G.rayPick(this.scene.objects,this.camera,x,y):null;
      return this.mapHit(x,y)?.entry.n.id ?? null;
    }
    pickFloor(x,y) {
      if(!this.gpuReady){
        const hit=this.mapHit(x,y);
        if(!hit || !hit.entry.n.shape)return null;
        const o=hit.entry,eye=[hit.point[0],hit.point[1]+1,hit.point[2]];
        const vertices=this.catalog.get(o.n.visual)?.[0] || G.primitive(o.n.shape,8);
        return G.meshSurface(o,vertices,eye,[0,-1,0],0,Infinity)?.feet??null;
      }
      const cam=this.camera;
      if(!cam || this.drawnScene!==this.scene)return null;
      const ray=G.unit(cam.forward.map((v,i)=>v+x*cam.tx*cam.right[i]+y*cam.ty*cam.up[i]));
      const forward=G.dot(ray,cam.forward),near=cam.near/forward;
      let far=cam.far/forward,feet=null;
      // Only instances submitted during the displayed frame can occlude a floor.
      for(const {mesh,items} of this.groups.values())for(const o of items){
        if(o.n.id<0n)continue; // The editor's seat markers are overlays.
        const hit=G.meshSurface(o,mesh.vertices,cam.eye,ray,near,far);
        if(hit){far=hit.distance;feet=hit.feet;}
      }
      return feet;
    }

  }
  return Object.freeze({View,family,mobile,defaults});
})();
