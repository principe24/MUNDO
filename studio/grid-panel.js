"use strict";
window.MundoGridPanel = function({save, locate, mark, firstGate, changed}) {
  const el=id=>document.getElementById(id), form=el("gridForm"), status=el("gridStatus");
  const coords=["X","Y","Z"].map(axis=>el("grid"+axis)), bearing=el("gridBearing");
  const apply=el("gridApply"), aim=el("gridAim"), place=el("gridPlace"), clear=el("gridClear");
  let stored=null, original=null, dirty=false, issue="", savedError="";
  function point(){return coords.map(input=>input.valueAsNumber);}
  const fmt=value=>Number(value.toFixed(3));
  function show(){
    const gate=firstGate(), active=stored??original;
    apply.disabled=place.disabled=!original;
    aim.disabled=!original||!gate;
    clear.disabled=!stored&&!dirty;
    el("gridLocate").disabled=!active;
    if(issue){status.textContent=issue;return;}
    if(dirty){status.textContent="Coordenadas o rumbo pendientes de guardar.";return;}
    if(!active){status.textContent="Añade o selecciona un turismo para colocar su salida.";return;}
    const [x,y,z]=active.point;
    const info=(stored?"Parrilla guardada":"Posición original del turismo")+" · ("+
      [x,y,z].map(fmt).join(", ")+") m · rumbo "+fmt(active.bearing)+"°.";
    if(stored && gate && (x-gate.point[0])*gate.forwardX+(z-gate.point[2])*gate.forwardZ>=-.01)
      status.textContent=info+" La salida queda sobre la primera puerta elegida o por delante de ella. Acércate por detrás para activar su cruce.";
    else status.textContent=info;
  }
  function restoreFields(){
    const value=stored??original;
    coords.forEach((input,i)=>{input.value=value?.point[i]??"";});
    bearing.value=value?.bearing??"";
    dirty=false;issue=savedError;
  }
  function refresh(grid,car,error=""){
    stored=grid;
    original=car?{point:[car.x,car.base,car.z],bearing:((car.yaw*180/Math.PI)%360+360)%360}:null;
    savedError=error;restoreFields();show();
  }
  function pending(){dirty=true;issue="";changed();}
  form.oninput=pending;
  form.onsubmit=e=>{
    e.preventDefault();
    try{save({point:point(),bearing:bearing.valueAsNumber});}
    catch(error){issue=error.message;show();}
  };
  place.onclick=()=>mark("grid-position");
  aim.onclick=()=>{
    if(!coords.every(input=>input.reportValidity()))return;
    const gate=firstGate();
    if(!gate)return;
    const [x,,z]=point(),dx=gate.point[0]-x,dz=gate.point[2]-z;
    if(Math.hypot(dx,dz)<.01){issue="Separa la parrilla de la puerta para calcular el rumbo.";show();return;}
    bearing.value=String(((Math.atan2(dx,-dz)*180/Math.PI)%360+360)%360);pending();
  };
  clear.onclick=()=>{
    if(!stored){restoreFields();changed();return;}
    try{save(null);}catch(error){issue=error.message;show();}
  };
  el("gridLocate").onclick=()=>{
    if(dirty && coords.every(input=>input.checkValidity())){locate(point());return;}
    const pose=stored??original;
    if(pose)locate(pose.point);
  };
  return {refresh, show, get pending(){return dirty;}, get error(){return savedError;},
    pick(point){
      coords.forEach((input,i)=>{input.value=point[i];});
      pending();mark("grid-position");
      form.scrollIntoView({block:"nearest"});
      apply.focus({preventScroll:true});
    },
    marking(mode){
      const active=mode==="grid-position";
      place.setAttribute("aria-pressed",String(active));
      place.textContent=active?"Cancelar marcado de la salida":"Marcar la salida en el suelo";
    }};
};
