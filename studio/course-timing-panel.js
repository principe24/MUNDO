"use strict";

window.MundoCourseTimingPanel=function(openGate){
  const el=id=>document.getElementById(id);
  const input=el("timingFile"),otherInput=el("timingOther"),lapSelect=el("timingLap"),refSelect=el("timingRef");
  const gate=el("timingGate"),status=el("timingNotice"),data=el("timingData");
  const files={main:null,other:null},serial={main:0,other:0};
  let primary=null,external=null,shown=[],peak=null,view=0;
  const number=new Intl.NumberFormat("es");
  function clock(ms){
    if(ms===null)return "—";
    const mins=Math.floor(ms/60000),secs=Math.floor(ms%60000/1000);
    return mins+":"+String(secs).padStart(2,"0")+","+String(ms%1000).padStart(3,"0");
  }
  const delta=ms=>ms===null?"—":ms===0?"Igual":(ms<0?"−":"+")+clock(Math.abs(ms));
  const sameGate=(a,b)=>a.id===b.id && a.slot===b.slot && a.label===b.label;
  const compatible=(a,b)=>a.revision===b.revision && a.publication===b.publication && a.carRoot===b.carRoot && a.startMode===b.startMode &&
    a.total===b.total && a.gates.every((g,i)=>sameGate(g,b.gates[i]));
  const available=report=>report?[report,...report.history.filter(h=>h.run!==report.run).slice().reverse()]:[];
  function setOptions(select,choices,preferred){
    select.replaceChildren(...choices.map(([value,label])=>new Option(label,value)));
    if(choices.some(([v])=>v===preferred))select.value=preferred;
  }
  function lapName(lap){
    return "Vuelta "+number.format(lap.run)+(lap.phase==="ready"?" · preparada":
      lap.phase==="running"?" · en curso":" · "+clock(lap.elapsedMs));
  }
  function resetPicks(){
    const choices=available(primary).map(x=>[String(x.run),lapName(x)]);
    setOptions(lapSelect,choices,primary?String(primary.run):"");
    setBase();
  }
  function setBase(preferred="frozen"){
    const current=lapSelect.value,choices=[["frozen","Marca al iniciar esta vuelta"]];
    for(const [tag,report] of [["main",primary],["other",external]]){
      for(const lap of available(report)){
        if((tag==="main" && String(lap.run)===current) || (lap.phase && lap.phase!=="finished"))continue;
        choices.push([tag+"/"+lap.run,(tag==="other"?"Segundo informe · ":"Este informe · ")+lapName(lap)]);
      }
    }
    setOptions(refSelect,choices,preferred);draw();
  }
  function displayActions(){
    const i=shown.findIndex(r=>r.id===gate.value);
    el("timingLocate").disabled=i<0;
    el("timingPractice").disabled=el("timingZones").disabled=i<1;
  }
  function draw(){
    ++view;data.hidden=!primary;otherInput.disabled=!primary;
    el("timingClear").disabled=!primary;el("timingRemoveOther").disabled=!external;
    if(!primary){shown=[];peak=null;return;}
    const lap=available(primary).find(x=>String(x.run)===lapSelect.value);
    const [tag,id]=refSelect.value.split("/");
    const benchmark=tag==="frozen"?null:available(tag==="other"?external:primary).find(x=>String(x.run)===id);
    shown=benchmark?MundoCourseTiming.rows(primary,lap,benchmark):MundoCourseTiming.rows(primary,lap);
    const body=el("timingTable").tBodies[0];body.replaceChildren();
    peak=null;
    for(const r of shown){
      const tr=document.createElement("tr"),th=document.createElement("th");
      th.scope="row";th.textContent=r.slot+" · "+r.label;tr.append(th);
      for(const value of [clock(r.atMs),clock(r.referenceMs),delta(r.deltaMs),
                         clock(r.legMs),clock(r.referenceLegMs),delta(r.legDeltaMs)]){
        const td=document.createElement("td");td.textContent=value;tr.append(td);
      }
      body.append(tr);
      if(r.legDeltaMs>0 && (!peak || r.legDeltaMs>peak.legDeltaMs))peak=r;
    }
    const comparable=shown.filter(r=>r.legDeltaMs!==null).length;
    el("timingCoverage").textContent=peak?"Mayor pérdida de tramo: "+delta(peak.legDeltaMs)+" hasta "+peak.label+
      " · "+comparable+" de "+shown.length+" tramos comparables.":comparable?
      "En "+comparable+" de "+shown.length+" tramos comparables no hubo pérdida frente a la referencia.":
      "Faltan marcas contiguas para comparar tiempos de tramo.";
    const defaultGate=peak?.id??shown[Math.max(0,(lap.passed??shown.length)-1)].id;
    setOptions(gate,shown.map(r=>[r.id,r.slot+" · "+r.label]),defaultGate);
    el("timingPeak").disabled=!peak;
    el("timingIdentity").textContent=files.main+" · "+primary.worldName+" · revisión "+primary.revision+
      " · turismo "+primary.carRoot+" · "+MundoCourseTiming.startLabel(primary.startMode)+(external?" · segundo informe: "+files.other:"");
    displayActions();
  }
  async function read(which,chosen){
    if(!chosen)return;
    const own=++serial[which],base=primary;
    try{
      if(chosen.size>MundoCourseTiming.maxFileBytes)throw Error("El informe supera 256 KiB.");
      const report=MundoCourseTiming.parse(new TextDecoder("utf-8",{fatal:true}).decode(await chosen.arrayBuffer()));
      if(own!==serial[which] || (which==="other" && base!==primary))return;
      if(which==="other" && (!primary || !compatible(primary,report)))
        throw Error("Para comparar dos archivos deben coincidir la publicación, la revisión, el turismo, el modo de salida y las puertas en orden.");
      if(which==="main"){
        primary=report;external=null;files.other=null;++serial.other;
        files.main=chosen.name;resetPicks();
      }else{
        external=report;files.other=chosen.name;
        const best=available(external).find(l=>!l.phase || l.phase==="finished");
        setBase(best?"other/"+best.run:"frozen");
      }
      status.textContent=which==="main"?"Informe principal abierto.":external.history.length || external.phase==="finished"?
        "Segundo informe abierto. Ya puedes comparar sus vueltas completas.":"El segundo informe aún no contiene una vuelta completa.";
    }catch(error){if(own===serial[which])status.textContent=error.message;}
  }
  for(const [field,which] of [[input,"main"],[otherInput,"other"]]){
    field.onchange=()=>{const file=field.files?.[0];field.value="";void read(which,file);};
  }
  el("timingClear").onclick=()=>{
    ++serial.main;++serial.other;primary=external=null;files.main=files.other=null;
    resetPicks();el("timingTable").tBodies[0].replaceChildren();gate.replaceChildren();
    status.textContent="Informes retirados.";
  };
  el("timingRemoveOther").onclick=()=>{
    ++serial.other;external=null;files.other=null;setBase();status.textContent="Segundo informe retirado.";
  };
  lapSelect.onchange=()=>setBase(refSelect.value);refSelect.onchange=draw;
  gate.onchange=()=>{++view;displayActions();};
  el("timingPeak").onclick=()=>{if(peak){++view;gate.value=peak.id;displayActions();gate.focus();}};
  async function navigate(action){
    const report=primary,generation=++view,index=shown.findIndex(r=>r.id===gate.value);
    if(index<0 || (action!=="gate" && index===0))return;
    const current=()=>primary===report && generation===view;
    try{
      const done=await openGate(report,shown[index].id,action==="gate"?null:shown[index-1].id,current,action);
      if(done && current())status.textContent=action==="practice"?"Tramo seleccionado en el editor de práctica.":
        action==="zones"?"Tramo abierto en el comparador de carga.":"Puerta localizada en el borrador.";
    }catch(error){if(current())status.textContent=error.message;}
  }
  el("timingLocate").onclick=()=>navigate("gate");
  el("timingPractice").onclick=()=>navigate("practice");
  el("timingZones").onclick=()=>navigate("zones");
  draw();
};
