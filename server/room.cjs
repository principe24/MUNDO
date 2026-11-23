"use strict";
const fs=require("node:fs"),path=require("node:path");
const http=require("node:http"),https=require("node:https");
const {randomBytes, X509Certificate, createPrivateKey, createHash}=require("node:crypto");
const {performance}=require("node:perf_hooks");
const wire=require("./room-wire.cjs");
const {CircuitRecord}=require("./circuit-record.cjs");
const {SessionCheckpoint}=require("./session-checkpoint.cjs");
const {RoomRecovery}=require("./room-recovery.cjs");
const {worldPart,validatePartRequest,PART_SIZE,HEADER_SIZE}=require("./world-part.cjs");
const {EntryDelivery}=require("./entry-delivery.cjs");
const {SectorDelivery}=require("./sector-delivery.cjs");
const {AheadUsage}=require("./ahead-usage.cjs");
const {MundoZones}=require("./room-runtime.cjs");
const {fits}=require("./sector-fence.cjs");
const {ordinary,ProjectTravel,readProject,sceneCheckpoint,restoreSceneCheckpoint}=require("./project-room.cjs");
const root=path.resolve(__dirname,"..");
const files=["mundo/MUNDO.html","mundo/player.js","mundo/entrada.js","mundo/residence.js","mundo/sectors.js","mundo/room.js","mundo/walk.js","mundo/drive.js","mundo/avatar.js",
  "web/world.js","web/geometry.js","web/meeting.js","web/room-file.js","web/circuit.js","web/component-record.js","web/project.js","web/interface.css","web/view.js","web/starting-content.js","web/zones.js",
  "web/people-rig.js","mundo/online-people.js","web/bruma-look.js","web/creator-mesh.js","mundo/room-models.js"];
const movement=["KeyW","KeyS","KeyA","KeyD","ShiftLeft"];
const invitationLifetimeMs=30*60*1000;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function makeRoom(bytes,name,now=()=>performance.now(),vehicleRoot=null,meetingPoint=null,project=null,record=null,store=null){
  const single=project?null:ordinary(bytes,name,vehicleRoot,meetingPoint,record);
  return makeSession(single,project,store,now);
}
function makeSession(single,project,store,now=()=>performance.now()){
  const newInvite=()=>randomBytes(24).toString("hex");
  const seats=[0,1].map(id=>({id,invite:newInvite(),inviteUntil:null,player:null}));
  const aheadUsage=new AheadUsage();
  const travel=project?new ProjectTravel(project,seats,now):null;
  const scene=()=>travel?.active??single;
  const eligible=travel?[...project.worlds.values()].some(def=>def.gates.length || def.entry.npcCount):Boolean(single.course || single.npcs);
  const recovery=new RoomRecovery(eligible?store:null,
    t=>travel?travel.checkpoint(t):sceneCheckpoint(single,t),
    (data,t)=>travel?travel.restoreCheckpoint(data,t):restoreSceneCheckpoint(single,data,t));
  let frozen=false,lastCircuitSheet=null,lastCircuitEpoch=0;
  let admissionsOpen=true;
  let last=now();
  let invitationsStarted=false;
  function startInvitations(at){
    if(invitationsStarted)return;
    invitationsStarted=true;
    for(const seat of seats){
      if(seat.invite!==null && seat.inviteUntil===null)seat.inviteUntil=at+invitationLifetimeMs;
    }
  }
  function seatState(seat,at){
    if(seat.invite===null)return "cerrado";
    if(seat.player)return "ocupado";
    if(seat.inviteUntil!==null && at>=seat.inviteUntil)return "caducado";
    return "disponible";
  }
  function leave(seat){
    const wasPresent=Boolean(seat.player);
    if(wasPresent)travel?.cancel("Cambió una de las plazas. Se conserva la sala anterior.");
    scene().vehicle.remove(seat.id);scene().seats[seat.id].player=null;seat.player=null;
    if(wasPresent && !frozen && !seats.some(s=>s.player))recovery.offer(now());
  }
  // Each staged body carries its own approval across the atomic portal scene swap.
  // The same body after a rollback has a new epoch and must negotiate again.
  function windowAt(seat,body,epoch){
    const access=body?.sectorAccess;
    if(access && access.epoch===epoch)return access.square;
    return seat.player?.usesSectors?undefined:null;
  }
  function activeWindow(id){
    const seat=seats[id];
    return windowAt(seat,seat.player?.body,travel?.epoch);
  }
  const motionGuards=new WeakMap();
  function aheadMotion(seat,request=false){
    const p=seat.player;
    if(!p || (!request && !motionGuards.has(p)))return null;
    const live=scene(),square=activeWindow(seat.id);
    const car=!frozen && !travel?.offer && p.scene==="ready" && square && live.vehicle.aboard(seat.id)
      ?live.vehicle.snapshot():null;
    const window=car && MundoZones.aheadWindow(car.x,car.z,car.yaw,car.speed);
    if(!window || window.fromX!==square.cx || window.fromZ!==square.cz){
      motionGuards.delete(p);return null;
    }
    const old=motionGuards.get(p),role=car.driver===seat.id?"driver":"passenger";
    if(old && old.epoch===travel?.epoch && old.square===square && old.def===live.def && old.role===role && old.root===car.root &&
       old.window.cx===window.cx && old.window.cz===window.cz &&
       old.reverse===(car.speed<0) && Math.cos(car.yaw-old.yaw)>=Math.sqrt(3)/2)return old;
    motionGuards.delete(p);
    if(!request)return null;
    const guard={epoch:travel?.epoch,def:live.def,square,role,root:car.root,window,reverse:car.speed<0,yaw:car.yaw};
    motionGuards.set(p,guard);
    return guard;
  }
  function advance(){
    if(frozen)return;
    const t=now(),elapsed=Math.min(.1,Math.max(0,(t-last)/1000));last=t;
    // Expire issued hints on a stop, exit or change of direction, even if the
    // player later approaches the same boundary without requesting another hint.
    for(const seat of seats)aheadMotion(seat);
    travel?.expire();
    for(const seat of seats)if(seat.player && t-seat.player.seen>60000)leave(seat);
    const observe=()=>recovery.observe(scene(),t,seats.some(s=>s.player));
    if(travel?.offer){observe();return;}
    const vehicle=scene().vehicle;
    for(const seat of seats){
      const p=seat.player;if(!p)continue;
      const square=activeWindow(seat.id);
      if(square===undefined){
        p.keys.clear();p.body.jump=false;p.body.temp=0;continue;
      }
      if(t-p.inputAt>350){p.keys.clear();p.keys.add("Space");p.body.jump=false;}
      if(!vehicle.aboard(seat.id)){
        const allow=square===null?null:(x,z)=>fits(square,x,z);
        const dest=p.body.update(elapsed,p.keys,p.yaw,p.cross,allow);
        if(travel && dest!=null){travel.begin(dest);if(travel.offer){observe();return;}}
      }
    }
    const course=scene().course;
    vehicle.advance(elapsed,course?(x0,z0,x1,z1,y,remaining,step)=>{
      const end=t-remaining*1000;
      course.move(x0,z0,x1,z1,y,end-step*1000,end);
    }:null,activeWindow);
    const npcs=scene().npcs;
    if(npcs && seats.some(seat=>seat.player)){
      const players=[],obstacles=vehicle.chassisBounds?[vehicle.chassisBounds]:[];
      for(const seat of seats){
        if(!seat.player || vehicle.aboard(seat.id))continue;
        const position=seat.player.body.position;
        if(seat.player.scene!=="loading" && seat.player.scene!=="idle" && activeWindow(seat.id)!==undefined){
          players.push({id:seat.id,position});
        }else{
          // A paused pedestrian still occupies its space without attracting followers.
          const [x,y,z]=position;
          obstacles.push({min:[x-.28,y,z-.28],max:[x+.28,y+1.68,z+.28]});
        }
      }
      npcs.advance(elapsed,{players,obstacles});
    }
    observe();
  }
  function authorize(invite,proof,join,protocol=3,canTravel=false){
    advance();
    const seat=typeof invite==="string"&&seats.find(s=>s.invite===invite);
    if(!seat||typeof proof!=="string"||!/^[a-f0-9]{48}$/.test(proof))fail(403,"Invitación inválida.");
    // An embedded room can accept a first join directly, without the HTTP listener.
    const at=now();
    if(join && !invitationsStarted)startInvitations(at);
    if(seatState(seat,at)==="caducado")fail(410,"La invitación caducó. Pide al anfitrión un enlace nuevo para esta plaza.");
    if(seat.player&&seat.player.proof!==proof)fail(409,"Esta invitación ya está en uso.");
    if(travel && join && (!canTravel || protocol!==3))fail(426,"Este proyecto requiere un reproductor con viajes compartidos.");
    const vehicle=scene().vehicle;
    if(vehicle.available&&protocol!=null){
      if(protocol<2)fail(426,"Esta pista necesita un reproductor con conducción en sala.");
      if(seats.some(s=>s.player&&s.player.protocol!==protocol))
        fail(426,"Ambos jugadores necesitan la misma versión del protocolo para compartir este turismo.");
    }
    if(!seat.player&&join){
      if(!admissionsOpen)fail(423,"El anfitrión suspendió las nuevas entradas.");
      travel?.cancel("Entró otro jugador. Se conserva la sala anterior.");
      const body=vehicle.newBody(seat.id,Boolean(travel));
      if(!body)fail(409,scene().def.meetingPoint?"El punto de encuentro está ocupado. Vuelve a entrar cuando haya espacio.":"El punto de entrada está ocupado por el carro.");
      const t=now();
      seat.player={proof,protocol,lease:randomBytes(16).toString("hex"),body,yaw:0,seq:0,keys:new Set(),seen:t,inputAt:t};
      scene().seats[seat.id].player=seat.player;
      if(travel)travel.attach(seat);
    }
    if(!seat.player)fail(410,"El asiento ha caducado.");
    if(join)seat.player.seen=now();
    return seat;
  }
  function snapshot(){
    return seats.filter(s=>s.player).map(s=>{
      const {body,yaw}=s.player;
      return {id:s.id,position:body.position.slice(),grounded:body.grounded,vy:body.vy,yaw};
    });
  }
  function requireLease(p,msg){if(msg?.lease!==p.lease)fail(410,"La reserva del jugador ha caducado.");}
  function route(seat,msg){
    if(!travel)fail(404,"Esta sala tiene un solo mundo.");
    if(!msg || typeof msg!=="object" || Array.isArray(msg))fail(400,"Consulta de viaje inválida.");
    const p=seat.player;p.seen=now();
    if(Object.keys(msg).length){
      requireLease(p,msg);
      if(Object.keys(msg).length!==3 || !Number.isSafeInteger(msg.epoch) || msg.epoch<1 ||
         !["ready","failed"].includes(msg.vote))fail(400,"Confirmación de viaje inválida.");
      const offer=travel.offer;
      if(msg.vote!=="ready" || !offer || msg.epoch!==offer.epoch ||
          windowAt(seat,offer.next.seats[seat.id].player?.body,offer.epoch)!==undefined){
        const leaving=scene(),oldEpoch=travel.epoch;
        travel.vote(seat,msg);
        if(scene()!==leaving && leaving.course){
          lastCircuitSheet=timingSheet(leaving,now());lastCircuitEpoch=oldEpoch;
        }
      }
      recovery.observe(scene(),now(),true);
    }
    return wire.encodeRoute(travel.descriptor(seat));
  }
  function worldDocument(seat,msg){
    if(!travel)return scene().def;
    requireLease(seat.player,msg);
    const def=travel.document(msg.epoch);
    if(!def)fail(412,"La escena solicitada cambió.");
    return def;
  }
  function worldFor(seat,msg){
    const def=worldDocument(seat,msg);
    seat.player.seen=now();
    return def.bytes;
  }
  function entryContext(seat,msg,followVehicle=false){
    const def=worldDocument(seat,msg);
    const target=travel && travel.epoch!==msg.epoch?travel.offer?.next:scene();
    const position=target?.seats[seat.id].player?.body.position;
    if(!position || target.def!==def)fail(412,"La llegada ya no está preparada para esta plaza.");
    if(followVehicle && target.vehicle.aboard(seat.id)){
      const car=target.vehicle.snapshot();
      return {def,focus:[car.x,car.z]};
    }
    return {def,focus:[position[0],position[2]]};
  }
  function sectorWindow(seat,player,msg,square){
    if(frozen || !player || seat.player!==player)fail(410,"La reserva del jugador ha caducado.");
    const def=worldDocument(seat,msg);
    const staged=travel && msg.epoch!==travel.epoch;
    const target=staged?travel.offer?.next:scene();
    const body=target?.seats[seat.id].player?.body;
    if(def.revision!==msg.revision || !body || target.def!==def ||
       (staged && travel.offer?.members.get(seat.id)!==player.lease))
      fail(412,"La llegada ya no corresponde a esta reserva.");
    if(square && (!Number.isSafeInteger(square.cx) || !Number.isSafeInteger(square.cz) ||
       !Number.isInteger(square.radius) || square.radius<0 || square.radius>2 ||
       !target.vehicle.acceptsWindow(seat.id,square)))
      fail(409,"La nueva zona ya no contiene al jugador o al turismo.");
    const previous=body.sectorAccess;
    player.seen=now();
    if(square!==null)player.usesSectors=true;
    // While the next square is in flight the preceding accepted square remains playable.
    if(square===undefined && previous && previous.epoch===msg.epoch && previous.square!==null)return true;
    body.sectorAccess={epoch:msg.epoch,square:square?{cx:square.cx,cz:square.cz,radius:square.radius}:square};
    if(square===undefined && !staged){
      player.scene="loading";player.keys.clear();body.jump=false;body.temp=0;
    }
    return true;
  }
  function meeting(seat,msg){
    if(!msg || typeof msg!=="object" || Array.isArray(msg))fail(400,"Solicitud de encuentro inválida.");
    if(travel){
      if(msg.epoch!==travel.epoch || travel.offer)return "stale";
      msg={...msg};delete msg.epoch;
    }
    const vehicle=scene().vehicle,meetingPoint=scene().def.meetingPoint;
    const fields=Object.keys(msg);
    const p=seat.player, last=p.meetingReceipt;
    if(fields.length===0)
      return meetingPoint?"ready "+p.lease+" "+(last?.request??0):"off";
    if(fields.length!==2 || typeof msg.lease!=="string" || !/^[a-f0-9]{32}$/.test(msg.lease) ||
       !Number.isSafeInteger(msg.request) || msg.request<1)fail(400,"Solicitud de encuentro inválida.");
    if(msg.lease!==p.lease || (last && msg.request<last.request))return "stale";
    if(last && msg.request===last.request)return last.result;
    const square=activeWindow(seat.id);
    const result=square===undefined?"blocked":vehicle.returnToMeeting(seat,square);
    if(result==="returned")p.cross?.(p.body.position,p.body.grounded,true);
    p.meetingReceipt={request:msg.request,result};
    p.seen=now();
    return result;
  }
  function input(seat,msg,presence,includeNpcs=false){
    if(travel){
      requireLease(seat.player,msg);seat.player.seen=now();
      if(travel.offer || msg.epoch!==travel.epoch)fail(412,"Sincroniza el destino de la sala.");
      msg={...msg};delete msg.epoch;delete msg.lease;
    }
    const vehicle=scene().vehicle;
    if(!msg||typeof msg!=="object"||Array.isArray(msg)||Object.keys(msg).some(k=>!["seq","mask","yaw","jump","action","brake"].includes(k))||
      !Number.isSafeInteger(msg.seq)||msg.seq<=0||!Number.isInteger(msg.mask)||msg.mask<0||msg.mask>31||
      !Number.isFinite(msg.yaw)||Math.abs(msg.yaw)>Math.PI+.000001||typeof msg.jump!=="boolean"||
      (msg.action!==undefined&&!(["enter","exit"].includes(msg.action)||(msg.action==="ride"&&seat.player.protocol>=3)))||
      (msg.brake!==undefined&&typeof msg.brake!=="boolean"))fail(400,"Entrada inválida.");
    const p=seat.player;p.seen=now();
    if(msg.seq>p.seq){
      const square=activeWindow(seat.id);
      const suspended=presence==="loading" || presence==="idle" || square===undefined;
      if(suspended){
        p.keys.clear();p.keys.add("Space");p.body.jump=false;
      }else{
        const changed=vehicle.action(seat,msg.action,square);
        if(changed && !vehicle.aboard(seat.id))p.cross?.(p.body.position,p.body.grounded,true);
        p.keys=changed?new Set():new Set(movement.filter((_,i)=>msg.mask&(1<<i)));
        if(!changed&&msg.brake)p.keys.add("Space");
        p.yaw=msg.yaw;
        if(!changed&&!vehicle.aboard(seat.id))p.body.jump||=msg.jump;
      }

      // The sideband header describes the installed scene for this authenticated seat.
      // Ignore duplicate/out-of-order inputs just as we do for movement.
      if(["loading","ready","idle"].includes(presence))
        p.scene=square===undefined && presence==="ready"?"loading":presence;
      p.seq=msg.seq;p.inputAt=p.seen;
    }
    const result={ack:p.seq,players:snapshot(),car:vehicle.snapshot()};
    if(includeNpcs){
      const square=activeWindow(seat.id);
      result.npcs=(scene().npcs?.snapshot()??[]).filter(npc=>fits(square,npc.position[0],npc.position[2]));
    }
    return result;
  }
  function courseStatus(){return scene().course?.snapshot(now())??null;}
  function courseStartMode(){return scene().course?.startMode??"movement";}
  function timingSheet(current,at){
    const course=current.course;
    const worldName=(current.def.name??"").replace(/[\u0000-\u001f\u007f-\u009f]/gu," ").trim().slice(0,160).trimEnd() || "MUNDO";
    return {format:"MUNDO-course-timing",version:1,worldName,revision:current.def.revision,
      publication:current.def.entry?.hash??current.def.publicationHash??course.record?.hash??null,carRoot:current.root,
      gates:course.gates.map(({id,slot,label})=>({id:String(id),slot,label})),...course.timing(at)};
  }
  function courseTiming(){
    const current=scene();
    return current.course?timingSheet(current,frozen?last:now()):lastCircuitSheet;
  }
  function courseTimingIdentity(){
    const current=scene();
    if(current.course)return {revision:current.def.revision,publication:current.def.entry?.hash??current.def.publicationHash??current.course.record?.hash??null,
      carRoot:current.root,context:travel?.epoch??0,parked:false};
    return lastCircuitSheet && {revision:lastCircuitSheet.revision,publication:lastCircuitSheet.publication,
      carRoot:lastCircuitSheet.carRoot,context:lastCircuitEpoch,parked:true};
  }
  function courseAdmin(){
    const current=scene(),course=current.course;
    if(!course)return null;
    const status=course.snapshot(now());
    return {...status,startMode:course.startMode,canRestart:status.phase!=="ready" || current.vehicle.leftGrid,
      record:course.record?.status()??null,nextLabel:course.gates[status.passed]?.label??null,
      key:[travel?.epoch??0,current.def.entry?.id??0,current.def.revision,status.run].join("/")};
  }
  function hostSeat(number){
    if(!Number.isInteger(number)||number<1||number>seats.length)fail(409,"Elige el asiento 1 o 2.");
    return seats[number-1];
  }
  function entryStatus(seat,offer){
    const player=seat.player;
    const grant=player?.entryTransfer;
    if(!grant || scene().seats[seat.id].player!==player)return null;
    const target=offer?.next??scene();
    if(grant.def!==target.def || grant.epoch!==(offer?.epoch??travel?.epoch))return null;
    if(offer && offer.members.get(seat.id)!==player.lease)return null;
    if(!grant.pending && !grant.hash)return null;
    let phase="preparing";
    if(!grant.pending){
      phase=grant.sent===grant.total?"sent":grant.sent>0?"sending":"available";
    }
    return {world:target.def.name,profile:grant.profile,phase,sent:grant.sent,total:grant.total,cells:grant.cells,savedBytes:grant.savedBytes};
  }
  function hostTrack(current,occupancy,vehicle){
    const meeting=current.def.meetingPoint;
    const players=[];
    for(const seat of current.seats){
      if(!seat.player)continue;
      const [x,,z]=seat.player.body.position;
      const epoch=travel?.epoch;
      const access=seat.player.body.sectorAccess;
      const square=windowAt(seats[seat.id],seat.player.body,epoch);
      let coverage=null;
      if(square===undefined)coverage={mode:"waiting"};
      else if(square)coverage={mode:"sectors",cx:square.cx,cz:square.cz,radius:square.radius};
      else if(access && access.epoch===epoch && access.square===null)coverage={mode:"complete"};
      players.push({number:seat.id+1,x,z,stale:occupancy[seat.id].scene==="stale",coverage});
    }
    const gates=(current.course?.gates??[]).slice(0,32).map(({slot,label,point})=>({slot,label,x:point[0],z:point[2]}));
    const car=vehicle && {x:vehicle.x,z:vehicle.z,yaw:vehicle.yaw,
      driver:vehicle.driver===null?null:vehicle.driver+1,passenger:vehicle.passenger===null?null:vehicle.passenger+1};
    return {world:current.def.name,epoch:travel?.epoch??0,meeting:meeting?{x:meeting[0],z:meeting[2]}:null,
      seats:players,car,gates,passed:current.course?.passed??0,
      ...(current.npcs?{npcs:current.npcs.inspect()}: {})};
  }
  // Only the process holding this room reference has the moderation functions.
  const moderation={
    courseTiming,courseTimingIdentity,
    aheadUsage:()=>aheadUsage.snapshot(),
    aheadSummary:()=>aheadUsage.summary(),
    status(view="status"){
      const preview=view==="preview";
      if(!preview && view!=="closing")advance();
      const at=now(),current=scene();
      const offer=preview?null:travel?.offer;
      const occupancy=seats.map(seat=>{
        const state=seatState(seat,at);
        const inviteSeconds=state==="disponible" && seat.inviteUntil!==null?Math.ceil((seat.inviteUntil-at)/1000):null;
        const scene=!seat.player?null:at-seat.player.seen>8000?"stale":(seat.player.scene||"unknown");
        const destinationReady=offer && seat.player && offer.members.get(seat.id)===seat.player.lease
          ?offer.ready.has(seat.id):null;
        return {number:seat.id+1,state,inviteSeconds,scene,destinationReady,entry:preview?null:entryStatus(seat,offer)};
      });
      const vehicle=current.vehicle.snapshot(),project=travel?.status()??null;
      if(preview && project)Object.assign(project,{destination:null,ready:0,required:0,notice:""});
      const result={admissionsOpen,checkpoint:recovery.status(),course:courseAdmin(),project,vehicle,seats:occupancy};
      if(view==="live")result.track=frozen?null:hostTrack(current,occupancy,vehicle);
      if(view==="closing")result.track=null;
      return result;
    },
    async saveCheckpoint(){
      if(frozen)fail(409,"La sala se está cerrando.");
      advance();
      if(!await recovery.save(now()))fail(409,"No se pudo guardar la partida en el equipo anfitrión.");
      return recovery.status();
    },
    retryRecord(key){
      const course=scene().course;
      if(!course?.record || courseAdmin().key!==key || travel?.offer)fail(409,"La revisión del circuito cambió.");
      return course.record.flush();
    },
    restartCourse(key){
      advance();
      const info=courseAdmin();
      if(!info?.canRestart || key!==info.key || travel?.offer)
        fail(409,"El circuito cambió o ya está preparado. Actualiza el panel.");
      const current=scene(),blocked=current.vehicle.gridObstruction(activeWindow);
      if(blocked)fail(409,blocked);
      current.course.restart(now());
      current.vehicle.returnToGrid();
      recovery.observe(scene(),now(),seats.some(s=>s.player));
    },
    setAdmissions(open){
      admissionsOpen=Boolean(open);
    },
    revoke(number){
      const seat=hostSeat(number);
      seat.invite=null;
      seat.inviteUntil=null;
      leave(seat);
    },
    invitation(number){
      advance();
      const seat=hostSeat(number);
      const state=seatState(seat,now());
      if(state==="ocupado")fail(409,"La plaza está ocupada.");
      if(state==="caducado")fail(409,"La invitación caducó. Renueva el enlace de esta plaza.");
      if(state==="cerrado" || frozen || seat.inviteUntil===null)fail(409,"Abre la sala y habilita la plaza para compartir su invitación.");
      return seat.invite;
    },
    issue(number){
      advance();
      const seat=hostSeat(number);
      if(frozen)fail(409,"La sala se está cerrando.");
      if(seat.player)fail(409,"El asiento está ocupado. Usa expulsar antes de invitar.");
      seat.invite=newInvite();
      seat.inviteUntil=now()+invitationLifetimeMs;
      return seat.invite;
    }
  };
  return {get revision(){return scene().def.revision;},get name(){return scene().def.name;},get bytes(){return scene().def.bytes;},
    get meetingPoint(){return scene().def.meetingPoint;},get meetingSeats(){return scene().vehicle.meetingSeats;},
    get source(){return scene().def;},get characterLook(){return scene().characterLook;},
    get usesBruma(){return scene().vehicle.brumaLook;},
    project:Boolean(project),seats,advance,authorize,input,courseStatus,courseStartMode,meeting,route,worldFor,worldDocument,entryContext,sectorWindow,aheadMotion,leave,moderation,
    aheadOffered:aheadUsage.offer.bind(aheadUsage),aheadPageEnded:aheadUsage.page.bind(aheadUsage),
    reportAheadUsage:aheadUsage.report.bind(aheadUsage),aheadTerminal:aheadUsage.terminal.bind(aheadUsage),
    sectorDelivered(seat,player,msg,count){
      const offer=travel?.offer;
      if(frozen || !player || player!==seat.player || !(count>0) || (travel && msg.lease!==player.lease))return;
      const forOffer=offer && offer.epoch===msg.epoch && offer.members.get(seat.id)===player.lease &&
        offer.next.def.revision===msg.revision;
      if(!forOffer && (travel?.epoch!==msg.epoch || scene().def.revision!==msg.revision))return;
      const t=now();
      if(forOffer && t<offer.deadline)offer.deadline=Math.min(offer.limit,t+30000);
      player.seen=t;
    },
    partDelivered(seat,player,msg,count,entry=false){
      if(frozen || player!==seat.player)return;
      player.seen=now();
      travel?.downloaded(seat,msg,count,entry);
    },
    async beginSession(){await recovery.open(now);last=now();startInvitations(last);},
    async endSession(){
      advance();frozen=true;
      try{return {checkpoint:await recovery.close(now())};}
      finally{for(const seat of seats){seat.invite=null;seat.inviteUntil=null;leave(seat);}}
    }};
}
function timingStorageKey(hash,flying){
  // A pre-0.46 host could open the exact same bytes and count the approach.
  // Separate local timing state while preserving the real public content hashes.
  return flying?createHash("sha256").update("MUNDO/flying-start/v1\0"+hash).digest("hex"):hash;
}
async function roomFromSource(source){
  if(source.projectData){
    const project=await readProject(source.projectData),records=new Map();
    for(const def of project.worlds.values())if(def.gates.length){
      // A published room has the same record whether hosted directly or inside a project.
      const key=timingStorageKey(def.entry.hash,def.startMode==="flying");
      if(!records.has(key)){
        const record=new CircuitRecord(key);
        await record.load();records.set(key,record);
      }
      def.record=records.get(key);
    }
    const flying=[...project.worlds.values()].some(def=>def.startMode==="flying");
    return makeSession(null,project,new SessionCheckpoint(timingStorageKey(project.hash,flying)));
  }
  const hash=source.publicationHash??createHash("sha256").update(source.bytes).digest("hex");
  const single=ordinary(source.bytes,source.title,source.vehicleRoot,source.meetingPoint,null);
  const key=timingStorageKey(hash,single.course?.startMode==="flying");
  single.def.publicationHash=hash;
  if(single.course){
    const record=new CircuitRecord(key);
    await record.load();
    single.course.record=record;
  }
  return makeSession(single,null,new SessionCheckpoint(key));
}
function createHost(room,{host="127.0.0.1",port=8787,tls=null,advertisedOrigin=null,shareInes=false,shareBruma=false,creatorModels=null}={}){
  if(host!=="127.0.0.1" && !tls)throw Error("La red privada requiere HTTPS.");
  if(advertisedOrigin && (!tls || !publicOrigin(advertisedOrigin)))throw Error("Origen HTTPS de juego inválido.");
  let origin;
  const actorPackage=shareInes===true?require("./room-actor.cjs").inesPackage():null;
  const brumaPackage=shareBruma===true?require("./bruma-package.cjs").readBruma():null;
  const modelRevision=creatorModels?.size && !room.project ? room.revision : null;
  const entries=new EntryDelivery(room);
  const sectors=new SectorDelivery(room,entries.zones);
  const assets=new Map(files.map(file=>{
    let data=fs.readFileSync(path.join(root,file));
    if(file.endsWith(".html"))data=Buffer.from(data.toString().replace("connect-src 'none'","connect-src 'self'"));
    return ["/"+file,data];
  }));
  // Two seat objects live for the lifetime of a room. Renewing an invitation resets
  // that seat's allowance. Invalid credentials never consume another player's quota.
  const traffic=new Map();
  function admitRequest(seat,route,res){
    if(route==="/room/leave")return;
    const now=performance.now();
    let meter=traffic.get(seat);
    if(!meter || meter.invite!==seat.invite){
      meter={invite:seat.invite,at:now,requests:80,usage:16,worlds:4,sending:false};
      traffic.set(seat,meter);
    }
    const seconds=(now-meter.at)/1000;
    meter.at=now;
    meter.requests=Math.min(80,meter.requests+50*seconds);
    meter.usage=Math.min(16,meter.usage+8*seconds);
    meter.worlds=Math.min(4,meter.worlds+.5*seconds);
    const ahead=route==="/room/sector-ahead" || route==="/room/sector-ahead-part";
    const report=route==="/room/sector-usage" || route==="/room/sector-usage-stages";
    if(meter.requests<(ahead || report?12:1) || (report && meter.usage<1)){
      res.setHeader("Retry-After","1");
      fail(429,"Espera un momento antes de repetir la solicitud.");
    }
    --meter.requests;
    if(report)--meter.usage;
    return meter;
  }
  function admitTransfer(meter,res,cost){
    if(meter.sending || meter.worlds<cost){
      res.setHeader("Retry-After","2");
      fail(429,"Espera un momento antes de repetir la descarga.");
    }
    meter.worlds-=cost;meter.sending=true;
    res.once("close",()=>{meter.sending=false;});
  }
  function admitAhead(meter,res,cost){
    // Keep one full-world credit available. A required download can start while
    // an earlier speculative page drains; only one of each can be in flight.
    if(meter.sending || meter.ahead || meter.worlds<1+cost)return false;
    meter.worlds-=cost;meter.ahead=true;
    res.once("close",()=>{meter.ahead=false;});
    return true;
  }
  async function handle(req,res){
    const url=req.url;
    const send=(code,body,type="application/json")=>{res.writeHead(code,{"content-type":type});res.end(body);};
    try{
      res.setHeader("cache-control","no-store");res.setHeader("referrer-policy","no-referrer");
      res.setHeader("x-content-type-options","nosniff");res.setHeader("x-frame-options","DENY");
      if(!origin||stopping||req.headers.host!==new URL(origin).host)fail(403,"Destino inválido.");
      if(req.method==="GET"&&assets.has(url)){
        const ext=path.extname(url);return send(200,assets.get(url),{".html":"text/html; charset=utf-8",".js":"text/javascript",".css":"text/css"}[ext]);
      }
      if(req.method!=="POST"||!["/room/join","/room/actor","/room/bruma","/room/model","/room/world","/room/world-part","/room/world-rest","/room/entry-info","/room/entry-part","/room/cell-index",
        "/room/sector-plan","/room/sector-part","/room/sector-ready","/room/sector-full",
        "/room/sector-ahead","/room/sector-ahead-part","/room/sector-usage","/room/sector-usage-stages",
        "/room/input","/room/meeting","/room/route","/room/leave"].includes(url))fail(404,"Ruta inválida.");
      if(req.headers.origin!==origin||req.headers["content-type"]!=="application/json")fail(403,"Solicitud inválida.");
      if(!room.seats.some(s=>s.invite===req.headers["x-invite"]))fail(403,"Invitación inválida.");
      if(Number(req.headers["content-length"])>512)fail(413,"Entrada demasiado grande.");
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>512)fail(413,"Entrada demasiado grande.");chunks.push(chunk);}
      const requestBody=Buffer.concat(chunks);
      if(stopping)fail(503,"La sala se está cerrando.");
      const seatRequest=url==="/room/join" || url==="/room/leave";
      let data;
      try{data=seatRequest && !requestBody.length?{}:JSON.parse(requestBody);}catch{fail(400,"Entrada inválida.");}
      if(seatRequest &&
         (!data || typeof data!=="object" || Array.isArray(data) || Object.keys(data).length))fail(400,"Solicitud de plaza inválida.");
      const presence=req.headers["x-mundo-scene"];
      if(presence!==undefined && !["ready","idle","loading"].includes(presence))fail(400,"Estado de juego desconocido.");
      const accept=req.headers.accept;
      const binary=[wire.mediaType,wire.mediaTypeV2,wire.mediaTypeV3].indexOf(accept)+1;
      const jsonVersion=req.headers["x-mundo-room-version"];
      const protocol=binary||(jsonVersion==="3"?3:jsonVersion==="2"?2:1);
      const needsProtocol=url==="/room/join"||url==="/room/input";
      const live=room.authorize(req.headers["x-invite"],req.headers["x-seat"],url==="/room/join",needsProtocol?protocol:null,req.headers["x-mundo-travel"]==="1");
      const meter=admitRequest(live,url,res);
      const p=live.player;
      if(url==="/room/leave"){room.leave(live);return send(200,"{}");}
      if(url==="/room/join"){
        if(req.headers["x-mundo-scene"]==="loading")p.scene="loading";
        if(actorPackage)res.setHeader("x-mundo-actor","ines-bajamar-1");
        if(modelRevision)res.setHeader("x-mundo-creator-models","mesh-1");
        if(brumaPackage)res.setHeader("x-mundo-car-art","bruma-1");
        const join={id:live.id,revision:room.revision,name:room.name,ack:p.seq,vehicleProtocol:protocol,lease:p.lease,...(room.project?{project:true}:{})};
        return binary ? send(200,wire.encodeJoin(join),accept) : send(200,JSON.stringify(join));
      }
      if(url==="/room/actor"){
        if(!actorPackage)fail(404,"El anfitrión no activó este personaje.");
        if(!data || Object.keys(data).length!==1 || data.lease!==p.lease)
          fail(403,"La reserva de esta plaza cambió.");
        // Art has its own per-seat cooldown. An optional texture transfer must
        // never spend a world credit or prevent the next sector download.
        const now=performance.now();
        if(meter.actorSending || now<(meter.nextActor??0)){
          res.setHeader("Retry-After","10");fail(429,"Espera para volver a descargar el personaje.");
        }
        meter.actorSending=true;meter.nextActor=now+10000;
        res.once("close",()=>{meter.actorSending=false;});
        res.setHeader("content-length",actorPackage.length);
        return send(200,actorPackage,"application/octet-stream");
      }
      if(url==="/room/model"){
        if(!modelRevision)fail(404,"Este anfitrión no comparte modelos de autor.");
        if(!data || Object.keys(data).length!==3 || data.lease!==p.lease)fail(403,"La reserva de esta plaza cambió.");
        if(data.revision!==modelRevision || room.revision!==modelRevision)fail(409,"La revisión de la sala cambió.");
        if(typeof data.key!=="string" || !/^c[0-9a-f]{15}$/.test(data.key))fail(400,"La clave visual es inválida.");
        const item=creatorModels.get(data.key);
        if(!item)fail(404,"El modelo no pertenece a esta publicación.");
        // Optional art has a separate byte budget for each admitted seat.
        const now=performance.now(),burst=6*1024*1024;
        meter.artBytes=Math.min(burst,(meter.artBytes??burst)+(now-(meter.artAt??now))*1024);
        meter.artAt=now;
        if(meter.artSending || meter.artBytes<item.bytes.length){
          res.setHeader("Retry-After","5");fail(429,"Espera un momento antes de descargar otro modelo.");
        }
        meter.artBytes-=item.bytes.length;meter.artSending=true;
        res.once("close",()=>{meter.artSending=false;});
        res.setHeader("x-mundo-model-digest",item.digest);
        res.setHeader("content-length",item.bytes.length);
        return send(200,item.bytes,"application/octet-stream");
      }
      if(url==="/room/bruma"){
        if(!brumaPackage)fail(404,"El anfitrión no comparte la apariencia del cupé.");
        if(!data || Object.keys(data).length!==2 || data.lease!==p.lease)
          fail(403,"La reserva de esta plaza cambió.");
        if(data.revision!==room.revision || !room.usesBruma)
          fail(409,"El turismo de este mundo ha cambiado.");
        const now=performance.now();
        if(meter.brumaSending || now<(meter.nextBruma??0)){
          res.setHeader("Retry-After","10");fail(429,"Espera para volver a descargar Bruma.");
        }
        meter.brumaSending=true;meter.nextBruma=now+10000;
        res.once("close",()=>{meter.brumaSending=false;});
        res.setHeader("content-length",brumaPackage.length);
        return send(200,brumaPackage,"application/octet-stream");
      }
      if(url==="/room/world"){
        admitTransfer(meter,res,1);
        return send(200,room.worldFor(live,data),"application/octet-stream");
      }
      if(url==="/room/sector-usage" || url==="/room/sector-usage-stages"){
        sectors.usage(live,p,data,url==="/room/sector-usage-stages");
        res.writeHead(204);return res.end();
      }
      if(url==="/room/sector-ahead" || url==="/room/sector-ahead-part"){
        const frame=url==="/room/sector-ahead"
          ?sectors.ahead(live,p,data,!meter.sending && !meter.ahead && meter.worlds>1)
          :sectors.aheadPart(live,p,data,cost=>admitAhead(meter,res,cost));
        if(!frame){res.writeHead(204);return res.end();}
        if(url==="/room/sector-ahead-part"){
          const {token,slot,offset}=data,count=frame.length-HEADER_SIZE;
          // finish covers the framed response handed to the HTTP transport, not
          // receipt by the client. Count a premature close once without inferring bytes.
          let settled=false;
          const settle=finished=>{
            if(settled)return;
            settled=true;
            room.aheadPageEnded(token,slot,offset,count,finished);
          };
          res.once("finish",()=>settle(true));
          res.once("close",()=>settle(false));
        }
        res.setHeader("content-length",frame.length);
        return send(200,frame,"application/octet-stream");
      }
      if(url==="/room/sector-plan"){
        const plan=await sectors.plan(live,p,data);
        if(res.destroyed)return;
        if(!plan){res.writeHead(204);return res.end();}
        res.setHeader("content-length",plan.length);
        return send(200,plan,"application/octet-stream");
      }
      if(url==="/room/sector-part"){
        const part=sectors.part(live,p,data,cost=>admitTransfer(meter,res,cost));
        res.once("finish",()=>sectors.delivered(live,p,data,part));
        res.setHeader("content-length",part.frame.length);
        return send(200,part.frame,"application/octet-stream");
      }
      if(url==="/room/sector-ready" || url==="/room/sector-full"){
        if(url==="/room/sector-ready")sectors.ready(live,p,data);
        else{
          const challenge=sectors.full(live,p,data);
          if(challenge){
            res.setHeader("content-length",challenge.length);
            return send(200,challenge,"application/octet-stream");
          }
        }
        res.writeHead(204);return res.end();
      }
      if(url==="/room/cell-index"){
        const index=await entries.cellIndex(live,p,data,cost=>{
          if(!res.destroyed)admitTransfer(meter,res,cost);
        });
        if(res.destroyed)return;
        if(!index){res.writeHead(204);return res.end();}
        res.setHeader("content-length",index.length);
        return send(200,index,"application/octet-stream");
      }
      if(url==="/room/entry-info"){
        const header=await entries.info(live,p,data);
        if(res.destroyed)return;
        if(!header){res.writeHead(204);return res.end();}
        res.setHeader("content-length",header.length);
        return send(200,header,"application/octet-stream");
      }
      if(url==="/room/entry-part"){
        const {frame,grant}=entries.part(live,p,data,cost=>admitTransfer(meter,res,cost));
        res.once("finish",()=>entries.delivered(live,p,data,grant,frame.length-HEADER_SIZE));
        res.setHeader("content-length",frame.length);
        return send(200,frame,"application/octet-stream");
      }
      if(url==="/room/world-rest"){
        const {frame,grant,count}=entries.remaining(live,p,data,cost=>admitTransfer(meter,res,cost));
        res.once("finish",()=>entries.deliveredWorld(live,p,data,grant,count,frame.length));
        res.setHeader("content-length",frame.length);
        return send(200,frame,"application/octet-stream");
      }
      if(url==="/room/world-part"){
        validatePartRequest(data,room.project);
        const partSource=room.worldDocument(live,data);
        admitTransfer(meter,res,1/Math.max(1,Math.ceil(partSource.bytes.length/PART_SIZE)));
        const frame=worldPart(partSource.bytes,partSource.revision,data);
        res.once("finish",()=>room.partDelivered(live,p,data,frame.length-HEADER_SIZE));
        res.setHeader("content-length",frame.length);
        return send(200,frame,"application/octet-stream");
      }
      if(url==="/room/route")return send(200,room.route(live,data),"application/octet-stream");
      if(url==="/room/meeting")return send(200,room.meeting(live,data),"text/plain");
      const wantsNpcs=protocol===3 && req.headers["x-mundo-npcs"]==="1";
      const state=room.input(live,data,req.headers["x-mundo-scene"],wantsNpcs);
      const sendV3=base=>send(200,wantsNpcs?wire.encodeNpcs(base,state.npcs):base,accept);
      if(protocol===3 && req.headers["x-mundo-circuit"]==="1"){
        const course=room.courseStatus();
        const withSplits=req.headers["x-mundo-splits"]==="1";
        const withStart=withSplits && req.headers["x-mundo-race-start"]==="1";
        const startMode=withStart?room.courseStartMode():null;
        if(binary===3)return sendV3(wire.encodeCircuit(state,course,withSplits,startMode==="flying"));
        if(course){
          const {split,...legacy}=course;
          state.course=withStart?{...course,startMode}:withSplits?course:legacy;
        }
      }
      if(binary===3)return sendV3(wire.encodeSnapshotV3(state));
      if(binary===2)return send(200,wire.encodeSnapshotV2(state),accept);
      return binary ? send(200,wire.encodeSnapshot(state),accept) : send(200,JSON.stringify(state));
    }catch(e){if(!res.destroyed)send(e.status||500,JSON.stringify({error:e.status?e.message:"Error de la sala."}));}
  }
  const server=tls?https.createServer({...tls,maxHeaderSize:8192},handle):http.createServer({maxHeaderSize:8192},handle);
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxConnections=32;
  let timer,opening,finalState,closing,stopping=false;
  function finish(){
    stopping=true;
    clearInterval(timer);
    if(!finalState){
      sectors.close();
      const jobs=entries.close();
      finalState=(async()=>{
        try{await opening;return await room.endSession();}
        finally{await jobs;}
      })();
    }
    return finalState;
  }
  function close(){
    if(closing)return closing;
    const saved=finish();
    const disconnected=new Promise(resolve=>{
      if(!server.listening){resolve();return;}
      server.close(resolve);
      server.closeAllConnections();
    });
    closing=Promise.all([saved,disconnected]).then(([result])=>result);
    return closing;
  }
  server.once("close",()=>{void finish().catch(()=>{});});
  async function start(){
    await new Promise((resolve,reject)=>{
      server.once("error",reject);
      server.listen(port,host,()=>{server.removeListener("error",reject);resolve();});
    });
    try{
      opening=room.beginSession();
      await opening;
      if(stopping)throw Error("La sala se cerró durante la apertura.");
      origin=advertisedOrigin || new URL((tls?"https://":"http://")+host+":"+server.address().port).origin;
      timer=setInterval(room.advance,1000/60);
      return origin;
    }catch(error){
      await close().catch(()=>{});
      throw error;
    }
  }
  return {server,start,close};
}
function privateIPv4(host){
  return require("node:net").isIPv4(host) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}
// Public invitations carry a canonical ASCII DNS origin provided by the operator.
function publicOrigin(text){
  let url;
  try{url=new URL(text);}catch{return null;}
  if(url.protocol!=="https:" || text!==url.origin || text.length>185)return null;
  const labels=url.hostname.split(".");
  if(labels.length<2 || !/^[a-z]/.test(labels.at(-1)) ||
     !labels.every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)))return null;
  return url;
}
function roomNetwork(env=process.env){
  const host=env.MUNDO_ROOM_IP||"127.0.0.1";
  const advertisedOrigin=env.MUNDO_ROOM_ORIGIN||null;
  const advertised=advertisedOrigin && publicOrigin(advertisedOrigin);
  if(advertisedOrigin && !advertised)throw Error("El origen de juego debe ser HTTPS con nombre DNS y sin ruta.");
  if(!advertised && host==="127.0.0.1")return {host,tls:null};
  if(!privateIPv4(host) && !(advertised && (host==="0.0.0.0" || host==="127.0.0.1")))
    throw Error("Elige una interfaz IPv4 local para escuchar.");
  if(!env.MUNDO_ROOM_CERT || !env.MUNDO_ROOM_KEY)throw Error("Configura el certificado y la clave del anfitrión.");
  const cert=fs.readFileSync(env.MUNDO_ROOM_CERT), key=fs.readFileSync(env.MUNDO_ROOM_KEY);
  const leaf=new X509Certificate(cert);
  const identity=advertised?leaf.checkHost(advertised.hostname,{subject:"never",partialWildcards:false,multiLabelWildcards:false}):leaf.checkIP(host);
  if(!identity)throw Error("El certificado no incluye la dirección anunciada.");
  if(Date.now()<Date.parse(leaf.validFrom) || Date.now()>Date.parse(leaf.validTo))
    throw Error("El certificado está fuera de su periodo de validez.");
  if(!leaf.checkPrivateKey(createPrivateKey(key)))throw Error("El certificado y la clave no coinciden.");
  return {host,advertisedOrigin,tls:{cert,key,minVersion:"TLSv1.2"}};
}

function playerInvitation(origin,invite){
  return origin+"/mundo/MUNDO.html#seat="+invite;
}
module.exports={makeRoom,roomFromSource,createHost,privateIPv4,roomNetwork,playerInvitation};
if(require.main===module)(async()=>{
  const file=process.argv[2];
  if(!file)throw Error("Uso: node server/room.cjs archivo.mproject, archivo.mroom o archivo.mworld");
  const source=require("./room-source.cjs").openRoomSource(file);
  const settings=roomNetwork();
  const room=await roomFromSource(source),app=createHost(room,settings),origin=await app.start();
  const stop=()=>{void app.close().then(({checkpoint})=>{
    if(["unavailable","invalid","busy"].includes(checkpoint.state))console.error("La sala cerró sin confirmar un nuevo guardado.");
    require("node:process").stdin.unref?.();
  }).catch(error=>{console.error(error.message);process.exitCode=1;});};
  process.once("SIGINT",stop);process.once("SIGTERM",stop);
  for(const s of room.seats)console.log("Jugador "+(s.id+1)+": "+playerInvitation(origin,s.invite));
  require("./room-console.cjs").attachConsole(room.moderation,origin,app.server);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
