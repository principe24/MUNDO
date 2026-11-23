"use strict";
globalThis.MundoNpcPreflight=(()=>{
  const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
  const location=point=>"[X "+point[0]+", Y "+point[1]+", Z "+point[2]+"] m";
  async function check({world,terrain,npc,route,current,progress,yieldFrame=yieldTurn}){
    // Inspect only saved data. A concurrent edit, actor switch or cancellation discards the report.
    await yieldFrame();
    if(!current()) return "";
    const {car}=MundoDriving.roomStart(world,terrain.scene,terrain.vehicleRoot);
    const obstacles=car?[MundoDriving.chassisBounds(car)]:[];
    const solids=car?terrain.scene.objects.filter(o=>!car.partIds.has(o.n.id)):terrain.scene.objects;
    const nav=MundoNavigation3D.createNavigation(solids);
    const origin={label:"origen",point:npc.spawn};
    let feet=nav.project(origin.point,{obstacles});
    if(!feet) return "Sin apoyo o espacio libre comprobado en el origen "+location(npc.spawn)+".";
    if(npc.mode==="follow") return "Origen transitable "+location(feet)+". El seguimiento y el regreso dependen de la posición del jugador en la partida.";
    const stops=route.steps.map(s=>({label:"punto "+s.slot,point:s.point}));
    stops.push(origin);
    let last=origin,checked=0;
    for(const stop of stops){
      const leg=last.label+" → "+stop.label;
      progress("Comprobando "+leg+" ("+(checked+1)+"/"+stops.length+")…");
      // There are at most 33 legs. Yield between bounded planner calls so Studio stays interactive.
      await yieldFrame();
      if(!current()) return "";
      const result=nav.plan(feet,stop.point,{obstacles,maxNodes:3072});
      if(result.status!=="ok"){
        const message=result.status==="budget"?"Búsqueda inconclusa por límite de trabajo en ":
          result.status==="unreachable"?"Sin paso transitable en ":"Datos inválidos en ";
        return message+leg+" · "+location(last.point)+" → "+location(stop.point)+".";
      }
      feet=result.points[result.points.length-1];
      last=stop;++checked;
    }
    return checked+" tramos transitables, incluido el regreso al origen. Geometría y turismo en su posición inicial.";
  }
  return {check};
})();
