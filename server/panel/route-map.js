"use strict";

window.MundoHostMap = function () {
  const el=id=>document.getElementById(id);
  const details=el("trackingDetails"), follow=el("trackingFollow"), canvas=el("trackingMap");
  const coverageToggle=el("trackingCoverage");
  const format=new Intl.NumberFormat("es",{maximumFractionDigits:1});
  let state=null;
  function location(p) {
    const cell=v=>Math.floor(v/64+.5);
    return "X "+format.format(p.x)+" m, Z "+format.format(p.z)+" m · celda ("+cell(p.x)+", "+cell(p.z)+")";
  }
  function bounds(seat) {
    const area=seat.coverage;
    if(area?.mode!=="sectors")return null;
    const half=(area.radius+.5)*64;
    return {x0:area.cx*64-half,x1:area.cx*64+half,z0:area.cz*64-half,z1:area.cz*64+half};
  }
  function coverageText(seat) {
    const area=seat.coverage;
    if(area?.mode==="waiting")return " · esperando confirmación del terreno";
    if(area?.mode==="complete")return " · revisión completa confirmada";
    if(area?.mode!=="sectors")return "";
    const r=area.radius;
    return " · terreno confirmado de ("+(area.cx-r)+", "+(area.cz-r)+") a ("+(area.cx+r)+", "+(area.cz+r)+")";
  }
  const npcStates={patrol:"en patrulla",waiting:"en espera",follow:"siguiendo a un jugador",
    return:"de regreso",blocked:"detenido",idle:"en reposo"};
  const reasons={spawn:"punto de aparición sin espacio o suelo",unreachable:"destino inaccesible",
    budget:"búsqueda pendiente por su límite de cálculo",obstacle:"paso obstruido",invalid:"destino inválido"};
  function npcPoint(npc){
    if(!npc.position)return null;
    return {x:npc.position[0],z:npc.position[2]};
  }
  function draw(target) {
    const ctx=canvas.getContext("2d");
    if(!ctx)return;
    const w=canvas.width,h=canvas.height;
    const npcs=(state.npcs??[]).map(npcPoint).filter(Boolean);
    const points=[...state.gates,...state.seats,...npcs];
    const windows=coverageToggle.checked?state.seats.map(s=>({seat:s,area:bounds(s)})).filter(v=>v.area):[];
    for(const {area} of windows)points.push({x:area.x0,z:area.z0},{x:area.x1,z:area.z1});
    if(state.car)points.push(state.car);
    if(state.meeting)points.push(state.meeting);
    if(!points.length)points.push({x:0,z:0});
    const xs=points.map(p=>p.x),zs=points.map(p=>p.z);
    const x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs);
    const cx=target?.x??(x0+x1)/2, cz=target?.z??(z0+z1)/2;
    const scale=target ? (h-48)/192 : Math.min((w-80)/Math.max(128,x1-x0),(h-80)/Math.max(128,z1-z0));
    const X=x=>w/2+(x-cx)*scale, Z=z=>h/2+(z-cz)*scale;
    ctx.fillStyle="#13242b";ctx.fillRect(0,0,w,h);
    // Use multiples of 64 m for far-apart objects. Bound work even at world extremes.
    let grid=64;
    while(grid*scale<40)grid*=2;
    const left=cx-w/(2*scale),top=cz-h/(2*scale);
    ctx.strokeStyle="#334a50";ctx.lineWidth=1;ctx.beginPath();
    // Offset the grid by half a cell to match the actual district boundaries.
    const gx=Math.floor((left+32)/grid)*grid-32, gz=Math.floor((top+32)/grid)*grid-32;
    for(let i=0;i<=Math.ceil(w/(grid*scale))+1;++i){const x=X(gx+i*grid);ctx.moveTo(x,0);ctx.lineTo(x,h);}
    for(let i=0;i<=Math.ceil(h/(grid*scale))+1;++i){const z=Z(gz+i*grid);ctx.moveTo(0,z);ctx.lineTo(w,z);}
    ctx.stroke();
    for(const {seat,area} of windows){
      ctx.save();
      const tint=seat.number===1?"121,213,255":"238,168,255";
      ctx.fillStyle="rgba("+tint+",0.07)";ctx.strokeStyle="rgba("+tint+",0.8)";
      ctx.setLineDash(seat.number===1?[8,4]:[3,5]);ctx.lineDashOffset=seat.number===1?0:3;
      const x=X(area.x0),z=Z(area.z0),width=(area.x1-area.x0)*scale,height=(area.z1-area.z0)*scale;
      ctx.fillRect(x,z,width,height);ctx.strokeRect(x,z,width,height);ctx.restore();
    }
    ctx.font="bold 14px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";
    // Dots show gate order. They need not lie on a straight drivable road.
    for(const gate of state.gates){
      const x=X(gate.x),z=Z(gate.z);
      if(x<0 || x>w || z<0 || z>h)continue;
      ctx.fillStyle=gate.slot===state.passed+1?"#ffe49a":gate.slot<=state.passed?"#99c5aa":"#b0bac4";
      ctx.fillRect(x-9,z-9,18,18);ctx.fillStyle="#172122";ctx.fillText(String(gate.slot),x,z);
    }
    if(state.meeting){
      ctx.strokeStyle="#66ddbc";ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(X(state.meeting.x),Z(state.meeting.z),11,0,2*Math.PI);ctx.stroke();
    }
    if(state.car){
      ctx.save();ctx.translate(X(state.car.x),Z(state.car.z));ctx.rotate(state.car.yaw);
      ctx.fillStyle="#f5ab61";ctx.beginPath();ctx.moveTo(0,-12);
      ctx.lineTo(8,8);ctx.lineTo(0,5);ctx.lineTo(-8,8);ctx.closePath();ctx.fill();ctx.restore();
    }
    for(const npc of npcs){
      ctx.fillStyle="#ffbf64";
      const x=X(npc.x),z=Z(npc.z);
      ctx.beginPath();ctx.moveTo(x,z-6);ctx.lineTo(x+6,z);ctx.lineTo(x,z+6);ctx.lineTo(x-6,z);ctx.closePath();ctx.fill();
    }
    for(const seat of state.seats){
      const aboard=state.car && [state.car.driver,state.car.passenger].includes(seat.number);
      const x=X(seat.x)+(aboard?(seat.number===1?-12:12):0),z=Z(seat.z);
      ctx.fillStyle=seat.stale?"#778185":seat.number===1?"#79d5ff":"#eea8ff";
      ctx.beginPath();ctx.arc(x,z,9,0,2*Math.PI);ctx.fill();ctx.fillStyle="#171f27";ctx.fillText(String(seat.number),x,z);
    }
    ctx.textAlign="left";ctx.textBaseline="bottom";ctx.font="13px system-ui";
    const legend="Norte ↑  ·  cuadrícula "+format.format(grid)+" m";
    ctx.fillStyle="#13242b";ctx.fillRect(4,h-23,ctx.measureText(legend).width+14,20);
    ctx.fillStyle="#deefeb";ctx.fillText(legend,10,h-5);
  }

  function render() {
    if(!state || !details.open)return;
    const choices=new Map(state.seats.map(s=>[String(s.number),s]));
    if(state.car)choices.set("car",state.car);
    for(const option of follow.options)option.disabled=option.value!=="all" && !choices.has(option.value);
    if(follow.selectedOptions[0]?.disabled)follow.value="all";
    el("trackingWorld").textContent=state.world;
    const lines=[];
    for(const seat of state.seats){
      const role=state.car?.driver===seat.number?" · al volante":state.car?.passenger===seat.number?" · pasajero":"";
      lines.push("Plaza "+seat.number+role+" · "+location(seat)+coverageText(seat)+(seat.stale?" · última posición conocida":""));
    }
    if(!state.seats.length)lines.push("La sala espera jugadores.");
    if(state.car)lines.push("Turismo · "+location(state.car));
    for(const npc of state.npcs??[]){
      const point=npcPoint(npc);
      const reason=reasons[npc.reason];
      lines.push("NPC "+npc.id+" · "+(npcStates[npc.state]??"desconocido")+
        (reason?" · "+reason:"")+(point?" · "+location(point)+" · Y "+format.format(npc.position[1])+" m":""));
    }
    const next=state.gates[state.passed];
    if(next)lines.push("Próxima puerta "+next.slot+" · "+next.label+" · "+location(next));
    else if(state.gates.length)lines.push("Vuelta completada.");
    el("trackingSummary").textContent=lines.join("\n");
    draw(choices.get(follow.value));
  }
  coverageToggle.onchange=render;follow.onchange=render;details.addEventListener("toggle",render);
  return {update(next){
    if(!next || state?.world!==next.world || state?.epoch!==next.epoch)follow.value="all";
    state=next??null;el("trackingSection").hidden=!state;
    if(state){render();return;}
    el("trackingSummary").textContent="";el("trackingWorld").textContent="";
    canvas.getContext("2d")?.clearRect(0,0,canvas.width,canvas.height);
  }};
};
