"use strict";
window.MundoCircuitPanel = function({world,edit,choose,center,locate,mark,saveGrid,practiceContext}) {
  const el=id=>document.getElementById(id), list=el("circuitList"), form=el("circuitForm");
  const axes=["X","Y","Z"].map(axis=>el("gate"+axis));
  const practice=el("circuitPractice"),first=el("practiceFirst"),last=el("practiceLast");
  const mode=el("practiceStartMode");
  const download=el("practiceExport"),status=el("practiceStatus");
  let gates=[],current=null,markedFrom=null;
  let practiceVersion=0,preparing=false;
  const gateIndex=id=>gates.findIndex(g=>String(g.id)===id);
  const gateOption=(gate,i)=>new Option((i+1)+" · "+gate.label,String(gate.id));
  const grid=MundoGridPanel({save:saveGrid,locate,mark,changed:practiceState,
    firstGate:()=>gates[gateIndex(first.value)]});
  function practiceState(){
    ++practiceVersion;
    const a=gateIndex(first.value),b=gateIndex(last.value),count=b-a+1;
    grid.show();
    download.disabled=preparing || a<0 || b<=a || grid.pending || Boolean(grid.error);
    status.textContent=grid.error && !grid.pending?grid.error:grid.pending?"Guarda la parrilla antes de descargar la práctica.":
      gates.length<2?"Necesitas dos puertas en el circuito.":
      a<0?"Elige dónde empieza el tramo.":b<=a?"Elige una puerta posterior para terminar el tramo.":
      count+" puertas cronometradas · "+gates[a].label+" → "+gates[b].label+
        (mode.value==="flying"?". La primera puerta inicia la vuelta con un parcial de 0 ms.":". El primer parcial incluye la aproximación.");
  }
  function lastOptions(preferred=""){
    const a=gateIndex(first.value);
    last.replaceChildren(new Option("Elegir última puerta",""));
    if(a>=0)for(let i=a+1;i<gates.length;++i)last.add(gateOption(gates[i],i));
    last.disabled=a<0;
    last.value=gateIndex(preferred)>a?preferred:"";
    practiceState();
  }
  function practiceSelection(){return {first:first.value,last:last.value,mode:mode.value};}
  function resetPractice(preferred,originalMode){
    mode.value=preferred?.mode??originalMode;
    el("draftStartMode").textContent=originalMode==="flying"?"Borrador con salida lanzada en la primera puerta.":
      "En este borrador, el cronómetro empieza con el primer movimiento.";
    first.replaceChildren(new Option("Elegir primera puerta",""),...gates.slice(0,-1).map(gateOption));
    first.disabled=gates.length<2;
    if(preferred && gateIndex(preferred.first)>=0 && gateIndex(preferred.first)<gates.length-1)first.value=preferred.first;
    lastOptions(preferred?.last);
  }
  first.onchange=()=>lastOptions(last.value);
  last.onchange=practiceState;
  mode.onchange=practiceState;
  function practiceRange(firstId,lastId){
    if(![firstId,lastId].every(id=>typeof id==="bigint" || (typeof id==="string" && /^[1-9][0-9]{0,19}$/.test(id))))return false;
    const a=gateIndex(String(firstId)),b=gateIndex(String(lastId));
    if(a<0 || b<=a)return false;
    first.value=String(gates[a].id);lastOptions(String(gates[b].id));
    practice.open=true;
    practice.scrollIntoView({block:"nearest"});
    first.focus({preventScroll:true});
    return true;
  }
  download.onclick=async()=>{
    if(preparing || download.disabled)return;
    const draft=practiceContext(),ticket=practiceVersion,a=first.value,b=last.value;
    const valid=()=>ticket===practiceVersion && draft.current();
    preparing=true;download.disabled=true;download.setAttribute("aria-busy","true");
    status.textContent="Preparando la copia de práctica…";
    try{
      const file=await MundoCircuitEdit.practiceRoom(draft,a,b,valid,mode.value);
      if(!file || !valid()){
        if(ticket===practiceVersion)status.textContent="El borrador cambió. Vuelve a solicitar la copia.";
        return;
      }
      const url=URL.createObjectURL(file.blob),link=document.createElement("a");
      try{
        link.href=url;link.download=file.filename;document.body.append(link);link.click();
      }finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
      status.textContent="Descarga solicitada · "+file.filename+" · "+file.gates+" puertas. SHA-256 de la sala: "+file.hash;
    }catch(error){if(valid())status.textContent=error.message;}
    finally{
      preparing=false;download.removeAttribute("aria-busy");
      const start=gateIndex(first.value);
      download.disabled=start<0 || gateIndex(last.value)<=start || grid.pending || Boolean(grid.error);
    }
  };
  function fields(point) {
    return {point:point??axes.map(input=>input.valueAsNumber),label:el("gateLabel").value.trim(),
      width:el("gateWidth").valueAsNumber,height:el("gateHeight").valueAsNumber,bearing:el("gateBearing").valueAsNumber};
  }
  function show(id) {
    const index=gates.findIndex(gate=>gate.id===id), gate=gates[index];
    if(markedFrom!==null && markedFrom!==gate?.id)mark("gate-insert");
    current=gate?.id??null;list.value=gate?String(gate.id):"";
    for(const key of ["circuitApply","circuitDelete","circuitLocate","circuitRelocate"])el(key).disabled=!gate;
    el("circuitEarlier").disabled=index<=0;el("circuitLater").disabled=index<0||index===gates.length-1;
    el("circuitPlace").disabled=el("circuitAdd").disabled=gates.length===MundoCircuit.limit;
    el("circuitDuplicate").disabled=!gate || gates.length===MundoCircuit.limit;
    const next=gate && gates[index+1],full=gates.length===MundoCircuit.limit;
    el("circuitInsert").disabled=el("circuitMarkStep").disabled=!next || full;
    el("circuitSegment").textContent=full?"El circuito alcanzó el límite de 32 puertas.":
      next?gate.label+" → "+next.label+". Inserta en el punto medio o marca un desvío. El arco conserva el ancho y el alto de "+gate.label+".":
      gate?"Esta puerta cierra el recorrido. Elige una anterior para insertar un paso.":"Crea dos puertas para insertar un paso entre ellas.";
    if(gate) {
      axes.forEach((input,i)=>{input.value=gate.point[i];});
      el("gateLabel").value=gate.label;el("gateWidth").value=gate.width;el("gateHeight").value=gate.height;
      el("gateBearing").value=Number(gate.bearing.toFixed(8));
    }
  }
  function gateFor(id) {
    for(let n=world().nodes.get(id);n;n=world().nodes.get(n.parent))
      if(gates.some(gate=>gate.id===n.id))return n.id;
    return null;
  }
  function refresh(selection,preferred=practiceSelection()) {
    const course=MundoCircuit.read(world());
    gates=course.gates;
    list.replaceChildren(...gates.map((gate,i)=>new Option((i+1)+" · "+gate.label,String(gate.id))));
    if(!gates.length)list.add(new Option("Aún no hay puertas",""));
    list.disabled=!gates.length;
    resetPractice(preferred,course.startMode);
    show(gateFor(selection)??gates.find(g=>g.id===current)?.id??gates[0]?.id);
  }
  function place(point,mode) {
    if(mode==="grid-position"){grid.pick(point);return;}
    if(mode==="gate-insert"){
      const from=markedFrom??current;
      edit(next=>MundoCircuitEdit.insert(next,from,point),id=>{
        const index=gates.findIndex(g=>g.id===id),gate=gates[index];
        const position=gate.point.map(n=>Number(n.toFixed(3))).join(", ");
        return "Puerta "+(index+1)+" · "+gate.label+" en ("+position+") m. "+
          gates[index-1].label+" → "+gate.label+" → "+gates[index+1].label+". Rumbo "+Number(gate.bearing.toFixed(2))+"°.";
      });
      return;
    }
    const data=fields(point),id=current;
    if(mode==="gate-move" && id!==null)edit(next=>MundoCircuitEdit.change(next,id,data),"Puerta desplazada.");
    if(mode==="gate-add")edit(next=>MundoCircuitEdit.add(next,data),"Puerta añadida al final del circuito.");
  }
  list.onchange=()=>choose(list.value?BigInt(list.value):null);
  el("circuitAdd").onclick=()=>{if(form.reportValidity())place(null,"gate-add");};
  el("circuitPlace").onclick=()=>mark("gate-add");
  el("circuitInsert").onclick=()=>place(null,"gate-insert");
  el("circuitMarkStep").onclick=()=>mark("gate-insert");
  el("circuitRelocate").onclick=()=>{if(current!==null)mark("gate-move");};
  form.onsubmit=e=>{e.preventDefault();if(current!==null)place(null,"gate-move");};
  el("circuitLocate").onclick=()=>{if(current!==null){choose(current);center();}};
  el("circuitEarlier").onclick=()=>edit(next=>MundoCircuitEdit.move(next,current,-1),"Puerta adelantada.");
  el("circuitLater").onclick=()=>edit(next=>MundoCircuitEdit.move(next,current,1),"Puerta atrasada.");
  el("circuitDuplicate").onclick=()=>edit(next=>MundoCircuitEdit.duplicate(next,current),"Copia insertada cinco metros después. Puedes moverla y cambiar su nombre.");
  el("circuitDelete").onclick=()=>edit(next=>MundoCircuitEdit.remove(next,current),"Puerta y piezas retiradas. Puedes deshacer.");
  return {refresh,place,practiceRange,practiceSelection,
    refreshGrid(pose,car,error){grid.refresh(pose,car,error);practiceState();},
    select(id){const gate=gateFor(id);if(gate!==null && gate!==current)show(gate);},
    marking(mode){
      grid.marking(mode);
      markedFrom=mode==="gate-insert"?current:null;
      for(const [key,target,label] of [["circuitPlace","gate-add","Crear sobre el suelo"],["circuitRelocate","gate-move","Mover sobre el suelo"],
        ["circuitMarkStep","gate-insert","Marcar paso en el suelo"]]){
        const active=mode===target;el(key).setAttribute("aria-pressed",String(active));
        el(key).textContent=active?"Cancelar · toca el suelo para colocar":label;
      }
    }};
};
