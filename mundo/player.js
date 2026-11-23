"use strict";
(() => {
  const el=id=>document.getElementById(id), canvas=el("viewport"), menu=el("menu"), keys=new Set();
  const trial=document.body.dataset.session==="solo";
  const invite=trial?null:MundoEntrada.enter();
  if(!trial && invite===null)return;
  const inRoom=!trial;
  const audio=window.MundoPlayerAudio?.create(window,MundoView.mobile);
  let roomClips=null;
  function audioForm(settings){
    if(!audio || !settings)return;
    el("audioVolume").value=settings.volume;
    el("audioMute").checked=settings.muted;
    for(const group of audio.groups)el("audio-"+group).value=settings[group];
  }
  if(audio){
    function unlockSound(){if(!document.hidden)void audio.activate();}
    document.addEventListener("pointerup",unlockSound);
    document.addEventListener("keydown",unlockSound);
    el("audioEnable").onclick=async()=>{
      const ready=await audio.activate(true);
      el("audioStatus").textContent=ready?"Salida de audio activa.":"El navegador no pudo activar el audio. Vuelve a intentarlo.";
    };
    document.addEventListener("visibilitychange",()=>audio.setActive(!document.hidden && (!inRoom || (online && !sectorWaiting))));
    window.addEventListener("pagehide",event=>{if(event.persisted)audio.setActive(false);else audio.clear();});
    if(!inRoom)window.addEventListener("pageshow",()=>audio.setActive(!document.hidden));
  }
  if(inRoom)canvas.parentElement.classList.add("awaiting-room");
  const view=new MundoView.View(canvas,s=>{
    el("stats").textContent=(s.mode?s.mode+" · ":"")+s.fps+" FPS · "+s.width+" × "+s.height;
    if(menu.open)el("videoDimensions").textContent=view.videoDimensions();
  },s=>{el("notice").textContent=s;});
  const ownerPeople=inRoom?window.MundoPeople?.install(view,layer=>link?.retryRoomActor(layer)):null;
  const vehicleLook=inRoom?window.MundoBrumaLook?.install(view):null;
  let avatar,yaw=0,pitch=0,drag=null,loadTicket=0;
  let rig,thirdPerson=true;
  let cars=[],driving=null,road=null;
  let localActivity=null;
  let streaming=null,activeProject=null,travelTicket=null,fileTicket=null;
  const destinations=el("travelWorld"),travelGo=el("travelGo"),travelInfo=el("travelInfo");
  let lastSnapshot=0, presenceEpoch=0;
  let holdConnection=()=>{};
  let online=false,sectorWaiting=false,peer=null,peerRig=new MundoAvatar(64);
  const npcView=new MundoNpcView();
  function clearNpcs(){npcView.clear();view.npcPositions=[];}
  let entryView=null;
  if(inRoom)view.allowDraw=()=>(online && !sectorWaiting) || entryView!==null;
  const courseCard=el("courseCard"),courseScore=el("courseScore"),courseClock=el("courseClock"),courseSplit=el("courseSplit");
  function raceTime(ms,exact){
    const seconds=Math.floor(ms/1000);
    const clock=Math.floor(seconds/60)+":"+String(seconds%60).padStart(2,"0");
    return exact?clock+","+String(ms%1000).padStart(3,"0"):clock;
  }
  function splitText(score){
    if(!score.split)return "";
    const {atMs,referenceMs}=score.split;
    let comparison="Sin marca de referencia";
    if(referenceMs!==null){
      const delta=atMs-referenceMs;
      if(delta===0)comparison="±0,000 s · igual a la referencia";
      else comparison=(delta<0?"−":"+")+raceTime(Math.abs(delta),true)+(delta<0?" por delante":" por detrás");
    }
    return "Parcial "+score.passed+" · "+score.splitLabel+" · "+raceTime(atMs,true)+" · "+comparison;
  }
  function displayCourse(score){
    courseCard.hidden=!score;
    if(!score){courseScore.textContent="";courseClock.textContent="";courseSplit.textContent="";return;}
    const done=score.phase==="finished";
    const next="Vuelta "+score.run+" · "+score.passed+"/"+score.total+" · "+
      (done?"Meta "+raceTime(score.elapsedMs,true):score.phase==="ready" && score.startMode==="flying"
        ?"Cruza "+score.nextLabel+" para iniciar":score.nextLabel)+
      (score.bestMs===null?"":" · Mejor "+raceTime(score.bestMs,true));
    if(courseScore.textContent!==next)courseScore.textContent=next;
    const split=splitText(score);
    if(courseSplit.textContent!==split)courseSplit.textContent=split;
    const clock=score.phase==="running"?raceTime(score.elapsedMs,false):"";
    if(courseClock.textContent!==clock)courseClock.textContent=clock;
  }
  function coverScene(){
    audio?.setActive(false);roomClips?.pause();
    clearNpcs();
    displayCourse(null);
    canvas.parentElement.classList.add("awaiting-room");
    canvas.parentElement.classList.remove("entry-drawn");
    if(entryView){
      view.scene=entryView.previousScene;view.look=entryView.previousLook;
      view.actorParts=entryView.previousParts;view.peerPosition=entryView.previousPeer;
      el("world").textContent=entryView.previousTitle;
      entryView=null;view.levels.clear();
    }
    view.drawnScene=null;view.mapProjection=null;
  }
  function presentEntry({world,focus,title,proposed}){
    // This collision index is for positioning the frozen camera only. The
    // online body and controller are still bound to the full admitted world.
    const geometry=MundoGeometry.flatten(world);
    const terrain=new MundoWalk(geometry.objects,false);
    const [x,z]=focus;
    let ground=-Infinity;
    for(const box of terrain.around(x,z)){
      if(x>=box.min[0] && x<=box.max[0] && z>=box.min[2] && z<=box.max[2])
        ground=Math.max(ground,box.max[1]);
    }
    if(!Number.isFinite(ground))return;
    const target=[x,ground+1.3,z], direction=[1/3,2/3,2/3];
    const distance=terrain.clearDistance(target,direction,8,.16);
    const look=distance>.5?{eye:target.map((v,i)=>v+direction[i]*distance),target}:
      {eye:[x,ground+1.7,z],target:[x,ground+1.45,z-3]};
    coverScene();
    entryView={previousScene:view.scene,previousLook:view.look,previousParts:view.actorParts,
      previousPeer:view.peerPosition,previousTitle:el("world").textContent,geometry};
    view.scene=geometry;view.look=look;view.actorParts=[];view.peerPosition=null;view.levels.clear();
    const label=proposed?"Vista previa del destino propuesto":"Vista previa de la entrada";
    el("world").textContent=title?label+" · "+title:label;
  }
  let playerTarget=null,peerTarget=null;
  let roomCar=null,roomResidence=null,seatRequest=null,link=null;
  const returnDialog=el("returnDialog");
  let meetingEnabled=false,meetingIntent=null;
  function meetingControls(){
    const button=el("returnMeeting");
    button.hidden=!inRoom||!online||sectorWaiting||!meetingEnabled||!!driving||riding;
    button.disabled=!!meetingIntent||!!seatRequest;
    el("meetingAction").hidden=button.hidden&&!el("returnNotice").textContent;
  }
  function meetingNotice(message){
    el("returnNotice").textContent=message;meetingControls();
  }
  const notify=message=>{el("notice").textContent=message;};
  function approach(position,target,dt){
    if(!target)return;
    const factor=1-Math.exp(-24*dt);
    for(let i=0;i<3;i++)position[i]+=(target[i]-position[i])*factor;
  }

  const touchControls=MundoView.mobile || navigator.maxTouchPoints>0;
  let riding=false;
  function seatAction(alternate=false){
    if(!roomCar)return null;
    const state=roomCar.target;
    if(alternate){
      if(riding && state.driver===null)return "enter";
      return !driving && !riding && state.driver===null && state.passenger===null?"ride":null;
    }
    if(driving||riding)return "exit";
    return state.driver===null?"enter":state.passenger===null?"ride":null;
  }
  const seatLabel=action=>({enter:"Tomar el volante",ride:"Subir de pasajero",exit:"Bajar del carro"}[action]);
  const walkingHint=el("hint").textContent;
  function controls(){
    meetingControls();
    const available=inRoom?online&&!sectorWaiting&&!!roomCar:cars.length>0;
    const primary=seatAction(),alternate=seatAction(true);
    const second=el("secondSeat");
    second.hidden=!inRoom||!available||!alternate;
    second.disabled=!!seatRequest||!!meetingIntent;
    if(alternate)second.textContent=seatLabel(alternate);
    const button=el("useCar");
    button.hidden=!available;button.disabled=!!seatRequest||!!meetingIntent||(inRoom&&!primary);
    button.textContent=seatRequest?"Esperando a la sala…":inRoom?(seatLabel(primary)||"Plazas ocupadas"):driving?"Bajar del carro":"Subir al carro";
    el("jump").hidden=el("pad").hidden=!touchControls||riding||sectorWaiting;
    el("jump").textContent=driving?"Frenar":"Saltar";
    el("hint").textContent=driving?"↑ o W acelera · ↓ o S frena y da reversa · ← → giran · Espacio frena · E para bajar":
      riding?"Pasajero · Arrastra para mirar · E para bajar"+(alternate?" · G para tomar el volante":""):
      walkingHint+(available?" · E "+(inRoom?(seatLabel(primary)||""):"para subir al carro"):"")+(alternate?" · G "+seatLabel(alternate):"");
  }
  function toggleCar(alternate=false){
    if(localActivity?.paused||menu.open||returnDialog.open||meetingIntent||travelTicket!==null||streaming?.waiting||streaming?.failed)return;
    if(inRoom){
      if(!online||sectorWaiting||!roomCar||seatRequest)return;
      const action=seatAction(alternate);
      if(!action)return;
      seatRequest=action;controls();canvas.focus({preventScroll:true});return;
    }
    if(driving){
      if(Math.abs(driving.speed)>.2){notify("Detén el carro para bajar.");return;}
      const pedestrian=new MundoWalk(view.scene.objects,false);
      const feet=driving.exitPosition(pedestrian,road);
      if(!feet){notify("Busca un lugar con espacio libre junto al carro.");return;}
      avatar=pedestrian;if(streaming)avatar.floor=streaming.archive.floor;avatar.position=feet;avatar.grounded=true;
      yaw=driving.yaw;pitch=0;driving.speed=0;driving.accumulator=0;
      rig=new MundoAvatar();driving=null;road=null;
      activeProject?.cross(avatar.position,avatar.grounded,true);
    }else{
      let nearest=null,distance=1.75;
      for(const car of cars){
        const d=car.distance(avatar.position);
        if(d<distance){nearest=car;distance=d;}
      }
      if(!nearest){notify("Acércate a la puerta de un carro del taller.");return;}
      const index=new MundoWalk(view.scene.objects.filter(o=>!nearest.partIds.has(o.n.id)),false);
      if(!nearest.accessible(index,avatar.position)){notify("Acércate por un lado despejado del carro.");return;}
      if(!nearest.allowed(index,nearest.x,nearest.z,nearest.yaw)){
        notify("Coloca las cuatro ruedas sobre un piso plano y deja espacio alrededor del carro.");return;
      }
      driving=nearest;road=index;yaw=0;pitch=-.13;
    }
    keys.clear();drag=null;controls();pose();notify("");canvas.focus({preventScroll:true});
  }
  function pose(dt=0) {
    if(!avatar || !rig)return;
    if(driving||riding){
      const car=driving||roomCar.car;
      const angle=car.yaw+yaw,cp=Math.cos(pitch);
      const forward=[cp*Math.sin(angle),Math.sin(pitch),-cp*Math.cos(angle)];
      const pivot=roomCar && window.MundoBrumaLook?.seat(car,riding);
      const [cx,cz]=pivot?[pivot[0],pivot[2]]:roomCar?car.point((riding?1:-1)*car.width*.36,0):[car.x,car.z];
      const eye=[cx,car.top+.36,cz];
      audio?.listen(eye,angle);
      const chase=thirdPerson&&view.gpuReady&&rig.follow(road,eye,forward,car.length+4);
      view.look=chase||{eye,target:eye.map((v,i)=>v+forward[i])};
      if(roomCar&&chase){rig.sit(car,riding);view.actorParts=rig.parts;}
      else view.actorParts=[];
    }else{
      const p=avatar.position,eye=[p[0],p[1]+1.58,p[2]],cp=Math.cos(pitch);
      const forward=[cp*Math.sin(yaw),Math.sin(pitch),-cp*Math.cos(yaw)];
      audio?.listen(eye,yaw);
      rig.update(avatar,yaw,dt);
      const chase=thirdPerson && view.gpuReady && rig.follow(roomCar?.walkCamera??avatar,eye,forward);
      view.look=chase||{eye,target:eye.map((n,i)=>n+forward[i])};
      view.actorParts=chase?rig.parts:[];
    }
    if(peer){
      const inPassengerSeat=peer.id===roomCar?.target.passenger;
      if(inPassengerSeat || peer.id===roomCar?.target.driver)peerRig.sit(roomCar.car,inPassengerSeat);
      else peerRig.update(peer,peer.yaw,dt);
      view.actorParts=view.actorParts.concat(peerRig.parts);
    }
    view.peerPosition=peer?peer.position:null;
    if(inRoom)npcView.draw(view,performance.now()*.001,dt);
  }
  function applyRoomCar(state,seat){
    const wasDriving=!!driving, wasRiding=riding;
    if(state!=null){
      if(!roomCar){
        const car=cars.find(item=>String(item.rootId)===state.root);
        if(!car)throw Object.assign(new Error("El carro de la sala no existe en esta revisión."),{status:422});
        roomCar=new MundoRoomCar(car,view.scene,state);
      }else{
        if(String(roomCar.car.rootId)!==state.root)throw Object.assign(new Error("La sala cambió de carro sin cambiar la revisión."),{status:422});
        roomCar.accept(state,!online);
      }
      driving=state.driver===seat?roomCar.car:null;riding=state.passenger===seat;road=roomCar.road;
    }else if(roomCar){
      throw Object.assign(new Error("Falta el carro de la revisión de sala."),{status:422});
    }
    if(wasDriving!==!!driving||wasRiding!==riding){
      keys.clear();avatar.jump=false;drag=null;rig=new MundoAvatar();
      if((wasDriving||wasRiding)!==(!!driving||riding)){
        yaw=driving||riding?0:state.yaw+yaw;pitch=driving||riding?-.13:0;
      }
    }
    return wasDriving!==!!driving||wasRiding!==riding;
  }
  function load(world,name,demo=false,preview=null,projectLocation=null){
    const geometry=MundoGeometry.flatten(world), next=new MundoWalk(geometry.objects,demo);
    let previewCars;
    if(preview && (preview.meetingPoint!=null || preview.vehicleRoot!=null)){
      const car=MundoDriving.roomCar(geometry,preview.vehicleRoot??null);
      previewCars=car?[car]:[];
      if(preview.meetingPoint!=null){
        const seat=preview.seat===undefined?0:preview.seat;
        if(seat!==0 && seat!==1)throw new Error("La plaza elegida para la vista previa no existe.");
        const terrain=car?new MundoWalk(geometry.objects.filter(o=>!car.partIds.has(o.n.id)),false):next;
        const feet=MundoMeeting.plan(terrain,car,preview.meetingPoint).initial[seat];
        next.position=feet.slice();next.spawn=feet.slice();next.grounded=true;
      }
    }
    streaming=null;
    audio?.setActive(false);
    install(geometry,next,name,previewCars,projectLocation);
    audio?.install(world);audio?.setActive(!document.hidden);
  }
  function install(geometry,next,name,availableCars=MundoDriving.discover(geometry),projectLocation=null){
    activeProject=projectLocation;
    activeProject?.cross(next.position,next.grounded,true);
    cars=availableCars;driving=null;riding=false;road=null;roomCar=null;drag=null;controls();
    view.scene=geometry;view.levels.clear();avatar=next;rig=new MundoAvatar();yaw=pitch=0;keys.clear();pose();el("world").textContent=name;
    if(menu.open)listDestinations();
  }
  const zoneRadius=MundoView.mobile?1:2;
  async function openZones(file,ticket){
    const archive=await MundoZones.open(file);
    if(ticket!==loadTicket)return;
    const spawn=new MundoWalk(archive.global.objects,false).position;
    const cx=archive.cell(spawn[0]),cz=archive.cell(spawn[2]);
    const objects=await archive.nearby(cx,cz,zoneRadius);
    if(ticket!==loadTicket)return;
    const character=new MundoWalk(objects,false);character.floor=archive.floor;
    audio?.setActive(false);
    install({byId:archive.global.byId,objects},character,file.name.replace(/\.mzones$/i,""));
    if(audio){
      const nodes=new Map([...archive.global.byId].map(([id,entry])=>[id,entry.n]));
      audio.install({nodes});audio.setActive(!document.hidden);
    }
    streaming={archive,cx,cz,waiting:false,failed:false};
    el("notice").textContent="";
  }
  function zonesReady(){
    const state=streaming;
    if(!state)return true;
    if(state.waiting||state.failed)return false;
    const x=state.archive.cell(driving?driving.x:avatar.position[0]);
    const z=state.archive.cell(driving?driving.z:avatar.position[2]);
    if(x===state.cx&&z===state.cz)return true;
    state.waiting=true;
    state.archive.nearby(x,z,zoneRadius).then(objects=>{
      if(state!==streaming)return;
      const terrain=new MundoWalk(driving?objects.filter(o=>!driving.partIds.has(o.n.id)):objects,false);
      if(driving)road=terrain;
      else{
        avatar.grid=terrain.grid;avatar.large=terrain.large;avatar.floor=state.archive.floor;
      }
      view.scene.objects=objects;view.levels.clear();state.cx=x;state.cz=z;
    }).catch(error=>{
      if(state!==streaming)return;
      state.failed=true;keys.clear();
      el("notice").textContent=error.message+" Abre de nuevo el paquete o selecciona otro mundo.";
    }).finally(()=>{state.waiting=false;});
    return false;
  }
  if(trial)load(MundoWorld.decode(MundoWorld.from64(MundoPublic.world)),"Plaza Brisa",true);
  el("useCar").onclick=()=>toggleCar();
  el("secondSeat").onclick=()=>toggleCar(true);
  view.onMove=dt=>{
    if(inRoom){
      if(online && performance.now()-lastSnapshot>=2000)holdConnection();
      if(sectorWaiting)return;
      if(online){
        roomCar?.advance(dt);
        approach(avatar.position,playerTarget,dt);
        if(peer)approach(peer.position,peerTarget,dt);
        pose(dt);
        // Reveal only after this renderer has drawn the installed room, including
        // the 2D fallback and low frame caps that can defer the next draw.
        const drawn=view.gpuReady?view.drawnScene:view.mapProjection?.scene;
        if(drawn===view.scene)canvas.parentElement.classList.remove("awaiting-room");
      }else if(entryView){
        const drawn=view.gpuReady?view.drawnScene:view.mapProjection?.scene;
        if(drawn===entryView.geometry)canvas.parentElement.classList.add("entry-drawn");
      }
      return;
    }
    if(localActivity?.paused||menu.open||travelTicket!==null||!zonesReady())return;
    if(driving)driving.update(dt,keys,road);
    else {
      const target=avatar.update(dt,keys,yaw,fileTicket===null?activeProject?.cross:null);
      if(target!==null)travelTo(target,false);
    }
    pose(dt);
    localActivity?.frame(activeProject?.id,avatar.position,driving,yaw);
  };
  el("cameraMode").onclick=()=>{if(inRoom&&(!online||sectorWaiting))return;thirdPerson=!thirdPerson;pose();
    el("cameraMode").setAttribute("aria-pressed",String(thirdPerson));};
  el("open").onclick=()=>{keys.clear();el("file").click();};
  el("file").onchange=async e=>{
    const file=e.target.files[0];e.target.value="";if(!trial||!file)return;
    const ticket=++loadTicket;fileTicket=ticket;
    try{
      if(/\.mproject$/i.test(file.name)){
        await openProject(file,ticket);
        return;
      }
      if(/\.mzones$/i.test(file.name)){await openZones(file,ticket);return;}
      const next=await MundoWorld.readFile(file);if(ticket!==loadTicket)return;
      load(next,file.name.replace(/\.mworld$/i,""));if(view.gpuReady)el("notice").textContent="";
    }catch(error){if(ticket===loadTicket)el("notice").textContent=error.message;}
    finally{if(fileTicket===ticket)fileTicket=null;}
  };
  async function openProject(file,ticket){
    const project=await MundoProject.open(file);
    if(ticket!==loadTicket)return false;
    const initial=project.worlds.find(entry=>entry.id===project.start);
    if(!await enterProjectWorld(project,initial,ticket))return false;
    notify("Proyecto «"+project.name+"» · "+initial.title+".");
    return true;
  }
  async function enterProjectWorld(project,entry,ticket,manual=false) {
    const room=await MundoProject.load(entry);
    if(ticket!==loadTicket || inRoom || (manual && !menu.open))return false;
    load(room.world,room.title,false,{vehicleRoot:room.vehicleRoot,meetingPoint:room.meetingPoint,seat:0},
      {project,id:entry.id,cross:MundoProject.crossing(project,entry)});
    return true;
  }
  function destinationChanged() {
    travelGo.disabled=!activeProject || !!driving || travelTicket!==null ||
      Number(destinations.value)===activeProject.id;
  }
  function listDestinations() {
    const enabled=!inRoom && activeProject && activeProject.project.worlds.length>1;
    el("projectTravel").hidden=!enabled;
    if(!enabled) { destinations.replaceChildren(); return; }
    const {project,id}=activeProject;
    destinations.replaceChildren(...project.worlds.map(entry=>
      new Option(entry.title+" · #"+entry.id+(entry.id===id?" · Actual":""),String(entry.id))));
    destinations.value=String(id);
    travelInfo.textContent=driving?"Baja del carro para cambiar de mundo.":
      "Cada visita comienza en la posición de entrada del destino.";
    destinationChanged();
  }
  destinations.onchange=destinationChanged;
  travelGo.onclick=()=>travelTo(Number(destinations.value),true);
  async function travelTo(target,manual){
    if(inRoom || menu.open!==manual || !activeProject || driving || travelTicket!==null || fileTicket!==null)return;
    const {project,id}=activeProject;
    const entry=project.worlds.find(item=>item.id===target);
    if(!entry || entry.id===id)return;
    const ticket=++loadTicket;
    travelTicket=ticket;
    releaseInput();
    const opening="Abriendo «"+entry.title+"»…";
    if(manual)travelInfo.textContent=opening;else notify(opening);
    destinations.disabled=true;destinationChanged();
    try {
      if(await enterProjectWorld(project,entry,ticket,manual)){
        travelTicket=null;
        if(manual)menu.close();
        notify("Proyecto «"+project.name+"» · "+entry.title+".");
      }
    } catch(error) {
      if(ticket===loadTicket){if(manual)travelInfo.textContent=error.message;else notify(error.message);}
    } finally {
      if(travelTicket===ticket)travelTicket=null;
      destinations.disabled=travelTicket!==null;
      destinationChanged();
    }
  }
  function form(s){el("resolution").value=s.resolution;el("detail").value=s.detail;el("cap").value=s.cap;}
  function releaseInput(){
    keys.clear();if(avatar)avatar.jump=false;drag=null;
    if(link)link.unconfirmed=null;
    if(seatRequest){seatRequest=null;controls();}
  }
  function suspendMeeting(){
    if(returnDialog.open)returnDialog.close();
    if(meetingIntent && !meetingIntent.sent){
      meetingIntent=null;meetingNotice("Regreso cancelado.");controls();
    }
  }
  window.addEventListener("blur",suspendMeeting);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)suspendMeeting();});
  function openMenu(){
    if(!menu.open && travelTicket!==null && travelTicket===loadTicket){
      ++loadTicket;travelTicket=null;destinations.disabled=false;notify("Viaje cancelado al abrir los ajustes.");
    }
    releaseInput();listDestinations();form(view.settings);audioForm(audio?.settings);
    el("videoDimensions").textContent=view.videoDimensions();el("feedback").textContent="";
    if(!menu.open)menu.showModal();
  }
  el("family").textContent=MundoView.mobile?"Perfil de este móvil o tableta":"Perfil de esta PC";
  el("settings").onclick=openMenu;el("reset").onclick=()=>{form(MundoView.defaults());audioForm(audio?.defaults);};
  el("cancel").onclick=()=>menu.close();menu.addEventListener("close",()=>{
    if(travelTicket!==null && travelTicket===loadTicket)++loadTicket;
    travelTicket=null;destinations.disabled=false;
    keys.clear();canvas.focus({preventScroll:true});
  });
  el("video").onsubmit=e=>{
    e.preventDefault();try{
      const saved=view.applySettings({resolution:Number(el("resolution").value),cap:el("cap").valueAsNumber,detail:el("detail").value});
      let audioSaved=true;
      if(audio){
        const levels=Object.fromEntries(audio.groups.map(group=>[group,Number(el("audio-"+group).value)]));
        audioSaved=audio.apply({...levels,volume:Number(el("audioVolume").value),muted:el("audioMute").checked});
        void audio.activate();
      }
      menu.close();if(!saved || !audioSaved)el("notice").textContent="Ajustes aplicados a esta sesión. El navegador tiene desactivado el guardado local.";
    }catch(error){el("feedback").textContent=error.message;}
  };
  const moves=new Set(["KeyW","KeyS","KeyA","KeyD","ArrowLeft","ArrowRight","ArrowUp","ArrowDown","ShiftLeft","ShiftRight"]);
  window.addEventListener("keydown",e=>{
    if((inRoom&&(!online||sectorWaiting)) || localActivity?.paused || menu.open || returnDialog.open || e.altKey||e.ctrlKey||e.metaKey)return;
    if(inRoom&&e.code==="KeyG"){e.preventDefault();if(!e.repeat)toggleCar(true);return;}
    if(e.code==="KeyE"){e.preventDefault();if(!e.repeat)toggleCar();return;}
    if(e.code==="Escape"){openMenu();return;}
    if(e.target instanceof HTMLButtonElement && e.code==="Space")return;
    if(moves.has(e.code)){e.preventDefault();keys.add(e.code);}
    if(e.code==="Space"){e.preventDefault();if(driving)keys.add("Space");else if(!riding&&!e.repeat)avatar.jump=true;}
  });
  window.addEventListener("keyup",e=>keys.delete(e.code));
  window.addEventListener("blur",releaseInput);
  document.addEventListener("visibilitychange",()=>{if(document.hidden)releaseInput();});
  canvas.onpointerdown=e=>{if(drag || menu.open || (inRoom&&(!online||sectorWaiting)))return;canvas.setPointerCapture(e.pointerId);canvas.focus({preventScroll:true});drag={id:e.pointerId,x:e.clientX,y:e.clientY};};
  canvas.onpointermove=e=>{
    if(!drag||drag.id!==e.pointerId)return;
    yaw+=(e.clientX-drag.x)*.005;pitch=Math.max(-1.35,Math.min(1.35,pitch-(e.clientY-drag.y)*.005));
    drag.x=e.clientX;drag.y=e.clientY;pose();
  };
  canvas.onlostpointercapture=()=>{drag=null;};
  if(touchControls){
    el("pad").hidden=el("jump").hidden=false;
    for(const b of el("pad").querySelectorAll("button")){
      b.onpointerdown=e=>{if(inRoom&&(!online||sectorWaiting))return;e.preventDefault();b.setPointerCapture(e.pointerId);keys.add(b.dataset.key);};
      b.onlostpointercapture=()=>keys.delete(b.dataset.key);
    }
    el("jump").onpointerdown=e=>{
      if(inRoom&&(!online||sectorWaiting))return;
      e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);
      if(driving)keys.add("Space");else if(!riding)avatar.jump=true;
    };
    el("jump").onlostpointercapture=()=>keys.delete("Space");
  }
  if(!inRoom && typeof window.MundoLocalActivity==="function"){
    localActivity=window.MundoLocalActivity(async file=>{
      releaseInput();
      const ticket=++loadTicket;fileTicket=ticket;
      try{
        if(!await openProject(file,ticket))throw Error("La partida cambió durante la apertura.");
        notify("");canvas.focus({preventScroll:true});
      }finally{if(fileTicket===ticket)fileTicket=null;}
    });
  }
  if(inRoom){
    el("open").hidden=true;el("roomAction").hidden=false;
    controls();
    let proof;
    const key="mundo-seat-"+invite;
    try{proof=sessionStorage.getItem(key);}catch{}
    if(!/^[a-f0-9]{48}$/.test(proof||"")){
      proof=Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,"0")).join("");
      try{sessionStorage.setItem(key,proof);}catch{}
    }
    link=new MundoRoomLink(invite,proof);
    if(audio)roomClips=MundoPlayerAudio.roomClips(link,audio,window.MundoAudioClips,mundoRoomBytes,
      message=>{el("audioClipStatus").textContent=message;});
    const roomModels=MundoRoomModels(view,link,message=>{el("modelNotice").textContent=message;});
    const status=message=>{el("notice").textContent=message;};
    let active=false,generation=0,timer=null,pending=Promise.resolve(),peers=-1;
    let meetingLast=0,probeAt=Infinity;
    function currentMeeting(){
      return online && !sectorWaiting && meetingEnabled && !driving && !riding && !seatRequest && !meetingIntent &&
        !document.hidden && document.hasFocus() && !!link.lease;
    }
    el("returnMeeting").onclick=()=>{
      if(!currentMeeting())return;
      releaseInput();returnDialog.showModal();
    };
    el("cancelReturn").onclick=()=>returnDialog.close();
    el("confirmReturn").onclick=()=>{
      returnDialog.close();
      if(!currentMeeting())return;
      meetingIntent={lease:link.lease,request:meetingLast+1,sent:false};
      meetingLast=meetingIntent.request;
      meetingNotice("Esperando al anfitrión…");controls();
    };
    function parseMeeting(text){
      const match=/^ready ([a-f0-9]{32}) (0|[1-9][0-9]{0,15})$/.exec(text);
      if(!match || match[1]!==link.lease)return null;
      const last=Number(match[2]);
      return Number.isSafeInteger(last)?last:null;
    }
    async function probeMeeting(ticket){
      probeAt=Infinity;
      try{
        const reply=await link.meeting({});
        if(ticket!==generation)return;
        const last=parseMeeting(reply);
        if(last!==null)meetingLast=Math.max(meetingLast,last);
        meetingEnabled=last!==null && meetingLast<Number.MAX_SAFE_INTEGER;
      }catch(error){
        if(ticket!==generation)return;
        meetingEnabled=false;
        if(error.status===403 || error.status===410)throw error;
        if(!error.status||error.status>=500||[408,429].includes(error.status))probeAt=performance.now()+10000;
      }
      meetingControls();
    }
    async function sendReturn(intent,ticket){
      intent.sent=true;
      const body={lease:intent.lease,request:intent.request};
      const current=()=>generation===ticket && link.lease===intent.lease;
      const result=async()=>{
        const text=await link.meeting(body);
        return ["returned","blocked","aboard","off","stale"].includes(text)?text:"unknown";
      };
      try{return await result();}
      catch(error){
        if(!current()||error.status===404)return "off";
        if(error.status===403 || error.status===410)throw error;
        // Replay only a receipt the host already committed to this reservation.
        // A return that never arrived must require a fresh confirmation.
        if(!error.status || error.status>=500 || [408,429].includes(error.status)){
          try{
            const receipt=await link.meeting({});
            if(current() && parseMeeting(receipt)===intent.request)return await result();
          }catch(receiptError){
            if(receiptError.status===403 || receiptError.status===410)throw receiptError;
          }
        }
        return "unknown";
      }
    }
    function resetPeer(){
      peer=null;peerTarget=null;peerRig=new MundoAvatar(64);view.peerPosition=null;
    }
    let nextGuide=0;
    function guideToCar(state,feet,gate=null){
      const label=el("carGuide");
      const aboard=Boolean(driving||riding);
      if(!state||(aboard && !gate)){
        if(label.textContent)label.textContent="";
        nextGuide=0;return;
      }
      const now=performance.now();
      if(now<nextGuide)return;
      nextGuide=now+1000;
      const dx=aboard?gate[0]-state.x:state.x-feet[0],dz=aboard?gate[2]-state.z:state.z-feet[2];
      const heading=aboard?state.yaw:yaw,meters=Math.hypot(dx,dz);
      const forward=dx*Math.sin(heading)-dz*Math.cos(heading),right=dx*Math.cos(heading)+dz*Math.sin(heading);
      const direction=Math.abs(forward)>=Math.abs(right)?(forward>=0?"delante":"detrás"):
        (right>=0?"a la derecha":"a la izquierda");
      const target=aboard?"Puerta":"Turismo";
      const guide=meters<1?target+" a menos de 1 m":target+" · "+Math.round(meters)+" m · "+direction;
      if(guide!==label.textContent)label.textContent=guide;
    }
    function changeRoomTerrain(geometry,terrain){
      // Retain the walker, camera rig, seat, vehicle transforms and interpolation targets.
      avatar.grid=terrain.grid;avatar.large=terrain.large;avatar.floor=terrain.floor;
      if(roomCar){roomCar.road=terrain;road=terrain;}
      if(entryView)entryView.previousScene=geometry;
      else{
        view.scene=geometry;view.levels.clear();view.mapProjection=null;view.drawnScene=null;view.mapShapes=[];
        for(const bucket of view.groups?.values()??[])bucket.items.length=0;
      }
    }
    function suspendRoomTerrain(){
      if(!roomResidence?.active)return;
      roomResidence.clear();
      changeRoomTerrain(roomResidence.global,new MundoWalk([],false));
    }
    function installRoom(admission,self,carState){
      let residence=admission.residence;
      if(carState && residence && !residence.cars.some(car=>String(car.rootId)===carState.root)){
        if(link.soloResidence===residence)link.soloResidence=null;
        admission.residence=null;residence=null;
      }
      const area=residence?.select(self,carState,performance.now());
      const geometry=area?.geometry??admission.geometry??MundoGeometry.flatten(admission.world);
      const next=area?.terrain??admission.walker??new MundoWalk(geometry.objects,false);
      next.position=self.position.slice();next.spawn=self.position.slice();
      next.grounded=self.grounded;next.vy=self.vy;
      const available=residence?.cars??admission.available??MundoDriving.discover(geometry);
      let replica=null;
      if(carState){
        const car=available.find(item=>String(item.rootId)===carState.root);
        if(!car)throw Object.assign(new Error("El carro de la sala no existe en esta revisión."),{status:422});
        replica=new MundoRoomCar(car,geometry,carState,area?.terrain??admission.road);
      }
      streaming=null;
      audio?.setActive(false);audio?.install(admission.world);
      install(geometry,next,admission.title,available);
      roomCar=replica;roomResidence=residence;
    }
    function adoptRoomArea(admission,self,state){
      roomResidence=admission.residence??null;
      const area=roomResidence?.select(self,state,performance.now());
      const geometry=area?.geometry??admission.geometry,available=roomResidence?.cars??admission.available;
      const terrain=area?.terrain??admission.road??admission.walker;
      if(roomCar && state){
        const car=available.find(candidate=>String(candidate.rootId)===state.root);
        if(!car)throw Object.assign(new Error("Falta el turismo de la revisión."),{status:422});
        const next=new MundoRoomCar(car,geometry,roomCar.display,terrain);
        next.target=roomCar.target;next.moving=roomCar.moving;
        if(driving)driving=car;
        roomCar=next;
      }
      audio?.install(admission.world,true);
      cars=available;changeRoomTerrain(geometry,terrain);
    }
    function clearRoom(){
      roomClips?.clear();audio?.clear();
      roomModels.clear();
      coverScene();suspendRoomTerrain();roomResidence=null;el("world").textContent="Sala privada";
      guideToCar(null,null);
      online=false;sectorWaiting=false;resetPeer();peers=-1;playerTarget=null;seatRequest=null;driving=null;riding=false;road=null;roomCar=null;
      meetingEnabled=false;meetingIntent=null;meetingLast=0;probeAt=Infinity;
      if(returnDialog.open)returnDialog.close();
      meetingNotice("");keys.clear();if(avatar)avatar.jump=false;drag=null;view.actorParts=[];controls();
    }
    holdConnection=()=>{
      // A verified download can be retained even if it had no floor for the preview camera.
      link.dismissEntry();
      link.clearCellCache();
      link.pauseSectors();sectorWaiting=false;
      if(!active)return;
      ++presenceEpoch;
      coverScene();suspendRoomTerrain();
      online=false;peers=-1;meetingEnabled=false;meetingIntent=null;probeAt=link.lease?0:Infinity;
      if(returnDialog.open)returnDialog.close();
      releaseInput();guideToCar(null,null);meetingNotice("");controls();
      status("Esperando una actualización de la sala…");
    };
    window.addEventListener("offline",holdConnection);
    window.addEventListener("pagehide",holdConnection);
    window.addEventListener("memorypressure",()=>{link.clearCellCache();link.trimAhead();});
    document.addEventListener("visibilitychange",()=>{if(document.hidden)holdConnection();});
    function run(){
      const ticket=++generation;active=true;clearRoom();el("changeInvite").hidden=true;
      el("roomAction").hidden=false;el("roomAction").textContent="Salir de la sala";status("Entrando a la sala privada…");
      let joined=false,installed=false,admission=null,installedScene=null,installedArea=0;
      let firstFailure=null,backoff=500;
      link.onEntryScene=preview=>{
        if(ticket!==generation || !active)return;
        if(!preview){if(entryView)coverScene();return;}
        if(!online && !document.hidden)presentEntry(preview);
      };
      link.onWorldReuse=()=>{
        if(ticket===generation && active)status("Recuperando el mundo de esta sesión…");
      };
      link.onProgress=(received,total,advanced)=>{
        if(ticket!==generation || !active)return;
        if(advanced){firstFailure=null;backoff=500;}
        const percent=Math.floor(received*100/total);
        const message=received===total?"Verificando la revisión del mundo…":
          (advanced?"Cargando el mundo · ":"Reanudando la carga del mundo · ")+percent+" %";
        if(el("notice").textContent!==message)status(message);
      };
      function conclude(message,newInvitation){
        link.resetSeat();clearRoom();active=false;
        const retry=el("roomAction"),change=el("changeInvite");
        retry.hidden=newInvitation;retry.textContent="Volver a entrar";change.hidden=false;
        status(message);
        if(newInvitation){
          try{sessionStorage.removeItem(key);}catch{}
          change.focus();
        }
      }
      function holdScene(){
        audio?.setActive(false);roomClips?.pause();
        sectorWaiting=false;
        if(!entryView)coverScene();
        suspendRoomTerrain();
        online=false;peers=-1;seatRequest=null;meetingEnabled=false;meetingIntent=null;
        outcome=null;snapAfterReturn=false;probeAt=Infinity;
        if(returnDialog.open)returnDialog.close();
        releaseInput();guideToCar(null,null);controls();
        status("Preparando el destino con el anfitrión…");
      }
      function again(delay){
        if(ticket===generation)timer=setTimeout(()=>{pending=poll();},delay);
      }
      function retryRecovery(message,expired){
        if(ticket!==generation)return;
        const now=performance.now();
        firstFailure??=now;
        const remaining=45000-(now-firstFailure);
        if(remaining<=0){conclude(expired,false);return;}
        status(message);again(Math.min(backoff,remaining));backoff=Math.min(4000,backoff*2);
      }
      function retryRoute(){
        link.dismissEntry();
        retryRecovery("Sincronizando la revisión actual con el anfitrión…",
          "El anfitrión no pudo confirmar el mundo activo. Vuelve a entrar con tu invitación.");
      }
      let snapAfterReturn=false,outcome=null;
      async function poll(){
        try{
          if(!joined){
            admission=await link.join();if(generation!==ticket)return;
            joined=true;probeAt=link.lease?0:Infinity;
          }
          if(link.project && link.waiting){
            holdScene();
            try{if(!await link.syncRoute())return again(160);}
            catch(error){if(error.status===412)return retryRoute();throw error;}
            if(generation!==ticket)return;
            admission=link.scene;probeAt=0;
          }
          if(meetingIntent && !meetingIntent.sent){
            const intent=meetingIntent;
            if(intent.lease===link.lease && online && !sectorWaiting && link.canSendSectorInput(admission) && !driving && !riding && !document.hidden && document.hasFocus()){
              outcome=await sendReturn(intent,ticket);
              if(generation!==ticket)return;
              snapAfterReturn=outcome==="returned"||outcome==="unknown";
              if(outcome==="stale"||outcome==="unknown"){meetingEnabled=false;probeAt=0;}
              if(outcome==="off"){meetingEnabled=false;probeAt=Infinity;}
            }else{meetingIntent=null;meetingNotice("Regreso cancelado.");controls();}
          }
          let mask=0;
          const codes=[["KeyW","ArrowUp"],["KeyS","ArrowDown"],["KeyA","ArrowLeft"],["KeyD","ArrowRight"],["ShiftLeft","ShiftRight"]];
          const hasFocus=!menu.open&&!returnDialog.open&&!meetingIntent&&!document.hidden&&document.hasFocus();
          const sectorReady=!sectorWaiting && link.canSendSectorInput(admission);
          const focused=hasFocus && sectorReady;
          if(online&&focused&&!riding)codes.forEach((pair,i)=>{if(pair.some(k=>keys.has(k)))mask|=1<<i;});
          const jump=online&&focused&&!riding&&!driving&&avatar?.jump;if(avatar)avatar.jump=false;
          const command=online&&focused?seatRequest:null;
          if(!hasFocus)releaseInput();
          const scene=!online||!sectorReady?"loading":document.hidden?"idle":"ready";
          const presence=presenceEpoch;
          const requestedAt=performance.now();
          const snap=await link.step(mask,yaw,jump,!online||!sectorReady||(!!driving&&(!focused||keys.has("Space"))),command,scene);
          if(generation!==ticket)return;
          if(!snap){link.pauseSectors();holdScene();return retryRoute();}
          firstFailure=null;backoff=500;
          if(document.hidden || presence!==presenceEpoch || performance.now()-requestedAt>=2000){
            holdConnection();return again(document.hidden?700:80);
          }
          const self=snap.players.find(p=>p.id===link.id);
          if(entryView)link.dismissEntry();
          // Keep playing inside the old verified square. At a gap, continue neutral
          // heartbeats until the next square can support the reported body or car.
          if(!link.followSector(admission,self,snap.car)){
            lastSnapshot=performance.now();
            if(!sectorWaiting){
              audio?.setActive(false);roomClips?.pause();
              sectorWaiting=true;seatRequest=null;meetingIntent=null;releaseInput();
              if(returnDialog.open)returnDialog.close();
              controls();status("Cargando el terreno de la partida…");
            }
            if(!link.sectorIsLocal(admission,self,snap.car))canvas.parentElement.classList.add("awaiting-room");
            displayCourse(snap.course);return again(80);
          }
          const resumedArea=sectorWaiting;sectorWaiting=false;
          if(resumedArea)peers=-1;
          let relocated=false;
          if(!installed || (link.project&&installedScene!==admission)){
            resetPeer();clearNpcs();playerTarget=null;driving=null;riding=false;
            installRoom(admission,self,snap.car);
            yaw=self.yaw;
            installed=true;installedScene=admission;installedArea=admission.areaRevision??0;
          }else if(installedArea!==(admission.areaRevision??0)){
            adoptRoomArea(admission,self,snap.car);installedArea=admission.areaRevision;
            relocated=[0,2].some(axis=>Math.abs(MundoZones.cell(self.position[axis])-MundoZones.cell(avatar.position[axis]))>1);
          }else if(roomResidence){
            const area=roomResidence.select(self,snap.car,performance.now());
            if(view.scene!==area.geometry)changeRoomTerrain(area.geometry,area.terrain);
            relocated=[0,2].some(axis=>Math.abs(MundoZones.cell(self.position[axis])-MundoZones.cell(avatar.position[axis]))>1);
          }
          const oldDriver=roomCar?.target.driver,oldPassenger=roomCar?.target.passenger;
          const changed=applyRoomCar(snap.car,link.id);
          guideToCar(snap.car,self.position,snap.course?.target);
          if(!online||changed||snapAfterReturn||relocated)avatar.position=self.position.slice();
          if(snapAfterReturn)rig=new MundoAvatar();
          playerTarget=self.position;avatar.grounded=self.grounded;avatar.vy=self.vy;
          npcView.accept(snap.npcs,performance.now()*.001,!online||relocated||resumedArea);
          const other=snap.players.find(p=>p.id!==link.id);
          if(!other&&peer)resetPeer();
          if(other){
            peerTarget=other.position;
            const transitioned=(oldDriver===other.id)!==(snap.car?.driver===other.id)||
              (oldPassenger===other.id)!==(snap.car?.passenger===other.id);
            if(transitioned)peerRig=new MundoAvatar(64);
            peer={...other,position:online&&peer&&!transitioned?peer.position:other.position.slice()};
          }
          const controlsChanged=!online||resumedArea||oldDriver!==snap.car?.driver||oldPassenger!==snap.car?.passenger||!!command;
          if(!online||snapAfterReturn||relocated)pose();
          const rolledBack=!online && link.project && link.route?.phase===2;
          snapAfterReturn=false;
          lastSnapshot=performance.now();online=true;displayCourse(snap.course);
          roomClips?.update();audio?.setActive(!document.hidden);
          roomModels.update();
          if(ownerPeople)link.roomActor(ownerPeople);
          if(vehicleLook)link.roomBruma(vehicleLook,MundoBrumaLook.isBruma(roomCar?.car));
          admission.sectors?.store?.installed(admission.sectors.token);
          if(peers!==snap.players.length||changed){
            peers=snap.players.length;status(peers===1?"Sala privada · esperando al otro jugador":"Sala privada · 2 jugadores");
          }
          if(rolledBack)status("Se canceló el viaje. Conservas tu posición en "+admission.title+".");
          if(command){
            seatRequest=null;
            if(command==="enter"&&!driving)status(roomCar?.target.driver!=null?"El otro jugador ocupa el carro.":
              "Acércate a un lado despejado del carro estacionado para subir.");
            if(command==="ride"&&!riding)status("Acércate al carro detenido para ocupar la plaza de pasajero.");
            if(command==="exit"&&(driving||riding))status("Detén el carro donde haya espacio para bajar.");
          }
          if(controlsChanged)controls();
          if(outcome!==null){
            const messages={returned:"Volviste al punto de encuentro.",blocked:"El punto de encuentro está ocupado.",
              aboard:"Baja del turismo para volver.",off:"Esta sala usa aparición automática.",
              stale:"La solicitud caducó. Vuelve a confirmar si quieres regresar."};
            meetingIntent=null;
            if(meetingLast>=Number.MAX_SAFE_INTEGER)meetingEnabled=false;
            meetingNotice(messages[outcome]??"El anfitrión no confirmó el regreso.");controls();outcome=null;
          }
          if(probeAt<=performance.now())await probeMeeting(ticket);
        }catch(error){
          if(generation!==ticket)return;
          joined=false;
          const transient=!error.status || error.status===408 || error.status===429 ||
            (error.status>=500 && error.status<600);
          if(!transient){
            if([400,422].includes(error.status)&&link.id!==null){
              try{await link.leave();}catch{}
              if(generation!==ticket)return;
            }
            conclude(error.message,error.newInvitation===true);return;
          }
          holdConnection();
          return retryRecovery("Reconectando con la sala…",
            "La sala sigue sin responder. Comprueba la conexión y vuelve a entrar.");
        }
        again(80);
      }
      pending=poll();
    }
    el("changeInvite").onclick=()=>{
      if(active)return;
      history.replaceState(null,"",location.pathname);
      location.reload();
    };
    el("roomAction").onclick=async ()=>{
      if(!active){run();return;}
      ++generation;active=false;clearTimeout(timer);link.cancelWorld();clearRoom();
      const button=el("roomAction");button.disabled=true;
      await pending;
      try{await link.leave();status("Saliste de la sala.");}
      catch{status("Desconectado. El servidor liberará el asiento al caducar.");}
      button.textContent="Volver a entrar";button.disabled=false;el("changeInvite").hidden=false;
    };
    run();
  }
})();
