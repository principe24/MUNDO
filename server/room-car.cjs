"use strict";
const {fits,fitsCar}=require("./sector-fence.cjs");
const parkedFields=new Set(["root","x","z","yaw","steer","distance"]);

// Region queries share the immutable road grid. A room adds only one moving
// chassis and at most one other pedestrian to any query made by its driver.
function withBoxes(index,boxes){
  const result=Object.create(index);
  result.region=(left,right,back,front)=>{
    const near=index.region(left,right,back,front);
    for(const box of boxes()){
      if(box.min[0]<=right&&box.max[0]>=left&&box.min[2]<=front&&box.max[2]>=back)near.add(box);
    }
    return near;
  };
  return result;
}
function pedestrianBox([x,y,z]){
  return {pedestrian:true,min:[x-.28,y,z-.28],max:[x+.28,y+1.68,z+.28]};
}

function makeRoomCar(world,scene,seats,{MundoDriving,MundoMeeting,MundoBrumaLook},vehicleRoot=null,meetingPoint=null){
  const {car,road,grid}=MundoDriving.roomStart(world,scene,vehicleRoot);
  const authored=car?{x:car.x,z:car.z,yaw:Math.atan2(Math.sin(car.yaw),Math.cos(car.yaw))}:null;
  const meeting=meetingPoint===null?null:MundoMeeting.plan(road,car,meetingPoint);
  let recoveryArrival=null;
  let driver=null,passenger=null;
  const aboard=id=>id===driver||id===passenger;
  let chassis;
  function refreshBounds(){
    chassis=MundoDriving.chassisBounds(car);
  }
  const walking=car?withBoxes(road,()=>[chassis]):road;
  if(car){
    refreshBounds();
    // Walkers use the same oriented footprint that stops the driving simulation.
    walking.overlaps=(b,x,z)=>b.chassis?car.intersects(pedestrianBox([x,0,z])):road.overlaps(b,x,z);
  }
  function others(except){
    return seats.filter(s=>s.id!==except&&!aboard(s.id)&&s.player)
      .map(s=>pedestrianBox(s.player.body.position));
  }
  function newBody(id,separate=false){
    const body=Object.create(walking);
    if(recoveryArrival || meeting){
      const other=seats[1-id].player;
      const otherFeet=other?.body.position??null;
      const arrival=recoveryArrival??meeting;
      const feet=arrival.position(id,otherFeet)??(meeting && arrival!==meeting?meeting.position(id,otherFeet):null);
      if(!feet)return null;
      body.position=feet;body.spawn=feet.slice();body.grounded=true;
      return body;
    }
    body.spawn=road.spawn.slice();body.position=body.spawn.slice();
    if(id){body.grounded=true;for(let i=0;i<8;i++)body.moveAxis(0,.12);}
    if(car){
      // A newly arriving seat must not appear inside a moving or parked car.
      const [x,y,z]=body.position;
      if(y<car.top&&y+1.68>car.base&&car.intersects(pedestrianBox([x,y,z]))){
        const peers=()=>others(id);
        const feet=car.exitPosition(withBoxes(walking,peers),withBoxes(road,peers));
        if(!feet)return null;
        body.position=feet;body.grounded=true;
      }
    }
    const otherFeet=seats[1-id].player?.body.position;
    if(separate && otherFeet && MundoMeeting.overlapsPlayer(body.position,otherFeet)){
      let feet;
      try{feet=MundoMeeting.plan(road,car,road.spawn).position(id,otherFeet,false);}catch{return null;}
      if(!feet)return null;
      body.position=feet;body.spawn=feet.slice();body.grounded=true;
    }
    return body;
  }
  function acceptsWindow(id,square){
    if(aboard(id))return fitsCar(square,car);
    const feet=seats[id].player?.body.position;
    return Boolean(feet && fits(square,feet[0],feet[2]));
  }
  function returnToMeeting(seat,square=null){
    if(!meeting)return "off";
    if(aboard(seat.id))return "aboard";
    const other=seats[1-seat.id].player;
    const feet=meeting.position(seat.id,other?.body.position,false);
    if(!feet || !fits(square,feet[0],feet[2]))return "blocked";
    const {body,keys}=seat.player;
    body.position=feet;
    body.spawn=feet.slice();
    body.grounded=true;
    body.vy=0;
    body.temp=0;
    body.jump=false;
    keys.clear();
    return "returned";
  }
  function park(){
    driver=null;car.speed=0;car.accumulator=0;
  }
  function remove(id){
    if(car&&driver===id)park();
    if(passenger===id)passenger=null;
  }
  function placeOccupant(id){
    if(id===null)return;
    const body=seats[id].player.body;
    const pivot=MundoBrumaLook?.seat(car,id===passenger);
    const [x,z]=pivot?[pivot[0],pivot[2]]:car.point((id===driver?-1:1)*car.width*.36,0);
    body.position=[x,car.base,z];body.temp=0;body.jump=false;body.vy=0;body.grounded=true;
  }
  function gridObstruction(windowOf){
    if(!grid)return null;
    for(const id of [driver,passenger]){
      if(id!==null && !fitsCar(windowOf(id),car,grid.x,grid.z,grid.yaw))
        return "Acerca el turismo a la parrilla para que ambos ocupantes tengan cargada la zona de salida.";
    }
    if(!car.allowed(withBoxes(road,()=>others(null)),grid.x,grid.z,grid.yaw))
      return "La parrilla está ocupada. Despeja el punto de salida antes de preparar otra vuelta.";
    return null;
  }
  function returnToGrid(){
    if(!grid)return;
    Object.assign(car,grid,{speed:0,steer:0,travelDistance:0,accumulator:0});
    car.present();refreshBounds();
    recoveryArrival=null;
    for(const id of [driver,passenger]){
      if(id===null)continue;
      seats[id].player.keys.clear();seats[id].player.inputAt=-Infinity;
      placeOccupant(id);
    }
  }
  function action(seat,requested,square=null){
    if(!car||!requested)return;
    const body=seat.player.body;
    const peers=()=>others(seat.id);
    const traffic=withBoxes(road,peers);
    if(requested==="enter"||requested==="ride"){
      const wantsWheel=requested==="enter";
      if(Math.abs(car.speed)>.15||(wantsWheel?driver:passenger)!==null || !fitsCar(square,car))return;
      if(wantsWheel&&passenger===seat.id){
        passenger=null;driver=seat.id;placeOccupant(driver);return true;
      }
      if(aboard(seat.id)||car.distance(body.position)>2.2||
         !car.accessible(traffic,body.position)||!car.allowed(traffic,car.x,car.z,car.yaw))return;
      if(wantsWheel)driver=seat.id;else passenger=seat.id;
      placeOccupant(seat.id);return true;
    }else if(requested==="exit"&&aboard(seat.id)&&Math.abs(car.speed)<=.15){
      const feet=car.exitPosition(withBoxes(walking,peers),traffic,(x,z)=>fits(square,x,z));
      if(!feet)return;
      remove(seat.id);body.position=feet;body.grounded=true;body.vy=0;body.temp=0;body.jump=false;
      return true;
    }
  }
  function advance(elapsed,acceptedStep=null,windowOf=null){
    if(driver===null)return;
    const p=seats[driver].player;
    const bystanders=others(driver);
    const driverSquare=windowOf?windowOf(driver):null;
    const passengerSquare=windowOf && passenger!==null?windowOf(passenger):null;
    const allowed=driverSquare===null && passengerSquare===null?null:
      (x,z,yaw)=>fitsCar(driverSquare,car,x,z,yaw) && fitsCar(passengerSquare,car,x,z,yaw);
    car.update(elapsed,p.keys,withBoxes(road,()=>bystanders),acceptedStep,allowed);
    refreshBounds();
    placeOccupant(driver);placeOccupant(passenger);
  }
  function snapshot(){
    return car?{root:String(car.rootId),x:car.x,z:car.z,
      yaw:Math.atan2(Math.sin(car.yaw),Math.cos(car.yaw)),speed:car.speed,steer:car.steer,
      distance:car.travelDistance,driver,passenger}:null;
  }
  function checkpoint(){
    if(!car)return null;
    return {root:String(car.rootId),x:car.x,z:car.z,yaw:Math.atan2(Math.sin(car.yaw),Math.cos(car.yaw)),
      steer:car.steer,distance:car.travelDistance};
  }
  function prepareCheckpoint(data){
    if(driver!==null || passenger!==null || seats.some(seat=>seat.player))return null;
    if(!car)return data===null?{}:null;
    if(!data || typeof data!=="object" || Array.isArray(data) || data.root!==String(car.rootId) ||
       Object.keys(data).some(key=>!parkedFields.has(key)))return null;
    const {x,z,yaw,steer,distance}=data;
    if(![x,z,yaw,steer,distance].every(Number.isFinite) || Math.abs(x)>1e15 || Math.abs(z)>1e15 ||
       Math.abs(yaw)>Math.PI || Math.abs(steer)>.470001 || Math.abs(distance)>1e15)return null;
    // Older scenes may exhibit a parked decorative car lacking a drivable
    // surface. Such a scene is already allowed to open at its original transform.
    const original=x===authored.x && z===authored.z && yaw===authored.yaw && distance===0 && steer===0;
    if(!original && !car.allowed(road,x,z,yaw))return null;

    const parked=Object.assign(Object.create(car),{x,z,yaw});
    if(!meeting){
      // The ordinary second arrival is offset by at most eight 12 cm steps.
      const [sx,sy,sz]=road.spawn;
      const starts={min:[sx-.28,sy,sz-.28],max:[sx+.96+.28,sy+1.68,sz+.28]};
      if(sy>=parked.top || sy+1.68<=parked.base || !parked.intersects(starts))return {};
    }
    // A car can legally park across both arrivals. Locate a pair of positions
    // on supported ground before changing the live chassis.
    const side=parked.width+.85,end=parked.length+.85;
    const points=[meetingPoint??road.spawn];
    for(const [lateral,longitudinal] of [[-side,0],[side,0],[0,end],[0,-end]]){
      const [px,pz]=parked.point(lateral,longitudinal);
      points.push([px,parked.base,pz]);
    }
    if(meeting)points.push(road.spawn);
    for(const point of points){
      try{
        MundoMeeting.plan(road,parked,point);
        return {arrival:point};
      }catch{/* Try the next side of the parked chassis. */}
    }
    return original && !meeting?{}:null;
  }
  function canRestoreCheckpoint(data){return prepareCheckpoint(data)!==null;}
  function restoreCheckpoint(data){
    const prepared=prepareCheckpoint(data);
    if(!prepared)return false;
    if(!car)return true;
    car.applyNetworkPose({...data,speed:0});
    refreshBounds();
    recoveryArrival=prepared.arrival?MundoMeeting.plan(road,car,prepared.arrival):null;
    return true;
  }
  return {available:Boolean(car),brumaLook:Boolean(car && MundoBrumaLook?.isBruma(car)),
    isVehiclePart(id){return car?.partIds.has(id)??false;},
    get chassisBounds(){return chassis??null;},
    get meetingSeats(){return meeting?(recoveryArrival??meeting).initial:null;},
    get leftGrid(){return Boolean(grid && (car.x!==grid.x || car.z!==grid.z || car.travelDistance!==0));},
    aboard,acceptsWindow,newBody,returnToMeeting,gridObstruction,returnToGrid,remove,action,advance,snapshot,checkpoint,canRestoreCheckpoint,restoreCheckpoint};
}
module.exports={makeRoomCar};
