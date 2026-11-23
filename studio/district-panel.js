"use strict";

// A stationary comparison uses the same root ownership directory as the
// playing clients. The moving car and transition margins depend on live input.
window.MundoDistrictPanel = function (getDraft) {
  const el = id => document.getElementById(id);
  const panel = el("districtInspector"), point = el("districtPoint"), coords = el("districtCoordinates");
  const message = el("districtMessage"), table = el("districtReport");
  const target = el("districtNext"), targetCoords = el("districtNextCoordinates");
  const transfer = el("districtTransfer"), transferMessage = el("districtTransferMessage");
  const numbers = new Intl.NumberFormat("es");
  const distance = el("aheadDistance"), exactMeters = el("aheadMeters"), speed = el("aheadSpeed");
  const aheadReport=el("aheadReport"), detail=el("aheadDetail"), cellTable=el("aheadCells");
  const diagonal=el("aheadDiagonal"),stageTable=el("aheadStageReport"),viaSelect=el("aheadVia");
  const compare=el("compareGates"), compareStatus=el("compareStatus"), compareReport=el("compareReport");
  const usagePanel=MundoAheadUsagePanel();
  const metres=new Intl.NumberFormat("es",{maximumFractionDigits:2});
  let model = null;
  let journey=null,offset=0;
  let generation = 0, pending = null, legRequest = 0;
  let comparisonGeneration=0;

  function clear() {
    ++generation;
    ++legRequest;
    pending = null;
    clearModel();
  }

  function clearModel() {
    model = null;
    usagePanel.setDraft(null);
    point.replaceChildren();
    target.replaceChildren();
    coords.hidden = targetCoords.hidden = true;
    table.hidden = transfer.hidden = true;
    table.tBodies[0].replaceChildren();
    transfer.tBodies[0].replaceChildren();
    message.textContent = "";
    transferMessage.textContent = "";
    resetAhead("");
    invalidateComparison();
  }

  function summarize(world, cells) {
    const byCell = new Map();
    if (!cells) return {byCell, permanent:world.nodes.size};
    // Fill ownership once per node, including files with children before parents.
    const owners = new Map();
    let local = 0;
    for (const node of world.nodes.values()) {
      const path = [];
      let parent = node;
      while (parent.parent !== 0n && !owners.has(parent.id)) {
        path.push(parent.id);
        parent = world.nodes.get(parent.parent);
      }
      const root = owners.get(parent.id) ?? parent.id;
      for (const id of path) owners.set(id,root);
      const sector = cells.get(root);
      if (!sector) continue;
      const key = sector[0]+","+sector[1];
      byCell.set(key,(byCell.get(key) ?? 0)+1);
      ++local;
    }
    return {byCell,permanent:world.nodes.size-local};
  }

  const yieldTurn = () => new Promise(resolve => setTimeout(resolve,0));
  async function measure(draft,current) {
    const {world,report,bytes,vehicleRoot,sourceVersion,hasCar}=draft;
    const eligible=MundoZones.eligibleRoomBytes(bytes);
    const groups=eligible ? MundoZones.roomSectorGroups(world,world,vehicleRoot) : null;
    if (!groups) {
      // The resident-entity directory can describe more cells than MSP1 can offer.
      const index=eligible ? MundoZones.roomCellIndex(world,world,report.worldSha256,vehicleRoot) : null;
      const cells=index ? MundoZones.roomCells(index,report.worldSha256,world) : null;
      return {...summarize(world,cells),reason:eligible ? "sin catálogo de sectores" : "tamaño fuera del intervalo MSP1"};
    }
    const byCell=new Map(), localRows=new Map();
    let total=0, reason="", global=0, lastYield=performance.now();
    for (let i=0;i<groups.length;i++) {
      if (!current()) return null;
      const group=groups[i], key=i ? group.x+","+group.z : "global";
      if (i) byCell.set(key,group.world.nodes.size);
      if (!reason) {
        // Only lengths survive this iteration; the room hashes these same documents.
        const size=MundoWorld.encode(group.world,sourceVersion).byteLength;
        if (!i) global=size;
        total+=size;
        if (MundoZones.sectorCatalogFits(global,total,groups.length)) {
          if(i)localRows.set(key,{x:group.x,z:group.z,bytes:size,nodes:group.world.nodes.size,road:group.road});
        } else { reason="el catálogo supera el límite del anfitrión"; localRows.clear(); }
      }
      if (performance.now()-lastYield>=12) { await yieldTurn(); lastYield=performance.now(); }
    }
    return {byCell,localRows,globalBytes:global,hasCar,reason,permanent:groups[0].world.nodes.size};
  }

  function nearby(position, radius) {
    const cells = new Map();
    const bounds = MundoZones.roomWindow(position[0],position[1],radius);
    for (let x=bounds.left; x<=bounds.right; ++x) {
      for (let z=bounds.back; z<=bounds.front; ++z) {
        const key=x+","+z, count=model.byCell.get(key);
        if (count) cells.set(key,count);
      }
    }
    return cells;
  }

  function column(position, previous, radius) {
    const current = nearby(position,radius);
    const active = [...current.values()].reduce((sum,n) => sum+n,model.permanent);
    const rows = [current.size, model.permanent, active, model.total-active];
    if (previous) {
      const before = nearby(previous,radius);
      let entered=0, left=0;
      for (const [key,n] of current) if (!before.has(key)) entered+=n;
      for (const [key,n] of before) if (!current.has(key)) left+=n;
      rows.push(entered,left);
    }
    return rows;
  }

  function choice(position,profile,initial) {
    const full=reason=>({reason,parts:new Map([["full",model.bytes]]),size:model.bytes});
    if (model.reason) return full(model.reason);
    const [x,z]=position.map(MundoZones.cell), radius=model[profile];
    if ([x,z].some(n=>n < -2147483648 || n > 2147483647)) return full("centro fuera del intervalo MSP1");
    // MSP1 transfers a square without the live renderer's transition margins.
    const global=model.globalBytes, parts=new Map([["global",global]]);
    let size=global;
    for (let dx=-radius;dx<=radius;dx++) for (let dz=-radius;dz<=radius;dz++) {
      const key=(x+dx)+","+(z+dz), bytes=model.localRows.get(key)?.bytes;
      if (bytes!==undefined) { parts.set(key,bytes); size+=bytes; }
    }
    if (!MundoZones.sectorFits(profile,size,model.bytes,false)) return full("supera "+(profile==="mobile"?"4":"8")+" MiB");
    if (initial && !MundoZones.sectorFits(profile,size,model.bytes,true)) return full("ahorro inicial inferior al 25 %");
    return {reason:"",parts,size};
  }

  function transferColumn(position,destination,profile) {
    const first=choice(position,profile,true);
    const mode=plan=>plan.reason ? "Archivo completo · "+plan.reason : "Sectores MSP1";
    const count=n=>numbers.format(n), bytes=n=>count(n)+" bytes";
    const result=[mode(first),count(first.parts.size),bytes(first.size)];
    if (!destination) return result;
    const next=first.reason ? first : choice(destination,profile,false);
    let added=0,download=0;
    for (const [key,size] of next.parts) {
      if (!first.parts.has(key)) { ++added; download+=size; }
    }
    result.push(first.reason ? "Archivo completo ya disponible" : mode(next),
      count(next.parts.size-added),count(added),bytes(download));
    return result;
  }

  function renderRows(output,labels,mobile,pc) {
    const rows=mobile.map((value,i)=>{
      const tr=document.createElement("tr"), title=document.createElement("th");
      title.scope="row"; title.textContent=labels[i]; tr.append(title);
      for (const content of [value,pc[i]]) {
        const td=document.createElement("td"); td.textContent=content; tr.append(td);
      }
      return tr;
    });
    output.tBodies[0].replaceChildren(...rows);
    output.hidden=false;
  }

  function clearForecast() {
    aheadReport.hidden=detail.hidden=diagonal.hidden=el("aheadMap").hidden=true;
    aheadReport.tBodies[0].replaceChildren();
    cellTable.tBodies[0].replaceChildren();
    stageTable.tBodies[0].replaceChildren();
    el("aheadMapText").textContent="";
  }
  function resetAhead(text) {
    journey=null;offset=0;
    el("aheadControls").hidden=true;
    el("aheadAvailability").textContent=text;
    el("aheadPosition").textContent="";
    clearForecast();
  }
  function configureAhead(start,end) {
    if(!end) { resetAhead("Elige un destino para inspeccionar el tramo.");return; }
    if(model.reason) { resetAhead("Precarga no disponible en este borrador · "+model.reason+".");return; }
    const leg=MundoAheadInspector.segment(start,end);
    if(!leg) { resetAhead("El origen y el destino deben ser puntos distintos.");return; }
    if(!model.hasCar) { resetAhead("Elige un turismo compatible con la sala para inspeccionar su precarga.");return; }
    const key=[...start,...end].join("/");
    if(journey?.key!==key) {
      const first={mobile:choice(start,"mobile",true),pc:choice(start,"pc",true)};
      if(first.mobile.reason && first.pc.reason){
        resetAhead("Archivo completo desde el origen. Móvil: "+first.mobile.reason+". PC: "+first.pc.reason+".");
        return;
      }
      journey={key,leg,first};
      offset=0;
      distance.max=exactMeters.max=String(leg.length);
      distance.value=exactMeters.value="0";
    }
    el("aheadControls").hidden=false;
    el("aheadAvailability").textContent="Longitud del tramo · "+metres.format(leg.length)+" m.";
    showAhead();
  }
  const byteLabel=n=>numbers.format(n)+" bytes";
  const lookup=(x,z)=>model.localRows.get(x+","+z);
  function enteringBytes(before,after) {
    let bytes=0;
    for(const [key,size] of after.parts)if(!before.parts.has(key))bytes+=size;
    return bytes;
  }
  function stageForecast(profile,aim,rows,via,current,next) {
    const stages=MundoZones.aheadStages(profile,aim,rows,via);
    if(!stages)return {reason:"No se pudo distribuir esta oferta entre las dos ventanas."};
    const middle=choice([stages.x*64,stages.z*64],profile,false);
    if(middle.reason)return {reason:"La ventana intermedia requiere el archivo completo · "+middle.reason};
    return {...stages,middleRequired:enteringBytes(current,middle),finalRequired:enteringBytes(middle,next)};
  }
  function forecastCrossing(profile,aim,inspectStages=false) {
    // An offered crossing originates in a confirmed window. Its initial
    // download may have taken place earlier, in a different cell.
    const current=choice([aim.fromX*64,aim.fromZ*64],profile,false);
    if(current.reason)return {reason:"Archivo completo en la posición actual · "+current.reason};
    const next=choice([aim.cx*64,aim.cz*64],profile,false);
    if(next.reason)return {reason:"Archivo completo en el cruce · "+next.reason};
    const newBytes=enteringBytes(current,next);
    const rows=MundoZones.aheadRows(profile,aim,lookup);
    const bytes=rows.reduce((sum,row)=>sum+row.bytes,0);
    let stages=null;
    if(inspectStages && aim.axisX && aim.axisZ)stages={
      x:stageForecast(profile,aim,rows,"x",current,next),
      z:stageForecast(profile,aim,rows,"z",current,next)
    };
    return {newBytes,rows,bytes,remaining:newBytes-bytes,road:rows.filter(row=>row.road).length,stages};
  }
  function forecast(profile,first,sample,inspectStages=false) {
    if(first.reason)return {reason:"Archivo completo en el origen · "+first.reason};
    return forecastCrossing(profile,sample.aim,inspectStages);
  }
  function estimateOffer(row) {
    if(model.reason)return {reason:model.reason};
    if(!model.hasCar)return {reason:"El borrador necesita un turismo compatible con la sala."};
    const {profile,fromX,fromZ,cx,cz}=row;
    const aim={fromX,fromZ,cx,cz,axisX:cx-fromX,axisZ:cz-fromZ};
    const estimate=forecastCrossing(profile,aim,true);
    if(estimate.reason)return estimate;
    return {plannedBytes:estimate.bytes,requiredBytes:estimate.newBytes,rows:estimate.rows,aim,lookup,stages:estimate.stages};
  }
  function showStageTable(result,profile) {
    diagonal.hidden=!result.stages;
    if(diagonal.hidden)return;
    el("aheadStageCaption").textContent="Demanda y precarga aprovechable · "+(profile==="mobile"?"Móvil":"PC");
    function amounts(required,offered) {
      const td=document.createElement("td"),total=document.createElement("span"),planned=document.createElement("span");
      total.textContent=byteLabel(required)+" nuevos";
      planned.textContent=byteLabel(offered)+" adelantables";
      td.append(total,planned);
      return td;
    }
    const body=stageTable.tBodies[0];
    body.replaceChildren();
    for(const via of ["","x","z"]) {
      const row=document.createElement("tr"),label=document.createElement("th");
      label.scope="row";
      label.textContent=via?via.toUpperCase()+" primero":"Salto directo";
      row.append(label);
      const path=result.stages[via];
      if(!via) {
        const middle=document.createElement("td");
        middle.textContent="—";
        row.append(middle,amounts(result.newBytes,result.bytes));
      } else if(path.reason) {
        const fallback=document.createElement("td");
        fallback.colSpan=2;fallback.textContent=path.reason;
        row.append(fallback);
      } else {
        label.textContent+=" · ("+path.x+", "+path.z+")";
        row.append(amounts(path.middleRequired,path.middleBytes),amounts(path.finalRequired,path.finalBytes));
      }
      body.append(row);
    }
  }
  function showAhead() {
    if(!journey)return;
    const {leg}=journey,velocity=speed.valueAsNumber;
    const validSpeed=Number.isFinite(velocity) && velocity>=-4 && velocity<=14;
    const validOffset=Number.isFinite(offset) && offset>=0 && offset<=leg.length;
    const crossing=step=>validSpeed && validOffset?MundoAheadInspector.nearCrossing(leg,offset,velocity,step):null;
    el("aheadPrevious").disabled=crossing(-1)===null;
    el("aheadNext").disabled=crossing(1)===null;
    const status=el("aheadPosition");
    if(!validSpeed || !validOffset){
      clearForecast();
      status.textContent=!validSpeed?"Escribe una velocidad entre −4 y 14 m/s.":"Escribe una distancia dentro del tramo.";
      return;
    }
    distance.setAttribute("aria-valuetext",metres.format(offset)+" metros desde el origen");
    const sample=MundoAheadInspector.sample(leg,offset,velocity),aim=sample.aim;
    const motion=velocity<0?"Marcha atrás hacia el destino":velocity===0?"Turismo detenido":"Avance hacia el destino";
    const location=motion+" · X "+metres.format(sample.x)+" m · Z "+metres.format(sample.z)+" m. ";
    if(!aim){
      clearForecast();
      const explanation=offset>=leg.length?"Fin del tramo.":Math.abs(velocity)<2?
        "La precarga requiere al menos 2 m/s en cualquier sentido.":"No hay un cruce próximo dentro del tramo a esta velocidad.";
      status.textContent=location+explanation;
      return;
    }
    status.textContent=location+"Celda ("+aim.fromX+", "+aim.fromZ+") hacia ("+aim.cx+", "+aim.cz+").";
    const profile=el("aheadProfile").value;
    const results={mobile:forecast("mobile",journey.first.mobile,sample,profile==="mobile"),
      pc:forecast("pc",journey.first.pc,sample,profile==="pc")};
    const labels=["Ventana al cruzar","Contenido nuevo del próximo MSP1","Celdas adelantables","Contenido que se puede adelantar",
      "Contenido pendiente al cruzar","Celdas adelantables con posible apoyo","Presupuesto de precarga"];
    function columnFor(profile) {
      const r=results[profile],limit=MundoZones.aheadLimits(profile);
      const budget=byteLabel(limit.bytes)+" · "+limit.rows+" celdas";
      return r.reason?[r.reason,"—","—","—","—","—",budget]:
        ["Sectores MSP1",byteLabel(r.newBytes),String(r.rows.length),byteLabel(r.bytes),byteLabel(r.remaining),String(r.road),budget];
    }
    renderRows(aheadReport,labels,columnFor("mobile"),columnFor("pc"));
    detail.hidden=false;
    const result=results[profile];
    showStageTable(result,profile);
    const path=result.stages?.[viaSelect.value];
    const reason=result.reason || path?.reason;
    const canvas=el("aheadMap"),mapText=el("aheadMapText");
    cellTable.tBodies[0].replaceChildren();
    cellTable.hidden=Boolean(reason)||!result.rows.length;
    if(reason){canvas.hidden=true;mapText.textContent=reason;return;}
    const firstRows=new Set(path?.middleRows);
    for(const [i,row] of result.rows.entries()){
      const tr=document.createElement("tr"),pos=document.createElement("th");
      pos.scope="row";pos.textContent=(i+1)+" · ("+row.x+", "+row.z+")"+
        (path?(firstRows.has(row)?" · Intermedio":" · Destino"):"");tr.append(pos);
      for(const value of [byteLabel(row.bytes),row.road?"Sí":"—"]){
        const td=document.createElement("td");td.textContent=value;tr.append(td);
      }
      cellTable.tBodies[0].append(tr);
    }
    mapText.textContent=(result.rows.length?"Los números siguen el orden de la tabla. ":"No se adelantan celdas en este cruce. ")+
      "El borde azul continuo marca la ventana actual y el ámbar discontinuo la futura. Las celdas numeradas en verde tienen posible apoyo."+
      (path?" El borde violeta punteado marca la ventana intermedia, centrada en ("+path.x+", "+path.z+").":"");
    canvas.hidden=false;
    MundoAheadInspector.draw(canvas,aim,profile,lookup,result.rows,path?.via);
  }
  function setOffset(value,reflect=true) {
    if(!journey)return;
    offset=value;
    if(Number.isFinite(value) && value>=0 && value<=journey.leg.length){
      distance.value=String(value);
      if(reflect)exactMeters.value=String(value);
    }
    showAhead();
  }
  function jump(step) {
    if(!journey)return;
    const value=MundoAheadInspector.nearCrossing(journey.leg,offset,speed.valueAsNumber,step);
    if(value!==null)setOffset(value);
  }

  function invalidateComparison() {
    ++comparisonGeneration;
    compareReport.hidden=true;
    compareReport.tBodies[0].replaceChildren();
    const velocity=speed.valueAsNumber;
    let reason="";
    if(model?.reason)reason="Comparación no disponible · "+model.reason+".";
    else if(model && !model.hasCar)reason="El circuito necesita un turismo compatible con la sala.";
    else if(model && model.stops.length<2)reason="Añade una puerta al recorrido para comparar sus cruces.";
    else if(model && (!Number.isFinite(velocity) || velocity< -4 || velocity>14 || Math.abs(velocity)<2))
      reason="Usa una velocidad entre −4 y 14 m/s y de al menos 2 m/s en cualquier sentido.";
    compare.disabled=!model || Boolean(reason);
    compareStatus.textContent=reason;
  }
  // Yield candidates before sampling. One lookahead establishes whether a budget
  // of exactly 256 samples exhausted the route without evaluating a 257th point.
  function* crossingCandidates(stops,velocity) {
    for(let index=1;index<stops.length;++index){
      const start=stops[index-1].position,end=stops[index].position;
      const leg=MundoAheadInspector.segment(start,end);
      if(!leg || start.every((v,axis)=>MundoZones.cell(v)===MundoZones.cell(end[axis])))continue;
      const visited=new Set();
      let meters=0;
      for(;;){
        yield {index,leg,meters,visited};
        const next=MundoAheadInspector.nearCrossing(leg,meters,velocity,1);
        if(next===null || next<=meters)break;
        meters=next;
      }
    }
  }
  function compareLink(profile,hit,text,ticket){
    const button=document.createElement("button");
    button.type="button";
    const route=model.stops[hit.index-1].label+" → "+model.stops[hit.index].label;
    button.textContent=text+" · "+route+" · "+metres.format(hit.meters)+" m";
    button.setAttribute("aria-label","Inspeccionar · "+(profile==="mobile"?"Móvil":"PC")+" · "+button.textContent);
    button.addEventListener("click",()=>{
      if(ticket!==comparisonGeneration || !model)return;
      point.value=String(hit.index-1);target.value=String(hit.index);
      el("aheadProfile").value=profile;
      show();setOffset(hit.meters);distance.focus();
    });
    return button;
  }
  function publishComparison(results,ticket) {
    for(const profile of ["mobile","pc"]){
      const r=results[profile],header=document.createElement("th"),row=document.createElement("tr");
      header.scope="row";header.textContent=profile==="mobile"?"Móvil":"PC";row.append(header);
      const peak=document.createElement("td"),fallback=document.createElement("td");
      if(r.worst)peak.append(compareLink(profile,r.worst,byteLabel(r.worst.remaining),ticket));
      else peak.textContent="Sin cruce MSP1";
      if(r.fullCount)fallback.append(compareLink(profile,r.firstFull,r.fullCount+" · Ver primero",ticket));
      else fallback.textContent="0";
      row.append(peak,fallback);compareReport.tBodies[0].append(row);
    }
    compareReport.hidden=false;
  }
  async function compareCrossings(){
    invalidateComparison();
    if(compare.disabled)return;
    const ticket=comparisonGeneration,velocity=speed.valueAsNumber,limit=256;
    const result=()=>({worst:null,fullCount:0,firstFull:null});
    const results={mobile:result(),pc:result()};
    let checked=0,crossings=0,incomplete=false,activeLeg=0,first;
    compareStatus.textContent="Comparando los cruces del circuito…";
    await yieldTurn();
    if(ticket!==comparisonGeneration)return;
    try{
      for(const candidate of crossingCandidates(model.stops,velocity)){
        if(checked===limit){incomplete=true;break;}
        const {index,leg,meters,visited}=candidate;
        const sample=MundoAheadInspector.sample(leg,meters,velocity),aim=sample.aim;
        ++checked;
        if(aim){
          const signature=[aim.fromX,aim.fromZ,aim.cx,aim.cz].join("/");
          if(!visited.has(signature)){
            visited.add(signature);++crossings;
            if(activeLeg!==index){
              const start=model.stops[index-1].position;
              first={mobile:choice(start,"mobile",true),pc:choice(start,"pc",true)};
              activeLeg=index;
            }
            for(const profile of ["mobile","pc"]){
              const forecasted=forecast(profile,first[profile],sample),r=results[profile];
              if(forecasted.reason){
                ++r.fullCount;
                if(!r.firstFull)r.firstFull={index,meters};
              }else if(!r.worst || forecasted.remaining>r.worst.remaining){
                r.worst={index,meters,remaining:forecasted.remaining};
              }
            }
          }
        }
        if(checked%8===0){
          await yieldTurn();
          if(ticket!==comparisonGeneration)return;
        }
      }
      const scope=incomplete?"Comparación parcial. Se alcanzó el límite y quedan posiciones por inspeccionar. ":"Recorrido completo. ";
      const samples=checked===1?"1 posición examinada":checked+" posiciones examinadas";
      const count=crossings===1?"1 cruce previsto":crossings+" cruces previstos";
      compareStatus.textContent=scope+samples+" · "+count+".";
      if(crossings)publishComparison(results,ticket);
    }catch(error){
      if(ticket===comparisonGeneration)compareStatus.textContent="No se pudo comparar el recorrido. "+error.message;
    }
  }
  compare.addEventListener("click",compareCrossings);
  distance.addEventListener("input",()=>setOffset(distance.valueAsNumber));
  exactMeters.addEventListener("input",()=>setOffset(exactMeters.valueAsNumber,false));
  speed.addEventListener("input",()=>{invalidateComparison();showAhead();});
  el("aheadProfile").addEventListener("change",showAhead);
  viaSelect.addEventListener("change",showAhead);
  el("aheadPrevious").addEventListener("click",()=>jump(-1));
  el("aheadNext").addEventListener("click",()=>jump(1));

  const validPosition = position=>position.every(n=>Number.isFinite(n) && Math.abs(n)<=1e15);
  function showTransfer(position,index) {
    const auto=target.value==="auto", custom=target.value==="custom";
    targetCoords.hidden=!custom;
    const stop=auto ? model.stops[index+1] : model.stops[Number(target.value)];
    const destination=custom ? [el("districtNextX").valueAsNumber,el("districtNextZ").valueAsNumber] : stop?.position;
    const valid=destination && validPosition(destination);
    transferMessage.textContent=custom ? (valid ? "Destino en las coordenadas indicadas." : "Escribe coordenadas de destino válidas.")
      : stop ? "Destino del tramo · "+stop.label : "Fin del recorrido. Puedes elegir otro destino.";
    const labels=["Al entrar aquí","Documentos iniciales","Contenido inicial","Al llegar al destino",
      "Documentos reutilizados","Documentos nuevos","Contenido nuevo"];
    const column=profile=>transferColumn(position,valid?destination:null,profile);
    renderRows(transfer,labels,column("mobile"),column("pc"));
    configureAhead(position,valid?destination:null);
  }

  function show() {
    if (!model) return;
    const custom = point.value==="custom";
    coords.hidden = !custom;
    const index = Number(point.value);
    const position = custom ? [el("districtX").valueAsNumber,el("districtZ").valueAsNumber]
                            : model.stops[index].position;
    table.hidden=transfer.hidden=true;
    transferMessage.textContent="";
    if (!validPosition(position)) {
      message.textContent="Escribe coordenadas X y Z válidas.";
      resetAhead("");
      return;
    }
    const center = position.map(MundoZones.cell);
    const previous = !custom && index>0 ? model.stops[index-1].position : null;
    const mobile = column(position,previous,model.mobile), pc = column(position,previous,model.pc);
    const labels = ["Celdas locales con piezas","Entidades permanentes","Entidades activas",
      "Fuera de la zona activa","Entran desde la parada anterior","Salen desde la parada anterior"];
    renderRows(table,labels,mobile.map(n=>numbers.format(n)),pc.map(n=>numbers.format(n)));
    showTransfer(position,custom ? -1 : index);
    message.textContent="Celda X "+numbers.format(center[0])+" · Z "+numbers.format(center[1])+". "+
      (model.byCell.size ? "Al moverse se pueden conservar temporalmente celdas adicionales."
                         : "Esta revisión se mantiene completa en ambos perfiles.");
  }

  function refresh(snapshot) {
    if (!panel.open || model) return;
    if (!pending) pending=buildModel(snapshot,++generation);
    return pending;
  }
  async function buildModel(snapshot,ticket) {
    const current=()=>ticket===generation;
    message.textContent="Calculando el contenido de los barrios…";
    try {
      await yieldTurn();
      if (!current()) return;
      const draft=getDraft(snapshot);
      if (!draft) { message.textContent=""; return; }
      const {world,report,bytes}=draft;
      const measured=await measure(draft,current);
      if (!current()) return;
      const stops=[{label:"Entrada del mundo",position:report.focus}];
      for (const gate of MundoCircuit.scan(world))
        stops.push({id:String(gate.id),label:"Puerta "+gate.slot+" · "+gate.label,position:[gate.point[0],gate.point[2]]});
      model={...measured,stops,bytes,total:world.nodes.size,
        mobile:report.profiles.mobile.radius,pc:report.profiles.pc.radius};
      usagePanel.setDraft({revision:report.worldSha256,carRoot:draft.carRoot,estimate:estimateOffer});
      invalidateComparison();
      const options=()=>[...stops.map((stop,i)=>new Option(stop.label,String(i))),new Option("Otras coordenadas","custom")];
      point.replaceChildren(...options());
      target.replaceChildren(new Option("Siguiente en el recorrido","auto"),...options());
      el("districtX").value=String(report.focus[0]); el("districtZ").value=String(report.focus[1]);
      el("districtNextX").value=String(report.focus[0]); el("districtNextZ").value=String(report.focus[1]);
      show();
    } catch (error) {
      if (!current()) return;
      clearModel();
      message.textContent="No se pudo analizar este recorrido. "+error.message;
    } finally { if (current()) pending=null; }
  }
  async function inspectGateLeg(firstId,lastId,current) {
    if(!current())return false;
    const request=++legRequest;
    panel.open=true;
    if(!model)await refresh();
    if(request!==legRequest || !current() || !panel.open)return false;
    if(!model)throw Error(message.textContent || "Falta el análisis de zonas del borrador.");
    // Stop zero is the world entrance and has no authored gate identity.
    const start=model.stops.findIndex(stop=>stop.id===firstId);
    if(start<1 || typeof lastId!=="string" || model.stops[start+1]?.id!==lastId)
      throw Error("Las dos puertas del informe no forman un tramo consecutivo de este borrador.");
    point.value=String(start);
    target.value=String(start+1);
    show();
    target.focus();
    return true;
  }
  panel.addEventListener("toggle",()=>{if (!panel.open && pending) clear(); else refresh();});
  target.onchange=point.onchange=()=>{++legRequest;show();};
  el("districtNextLocate").onclick=el("districtLocate").onclick=show;
  for (const fields of [coords,targetCoords]) fields.addEventListener("keydown",event=>{
    if(event.key==="Enter"){event.preventDefault();show();}
  });
  return {clear,refresh,inspectGateLeg};
};
