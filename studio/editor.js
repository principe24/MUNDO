"use strict";
(() => {
  const W=MundoWorld, el=id=>document.getElementById(id), canvas=el("viewport");
  const view=new MundoView.View(canvas,s=>{el("stats").textContent=s.fps+" FPS · "+s.width+" × "+s.height;},
    message=>{el("error").textContent=message;});
  const brumaLook=MundoBrumaLook.install(view);
  let artRequest=0;
  let world=W.decode(W.from64(MundoPublic.world)), selection=null, focus=[0,1,0], distance=44, yaw=.66, pitch=.61;
  const creatorModels=MundoCreatorModelPanel(view,edit,()=>selection);
  let undo=[], redo=[], queuedRead=0;
  const componentInspector=MundoComponentInspector(edit,()=>selection);
  // A verified import can use another record order or a v2 encoding of plain blocks.
  const timingOrigins=new WeakMap();
  let vehicleRoot=null, draftCars=[], publishing=false;
  let meetingPoint=null, meetingError="", gridError="", marking=false;
  let zoneRevision=0, zoneAnalysis=null, zoneJob=null, zoneSourceBytes=0, zoneSourceVersion=1, entryUrl=null;
  const districts=MundoDistrictPanel(snapshot=>{
    if(!zoneAnalysis)return null;
    const car=chosenDraftCar(),origin=timingOrigins.get(world);
    const report=origin?.hash?{...zoneAnalysis,worldSha256:origin.hash}:zoneAnalysis;
    return {world:snapshot??W.decode(W.encode(world)), report, bytes:origin?.bytes??zoneSourceBytes,
      sourceVersion:origin?.version??zoneSourceVersion, vehicleRoot, hasCar:Boolean(car), carRoot:car?String(car.rootId):null};
  });
  const meetingInputs=["X","Y","Z"].map(axis=>el("meeting"+axis));
  const vehicleChoice=el("vehicleChoice");
  const historyLimit=32*1024*1024;
  const say=message=>{el("notice").textContent=message;};
  for(const name of ["position","sizes"]) for(const axis of ["X","Y","Z"]){
    const label=document.createElement("label");label.textContent=axis;
    const input=document.createElement("input");input.id=name+axis;input.type="number";input.step="any";input.required=true;
    if(name==="sizes"){input.min=".0001";input.max="10000";}
    label.append(input);el(name).append(label);
  }
  function orbit(){
    const h=distance*Math.cos(pitch);
    view.look={eye:[focus[0]+h*Math.sin(yaw),focus[1]+distance*Math.sin(pitch),focus[2]+h*Math.cos(yaw)],target:focus};
    audioPanel.moveListener();
  }
  function zoom(factor){distance=Math.max(.55,Math.min(2800,distance*factor));orbit();}
  function record(){return {bytes:W.encode(world),components:MundoComponentRecords.snapshot(world),timingOrigin:timingOrigins.get(world),name:el("worldName").value,selection,vehicleRoot,
    meetingPoint:meetingPoint?.slice()??null,practice:circuitPanel.practiceSelection()};}
  function push(stack,entry){
    stack.push(entry);
    let size=stack.reduce((sum,x)=>sum+x.bytes.byteLength,0);
    while(stack.length>1 && (stack.length>30 || size>historyLimit)) size-=stack.shift().bytes.byteLength;
  }
  function historyButtons(){el("undo").disabled=!undo.length;el("redo").disabled=!redo.length;}
  function history(from,to){
    if(!from.length)return;
    const target=from[from.length-1], loaded=W.decode(target.bytes), previous=record();
    MundoComponentRecords.apply(loaded,target.components);
    from.pop();push(to,previous);world=loaded;if(target.timingOrigin)timingOrigins.set(world,target.timingOrigin);selection=target.selection;vehicleRoot=target.vehicleRoot;meetingPoint=target.meetingPoint;el("worldName").value=target.name;
    ++queuedRead;refresh(target.practice??null);say("Historial de edición actualizado.");
  }
  function list(){
    const box=el("objects"), needle=el("search").value.trim().toLocaleLowerCase(), rows=[];
    const hidden=MundoExperienceLook.markers(world);
    for(const node of world.nodes.values()){
      if(hidden.has(node.id))continue;
      if(rows.length>=180)break;
      if(!needle || node.name.toLocaleLowerCase().includes(needle) || String(node.id)===needle)rows.push(node);
    }
    if(selection!==null && world.nodes.has(selection) && !rows.some(n=>n.id===selection))rows.push(world.nodes.get(selection));
    box.replaceChildren();
    for(const n of rows){
      const opt=document.createElement("option");opt.value=String(n.id);opt.selected=n.id===selection;
      opt.textContent=(n.parent?"　":"")+(n.shape||n.visual?"":"▸ ")+n.name+" · "+n.id;box.append(opt);
    }
    box.value=selection===null?"":String(selection);
    el("count").textContent=world.nodes.size+" entidades";
  }
  function inspector(){
    const node=world.nodes.get(selection);
    componentInspector.show(node);
    creatorModels.showInstance(node);
    view.selected=selection;el("fields").disabled=!node;
    if(!node){el("pieceName").value="";el("parent").value="";el("parents").replaceChildren();return;}
    el("pieceName").value=node.name;el("color").value=W.toHex(node.color);
    ["X","Y","Z"].forEach((axis,i)=>{el("position"+axis).value=node.p[i];el("sizes"+axis).value=node.s[i];});
    const parent=el("parents");parent.replaceChildren(new Option("Raíz del mundo","0"));
    const descendants=new Set(W.subtree(world,selection));
    // Every existing parent stays selectable. Large scenes use an ID field as well as this short list.
    const hidden=MundoExperienceLook.markers(world);
    let count=0;
    for(const n of world.nodes.values()) if(!hidden.has(n.id) && (n.id===node.parent || (!n.shape && !descendants.has(n.id) && count<250))){
      parent.append(new Option(n.name+" · "+n.id,String(n.id)));++count;
    }
    el("parent").value=String(node.parent);
  }
  function chosenDraftCar(){
    return vehicleRoot===null?draftCars[0]:draftCars.find(car=>String(car.rootId)===vehicleRoot);
  }
  const toolButtons=Object.entries(MundoStudioTools.meetingTools).map(([id,tool])=>{
    const button=document.createElement("button");
    button.type="button";button.className="full";button.textContent=tool.label;
    button.onclick=()=>{
      try{
        const proposal=MundoStudioTools.prepareMeeting(id,view.scene,chosenDraftCar(),world);
        setMeeting(proposal.meetingPoint,proposal.vehicleRoot,proposal.seats);
      }catch(error){say(error.message);}
    };
    el("meetingTools").append(button);
    return {tool,button};
  });
  function syncChoiceControls(){
    const chosen=chosenDraftCar(),missing=vehicleRoot!==null&&!chosen;
    el("missingVehicle").hidden=!missing;
    el("publish").disabled=publishing||missing||Boolean(meetingError || gridError);
    el("locateVehicle").disabled=!chosen;
    for(const {tool,button} of toolButtons)button.disabled=!tool.available({scene:view.scene,car:chosen});
  }
  function formatPoint(point){
    return "("+point.map(n=>String(Number(n.toFixed(3)))).join(", ")+") m";
  }
  const circuitPanel=MundoCircuitPanel({
    practiceContext:()=>{
      const draft=world,ticket=queuedRead;
      return {world:draft,title:el("worldName").value,vehicleRoot,meetingPoint:meetingPoint?.slice()??null,
        current:()=>world===draft && queuedRead===ticket};
    },
    world:()=>world, edit, choose, center:centered,
    locate:point=>{focus=point.slice();distance=12;orbit();canvas.scrollIntoView({block:"nearest"});},
    saveGrid:pose=>{
      const error=edit(next=>{
        const id=MundoCircuit.writeGrid(next,pose);
        if(pose)MundoDriving.roomStart(next,MundoGeometry.flatten(next),vehicleRoot);
        return id;
      },pose?"Parrilla guardada en el borrador.":"Salida original del turismo restaurada.");
      if(error)throw error;
    },
    mark:mode=>{
      setMarking(marking===mode?false:mode);
      if(marking){
        if(marking==="grid-position")say("Toca la calzada para elegir el centro del carro. Después guarda la parrilla. Escape cancela.");
        if(marking==="gate-insert")say("Toca la cara superior del suelo para insertar el paso. Escape cancela.");
        canvas.focus({preventScroll:true});canvas.scrollIntoView({block:"nearest"});
      }
    }
  });
  const navPanel=MundoNpcPanel({edit,world:()=>world,terrain:()=>({scene:view.scene,vehicleRoot}),redraw:()=>renderMeeting(),mark:()=>{
    setMarking(marking==="nav-position"?false:"nav-position");
    if(marking){say("Toca una superficie para elegir las coordenadas. Escape cancela.");canvas.focus({preventScroll:true});}
  }});
  const audioPanel=MundoStudioAudioPanel({edit,world:()=>world,redraw:()=>renderMeeting(),
    camera:()=>({position:view.look.eye,yaw:-yaw}),
    mark:()=>{
      setMarking(marking==="audio-position"?false:"audio-position");
      if(marking){say("Toca una superficie para colocar la fuente sonora. Escape cancela.");canvas.focus({preventScroll:true});}
    },
    cancelMark:()=>{if(marking==="audio-position")setMarking(false);}
  });
  MundoCourseTimingPanel(async(report,id,fromId,current,action)=>{
    const source=world,ticket=queuedRead,car=chosenDraftCar(),root=car?String(car.rootId):null;
    const fresh=()=>current() && ticket===queuedRead && world===source && String(chosenDraftCar()?.rootId)===root;
    if(root!==report.carRoot)throw Error("Abre la revisión y selecciona el turismo del informe.");
    const original=timingOrigins.get(source);
    if(original?.hash && original.hash!==report.revision)throw Error("El borrador proviene de otra revisión. Abre la publicación del informe.");
    if(!original?.hash && zoneAnalysis?.worldSha256!==report.revision){
      if(!globalThis.crypto?.subtle)throw Error("Este navegador necesita SHA-256 para identificar el borrador.");
      const canonical=await MundoRoomFile.digest(W.encode(source));
      if(canonical!==report.revision)throw Error("El borrador pertenece a otra revisión. Abre la publicación del informe.");
    }
    if(!fresh())return false;
    const {gates,startMode}=MundoCircuit.read(source);
    if(startMode!==report.startMode)throw Error("El informe y el borrador usan modos de salida distintos.");
    if(gates.length!==report.total || !gates.every((g,i)=>String(g.id)===report.gates[i].id &&
      g.slot===report.gates[i].slot && g.label===report.gates[i].label))
      throw Error("Las puertas del informe difieren de las de la publicación.");
    if(action==="zones"){
      if(!zoneAnalysis)await requestZoneAnalysis();
      if(!fresh())return false;
      if(!zoneAnalysis)throw Error(el("zoneStatus").textContent || "Falta el análisis de zonas del borrador.");
      return districts.inspectGateLeg(fromId,id,fresh);
    }
    if(fromId!==null){
      if(!circuitPanel.practiceRange(fromId,id))throw Error("Estas puertas no forman un tramo de práctica.");
    }else{
      choose(BigInt(id));centered();
      el("circuitList").focus();
    }
    return true;
  });
  function setMarking(on){
    marking=on;circuitPanel.marking(on);navPanel.marking(on);audioPanel.marking(on);
    const portal=on==="portal", meeting=on==="meeting";
    el("markMeeting").setAttribute("aria-pressed",String(meeting));
    el("markMeeting").textContent=meeting?"Cancelar marcado":"Marcar sobre el suelo";
    el("placePortal").setAttribute("aria-pressed",String(portal));
    el("placePortal").textContent=portal?"Cancelar baldosa":"Colocar baldosa en el suelo";
    el("placeCatalogObject").setAttribute("aria-pressed",String(on==="catalog-object"));
    el("placeCatalogObject").textContent=on==="catalog-object"?"Cancelar colocación":"Colocar en una superficie";
    canvas.classList.toggle("mark-floor",!!on);
  }
  function renderMeeting(plannedSeats=null){
    meetingError="";
    gridError="";
    let seats=[];
    const grid=MundoCircuit.readGrid(world);
    let start=null;
    if(grid){
      try{start=MundoDriving.roomStart(world,view.scene,vehicleRoot);}
      catch(error){gridError=error.message;}
    }
    circuitPanel.refreshGrid(grid,chosenDraftCar(),gridError);
    view.startGrid=grid;
    if(meetingPoint && !gridError){
      try{seats=plannedSeats??(start?MundoMeeting.plan(start.road,start.car,meetingPoint).initial:
        MundoMeeting.preview(view.scene,vehicleRoot,meetingPoint));}
      catch(error){meetingError=error.message;}
    }
    view.seatMarkers=seats;
    // Transient editor markers live outside the editable world and its collision data.
    view.actorParts=seats.map(([x,y,z],i)=>({
      n:{id:BigInt(-1-i),shape:2,visual:0n,metal:0,rough:.65,color:i===0?[.03,.68,.58]:[1,.32,.06]},
      center:[x,y+.055,z],extent:[.25,.05,.25],radius:.36,
      m:[.5,0,0,0,0,.1,0,0,0,0,.5,0,x,y+.055,z,1]
    }));
    view.actorParts.push(...navPanel.overlays(),...audioPanel.overlays());
    if(grid) {
      // A yellow line and its two arrowheads are editor overlays, outside the world data.
      const [x,y,z]=grid.point,forwardX=Math.sin(grid.yaw),forwardZ=-Math.cos(grid.yaw);
      function stripe(id,cx,cz,angle,length){
        const c=Math.cos(angle),s=Math.sin(angle),height=.06,width=.18;
        const rx=(Math.abs(c)*width+Math.abs(s)*length)/2,rz=(Math.abs(s)*width+Math.abs(c)*length)/2;
        view.actorParts.push({n:{id,shape:1,visual:0n,metal:0,rough:.8,color:[1,.66,.04]},
          center:[cx,y+.06,cz],extent:[rx,height/2,rz],radius:Math.hypot(rx,height/2,rz),
          m:[width*c,0,width*s,0,0,height,0,0,-length*s,0,length*c,0,cx,y+.06,cz,1]});
      }
      stripe(-3n,x,z,grid.yaw,2.6);
      for(const sign of [-1,1]){
        const angle=grid.yaw+sign*Math.PI/4;
        stripe(sign===1?-4n:-5n,x+1.3*forwardX-.45*Math.sin(angle),
          z+1.3*forwardZ+.45*Math.cos(angle),angle,.9);
      }
    }
    for(let i=0;i<3;i++)meetingInputs[i].value=meetingPoint?.[i]??"";
    el("autoMeeting").disabled=el("locateMeeting").disabled=!meetingPoint;
    el("meetingStatus").textContent=meetingError ||
      (seats.length?"Plaza 1 (turquesa) "+formatPoint(seats[0])+" · Plaza 2 (naranja) "+formatPoint(seats[1]):
      "Aparición automática.");
    syncChoiceControls();
  }
  function setMeeting(value,nextRoot=vehicleRoot,plannedSeats=null){
    try{
      const point=MundoRoomFile.copyMeetingPoint(value);
      const changed=nextRoot!==vehicleRoot || Boolean(point)!==Boolean(meetingPoint) || point?.some((n,i)=>n!==meetingPoint[i]);
      if(changed){
        push(undo,record());redo=[];++queuedRead;
        vehicleRoot=nextRoot;vehicleChoice.value=nextRoot??"";meetingPoint=point;
        invalidateZones();
        renderMeeting(plannedSeats);historyButtons();
      }
      setMarking(false);
      say(meetingError || (point?"Punto de encuentro guardado en el borrador.":"Aparición automática restaurada."));
    }catch(error){say(error.message);}
  }
  el("markMeeting").onclick=()=>{
    setMarking(marking==="meeting"?false:"meeting");
    if(marking){
      say("Toca la cara superior del suelo para colocar el encuentro. Escape cancela.");
      canvas.focus({preventScroll:true});
      canvas.scrollIntoView({block:"nearest"});
    }
  };
  el("placePortal").onclick=()=>{
    setMarking(marking==="portal"?false:"portal");
    if(marking){
      say("Toca la cara superior de un suelo para colocar la baldosa.");
      canvas.focus({preventScroll:true});canvas.scrollIntoView({block:"nearest"});
    }
  };
  function placePortal(point){
    edit(next=>{
      const node=W.add(next,MundoProject.tilePrefix+"Salida "+next.next,1);
      node.p=[point[0],point[1]+.05,point[2]];node.s=[2,.1,2];
      node.color=[.025,.58,.47];node.rough=.66;
      return node.id;
    },"Baldosa colocada. Añade o sustituye el borrador en el proyecto y elige su destino.");
  }
  canvas.addEventListener("keydown",e=>{
    if(marking && e.key==="Escape"){setMarking(false);say("Marcado cancelado.");}
  });
  el("autoMeeting").onclick=()=>setMeeting(null);
  el("meetingForm").onsubmit=e=>{
    e.preventDefault();
    setMeeting(meetingInputs.map(input=>input.valueAsNumber));
  };
  el("locateMeeting").onclick=()=>{
    if(!meetingPoint)return;
    focus=meetingPoint.slice();distance=8;orbit();
    canvas.scrollIntoView({block:"nearest"});
  };
  function refreshVehicleChoices(){
    draftCars=MundoDriving.roomCars(view.scene);
    for(const car of draftCars)MundoBrumaLook.bind(car);
    function title(car){
      if(!MundoBrumaLook.isBruma(car))return car.name;
      const group=world.nodes.get(world.nodes.get(car.rootId)?.parent);
      return group?.name||car.name;
    }
    const automatic=draftCars.length?"Automático · "+title(draftCars[0])+" (ID "+draftCars[0].rootId+")":"Automático · a pie";
    vehicleChoice.replaceChildren(new Option(automatic,""));
    for(const car of draftCars)vehicleChoice.add(new Option(title(car)+" · ID "+car.rootId,String(car.rootId)));
    if(vehicleRoot!==null&&!chosenDraftCar())vehicleChoice.add(new Option("Turismo no disponible · ID "+vehicleRoot,vehicleRoot));
    vehicleChoice.value=vehicleRoot??"";
    renderMeeting();
  }
  vehicleChoice.onchange=()=>{
    navPanel.invalidate();
    const previous=record();
    vehicleRoot=vehicleChoice.value||null;
    invalidateZones();
    push(undo,previous);redo=[];++queuedRead;
    refreshVehicleChoices();historyButtons();
  };
  el("experienceLook").onchange=()=>{
    const requested=el("experienceLook").value||null;
    if(requested===MundoExperienceLook.read(world))return;
    const error=edit(next=>{
      MundoExperienceLook.set(next,requested);
      return selection;
    },requested?"Inés recomendada para esta experiencia.":"Preferencia de personaje retirada.");
    if(error)el("experienceLook").value=MundoExperienceLook.read(world)||"";
  };
  el("locateVehicle").onclick=()=>{
    const chosen=chosenDraftCar();
    if(chosen){choose(chosen.rootId);centered();}
  };
  function refresh(practice){
    invalidateZones();
    el("experienceLook").value=MundoExperienceLook.read(world)||"";
    if(!world.nodes.has(selection))selection=null;
    setMarking(false);view.setWorld(world);creatorModels.setWorld(world);el("worldTitle").textContent=el("worldName").value||"Mi mundo";
    list();inspector();navPanel.refresh();audioPanel.refresh();circuitPanel.refresh(selection,practice);refreshVehicleChoices();historyButtons();
  }
  function edit(fn,message){
    try{
      const next=W.fork(world), id=fn(next);
      W.validate(next);MundoCircuit.scan(next);MundoNpcRoutes.definitions(next);MundoAudioScene.read(next);MundoComponentRecords.snapshot(next);push(undo,record());redo=[];
      ++queuedRead;world=next;selection=id;refresh();say(typeof message==="function"?message(id):message);
    }catch(e){say(e.message);return e;}
  }
  function centered(){
    if(selection===null){focus=[0,1,0];distance=44;}
    else {
      const o=view.scene.byId.get(selection);
      if(!o){say("La pieza excede el alcance de la cámara.");return;}
      focus=o.center.slice();distance=Math.max(2.2,Math.min(2800,o.radius*3.5));
      if(!o.n.shape && !o.n.visual){
        let max=1;
        for(const id of W.subtree(world,selection)){
          const part=view.scene.byId.get(id);if(part)max=Math.max(max,Math.hypot(...part.center.map((x,i)=>x-focus[i]))+part.radius);
        }
        distance=Math.max(2.2,Math.min(2800,max*2.65));
      }
    }
    orbit();
  }
  function choose(id){selection=world.nodes.has(id)?id:null;list();inspector();circuitPanel.select(selection);audioPanel.select(selection);}
  el("objects").onchange=()=>choose(el("objects").value?BigInt(el("objects").value):null);
  el("search").oninput=list;
  el("worldName").oninput=()=>{++queuedRead;invalidateZones();el("worldTitle").textContent=el("worldName").value||"Mi mundo";};
  el("props").onsubmit=e=>{
    e.preventDefault();if(selection===null)return;
    edit(next=>{
      const n=next.nodes.get(selection);
      // Keep unedited linear color components exact across an open/save cycle.
      const color=el("color").value===W.toHex(n.color)?n.color:W.fromHex(el("color").value);
      next.nodes.set(selection,{...n,name:el("pieceName").value.trim(),parent:BigInt(el("parent").value),color,
        p:["X","Y","Z"].map(a=>el("position"+a).valueAsNumber),s:["X","Y","Z"].map(a=>el("sizes"+a).valueAsNumber)});
      return selection;
    },"Propiedades aplicadas.");
  };
  el("turn").onclick=()=>edit(next=>{
    const n=next.nodes.get(selection), [x,y,z,w]=n.q, a=15*Math.PI/360, c=Math.cos(a),s=Math.sin(a);
    next.nodes.set(n.id,{...n,q:[c*x+s*z,c*y+s*w,c*z-s*x,c*w-s*y]});return n.id;
  },"Pieza girada alrededor del eje vertical.");
  document.querySelectorAll("[data-shape]").forEach(button=>button.onclick=()=>edit(next=>{
    const shape=Number(button.dataset.shape), n=W.add(next,["","Bloque","Cilindro","Esfera"][shape],shape);
    n.p=[Math.round(focus[0]),.5,Math.round(focus[2])];return n.id;
  },"Pieza añadida."));
  const catalogObjects={
    planter:{visual:43001n,name:"Maceta de terracota",size:[.62,.54,.62],color:"#aa684d",rough:.86,metal:0},
    light:{visual:43002n,name:"Baliza de paseo",size:[.32,.90,.32],color:"#485258",rough:.42,metal:.48}
  };
  function placeCatalogObject(point){
    if(el("catalogObject").value.startsWith("creator:")){
      edit(next=>creatorModels.place(next,point),id=>world.nodes.get(id).name+" colocado en la escena.");
      return;
    }
    if(el("catalogObject").value==="bruma"){
      edit(next=>MundoVehicleModel.placeBruma(next,point).placement,
        "Bruma colocado. Puedes girar el grupo y elegirlo como turismo de la sala.");
      return;
    }
    const model=catalogObjects[el("catalogObject").value];
    if(!model)return;
    edit(next=>{
      const node=W.add(next,model.name,2);
      node.visual=model.visual;node.s=model.size.slice();
      node.p=[point[0],point[1]+model.size[1]/2,point[2]];
      node.color=W.fromHex(model.color);node.rough=model.rough;node.metal=model.metal;
      return node.id;
    },model.name+" añadida a la experiencia.");
  }
  el("addCatalogObject").onclick=()=>placeCatalogObject([focus[0],0,focus[2]]);
  el("placeCatalogObject").onclick=()=>{
    setMarking(marking==="catalog-object"?false:"catalog-object");
    if(marking){
      say("Toca una superficie para apoyar el modelo. Escape cancela.");
      canvas.focus({preventScroll:true});canvas.scrollIntoView({block:"nearest"});
    }
  };
  el("copy").onclick=()=>edit(next=>MundoCircuitEdit.duplicate(next,selection),"Selección duplicada con sus piezas.");
  el("remove").onclick=()=>edit(next=>{
    const parent=world.nodes.get(selection).parent;
    for(const id of W.subtree(world,selection))next.nodes.delete(id);
    return parent||null;
  },"Selección retirada. Puedes deshacer el cambio.");
  function install(next,name,chosenRoot=null,point=null,timingOrigin=null){
    if(timingOrigin)timingOrigins.set(next,timingOrigin);
    MundoCircuit.scan(next);MundoNpcRoutes.definitions(next);MundoAudioScene.read(next);push(undo,record());redo=[];world=next;selection=null;vehicleRoot=chosenRoot;meetingPoint=point?.slice()??null;el("worldName").value=name;refresh(null);
    focus=[0,1,0];distance=44;
    const first=view.scene.objects[0];
    if(first && Math.hypot(...first.center)>80){focus=first.center.slice();distance=Math.max(4,Math.min(2800,first.radius*3));}
    orbit();
  }
  el("new").onclick=()=>{++queuedRead;install(W.empty(),"Mi mundo");say("Mundo nuevo. Añade tu primera pieza.");};
  el("potteryCourtyard").onclick=()=>{
    ++queuedRead;
    install(W.decode(W.from64(window.MundoPatioTemplate)),"Patio de cerámica");
    distance=23;focus=[0,.9,0];orbit();
    say("Patio abierto. Selecciona una maceta o una baliza para editarla.");
  };
  el("brumaTrack").onclick=()=>{
    ++queuedRead;
    const track=MundoVehicleModel.brumaTrack();
    install(track.world,track.title,String(track.vehicleRoot));
    choose(track.placement);centered();
    say("Pista abierta. Bruma es el turismo elegido para esta sala de dos plazas.");
  };
  async function readBrumaCatalog(getBytes){
    const request=++artRequest,current=()=>request===artRequest;
    const status=el("brumaArtStatus");
    status.textContent="Cargando el catálogo del propietario…";
    try{
      const bytes=await getBytes();
      if(!current())return;
      await brumaLook.applyBruma(bytes,current);
      if(current())status.textContent=view.gpuReady?
        "Carrocería de Bruma cargada en este editor. La publicación guarda la referencia al modelo.":
        "Catálogo cargado. La vista en planta permite colocar Bruma. Su carrocería detallada se muestra con WebGL 2.";
    }catch(error){
      if(current())status.textContent="No se pudo cargar la carrocería. "+error.message;
    }
  }
  const embeddedBruma=el("brumaOwnerCatalog");
  if(embeddedBruma)void readBrumaCatalog(()=>W.from64(embeddedBruma.content.textContent.trim()));
  el("brumaFile").onchange=()=>{
    const input=el("brumaFile"),file=input.files?.[0];input.value="";
    if(!file)return;
    void readBrumaCatalog(async()=>{
      if(file.size<13||file.size>64*1024*1024)throw Error("Tamaño de catálogo inválido.");
      return new Uint8Array(await file.arrayBuffer());
    });
  };
  const shareButton=el("shareWorld");
  if(typeof navigator.canShare==="function" && typeof navigator.share==="function"){
    shareButton.hidden=false;
    shareButton.onclick=async ()=>{
      try{
        const file=W.worldFile(world,el("worldName").value);
        const payload={files:[file]};
        if(!navigator.canShare(payload)){
          say("Este navegador requiere Guardar. Después puedes abrir el archivo desde MUNDO.");
          return;
        }
        await navigator.share(payload);
        say("Archivo entregado al menú de compartir del dispositivo.");
      }catch(error){
        if(error.name!=="AbortError")say("Usa Guardar y selecciona el archivo desde MUNDO.");
      }
    };
  }
  function invalidateZones(){
    districts.clear();
    ++zoneRevision;
    if(el("zoneStatus").textContent)el("zoneStatus").textContent="El borrador cambió. Vuelve a analizar sus zonas.";
    zoneAnalysis=null;zoneSourceBytes=0;clearEntry();
    el("zoneResult").hidden=true;
    el("zoneAnalyze").disabled=false;
  }
  function zoneFilename(){
    const name=el("worldName").value.trim().replace(/[^\p{L}\p{N}_-]+/gu,"_") || "Mi_mundo";
    const stem=Array.from(name).slice(0,64).join("");
    return /^(con|prn|aux|nul|conin|conout|com[0-9¹²³]|lpt[0-9¹²³])$/iu.test(stem)?"Mundo_"+stem:stem;
  }
  function downloadZoneUrl(url,extension){
    const link=document.createElement("a");
    link.href=url;link.download=zoneFilename()+extension;
    document.body.append(link);link.click();link.remove();
  }
  function downloadZones(blob,extension){
    const url=URL.createObjectURL(blob);
    try{downloadZoneUrl(url,extension);}finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
  }
  el("zoneExport").onclick=()=>{
    try{
      downloadZones(MundoZones.pack(W.decode(W.encode(world))),".mzones");
      say("Descarga del paquete de zonas solicitada.");
    }catch(error){say(error.message);}
  };
  function draftEntry(snapshot){
    if(meetingError)throw Error(meetingError);
    if(meetingPoint)return [meetingPoint[0],meetingPoint[2]];
    const scene=MundoGeometry.flatten(snapshot),car=MundoDriving.roomCar(scene,vehicleRoot);
    const solids=car?scene.objects.filter(o=>!car.partIds.has(o.n.id)):scene.objects;
    const [x,,z]=new MundoWalk(solids,false).spawn;
    return [x,z];
  }
  function clearEntry(){
    if(entryUrl)URL.revokeObjectURL(entryUrl);
    entryUrl=null;
    el("entryExport").disabled=true;
    el("entryMap").hidden=true;
    el("entryStatus").textContent="";el("entryCaption").textContent="";
  }
  function drawEntryMap(geometry,point,radius,cellSize){
    const map=el("entryMap"),brush=map.getContext("2d");
    if(!brush)return null;
    const size=map.width,columns=2*radius+1,span=columns*cellSize;
    const center=point.map(n=>MundoZones.cell(n)*cellSize);
    const project=(value,axis)=>size*(.5+(value-center[axis])/span);
    const clamp=n=>Math.max(0,Math.min(size,n));
    const pieces=geometry.objects.filter(o=>
      Math.abs(o.center[0]-center[0])<=span/2+o.extent[0] &&
      Math.abs(o.center[2]-center[1])<=span/2+o.extent[2]);
    pieces.sort((a,b)=>(a.center[1]+a.extent[1])-(b.center[1]+b.extent[1]));
    brush.fillStyle="#18292e";brush.fillRect(0,0,size,size);
    for(const {center:[x,,z],extent:[rx,,rz],n} of pieces){
      const left=clamp(project(x-rx,0)),top=clamp(project(z-rz,1));
      const w=Math.max(1.5,clamp(project(x+rx,0))-left);
      const h=Math.max(1.5,clamp(project(z+rz,1))-top);
      brush.fillStyle=W.toHex(n.color);brush.fillRect(left,top,w,h);
      if(w>=6 && h>=6){brush.strokeStyle="rgba(0,0,0,.38)";brush.lineWidth=1;brush.strokeRect(left,top,w,h);}
    }
    brush.beginPath();
    for(let i=1;i<columns;i++){
      const p=size*i/columns;
      brush.moveTo(p,0);brush.lineTo(p,size);brush.moveTo(0,p);brush.lineTo(size,p);
    }
    brush.lineWidth=2;brush.strokeStyle="rgba(255,255,255,.54)";brush.stroke();
    const x=project(point[0],0),z=project(point[1],1);
    brush.beginPath();brush.arc(x,z,9,0,2*Math.PI);
    brush.moveTo(x-16,z);brush.lineTo(x-5,z);brush.moveTo(x+5,z);brush.lineTo(x+16,z);
    brush.moveTo(x,z-16);brush.lineTo(x,z-5);brush.moveTo(x,z+5);brush.lineTo(x,z+16);
    brush.lineWidth=6;brush.strokeStyle="#102527";brush.stroke();
    brush.lineWidth=3;brush.strokeStyle="#fff2a8";brush.stroke();
    map.hidden=false;
    return pieces.length;
  }
  function showDraftEntry(snapshot){
    clearEntry();
    if(!zoneAnalysis)return;
    try{
      // The room partitions a canonical .mworld. Keep only the download for
      // the selected profile so switching profiles and editing release it.
      snapshot??=W.decode(W.encode(world));
      const profile=el("entryProfile").value,point=zoneAnalysis.focus;
      const origin=timingOrigins.get(world),fullBytes=origin?.bytes??zoneSourceBytes;
      const result=MundoZones.roomEntry(snapshot,profile,point,fullBytes,origin?.version??zoneSourceVersion);
      const source=result?W.decode(result.bytes):snapshot;
      const geometry=MundoGeometry.flatten(source),format=new Intl.NumberFormat("es");
      const bytes=result?format.format(result.bytes.byteLength)+" de "+format.format(fullBytes):format.format(fullBytes);
      const pieces=format.format(geometry.objects.length);
      const cells=result?" · "+result.cells+" entradas de zona (incluida la global)":"";
      const mode=result?"La sala puede mostrar este sector durante la carga.":
        "La sala cargaría el mundo completo directamente. No hay un sector independiente para descargar.";
      el("entryStatus").textContent=mode+" "+bytes+" bytes · "+pieces+" piezas con geometría · "+
        format.format(source.nodes.size)+" entidades"+cells+".";
      let visible=null;
      try{visible=drawEntryMap(geometry,point,zoneAnalysis.profiles[profile].radius,zoneAnalysis.cellSize);}
      catch{el("entryMap").hidden=true;}
      el("entryCaption").textContent=visible===null?"Este navegador no pudo dibujar el mapa.":
        "Cajas de "+format.format(visible)+" de "+pieces+" piezas en planta. Cada cuadro mide "+
        zoneAnalysis.cellSize+" m de lado. La cruz marca X "+point[0]+", Z "+point[1]+
        " m. X aumenta hacia la derecha y Z hacia abajo.";
      if(result){
        entryUrl=URL.createObjectURL(new Blob([result.bytes],{type:"application/octet-stream"}));
        el("entryExport").disabled=false;
      }
    }catch(error){
      clearEntry();el("entryStatus").textContent="No se pudo preparar el terreno de entrada. "+error.message;
    }
  }
  el("entryProfile").value=MundoView.mobile?"mobile":"pc";
  el("entryProfile").onchange=()=>showDraftEntry();
  el("entryExport").onclick=()=>{
    if(entryUrl && zoneAnalysis)downloadZoneUrl(entryUrl,"-vista-entrada-"+el("entryProfile").value+".mworld");
  };
  function requestZoneAnalysis(){
    if(zoneJob?.revision===zoneRevision)return zoneJob.promise;
    const promise=analyzeZones(),job={revision:zoneRevision,promise};
    zoneJob=job;
    promise.then(()=>{if(zoneJob===job)zoneJob=null;},()=>{if(zoneJob===job)zoneJob=null;});
    return promise;
  }
  el("zoneAnalyze").onclick=requestZoneAnalysis;
  async function analyzeZones(){
    districts.clear();
    const revision=++zoneRevision, current=()=>revision===zoneRevision;
    el("zoneAnalyze").disabled=true;
    el("zoneResult").hidden=true;
    el("zoneStatus").textContent="Calculando tamaños y huellas de esta revisión…";
    zoneAnalysis=null;zoneSourceBytes=0;clearEntry();
    try{
      let bytes=W.encode(world);
      const sourceSize=bytes.byteLength,snapshot=W.decode(bytes),entry=draftEntry(snapshot);
      const sourceVersion=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8,true);
      const pointKind=meetingPoint?"Punto de encuentro":"Aparición automática";
      const hash=await MundoRoomFile.digest(bytes);
      bytes=null;
      if(!current())return;
      const report=await MundoZones.inventory(MundoZones.pack(snapshot),hash,entry,{current});
      if(!current())return;
      const format=new Intl.NumberFormat("es");
      const size=bytes=>format.format(bytes)+" bytes";
      const count=report.entries.length;
      el("zoneFocus").textContent=pointKind+" · X "+format.format(entry[0])+" m · Z "+format.format(entry[1])+" m";
      for(const [id,profile] of [["zoneMobile",report.profiles.mobile],["zonePC",report.profiles.pc]])
        el(id).textContent=size(profile.bytes)+" de "+size(report.packageBytes)+" · "+profile.count+" de "+count+" entradas (incluida la global)";
      el("zoneTotal").textContent=size(report.packageBytes)+" · "+count+" entradas";
      el("zoneGlobal").textContent=size(report.entries[0].bytes)+" + "+size(report.directoryBytes)+" de directorio";
      el("zoneHash").textContent=report.packageSha256;
      zoneAnalysis=report;
      zoneSourceBytes=sourceSize;
      zoneSourceVersion=sourceVersion;
      el("zoneResult").hidden=false;
      el("zoneStatus").textContent="Carga inicial estimada a partir del archivo .mzones.";
      showDraftEntry(snapshot);
      districts.refresh(snapshot);
    }catch(error){
      if(current())el("zoneStatus").textContent=error.message;
    }finally{
      if(current())el("zoneAnalyze").disabled=false;
    }
  }
  el("zoneManifest").onclick=()=>{
    if(!zoneAnalysis)return;
    try{
      const json=new Blob([JSON.stringify(zoneAnalysis,null,2)+"\n"],{type:"application/json"});
      downloadZones(json,".mzones.json");
    }catch(error){say(error.message);}
  };
  function worldDownloadNotice(root,point){
    if(point)return "Descarga de .mworld solicitada. Exporta la sala .mroom para conservar el punto de encuentro y el turismo de esta revisión.";
    return root==null?"Descarga de .mworld solicitada.":
      "Descarga de .mworld solicitada. Para conservar también el turismo elegido, exporta la sala .mroom desde su publicación.";
  }
  el("save").onclick=()=>{
    try{W.download(world,el("worldName").value);say(worldDownloadNotice(vehicleRoot,meetingPoint));}
    catch(e){say(e.message);}
  };
  el("open").onclick=()=>el("inputFile").click();el("place").onclick=()=>el("inputModel").click();
  for(const [id,isModel] of [["inputFile",false],["inputModel",true]])el(id).onchange=async e=>{
    const file=e.target.files[0];e.target.value="";if(!file)return;
    const ticket=++queuedRead;
    try{
      if(!isModel&&/\.mroom(?:3d|audio)?$/i.test(file.name)){
        const room=await MundoPublications.openRoomFile(file);
        if(room.hasModels)await creatorModels.refreshList();
        if(room.hasAudio)await audioPanel.reloadCatalog();
        if(ticket!==queuedRead)return;
        install(room.world,room.title,room.vehicleRoot,room.meetingPoint,room.worldSource);
        say("Sala v"+room.revision+" abierta como borrador.");
        return;
      }
      const bytes=await W.fileBytes(file);if(ticket!==queuedRead)return;
      const data=W.decode(bytes);
      const title=file.name.replace(/\.mworld$/i,"").slice(0,50)||"Modelo";
      if(isModel){
        // Only geometry travels with an inserted model. A world's recommendation belongs to its own root.
        MundoExperienceLook.set(data,null);
        const audioSources=MundoAudioScene.read(data);
        for(const source of audioSources)data.nodes.delete(BigInt(source.id));
        edit(next=>W.place(next,data,title,[Math.round(focus[0]),0,Math.round(focus[2])]),audioSources.length
          ? "Modelo insertado. Las fuentes de la sala original se conservan en su mundo."
          : "Modelo insertado como un único grupo editable.");
      }
      else{
        let sourceHash=null;
        if(globalThis.crypto?.subtle){
          try{sourceHash=await MundoRoomFile.digest(bytes);}catch{ /* Opening raw worlds also works without a digest. */ }
        }
        if(ticket!==queuedRead)return;
        install(data,title,null,null,W.sourceInfo(bytes,sourceHash));say("Mundo abierto.");
      }
    }catch(e){if(ticket===queuedRead)say(e.message);}
  };
  el("undo").onclick=()=>history(undo,redo);el("redo").onclick=()=>history(redo,undo);
  el("focus").onclick=centered;el("less").onclick=()=>zoom(1.25);el("more").onclick=()=>zoom(.8);
  let drag=null;
  canvas.onpointerdown=e=>{if(drag)return;canvas.setPointerCapture(e.pointerId);drag={id:e.pointerId,x:e.clientX,y:e.clientY,travel:0};};
  canvas.onpointermove=e=>{
    if(!drag||drag.id!==e.pointerId)return;
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.travel+=Math.abs(dx)+Math.abs(dy);
    yaw-=dx*.008;pitch=Math.max(.08,Math.min(1.46,pitch+dy*.007));drag.x=e.clientX;drag.y=e.clientY;orbit();
  };
  canvas.onpointerup=e=>{
    if(!drag||drag.id!==e.pointerId)return;
    if(drag.travel<5){
      const r=canvas.getBoundingClientRect(),x=2*(e.clientX-r.left)/r.width-1,y=1-2*(e.clientY-r.top)/r.height;
      if(marking){
        const point=view.pickFloor(x,y);
        if(point && (marking==="gate-add" || marking==="gate-move" || marking==="gate-insert" || marking==="grid-position"))circuitPanel.place(point,marking);
        else if(point && marking==="catalog-object")placeCatalogObject(point);
        else if(point && marking==="audio-position"){audioPanel.locate(point);setMarking(false);}
        else if(point && marking==="nav-position"){navPanel.locate(point);setMarking(false);}
        else if(point && marking==="portal")placePortal(point);
        else if(point)setMeeting(point);
        else say("Marca la cara superior de una pieza de suelo.");
      }else choose(view.pick(x,y));
    }
    drag=null;
  };
  canvas.onlostpointercapture=()=>{drag=null;};
  canvas.addEventListener("wheel",e=>{e.preventDefault();zoom(Math.exp(Math.max(-1,Math.min(1,e.deltaY*.001))));},{passive:false});
  el("audioExport").onclick=async ()=>{
    const button=el("audioExport"),message=el("audioStatus");
    if(button.disabled)return;
    button.disabled=true;
    try{
      if(meetingError || gridError)throw Error(meetingError || gridError);
      const snapshot=W.fork(world),title=el("worldName").value.trim()||"Mi mundo",root=vehicleRoot,point=meetingPoint?.slice()??null;
      const packed=await MundoPublications.audioDraft(snapshot,title,root,point);
      const url=URL.createObjectURL(packed.blob),link=document.createElement("a");
      try{
        link.href=url;link.download=packed.filename;document.body.append(link);link.click();
      }finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
      message.textContent="Descarga solicitada: "+packed.filename+".";
    }catch(error){message.textContent=error.message;}
    finally{button.disabled=false;}
  };
  MundoPrepararSala(el("play"),()=>{
    if(meetingError || gridError)throw new Error(meetingError || gridError);
    return {world,title:el("worldName").value||"Mi mundo",vehicleRoot,meetingPoint:meetingPoint?.slice()??null};
  },say);
  const catalog=MundoPublications,selector=el("releases"),publish=el("publish");
  const status=message=>{el("releaseStatus").textContent=message;};
  let selectedRelease=null,entries=[],readGeneration=0,listGeneration=0;
  let projectPanel;
  function enableRelease(active){
    projectPanel?.sync();
    el("playRelease").hidden=!active;
    el("modelRoomExport").disabled=!active;
    el("modelRoomExport").hidden=!active || !MundoModelRoom.references(selectedRelease.world).size;
    el("restoreRelease").disabled=el("exportRelease").disabled=el("roomExport").disabled=!active;
  }
  async function selectRelease(){
    const ticket=++readGeneration;
    selectedRelease=null;enableRelease(false);
    el("releaseCircuit").textContent="";el("roomVehicle").textContent="";el("releaseMeeting").textContent="";el("releaseLook").textContent="";
    const info=entries.find(entry=>entry.id===Number(selector.value));
    if(!info)return;
    try{
      const bytes=await catalog.bytesOf(info),snapshot=W.decode(bytes);
      if(ticket!==readGeneration)return;
      const car=MundoDriving.roomCar(MundoGeometry.flatten(snapshot),info.vehicleRoot??null);
      el("releaseLook").textContent=MundoExperienceLook.read(snapshot)?"Personaje recomendado en esta versión · Inés de Bajamar.":"";
      el("roomVehicle").textContent=car
        ? (info.vehicleRoot==null?"Turismo automático":"Turismo elegido")+" · "+car.name+" (ID "+car.rootId+")"
        : "Recorrido a pie · esta revisión no contiene un turismo de sala.";
      el("releaseMeeting").textContent=info.meetingPoint?"Encuentro publicado "+formatPoint(info.meetingPoint):"Encuentro automático.";
      const {gates,startMode,grid}=MundoCircuit.read(snapshot);
      el("releaseCircuit").textContent=gates.length?"Circuito publicado · "+gates.length+" puerta(s) · "+
        MundoCourseTiming.startLabel(startMode)+" · Primera: "+gates[0].label:"";
      if(grid)el("releaseCircuit").textContent+=" · Parrilla "+formatPoint(grid.point)+" · "+Number(grid.bearing.toFixed(2))+"°";
      selectedRelease={world:snapshot,source:W.sourceInfo(bytes,info.hash),info,title:info.title,revision:info.revision};
      enableRelease(true);
    }catch(error){if(ticket===readGeneration)status(error.message);}
  }
  async function refreshCatalog(preferred){
    const ticket=++listGeneration;
    const data=await catalog.list();
    if(ticket!==listGeneration)return;
    entries=data.reverse();
    const previous=preferred??Number(selector.value);
    selector.replaceChildren();
    for(const info of entries)selector.add(new Option(info.title+" · v"+info.revision,String(info.id)));
    if(entries.some(info=>info.id===previous))selector.value=String(previous);
    selector.disabled=!entries.length;
    await selectRelease();
  }
  selector.onchange=()=>{status("");selectRelease();};
  publish.onclick=async ()=>{
    publishing=true;syncChoiceControls();
    try{
      const result=await catalog.publish(world,el("worldName").value,vehicleRoot,meetingPoint);
      status(result.created?"Versión privada guardada en este navegador.":"Esta versión ya está guardada.");
      await refreshCatalog(result.id);
    }catch(error){status("No se pudo completar la operación. "+error.message);}
    finally{publishing=false;syncChoiceControls();}
  };
  el("restoreRelease").onclick=()=>{
    if(!selectedRelease)return;
    ++queuedRead;install(W.fork(selectedRelease.world),selectedRelease.title,selectedRelease.info.vehicleRoot??null,selectedRelease.info.meetingPoint??null,selectedRelease.source);
    status("Borrador recuperado. Deshacer recupera la edición anterior.");
  };
  el("exportRelease").onclick=()=>{
    if(!selectedRelease)return;
    W.download(selectedRelease.world,selectedRelease.title+"-v"+selectedRelease.revision);
    status(worldDownloadNotice(selectedRelease.info.vehicleRoot,selectedRelease.info.meetingPoint));
  };
  for (const withModels of [false,true]) {
    const button=el(withModels?"modelRoomExport":"roomExport");
    button.onclick=async ()=>{
      if(!selectedRelease)return;
      const chosen=selectedRelease, ticket=readGeneration;
      button.disabled=true;
      try{
        const raw=await catalog.roomDownload(chosen.info);
        const {filename,blob}=withModels ? await catalog.withModels(raw,chosen.world) : raw;
        if(ticket!==readGeneration)return;
        const url=URL.createObjectURL(blob);
        try{
          const link=document.createElement("a");
          link.href=url;link.download=filename;
          document.body.append(link);link.click();link.remove();
          status("Descarga solicitada. En el panel del anfitrión, usa Preparar archivo con "+filename+".");
        }finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
      }catch(error){if(ticket===readGeneration)status(error.message);}
      finally{if(ticket===readGeneration)button.disabled=!selectedRelease;}
    };
  }
  MundoPrepararSala(el("playRelease"),()=>{
    if(!selectedRelease)throw new Error("Selecciona una publicación.");
    return {publication:selectedRelease.info,world:selectedRelease.world};
  },status);
  projectPanel=MundoProjectPanel({
    plugins:componentInspector.plugins,
    captureDraft:id=>MundoProject.draft(id,world,el("worldName").value.trim()||"Mi mundo",vehicleRoot,meetingPoint),
    selectedPublication:()=>selectedRelease?.info,
    beginEdit:()=>{
      const ticket=++queuedRead;
      return room=>{
        if(ticket!==queuedRead)throw Error("El borrador cambió durante la lectura. Vuelve a elegir el mundo.");
        install(room.world,room.title,room.vehicleRoot,room.meetingPoint,room.worldSource);
      };
    }
  });
  refreshCatalog().catch(()=>status("El historial local requiere almacenamiento del navegador. Puedes guardar el archivo .mworld."));
  orbit();refresh();
})();
