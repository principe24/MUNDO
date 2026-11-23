"use strict";

// The imported session and its derived comparisons live only in this Studio tab.
window.MundoAheadUsagePanel=function(){
  const el=id=>document.getElementById(id);
  const file=el("usageFile"),status=el("usageStatus"),controls=el("usageControls");
  const revision=el("usageRevision"),epoch=el("usageEpoch"),seat=el("usageSeat"),profile=el("usageProfile");
  const state=el("usageState"),routeKind=el("usageRouteKind");
  const entry=el("usageEntry"),summary=el("usageSummary"),detail=el("usageDetail"),map=el("usageMap");
  const analyze=el("usageAnalyze"),clear=el("usageClear"),entryText=el("usageEntryText");
  const peak=el("usagePeak"),peakStatus=el("usagePeakStatus");
  const numbers=new Intl.NumberFormat("es");
  const name={mobile:"Móvil",pc:"PC",unreported:"Sin informe del cliente",active:"Informe abierto",
    turned:"Giro o inversión de marcha",changed:"Previsión cambiada",released:"Precarga liberada",crossed:"Cruce confirmado por el cliente"};
  const fmt=n=>numbers.format(n);
  const bytes=n=>n==null?"Sin dato":fmt(n)+" B";
  let report=null,draft=null,selection=[],peakEntry=null,ticket=0;
  const estimates=new Map();
  function options(sel,items,preferred){
    sel.replaceChildren(...items.map(([value,label])=>new Option(label,String(value))));
    if(items.some(([value])=>String(value)===String(preferred)))sel.value=String(preferred);
  }
  function table(output,rows){
    output.tBodies[0].replaceChildren(...rows.map(([label,...values])=>{
      const tr=document.createElement("tr"),th=document.createElement("th");
      th.scope="row";th.textContent=label;tr.append(th);
      for(const value of values){
        const td=document.createElement("td");td.textContent=value;tr.append(td);
      }
      return tr;
    }));
  }
  function matches(row){
    return draft && row.revision===draft.revision && row.carRoot!==null && row.carRoot===draft.carRoot;
  }
  function estimate(row){
    if(!matches(row))return null;
    if(!estimates.has(row.ordinal))estimates.set(row.ordinal,draft.estimate(row));
    return estimates.get(row.ordinal);
  }
  function setEpoch(){
    const rows=report.entries.filter(r=>!revision.value || r.revision===revision.value);
    const epochs=[...new Set(rows.map(r=>r.epoch))].sort((a,b)=>a-b);
    options(epoch,[["","Todos los viajes"],...epochs.map(i=>[i,i===0?"Sala de un mundo":"Época "+fmt(i)])],epoch.value);
  }
  function pathKind(row){
    if(report.version===1)return "legacy";
    if(row.via)return row.via;
    return row.state==="crossed"?"destination":"unknown";
  }
  function comparable(row,info){
    if(row.state!=="crossed" || !info || info.reason || info.plannedBytes!==row.plannedBytes ||
       info.requiredBytes!==row.requiredBytes)return false;
    return !row.via || Boolean(info.stages?.[row.via] && !info.stages[row.via].reason);
  }
  function totals(rows){
    const sent=rows.reduce((n,r)=>n+r.servedBytes,0);
    const unique=rows.reduce((n,r)=>n+r.uniqueServedBytes,0);
    const aborted=rows.reduce((n,r)=>n+r.interruptedPages,0);
    const complete=rows.filter(r=>MundoAheadReport.closed(r.state));
    const turns=rows.filter(r=>r.state==="turned");
    const unfinished=rows.filter(r=>r.state==="active").length;
    const silent=rows.filter(r=>r.state==="unreported").length;
    const sum=(list,key)=>list.reduce((n,r)=>n+r[key],0);
    const compared=complete.filter(r=>comparable(r,estimate(r)));
    const projected=compared.reduce((n,r)=>n+estimate(r).plannedBytes,0);
    const via=rows.filter(r=>r.via!==null);
    const figures=[fmt(rows.length),fmt(silent),fmt(unfinished),fmt(complete.length),
      rows.length?bytes(sent):"—",rows.length?bytes(sent-unique):"—",rows.length?fmt(aborted):"—",
      complete.length?bytes(sum(complete,"verifiedBytes")):"—",complete.length?bytes(sum(complete,"usedBytes")):"—",
      complete.length?bytes(sum(complete,"discardedBytes")):"—",
      fmt(turns.length),turns.length?bytes(sum(turns,"discardedBytes")):"—",fmt(compared.length),
      compared.length?bytes(projected):"—",compared.length?bytes(sum(compared,"usedBytes")):"—",
      ...[via.length,via.filter(r=>r.state==="crossed").length,via.filter(r=>r.state==="active").length,
        via.filter(r=>r.state!=="crossed" && MundoAheadReport.closed(r.state)).length]
        .map(n=>report.version===2?fmt(n):"Sin desglose")];
    return figures;
  }
  function selectRows(previous=entry.value){
    selection=report.entries.filter(r=>(!revision.value || revision.value===r.revision) &&
      (!epoch.value || Number(epoch.value)===r.epoch) && (!seat.value || Number(seat.value)===r.seat) &&
      (!profile.value || profile.value===r.profile) && (!state.value || state.value===r.state) &&
      (!routeKind.value || routeKind.value===pathKind(r)));
    const labels=["Ofertas","Sin informe del cliente","Informes abiertos","Informes cerrados",
      "Servidos por el anfitrión","Reenvíos incluidos en lo servido","Respuestas de página interrumpidas",
      "Verificados en informes cerrados","Usados en informes cerrados","Descartados en informes cerrados",
      "Cierres por giro o inversión de marcha","Descartados en esos giros o inversiones",
      "Cruces instalados comparables con el borrador","Studio · bytes adelantables en esos cruces",
      "Cliente · bytes usados en esos mismos cruces","Ofertas con instalación intermedia declarada",
      "Con intermedia y destino instalados","Con intermedia y recibo aún abierto",
      "Cerradas tras la intermedia sin instalación final declarada"];
    const mobile=totals(selection.filter(r=>r.profile==="mobile")),pc=totals(selection.filter(r=>r.profile==="pc"));
    table(summary,labels.map((label,i)=>[label,mobile[i],pc[i]]));
    options(entry,selection.map(r=>[r.ordinal,"#"+r.ordinal+" · "+name[r.profile]+" · plaza "+r.seat+
      " · ("+r.fromX+", "+r.fromZ+") → ("+r.cx+", "+r.cz+") · "+name[r.state]]),previous);
    entry.disabled=!selection.length;
    peakEntry=null;
    let matchingCount=0,widest=0;
    for(const row of selection){
      if(row.state!=="crossed")continue;
      const model=estimate(row);
      if(!comparable(row,model))continue;
      ++matchingCount;
      const gap=model.plannedBytes-row.usedBytes;
      if(gap>widest){widest=gap;peakEntry=row;}
    }
    peak.disabled=!peakEntry;
    peakStatus.textContent=peakEntry?fmt(matchingCount)+" cruces comparables · mayor diferencia: "+bytes(widest)+
      " en la oferta #"+peakEntry.ordinal+".":
      matchingCount?"Se aprovechó toda la precarga prevista en los "+fmt(matchingCount)+" cruces comparables.":
      "Este filtro carece de cruces instalados con una previsión coincidente.";
    showEntry();
  }
  function showPeers(row){
    const wrapper=el("usagePeers");
    wrapper.hidden=!row || row.carRoot===null || pathKind(row)==="unknown";
    if(wrapper.hidden)return;
    const same=report.entries.filter(r=>r.state==="crossed" && r.revision===row.revision && r.epoch===row.epoch &&
      (report.version===1 || r.via===row.via) && r.carRoot===row.carRoot && r.fromX===row.fromX && r.fromZ===row.fromZ && r.cx===row.cx && r.cz===row.cz);
    function group(which){
      const rows=same.filter(r=>r.profile===which);
      if(!rows.length)return ["0","—","—","—","—"];
      const sum=key=>rows.reduce((n,r)=>n+r[key],0);
      const offered=sum("plannedBytes"),used=sum("usedBytes");
      const average=n=>bytes(Math.round(n/rows.length));
      return [fmt(rows.length),average(sum("requiredBytes")),average(offered),average(used),
        new Intl.NumberFormat("es",{style:"percent",maximumFractionDigits:1}).format(used/offered)];
    }
    const a=group("mobile"),b=group("pc");
    table(el("usagePeerTable"),["Pasadas con informe de instalación","Demanda media del cruce directo",
      "Media ofrecida en precarga","Media usada por el cliente","Porción usada del total ofrecido"].map((label,i)=>[label,a[i],b[i]]));
  }
  function showEntry(){
    map.hidden=true;table(detail,[]);
    const row=selection.find(r=>r.ordinal===Number(entry.value));
    detail.hidden=!row;showPeers(row);
    analyze.hidden=!!draft || !row;
    if(!row){entryText.textContent="Ninguna oferta coincide con los filtros.";return;}
    const info=estimate(row),items=[];
    const add=(source,label,value)=>items.push([source,label,value]);
    add("Sala","Demanda de la oferta para el cruce directo",bytes(row.requiredBytes));
    add("Sala","Datos ofrecidos por adelantado",bytes(row.plannedBytes));
    add("Anfitrión","Contenido servido, con reenvíos",bytes(row.servedBytes));
    add("Anfitrión","Contenido servido una vez por página",bytes(row.uniqueServedBytes));
    add("Anfitrión","Respuestas interrumpidas",fmt(row.interruptedPages));
    add("Cliente","Contenido verificado",bytes(row.verifiedBytes));
    add("Cliente","Contenido usado al instalar",bytes(row.usedBytes));
    add("Cliente","Contenido verificado y descartado al cierre",bytes(row.discardedBytes));
    const middle=row.via==="x"?[row.cx,row.fromZ]:row.via==="z"?[row.fromX,row.cz]:null;
    if(report.version===1){
      add("Registro v1","Uso por etapa","Solo se guardó el total");
    }else if(row.state==="unreported"){
      add("Cliente","Instalación por etapa","Sin informe del jugador");
    }else{
      const first=middle?"("+middle.join(", ")+") · primero por "+row.via.toUpperCase():"Sin instalación intermedia declarada";
      add("Cliente","Paso intermedio",first);
      if(middle)add("Cliente","Bytes usados por primera vez en la intermedia",bytes(row.middleBytes));
      add("Cliente","Bytes usados por primera vez en el destino",
        row.state==="crossed"?bytes(row.finalBytes):"Sin instalación final declarada");
    }
    let comparison;
    if(!draft)comparison="Analiza el borrador para calcular su previsión local.";
    else if(!matches(row))comparison=row.revision!==draft.revision?
      "Abre y analiza la publicación con esta misma huella para compararla.":
      "La comparación requiere el mismo turismo que figura en la oferta.";
    else if(info?.reason)comparison="Previsión local no disponible · "+info.reason+".";
    else if(info){
      add("Studio","Demanda prevista del cruce directo",bytes(info.requiredBytes));
      add("Studio","Contenido adelantable previsto",bytes(info.plannedBytes));
      const stages=middle && info.stages?.[row.via];
      if(stages && !stages.reason){
        add("Studio","Demanda de archivos nuevos al entrar en la intermedia",bytes(stages.middleRequired));
        add("Studio","Demanda de archivos nuevos de la intermedia al destino",bytes(stages.finalRequired));
        add("Studio","Precarga que podría usarse ya en la intermedia",bytes(stages.middleBytes));
        add("Studio","Precarga restante para el destino si se usa toda la anterior",bytes(stages.finalBytes));
      }else if(stages?.reason)add("Studio","Paso intermedio",stages.reason);
      const unavailable=Boolean(middle && (!stages || stages.reason));
      if(row.state==="crossed" && !unavailable){
        if(!middle)add("Comparación","Demanda directa menos la precarga aprovechada",bytes(row.requiredBytes-row.usedBytes));
        const delta=row.usedBytes-info.plannedBytes;
        const sign=delta>0?"+":delta<0?"−":"";
        add("Comparación","Usados por el cliente menos previstos por Studio",sign+bytes(Math.abs(delta)));
      }
      comparison=unavailable?"Studio carece de una previsión por sectores para el paso intermedio declarado.":
        info.requiredBytes===row.requiredBytes && info.plannedBytes===row.plannedBytes?
        "La previsión de Studio coincide con la oferta de la sala.":
        "La previsión de Studio y la oferta de la sala difieren. Se muestran ambas cifras.";
      map.hidden=unavailable;
      if(!unavailable)MundoAheadInspector.draw(map,info.aim,row.profile,info.lookup,info.rows,row.via);
      if(middle && !unavailable)comparison+=" El contorno violeta marca la intermedia. Los números indican prioridad prevista por Studio.";
    }else comparison="No hay previsión disponible para esta oferta.";
    entryText.textContent="Revisión "+row.revision+" · turismo "+(row.carRoot??"sin identificar")+
      " · "+(row.epoch?"época "+row.epoch:"sala de un mundo")+" · "+name[row.state]+". "+comparison;
    table(detail,items);
  }
  function displayReport(){
    controls.hidden=!report;clear.disabled=!report;
    if(!report){
      peakEntry=null;peakStatus.textContent="";entryText.textContent="";
      for(const sel of [revision,epoch,seat,profile,state,routeKind,entry])sel.replaceChildren();
      for(const output of [summary,detail,el("usagePeerTable")])table(output,[]);
      map.getContext("2d")?.clearRect(0,0,map.width,map.height);
      el("usagePeers").hidden=map.hidden=analyze.hidden=true;
      return;
    }
    const revisions=[...new Set(report.entries.map(r=>r.revision))];
    options(revision,[["","Todas las revisiones"],...revisions.map(v=>[v,v])],draft?.revision??"");
    options(seat,[["","Ambas plazas"],["1","Plaza 1"],["2","Plaza 2"]],"");
    options(profile,[["","Ambos perfiles"],["mobile","Móvil"],["pc","PC"]],"");
    options(state,[["","Todos los estados"],...["unreported","active","turned","changed","released","crossed"].map(v=>[v,name[v]])],"");
    options(routeKind,report.version===1?[["","Informe v1 · uso total"]]:
      [["","Todas las rutas"],["x","Instaló la intermedia por X"],["z","Instaló la intermedia por Z"],
        ["destination","Instaló el destino sin intermedia declarada"],["unknown","Sin instalación declarada"]],"");
    options(epoch,[["","Todos los viajes"]],"");
    setEpoch();selectRows("");
  }
  file.addEventListener("change",async()=>{
    const chosen=file.files?.[0];file.value="";
    if(!chosen)return;
    const mine=++ticket;
    try{
      if(chosen.size>MundoAheadReport.maxFileBytes)throw new Error("El informe supera 512 KiB.");
      const input=await chosen.arrayBuffer();
      if(mine!==ticket)return;
      const incoming=MundoAheadReport.parse(new TextDecoder("utf-8",{fatal:true}).decode(input));
      estimates.clear();report=incoming;
      displayReport();
      status.textContent=chosen.name+" · v"+report.version+" · "+fmt(report.entries.length)+" ofertas conservadas de "+fmt(report.totalOffers)+
        ". Ofertas anteriores fuera del registro: "+fmt(report.omittedOffers)+".";
    }catch(error){
      if(mine===ticket)status.textContent="No se pudo abrir el informe. "+error.message+(report?" Sigue visible el informe anterior.":"");
    }
  });
  clear.onclick=()=>{++ticket;report=null;selection=[];estimates.clear();displayReport();status.textContent="Informe retirado.";};
  revision.onchange=()=>{setEpoch();selectRows();};
  epoch.onchange=seat.onchange=profile.onchange=state.onchange=routeKind.onchange=()=>selectRows();
  entry.onchange=showEntry;
  peak.onclick=()=>{
    if(!peakEntry)return;
    entry.value=String(peakEntry.ordinal);showEntry();entry.focus();
  };
  analyze.onclick=()=>{
    el("districtInspector").open=true;
    const button=el("zoneAnalyze");
    if(!button.disabled)button.click();
  };
  displayReport();
  return {setDraft(value){
    draft=value;estimates.clear();
    if(report)selectRows();
  }};
};
