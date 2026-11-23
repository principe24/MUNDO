"use strict";
const {createHash}=require("node:crypto");
const api=require("./room-runtime.cjs");
const roomFile=require("../web/room-file.js");
const experienceLook=require("../web/experience-look.js");
const {CircuitRun}=require("./circuit-run.cjs");
const {makeRoomCar}=require("./room-car.cjs");
const npcRoutes=require("../web/npc-routes.js");
const {createNavigation}=require("./navigation-3d.cjs");
const {NpcSimulation}=require("./npc-simulation.cjs");
const {MAX_PAYLOAD}=require("./session-checkpoint.cjs");

async function readProject(data){
  const index=await api.MundoProject.open(new Blob([data]));
  const worlds=new Map();
  for(const entry of index.worlds){
    const chunk=Buffer.from(await entry.blob.arrayBuffer());
    // open() already verified the complete immutable snapshot, including meeting and chosen car.
    const info=roomFile.unpack(chunk);
    worlds.set(entry.id,{entry,gates:entry.gates,startMode:entry.startMode,bytes:info.world,revision:info.hash,name:entry.title,
      publication:entry.source==="publication"?info.revision:null,vehicleRoot:info.vehicleRoot??null,meetingPoint:info.meetingPoint??null});
  }
  return {index,worlds,hash:data.subarray(16,80).toString("ascii")};
}
function stage(def,savedCourse=null){
  const world=api.MundoWorld.decode(new Uint8Array(def.bytes));
  const geometry=api.MundoGeometry.flatten(world);
  const {gates,startMode}=def.gates && def.startMode?def:api.MundoCircuit.read(world);
  const seats=[{id:0,player:null},{id:1,player:null}];
  const vehicle=makeRoomCar(world,geometry,seats,api,def.vehicleRoot,def.meetingPoint);
  if(gates.length && !vehicle.available)throw Error("El circuito necesita un turismo de sala.");
  const course=gates.length?(savedCourse??new CircuitRun(gates,def.record,startMode)):null;
  const definitions=npcRoutes.definitions(world);
  // The authored car changes position. Its meshes must never become fixed walls.
  let npcs=null;
  if(definitions.length){
    const solids=geometry.objects.filter(piece=>!vehicle.isVehiclePart(piece.n.id));
    const obstacles=vehicle.chassisBounds?[vehicle.chassisBounds]:[];
    npcs=new NpcSimulation(createNavigation(solids),definitions,{obstacles});
  }
  return {def,seats,vehicle,course,npcs,characterLook:experienceLook.read(world),root:vehicle.snapshot()?.root??null};
}
function ordinary(bytes,name,vehicleRoot,meetingPoint,record){
  return stage({bytes,name,vehicleRoot,meetingPoint,record,revision:createHash("sha256").update(bytes).digest("hex")});
}
function worldIdentity(def,root){
  return {id:def.entry?.id??null,publication:def.entry?.hash??null,revision:def.revision,root};
}
function sceneCheckpoint(scene,now){
  return {...worldIdentity(scene.def,scene.root),car:scene.vehicle.available?scene.vehicle.checkpoint():null,
    course:scene.course?.checkpoint(now)??null};
}
function restoreSceneCheckpoint(scene,data,now){
  if(!data || typeof data!=="object" || !Number.isFinite(now) || scene.seats.some(s=>s.player))return false;
  const identity=worldIdentity(scene.def,scene.root);
  if(Object.keys(identity).some(key=>data[key]!==identity[key]))return false;
  if(scene.vehicle.available?!scene.vehicle.canRestoreCheckpoint(data.car):data.car!==null)return false;
  if(scene.course?!scene.course.canRestoreCheckpoint(data.course,now):data.course!==null)return false;
  // Both validators are pure. No seat or simulation step can intervene between validation and application.
  if(scene.vehicle.available && !scene.vehicle.restoreCheckpoint(data.car))return false;
  if(scene.course && !scene.course.restoreCheckpoint(data.course,now))return false;
  return true;
}

// The writer bounds the whole project, not each individual circuit. Trim only
// detached snapshot copies. The host keeps every live lap and its frozen target.
function fitCourseHistory(payload){
  const size=value=>Buffer.byteLength(JSON.stringify(value));
  let bytes=size(payload);
  if(bytes<=MAX_PAYLOAD)return payload;
  const parked=payload.worlds.filter(w=>w.id!==payload.active && w.course?.timing);
  const current=payload.worlds.find(w=>w.id===payload.active);
  const courses=current?.course?.timing?[...parked,current]:parked;
  for(const world of courses){
    const history=world.course.timing.history;
    while(history.length){
      const oldest=history.shift();
      bytes-=size(oldest)+(history.length?1:0);
      if(bytes<=MAX_PAYLOAD)return payload;
    }
  }
  for(const world of parked){
    const t=world.course.timing;
    if(t.bestSplits!==null){
      bytes-=size(t.bestSplits)-4; // literal null
      t.bestSplits=null;
      if(bytes<=MAX_PAYLOAD)return payload;
    }
  }
  // At worst 32 circuits can carry long millisecond values. Keep the current
  // circuit intact; the original checkpoint shape still restores each parked
  // car, elapsed clock, completed gate count and next gate when details do not fit.
  for(const world of parked){
    bytes-=size(world.course.timing)+',"timing":'.length;
    delete world.course.timing;
    if(bytes<=MAX_PAYLOAD)return payload;
  }
  return payload;
}

// Published scene and proposed scene own separate physics and vehicle state.
// Only the host creates an offer. All participants must prepare the same offer.
class ProjectTravel {
  constructor(project,live,now){
    this.project=project;this.live=live;this.now=now;
    this.parked=new Map();
    this.active=this.prepare(project.worlds.get(project.index.start));
    this.serial=this.epoch=1;this.offer=null;this.rolledBack=false;this.notice="";
  }
  prepare(def){
    const parked=this.parked.get(def.entry.id);
    const next=stage(def,parked?.course);
    if(parked?.car && !next.vehicle.restoreCheckpoint(parked.car))
      throw Error("No se pudo colocar el turismo en su posición guardada.");
    return next;
  }
  parkedState(scene){
    return {def:scene.def,root:scene.root,car:scene.vehicle.available?scene.vehicle.checkpoint():null,course:scene.course};
  }
  checkpoint(now){
    const worlds=[sceneCheckpoint(this.active,now)];
    for(const entry of this.parked.values()){
      worlds.push({...worldIdentity(entry.def,entry.root),car:entry.car,course:entry.course?.checkpoint(now)??null});
    }
    worlds.sort((a,b)=>a.id-b.id);
    return fitCourseHistory({project:this.project.hash,active:this.active.def.entry.id,worlds});
  }
  restoreCheckpoint(data,now){
    if(this.offer || this.live.some(s=>s.player) || !Number.isFinite(now) || data?.project!==this.project.hash ||
       !this.project.worlds.has(data.active) || !Array.isArray(data.worlds) ||
       !data.worlds.length || data.worlds.length>this.project.worlds.size)return false;
    const seen=new Set(),parked=new Map();
    let active=null;
    // Validate detached scenes. Keep at most one active geometry and one temporary geometry in addition to the live scene.
    // Parked worlds retain only their car pose and a small clock/circuit object after validation.
    for(const row of data.worlds){
      const def=this.project.worlds.get(row?.id);
      if(!def || seen.has(row.id))return false;
      seen.add(row.id);
      try{
        const scene=stage(def);
        if(!restoreSceneCheckpoint(scene,row,now))return false;
        if(row.id===data.active)active=scene;
        else parked.set(row.id,this.parkedState(scene));
      }catch{return false;}
    }
    if(!active)return false;
    this.active=active;this.parked=parked;
    this.rolledBack=false;this.notice="";
    return true;
  }
  attach(seat){
    const p=seat.player;
    this.active.seats[seat.id].player=p;
    p.cross=api.MundoProject.crossing(this.project.index,this.active.def.entry);
    p.cross(p.body.position,p.body.grounded,true);
  }
  neutral(seat){
    const p=seat.player;if(!p)return;
    p.keys.clear();p.body.jump=false;p.inputAt=-Infinity;
  }
  begin(to){
    if(this.offer)return;
    const members=this.live.filter(seat=>seat.player);
    if(members.some(s=>this.active.vehicle.aboard(s.id) || s.player.scene!=="ready" || this.now()-s.player.seen>5000)){
      this.notice="Ambos jugadores deben estar activos y a pie para cruzar.";return;
    }
    const def=this.project.worlds.get(to);
    if(!def || def===this.active.def)return;
    try{
      const next=this.prepare(def);
      for(const s of members){
        const body=next.vehicle.newBody(s.id,true);
        if(!body)throw Error("El punto de llegada está ocupado.");
        next.seats[s.id].player={body};
      }
      const started=this.now();
      this.offer={next,epoch:++this.serial,deadline:started+30000,limit:started+120000,
        members:new Map(members.map(s=>[s.id,s.player.lease])),delivered:new Map(),entryDelivered:new Map(),ready:new Set()};
      for(const s of members)this.neutral(s);
      this.notice="";
    }catch{this.notice="El destino carece de una llegada disponible. La sala conserva su posición.";}
  }
  cancel(reason){
    if(!this.offer)return;
    this.offer=null;this.epoch=++this.serial;this.rolledBack=true;this.notice=reason;
    for(const seat of this.live)if(seat.player){
      this.neutral(seat);seat.player.scene="loading";seat.player.cross(seat.player.body.position,seat.player.body.grounded,true);
    }
  }
  expire(){
    if(this.offer && this.now()>=this.offer.deadline)this.cancel("El destino tardó demasiado. Se conserva el mundo de origen.");
  }
  downloaded(seat,msg,count,entry=false){
    const offer=this.offer;
    if(!offer || offer.epoch!==msg.epoch || offer.members.get(seat.id)!==msg.lease || offer.next.def.revision!==msg.revision)return;
    const offsets=entry?offer.entryDelivered:offer.delivered;
    if(msg.offset!==(offsets.get(seat.id)??0))return;
    const t=this.now();
    if(t>=offer.deadline)return;
    offsets.set(seat.id,msg.offset+count);
    offer.deadline=Math.min(offer.limit,t+30000);
  }
  vote(seat,msg){
    const p=seat.player,offer=this.offer;
    if(!offer || msg.epoch!==offer.epoch || offer.members.get(seat.id)!==p.lease)return;
    if(msg.vote==="failed"){this.cancel("Un jugador no pudo preparar el destino. Se conserva el mundo de origen.");return;}
    for(const [id,lease] of offer.members){
      const other=this.live[id].player;
      if(!other || other.lease!==lease){this.cancel("Cambió una reserva durante el viaje.");return;}
      if(this.now()-other.seen>5000)offer.ready.delete(id);
    }
    offer.ready.add(seat.id);
    if(offer.ready.size!==offer.members.size)return;
    // No asynchronous operation follows the swap. Reservations and input counters survive.
    this.parked.set(this.active.def.entry.id,this.parkedState(this.active));
    this.active=offer.next;
    this.parked.delete(this.active.def.entry.id);
    this.epoch=offer.epoch;this.offer=null;this.rolledBack=false;
    for(const s of this.live)if(s.player){
      s.player.body=this.active.seats[s.id].player.body;s.player.yaw=0;s.player.scene="loading";
      this.neutral(s);this.attach(s);
    }
    this.notice="Viaje confirmado a "+this.active.def.name+".";
  }
  descriptor(seat){
    const dest=this.offer?.next??this.active;
    return {phase:this.offer?1:(this.rolledBack?2:0),epoch:this.offer?.epoch??this.epoch,world:dest.def.entry.id,
      root:dest.root,lease:seat.player.lease,id:seat.id,ack:seat.player.seq,revision:dest.def.revision,name:dest.def.name};
  }
  document(epoch){
    if(epoch===this.epoch)return this.active.def;
    if(this.offer && this.offer.epoch===epoch)return this.offer.next.def;
    return null;
  }
  bytes(epoch){return this.document(epoch)?.bytes??null;}
  status(){
    const o=this.offer;
    return {name:this.project.index.name,hash:this.project.hash,worlds:this.project.worlds.size,current:this.active.def.entry.id,
      destination:o?.next.def.name??null,ready:o?.ready.size??0,required:o?.members.size??0,notice:this.notice};
  }
}
module.exports={readProject,ProjectTravel,ordinary,sceneCheckpoint,restoreSceneCheckpoint};
