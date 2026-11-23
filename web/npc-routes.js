"use strict";
// Empty, unscaled groups carry public gameplay instructions in existing MWENGIE documents.
// Artist assets, Studio components and scripts are never consulted by this reader.
globalThis.MundoNpcRoutes = (() => {
  const prefix="MUNDO/Nav/v1/", maxActors=8, maxRoutes=16, maxPoints=32;
  const utf8=new TextEncoder();
  const fail=message=>{throw Error(message);};
  function position(value,limit=1e6) {
    if (!Array.isArray(value) || value.length!==3 ||
        ![0,1,2].every(i=>Number.isFinite(value[i]) && Math.abs(value[i])<=limit))
      fail("Indica tres coordenadas de navegación entre −1 000 000 y 1 000 000 m.");
    return value.slice();
  }
  function label(value){
    if (typeof value!=="string" || !value || value!==value.trim() ||
        utf8.encode(value).length>32 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
      fail("Usa un nombre visible de hasta 32 bytes para la navegación.");
    return value;
  }
  function settings(mode,speed,waitSeconds){
    if (!["patrol","follow"].includes(mode)) fail("Elige patrulla o seguimiento.");
    if (!Number.isFinite(speed) || speed<.25 || speed>6 || Math.abs(100*speed-Math.round(100*speed))>1e-8)
      fail("La velocidad debe estar entre 0,25 y 6 m/s con hasta dos decimales.");
    if (!Number.isFinite(waitSeconds) || waitSeconds<0 || waitSeconds>30 ||
        Math.abs(waitSeconds*1000-Math.round(waitSeconds*1000))>1e-8)
      fail("La espera debe estar entre 0 y 30 s con hasta tres decimales.");
  }
  function inspect(world){
    const routes=new Map(), npcs=new Map(), steps=[], markers=new Map();
    for(const n of world.nodes.values()){
      if(!n.name.startsWith(prefix)) continue;
      if(n.shape!==0 || n.visual!==0n || !n.s.every(x=>x===1) ||
         !(n.q[0]===0 && n.q[1]===0 && n.q[2]===0 && Math.abs(n.q[3])===1))
        fail("Los marcadores de navegación deben ser grupos vacíos sin escala ni rotación.");
      const id=String(n.id), tag=n.name.slice(prefix.length), p=position(n.p,tag.startsWith("P/")?2e6:1e6);
      if(tag.startsWith("R/") && n.parent===0n){
        if(routes.size>=maxRoutes) fail("Una sala admite hasta 16 rutas.");
        routes.set(id,{id,label:label(tag.slice(2)),origin:p,steps:[]});
        markers.set(n.id,"route"); continue;
      }
      const step=/^P\/(0[1-9]|[12][0-9]|3[0-2])$/.exec(tag);
      if(step){
        if(steps.length>=maxRoutes*maxPoints) fail("La sala supera el máximo de pasos de navegación.");
        steps.push({id,route:String(n.parent),slot:Number(step[1]),local:p});
        markers.set(n.id,"step"); continue;
      }
      const actor=/^N\/([1-9][0-9]{0,19})\/(patrol|follow)\/(0|[1-9][0-9]{0,2})\/(0|[1-9][0-9]{0,4})\/(.+)$/su.exec(tag);
      if(actor && n.parent===0n){
        if(npcs.size>=maxActors) fail("Una sala admite hasta 8 personajes automáticos.");
        const speed=Number(actor[3])/100, waitSeconds=Number(actor[4])/1000;
        settings(actor[2],speed,waitSeconds);
        npcs.set(id,{id,label:label(actor[5]),route:actor[1],mode:actor[2],speed,waitSeconds,spawn:p});
        markers.set(n.id,"npc"); continue;
      }
      fail("Marcador de navegación inválido en la pieza "+id+".");
    }
    if(!markers.size) return {routes:[],npcs:[]};
    for(const n of world.nodes.values()){
      if(markers.has(n.parent) && !(markers.get(n.parent)==="route" && markers.get(n.id)==="step"))
        fail("Una ruta solo admite puntos de paso. Los demás marcadores no admiten piezas hijas.");
    }
    for(const step of steps){
      const route=routes.get(step.route);
      if(!route) fail("Cada punto debe pertenecer a una ruta.");
      route.steps.push({id:step.id,slot:step.slot,point:position(step.local.map((x,i)=>x+route.origin[i]))});
    }
    for(const route of routes.values()){
      route.steps.sort((a,b)=>a.slot-b.slot);
      if(!route.steps.length || route.steps.some((s,i)=>s.slot!==i+1))
        fail("Cada ruta necesita entre 1 y 32 puntos con orden consecutivo.");
    }
    for(const npc of npcs.values()) if(!routes.has(npc.route))
      fail("El personaje "+npc.label+" necesita una ruta existente.");
    const byId=(a,b)=>a.id.length-b.id.length || (a.id<b.id?-1:a.id>b.id?1:0);
    return {routes:[...routes.values()].sort(byId),npcs:[...npcs.values()].sort(byId)};
  }
  function definitions(world){
    const data=inspect(world), routes=new Map(data.routes.map(r=>[r.id,r]));
    return data.npcs.map(npc=>{
      const points=[npc.spawn];
      for(const {point} of routes.get(npc.route).steps){
        if(!point.every((v,i)=>v===points[points.length-1][i])) points.push(point.slice());
      }
      return {id:npc.id,points,mode:npc.mode,waitSeconds:npc.waitSeconds,speed:npc.speed};
    });
  }
  function routeById(data,id){
    const r=data.routes.find(r=>r.id===String(id));
    if(!r) fail("Selecciona una ruta existente.");
    return r;
  }
  function node(world,name,p,parent=0n) {
    const factory=globalThis.MundoWorld || require("../server/room-runtime.cjs").MundoWorld;
    const record=factory.add(world,prefix+name,0,parent);
    record.p=p.slice();
    return record.id;
  }
  function stepTag(slot){return "P/"+String(slot).padStart(2,"0");}
  function addRoute(world,name,points){
    if(inspect(world).routes.length>=maxRoutes) fail("Una sala admite hasta 16 rutas.");
    label(name);
    if(!Array.isArray(points) || !points.length || points.length>maxPoints) fail("Usa entre 1 y 32 pasos por ruta.");
    const coords=Array.from(points,p=>position(p));
    if(world.nodes.size+coords.length+1>65536 || world.next+BigInt(coords.length+1)>(1n<<64n)-1n)
      fail("El mundo no tiene espacio para todos los puntos de la ruta.");
    const id=node(world,"R/"+name,[0,0,0]);
    coords.forEach((p,i)=>node(world,stepTag(i+1),p,id));
    return id;
  }
  function npcTag(world,fields,id){
    const data=inspect(world);
    if(id===undefined && data.npcs.length>=maxActors) fail("Una sala admite hasta 8 personajes automáticos.");
    if(id!==undefined && !data.npcs.some(n=>n.id===String(id))) fail("Selecciona un personaje.");
    const route=routeById(data,fields.route);
    settings(fields.mode,fields.speed,fields.waitSeconds);
    return "N/"+route.id+"/"+fields.mode+"/"+Math.round(fields.speed*100)+"/"+
      Math.round(fields.waitSeconds*1000)+"/"+label(fields.label);
  }
  function addNpc(world,fields){
    const tag=npcTag(world,fields);
    return node(world,tag,position(fields.spawn));
  }
  function updateNpc(world,id,fields){
    const tag=npcTag(world,fields,id),key=BigInt(id),previous=world.nodes.get(key);
    world.nodes.set(key,{...previous,name:prefix+tag,p:position(fields.spawn)});
    return key;
  }
  function editStep(world,routeId,index,action,point){
    const route=routeById(inspect(world),routeId), count=route.steps.length, parent=BigInt(route.id);
    if(action==="add"){
      if(count>=maxPoints) fail("La ruta ya tiene 32 puntos.");
      const p=position(point).map((v,i)=>v-route.origin[i]);
      return node(world,stepTag(count+1),p,parent);
    }
    if(!Number.isInteger(index) || index<0 || index>=count) fail("Selecciona un punto de la ruta.");
    const key=BigInt(route.steps[index].id), n=world.nodes.get(key);
    if(action==="move"){
      world.nodes.set(key,{...n,p:position(point).map((v,i)=>v-route.origin[i])}); return key;
    }
    if(action==="remove"){
      if(count===1) fail("Conserva al menos un punto de paso en la ruta.");
      world.nodes.delete(key); route.steps.splice(index,1);
    } else {
      const target=index+(action==="up"?-1:action==="down"?1:0);
      if(target===index || target<0 || target>=count) fail("El punto ya se encuentra en el extremo de la ruta.");
      [route.steps[target],route.steps[index]]=[route.steps[index],route.steps[target]];
    }
    route.steps.forEach((s,i)=>{
      const id=BigInt(s.id), old=world.nodes.get(id), name=prefix+stepTag(i+1);
      if(old.name!==name) world.nodes.set(id,{...old,name});
    });
    return action==="remove"?parent:key;
  }
  function removeRoute(world,id){
    const data=inspect(world), route=routeById(data,id);
    if(data.npcs.some(n=>n.route===route.id)) fail("Cambia o retira los personajes que usan esta ruta antes de borrarla.");
    for(const s of route.steps) world.nodes.delete(BigInt(s.id));
    world.nodes.delete(BigInt(route.id));
  }
  return Object.freeze({inspect,read:definitions,definitions,addRoute,addNpc,updateNpc,editStep,removeRoute,maxActors,maxPoints,maxRoutes});
})();
if(typeof module!=="undefined" && module.exports) module.exports=globalThis.MundoNpcRoutes;
