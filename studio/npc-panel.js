"use strict";
window.MundoNpcPanel = function({edit,world,terrain,redraw,mark}) {
  const api=MundoNpcRoutes, el=id=>document.getElementById(id), status=el("navStatus");
  const routes=el("navRoute"), points=el("navPoint"), npcs=el("navNpc");
  let data={routes:[],npcs:[]},activeCheck=null;
  const check=el("navCheck"),report=el("navReport");
  function invalidate(){
    activeCheck=null;
    check.textContent="Comprobar recorrido guardado";
    report.textContent="";
  }
  const route=()=>data.routes.find(r=>r.id===routes.value);
  const npc=()=>data.npcs.find(n=>n.id===npcs.value);
  const coordinates=()=>["X","Y","Z"].map(axis=>el("nav"+axis).valueAsNumber);
  const describe=p=>p.map(n=>Number(n.toFixed(2))).join(", ");
  function locate(p){
    ["X","Y","Z"].forEach((axis,i)=>el("nav"+axis).value=String(p[i]));
    status.textContent="Posición elegida: "+describe(p)+" m.";
  }
  function refreshPoints(preferred=points.value){
    const r=route(), steps=r?.steps||[];
    points.replaceChildren(...steps.map(s=>new Option(s.slot+" · ("+describe(s.point)+")",s.id)));
    if(steps.some(s=>s.id===preferred)) points.value=preferred;
    const index=points.selectedIndex;
    el("navUp").disabled=index<=0;
    el("navDown").disabled=index<0 || index>=steps.length-1;
    el("navDeletePoint").disabled=steps.length<2;
    el("navAppend").disabled=!r || steps.length>=api.maxPoints;
    el("navMove").disabled=!r;
    el("navDeleteRoute").disabled=!r || data.npcs.some(n=>n.route===r.id);
    check.disabled=!npc();
    el("navCreateNpc").disabled=!r || data.npcs.length>=api.maxActors;
    el("navCreateRoute").disabled=data.routes.length>=api.maxRoutes;
    el("navUpdateNpc").disabled=el("navMoveNpc").disabled=el("navDeleteNpc").disabled=!npc();
  }
  function fillNpc(){
    const n=npc();
    if(!n) return;
    routes.value=n.route;
    el("navMode").value=n.mode;
    el("navNpcName").value=n.label;
    el("navSpeed").value=n.speed;
    el("navWait").value=n.waitSeconds;
  }
  function refresh(wantedRoute=routes.value,wantedNpc=npcs.value,wantedPoint=points.value){
    invalidate();data=api.inspect(world());
    routes.replaceChildren(...data.routes.map(r=>new Option(r.label+" · "+r.id,r.id)));
    if(data.routes.some(r=>r.id===wantedRoute)) routes.value=wantedRoute;
    npcs.replaceChildren(new Option("Nuevo personaje",""),...data.npcs.map(n=>new Option(n.label+" · "+n.id,n.id)));
    if(data.npcs.some(n=>n.id===wantedNpc)) npcs.value=wantedNpc;
    fillNpc();refreshPoints(wantedPoint);
    status.textContent=data.routes.length+" de "+api.maxRoutes+" rutas · "+data.npcs.length+" de "+api.maxActors+" personajes.";
  }
  function fields(){
    return {label:el("navNpcName").value.trim(),route:routes.value,mode:el("navMode").value,
      speed:el("navSpeed").valueAsNumber,waitSeconds:el("navWait").valueAsNumber};
  }
  function change(fn,message,after){
    let selected=null;
    const error=edit(next=>{selected=fn(next);return selected;},message);
    if(error){status.textContent=error.message;return;}
    if(after) after(String(selected));
    redraw();status.textContent=message;
  }
  routes.onchange=()=>{refreshPoints();redraw();};
  points.onchange=()=>{refreshPoints();const s=route()?.steps[points.selectedIndex];if(s)locate(s.point);redraw();};
  npcs.onchange=()=>{invalidate();fillNpc();refreshPoints();if(npc())locate(npc().spawn);redraw();};
  el("navCreateRoute").onclick=()=>change(next=>api.addRoute(next,el("navRouteName").value.trim(),[coordinates()]),
    "Ruta creada.",id=>refresh(id,""));
  el("navDeleteRoute").onclick=()=>change(next=>{api.removeRoute(next,routes.value);return null;},"Ruta retirada.");
  for(const [id,action] of [["navAppend","add"],["navMove","move"],["navUp","up"],["navDown","down"],["navDeletePoint","remove"]]){
    el(id).onclick=()=>{
      const routeId=routes.value,index=points.selectedIndex;
      change(next=>api.editStep(next,routeId,index,action,coordinates()),"Ruta actualizada.",pointId=>{
        routes.value=routeId;refreshPoints(pointId);
      });
    };
  }
  el("navCreateNpc").onclick=()=>change(next=>api.addNpc(next,{...fields(),spawn:coordinates()}),
    "Personaje añadido a la sala.",id=>refresh(routes.value,id));
  el("navUpdateNpc").onclick=()=>change(next=>api.updateNpc(next,npcs.value,{...fields(),spawn:npc().spawn}),
    "Ruta y conducta guardadas.");
  el("navMoveNpc").onclick=()=>change(next=>api.updateNpc(next,npcs.value,{...npc(),spawn:coordinates()}),"Origen del personaje actualizado.");
  el("navDeleteNpc").onclick=()=>change(next=>{next.nodes.delete(BigInt(npcs.value));return null;},"Personaje retirado.");
  check.onclick=async()=>{
    if(activeCheck){invalidate();report.textContent="Comprobación cancelada.";return;}
    const selected=npc();
    if(!selected) return;
    const ticket=Symbol(),getCurrent=()=>activeCheck===ticket;
    activeCheck=ticket; check.textContent="Cancelar comprobación";
    report.textContent="Preparando la geometría de la sala…";
    try{
      const result=await MundoNpcPreflight.check({world:world(),terrain:terrain(),npc:selected,
        route:data.routes.find(r=>r.id===selected.route),current:getCurrent,
        progress:text=>{if(getCurrent()) report.textContent=text;}});
      if(getCurrent()) report.textContent=result;
    }catch(e){if(getCurrent()) report.textContent=e.message;}
    finally{if(getCurrent()){activeCheck=null;check.textContent="Comprobar recorrido guardado";}}
  };
  el("navPick").onclick=mark;
  el("navPanel").ontoggle=redraw;
  function overlays(){
    if(!el("navPanel").open) return [];
    const out=[];
    function marker(p,w,h,color){
      const [x,y,z]=p,cy=y+h/2;
      out.push({n:{id:-100n-BigInt(out.length),shape:2,visual:0n,rough:.8,metal:0,color},
        center:[x,cy,z],extent:[w/2,h/2,w/2],radius:Math.hypot(w,h)/2,m:[w,0,0,0,0,h,0,0,0,0,w,0,x,cy,z,1]});
    }
    const steps=route()?.steps||[];
    for(let i=0;i<steps.length;i++){
      const s=steps[i];
      marker(s.point,.42,.12,s.id===points.value?[1,.73,.06]:[.04,.65,.28]);
      if(!i) continue;
      const a=steps[i-1].point,d=s.point.map((v,k)=>v-a[k]),length=Math.hypot(...d);
      if(length<1e-5) continue;
      const horizontal=Math.hypot(d[0],d[2]),w=.055;
      const u=horizontal>1e-9?[d[2]/horizontal,0,-d[0]/horizontal]:[1,0,0];
      const f=d.map(v=>v/length);
      const v=[f[1]*u[2]-f[2]*u[1], f[2]*u[0]-f[0]*u[2], f[0]*u[1]-f[1]*u[0]];
      const center=a.map((val,k)=>val+d[k]/2);
      center[1]+=.07;
      out.push({n:{id:-100n-BigInt(out.length),shape:1,visual:0n,rough:.8,metal:0,color:[.06,.55,.28]},
        center,extent:d.map(x=>Math.abs(x)/2+w),radius:length/2+w,
        m:[...u.map(x=>x*w),0,...v.map(x=>x*w),0,...d,0,...center,1]});
    }
    for(const n of data.npcs) marker(n.spawn,.45,1.4,[.28,.4,1]);
    return out;
  }
  return {refresh,invalidate,locate,overlays,marking(mode){el("navPick").setAttribute("aria-pressed",String(mode==="nav-position"));}};
};
