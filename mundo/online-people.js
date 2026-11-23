"use strict";
window.MundoPeople=(()=>{
  const knownDigest="c1a886790dcc6c5ebd355e8adf631774e03a5cd2fb7b5860c2547f5845feba28";
  const vertex=`#version 300 es
    layout(location=0) in vec3 position;
    layout(location=1) in vec3 normal;
    layout(location=2) in vec2 texcoord;
    layout(location=3) in vec4 joint;
    uniform mat4 camera, bones[16];
    uniform vec3 origin;
    out vec3 N;
    out vec3 relative;
    out vec2 uv;
    void main(){
      mat4 skin=bones[int(joint.x)]*(1.-joint.z/255.)+bones[int(joint.y)]*(joint.z/255.);
      relative=(skin*vec4(position,1.)).xyz+origin;
      N=mat3(skin)*normal;
      uv=texcoord;
      gl_Position=camera*vec4(relative,1.);
    }`;
  const fragment=`#version 300 es
    precision highp float;
    uniform sampler2D albedo;
    in vec3 N;
    in vec3 relative;
    in vec2 uv;
    out vec4 outColor;
    void main(){
      vec3 n=normalize(N),sun=normalize(vec3(-.45,.88,.37)),view=normalize(-relative);
      vec3 pigment=texture(albedo,uv).rgb;
      vec3 base=pow(pigment,vec3(2.2));
      vec3 sky=mix(vec3(.32,.30,.28),vec3(.67,.74,.82),n.y*.5+.5);
      vec3 color=base*(sky+vec3(1.,.91,.75)*max(dot(n,sun),0.)*.90);
      float rim=pow(1.-max(dot(n,view),0.),3.);
      float face=step(uv.x,.5)*step(uv.y,.39)*smoothstep(.015,.12,pigment.r-pigment.b);
      float cosine=dot(n,sun);
      float wrap=max((cosine+.28)/1.28,0.)-max(cosine,0.);
      color+=face*max(wrap,0.)*base*vec3(.48,.21,.13);
      color+=mix(vec3(.028,.025,.021),vec3(.055,.037,.03),face)*rim;
      color=mix(color,vec3(.58,.74,.80),1.-exp(-length(relative)*.004));
      outColor=vec4(pow(clamp(color,0.,1.),vec3(1./2.2)),1.);
    }`;

  function readMesh(buffer){
    const mesh=MundoPeopleRig.decode(buffer);
    if(!mesh.p.every(v=>Number.isFinite(v)&&Math.abs(v)<4) ||
       !mesh.uv.every(Number.isFinite) || mesh.idx.some(v=>v>=mesh.count)){
      throw Error("El modelo contiene geometría inválida.");
    }
    for(let i=0;i<mesh.j.length;i+=4){
      if(mesh.j[i]>=16||mesh.j[i+1]>=16)throw Error("El modelo contiene una articulación desconocida.");
    }
    return mesh;
  }

  function readImage(blob){
    if(typeof createImageBitmap==="function")return createImageBitmap(blob);
    return new Promise((resolve,reject)=>{
      const image=new Image(),reader=new FileReader();
      const fail=()=>reject(Error("Este navegador no pudo abrir la textura WebP."));
      reader.onerror=image.onerror=fail;
      image.onload=()=>resolve(image);
      reader.onload=()=>{image.src=reader.result;};
      reader.readAsDataURL(blob);
    });
  }

  async function unpack(file,current){
    if(file.size!==1549288)throw Error("Selecciona el paquete privado Inés Bajamar de esta edición.");
    const bytes=await file.arrayBuffer();
    if(!current())return null;
    const header=new DataView(bytes);
    if(new TextDecoder().decode(new Uint8Array(bytes,0,8))!=="MAVATAR1")throw Error("Formato de personaje desconocido.");
    const low=header.getUint32(8,true),high=header.getUint32(12,true),art=header.getUint32(16,true);
    if(Math.min(low,high)<16||art<12||20+low+high+art!==bytes.byteLength)throw Error("Paquete de personaje incompleto.");
    const digest=await MundoRoomFile.digest(bytes);
    if(!current())return null;
    if(digest!==knownDigest)throw Error("Este archivo no coincide con el personaje de esta edición.");
    const start=20+low+high;
    const source={low:readMesh(bytes.slice(20,20+low)),high:readMesh(bytes.slice(20+low,start))};
    source.image=await readImage(new Blob([new Uint8Array(bytes,start,art)],{type:"image/webp"}));
    if(!current()){source.image.close?.();return null;}
    return source;
  }

  // Keep the authored mesh indexed and share its two GPU buffer sets across seats.
  // Each draw supplies only the current 16 bone matrices and camera-relative origin.
  function upload(gl,source,light){
    const buffers=[],vaos=[],shaders=[];
    const program=gl.createProgram(),texture=gl.createTexture();
    function dispose(){
      for(const vao of vaos)gl.deleteVertexArray(vao);
      for(const buffer of buffers)gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);gl.deleteProgram(program);
    }
    function buffer(target,data){
      const result=gl.createBuffer();buffers.push(result);gl.bindBuffer(target,result);
      gl.bufferData(target,data,gl.STATIC_DRAW);
    }
    function geometry(mesh){
      const vao=gl.createVertexArray();vaos.push(vao);gl.bindVertexArray(vao);
      for(const [loc,data,size,type,normalized] of [[0,mesh.p,3,gl.FLOAT,false],[1,mesh.n,3,gl.BYTE,true],
        [2,mesh.uv,2,gl.FLOAT,false],[3,mesh.j,4,gl.UNSIGNED_BYTE,false]]){
        buffer(gl.ARRAY_BUFFER,data);
        gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,type,normalized,0,0);
      }
      buffer(gl.ELEMENT_ARRAY_BUFFER,mesh.idx);
      return {vao,count:mesh.idx.length};
    }
    try{
      for(const [kind,text] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
        const shader=gl.createShader(kind);shaders.push(shader);gl.shaderSource(shader,text);gl.compileShader(shader);
        if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error("Material del personaje no disponible.");
        gl.attachShader(program,shader);
      }
      gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error("No se pudo preparar el personaje.");
      const low=geometry(source.low),high=light?null:geometry(source.high);
      let image=source.image;
      const limit=Math.min(light?1024:2048,gl.getParameter(gl.MAX_TEXTURE_SIZE));
      if(Math.max(image.width,image.height)>limit){
        const small=document.createElement("canvas"),factor=limit/Math.max(image.width,image.height);
        small.width=Math.max(1,Math.round(image.width*factor));small.height=Math.max(1,Math.round(image.height*factor));
        small.getContext("2d").drawImage(image,0,0,small.width,small.height);image=small;
      }
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.generateMipmap(gl.TEXTURE_2D);
      return {program,texture,low,high,light,dispose,camera:gl.getUniformLocation(program,"camera"),
        bones:gl.getUniformLocation(program,"bones[0]"),origin:gl.getUniformLocation(program,"origin"),
        albedo:gl.getUniformLocation(program,"albedo")};
    }catch(e){dispose();throw e;}
    finally{
      for(const shader of shaders)gl.deleteShader(shader);
      gl.bindVertexArray(null);
    }
  }

  function install(view,retryHost){
    const file=document.getElementById("ownerPeopleFile"),status=document.getElementById("ownerPeopleStatus");
    const clear=document.getElementById("ownerPeopleClear"),options=document.getElementById("ownerPeopleOptions");
    const room=document.getElementById("ownerPeopleRoom");
    if(!file||!status||!clear||!options||!room)return null;
    let generation=0,manual=false,offered=false,source=null,sourceType=null,gpu=null,unavailable=false;
    function discard(){
      gpu?.dispose();gpu=null;source?.image.close?.();source=null;sourceType=null;unavailable=false;
    }
    function announce(text){status.textContent=text;}
    function activeText(){
      if(!source)return "Apariencia del mundo.";
      const origin=sourceType==="room"?"Inés compartida por el anfitrión.":"Inés seleccionada en este dispositivo.";
      return view.gpuReady?origin:origin+" La vista de mapa está activa.";
    }
    async function select(picked,type,valid){
      const ticket=++generation,current=()=>ticket===generation&&valid();
      announce("Preparando el personaje…");
      try{
        const next=await unpack(picked,current);
        if(!next)return;
        if(!current()){next.image.close?.();return;}
        discard();source=next;sourceType=type;announce(activeText());
      }catch(e){
        if(current())announce((e.message||"No se pudo abrir el personaje.")+" "+activeText());
      }
    }
    file.addEventListener("change",()=>{
      const picked=file.files?.[0];if(!picked)return;
      manual=true;room.hidden=!offered;file.value="";void select(picked,"local",()=>true);
    });
    clear.addEventListener("click",()=>{
      manual=true;room.hidden=!offered;++generation;discard();announce("Apariencia del mundo en este dispositivo.");
    });
    const layer={
      contextLost(){gpu=null;unavailable=false;if(source)announce(activeText());},
      contextRestored(){if(source)announce(activeText());},
      applyRoomFile(picked,current){
        if(manual||!current())return Promise.resolve();
        return select(picked,"room",()=>!manual&&current());
      },
      get acceptsRoomFile(){return !manual;},
      setRoomOffer(value){offered=value;room.hidden=!manual||!value;},
      clearRoomFile(){
        if(!manual)++generation;
        if(sourceType==="room"){discard();announce(activeText());}
        else if(!source&&!manual)announce(activeText());
      },
      draw(gl,cam,parts,time,detail){
        if(!source||unavailable||!parts?.length)return null;
        const rigs=new Set();
        for(const part of parts)if(part.actorRig && !part.actorRig.npc)rigs.add(part.actorRig);
        if(!rigs.size)return null;
        try{
          const light=detail==="economy" || (MundoView.mobile && detail!=="ultra" &&
            (detail!=="auto" || view.scale<.82 || Math.min(gl.drawingBufferWidth,gl.drawingBufferHeight)<1080));
          // Reallocate on a quality change. Hysteresis keeps automatic graphics stable on mobile.
          const mobileAuto=MundoView.mobile && detail==="auto";
          const keepHigh=mobileAuto && gpu && !gpu.light && view.scale>=.68 &&
            Math.min(gl.drawingBufferWidth,gl.drawingBufferHeight)>=830;
          const useLight=light&&!keepHigh;
          if(gpu&&gpu.light!==useLight){gpu.dispose();gpu=null;}
          if(!gpu)gpu=upload(gl,source,useLight);
          gl.useProgram(gpu.program);gl.uniformMatrix4fv(gpu.camera,false,cam.matrix);
          gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,gpu.texture);gl.uniform1i(gpu.albedo,0);
          let triangles=0;
          const visible=new Set();
          for(const rig of rigs){
            const origin=rig.feet.map((value,i)=>value-cam.eye[i]);
            const center=[origin[0],origin[1]+.9,origin[2]],depth=MundoGeometry.dot(center,cam.forward);
            if(depth+1.1<cam.near||depth-1.1>cam.far)continue;
            if(Math.abs(MundoGeometry.dot(center,cam.right))>depth*cam.tx+1.1*Math.hypot(1,cam.tx) ||
               Math.abs(MundoGeometry.dot(center,cam.up))>depth*cam.ty+1.1*Math.hypot(1,cam.ty))continue;
            const mesh=gpu.high&&detail!=="economy"&&depth<(detail==="ultra"?26:12)?gpu.high:gpu.low;
            const pose=MundoPeopleRig.rig({pos:[0,0,0],t:time*.001,
              facing:Math.PI-rig.heading,phase:rig.phase/(2*Math.PI),weight:rig.seated?0:Math.min(1,rig.speed/2.2),
              seated:rig.seated,air:rig.air});
            gl.uniformMatrix4fv(gpu.bones,false,pose);gl.uniform3fv(gpu.origin,origin);
            gl.bindVertexArray(mesh.vao);gl.drawElements(gl.TRIANGLES,mesh.count,gl.UNSIGNED_SHORT,0);
            triangles+=mesh.count/3;visible.add(rig);
          }
          return {rigs:visible,triangles};
        }catch{
          gpu?.dispose();gpu=null;unavailable=true;
          announce("El visor usa la apariencia del mundo. El material de Inés no está disponible en este dispositivo.");
          return null;
        }finally{gl.bindVertexArray(null);}
      }
    };
    room.addEventListener("click",()=>{
      manual=false;++generation;discard();room.hidden=true;
      announce(retryHost(layer)?"Preparando la apariencia del anfitrión…":"Apariencia de la sala.");
    });
    options.hidden=false;announce(activeText());view.peopleLayer=layer;
    return layer;
  }
  return Object.freeze({install});
})();
