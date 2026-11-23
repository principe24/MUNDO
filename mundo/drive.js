"use strict";
window.MundoDriving=(()=>{
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const tires=["delantera izquierda","delantera derecha","trasera izquierda","trasera derecha"];
  const dt=1/90;

  class Car {
    constructor(root,parts,wheels){
      const m=root.m;
      this.rootId=root.n.id;
      this.x=m[12];this.z=m[14];this.startYaw=Math.atan2(-m[8],m[10]);
      this.yaw=this.startYaw;this.speed=0;this.steer=0;this.accumulator=0;this.travelDistance=0;
      this.partIds=new Set(parts.map(p=>p.n.id));
      this.name=root.n.name;this.width=0;this.length=0;
      this.base=Infinity;this.top=-Infinity;
      const c=Math.cos(this.yaw),s=Math.sin(this.yaw);
      const local=(x,z)=>[c*x+s*z,-s*x+c*z];
      // Cache each rest transform in chassis coordinates. Studio's authoring tree stays untouched.
      this.parts=parts.map(entry=>{
        const a=entry.m.slice();
        for(const i of [0,4,8,12]){
          const x=a[i]-(i===12?this.x:0),z=a[i+2]-(i===12?this.z:0);
          [a[i],a[i+2]]=local(x,z);
        }
        const extent=axis=>(Math.abs(a[axis])+Math.abs(a[4+axis])+Math.abs(a[8+axis]))*.5;
        this.width=Math.max(this.width,Math.abs(a[12])+extent(0));
        this.length=Math.max(this.length,Math.abs(a[14])+extent(2));
        this.base=Math.min(this.base,a[13]-extent(1));this.top=Math.max(this.top,a[13]+extent(1));
        return {entry,rest:a,front:/^(Rueda|Llanta) delantera /.test(entry.n.name)};
      });
      this.axles=wheels.map(wheel=>{
        const suffix=wheel.n.name.slice("Rueda ".length);
        const rotating=this.parts.filter(p=>p.entry===wheel || p.entry.n.name==="Llanta "+suffix);
        const radius=.5*Math.hypot(wheel.m[0],wheel.m[1],wheel.m[2]);
        return {wheel,rotating,radius,phase:0};
      });
      this.contacts=wheels.map(w=>local(w.center[0]-this.x,w.center[2]-this.z));
      this.wheelbase=Math.abs(this.contacts[2][1]-this.contacts[0][1]);
    }
    point(lateral,longitudinal,x=this.x,z=this.z,yaw=this.yaw){
      const c=Math.cos(yaw),s=Math.sin(yaw);
      return [x+c*lateral-s*longitudinal,z+s*lateral+c*longitudinal];
    }
    distance(p){
      if(p[1]<this.base-.35||p[1]>this.top+.35)return Infinity;
      const dx=p[0]-this.x,dz=p[2]-this.z,c=Math.cos(this.yaw),s=Math.sin(this.yaw);
      return Math.hypot(Math.max(0,Math.abs(c*dx+s*dz)-this.width),
                        Math.max(0,Math.abs(-s*dx+c*dz)-this.length));
    }
    intersects(box,x=this.x,z=this.z,yaw=this.yaw,margin=0){
      const c=Math.cos(yaw),s=Math.sin(yaw),w=this.width+margin,l=this.length+margin;
      const hx=(box.max[0]-box.min[0])*.5,hz=(box.max[2]-box.min[2])*.5;
      const dx=box.min[0]+hx-x,dz=box.min[2]+hz-z;
      return Math.abs(dx)<Math.abs(c)*w+Math.abs(s)*l+hx && Math.abs(dz)<Math.abs(s)*w+Math.abs(c)*l+hz &&
        Math.abs(c*dx+s*dz)<w+Math.abs(c)*hx+Math.abs(s)*hz &&
        Math.abs(-s*dx+c*dz)<l+Math.abs(s)*hx+Math.abs(c)*hz;
    }
    allowed(index,x,z,yaw){
      const c=Math.cos(yaw),s=Math.sin(yaw),w=this.width+.04,l=this.length+.04;
      const rx=Math.abs(c)*w+Math.abs(s)*l,rz=Math.abs(s)*w+Math.abs(c)*l;
      const corners=this.contacts.map(([i,j])=>this.point(i,j,x,z,yaw));
      const supported=[false,false,false,false];
      for(const b of index.region(x-rx,x+rx,z-rz,z+rz)){
        if(!b.pedestrian&&Math.abs(b.max[1]-this.base)<=.035){
          corners.forEach(([cx,cz],i)=>{
            if(cx>=b.min[0]&&cx<=b.max[0]&&cz>=b.min[2]&&cz<=b.max[2])supported[i]=true;
          });
        }
        if(b.max[1]<=this.base+.035||b.min[1]>=this.top)continue;
        if(this.intersects(b,x,z,yaw,.04))return false;
      }
      return supported.every(Boolean);
    }
    update(elapsed,keys,index,acceptedStep=null,allow=null){
      const down=(a,b)=>keys.has(a)||keys.has(b);
      const throttle=Number(down("KeyW","ArrowUp"))-Number(down("KeyS","ArrowDown"));
      const turn=Number(down("KeyD","ArrowRight"))-Number(down("KeyA","ArrowLeft"));
      this.accumulator=Math.min(.22,this.accumulator+elapsed);
      let travelled=0;
      while(this.accumulator>=dt){
        this.accumulator-=dt;
        this.steer+=clamp(turn*.47-this.steer,-2*dt,2*dt);
        const brake=keys.has("Space"),opposed=throttle*this.speed<0;
        if(brake||!throttle||opposed){
          const drag=brake||opposed?13:2.5;
          this.speed-=Math.sign(this.speed)*Math.min(Math.abs(this.speed),drag*dt);
        }else this.speed=clamp(this.speed+throttle*6*dt,-4,14);
        const step=this.speed*dt;
        if(step===0)continue;
        const angle=step*Math.tan(this.steer)/this.wheelbase;
        const heading=this.yaw+angle*.5;
        const x=this.x+step*Math.sin(heading),z=this.z-step*Math.cos(heading);
        if((!allow || allow(x,z,this.yaw+angle)) && this.allowed(index,x,z,this.yaw+angle)){
          if(acceptedStep)acceptedStep(this.x,this.z,x,z,(this.base+this.top)/2,this.accumulator,dt);
          this.x=x;this.z=z;this.yaw+=angle;travelled+=step;
        }else this.speed=0;
      }
      this.travelDistance+=travelled;
      this.present();
    }
    applyNetworkPose(pose){
      if(!pose||pose.root!==String(this.rootId)||
         ![pose.x,pose.z,pose.yaw,pose.speed,pose.steer,pose.distance].every(Number.isFinite))return false;
      this.x=pose.x;this.z=pose.z;this.yaw=pose.yaw;this.speed=pose.speed;
      this.steer=pose.steer;this.travelDistance=pose.distance;this.accumulator=0;
      this.present();
      return true;
    }
    present(){
      this.placeParts();
      window.MundoBrumaLook?.steerRims(this);
      for(const axle of this.axles){
        axle.phase=(this.travelDistance/Math.max(.001,axle.radius))%(2*Math.PI);
        const c=Math.cos(axle.phase),s=Math.sin(axle.phase);
        for(const {entry} of axle.rotating){
          // Roll only the visible mesh. Contacts and pedestrian bounds use the unrolled matrix.
          const m=entry.m,draw=entry.drawMatrix??(entry.drawMatrix=m.slice());
          for(let i=0;i<3;i++){
            draw[i]=m[i]*c-m[8+i]*s;draw[8+i]=m[i]*s+m[8+i]*c;
            draw[4+i]=m[4+i];draw[12+i]=m[12+i];
          }
        }
      }
    }
    placeParts(){
      for(const {entry,rest,front} of this.parts){
        const angle=this.yaw+(front?this.steer:0),c=Math.cos(angle),s=Math.sin(angle);
        for(const i of [0,4,8]){
          entry.m[i]=c*rest[i]-s*rest[i+2];entry.m[i+2]=s*rest[i]+c*rest[i+2];
        }
        const [x,z]=this.point(rest[12],rest[14]);
        entry.center[0]=entry.m[12]=x;entry.center[2]=entry.m[14]=z;
        for(let i=0;i<3;i++)entry.extent[i]=.5*(Math.abs(entry.m[i])+Math.abs(entry.m[i+4])+Math.abs(entry.m[i+8]));
        entry.radius=Math.hypot(...entry.extent);
      }
    }
    accessible(index,feet){
      const origin=[feet[0],feet[1]+.85,feet[2]];
      const delta=[this.x-origin[0],(this.base+this.top)*.5-origin[1],this.z-origin[2]];
      const length=Math.hypot(...delta);
      return length<.001 || index.clearDistance(origin,delta.map(v=>v/length),length,.12)>=length;
    }
    exitPosition(index,road,allow=null){
      // A parked diagonal body can have a wider axis-aligned pedestrian proxy.
      const offsets=[];
      for(const clearance of [.55,1.05,1.55]){
        const side=this.width+clearance,end=this.length+clearance;
        offsets.push([-side,0],[side,0],[0,end],[0,-end]);
      }
      for(const offset of offsets){
        const [x,z]=this.point(...offset);
        if(allow && !allow(x,z))continue;
        const boxes=Array.from(index.around(x,z)).filter(b=>index.overlaps(b,x,z));
        for(const ground of boxes){
          if(ground.pedestrian||ground.chassis)continue;
          const y=ground.max[1];
          if(Math.abs(y-this.base)>.27 || x<ground.min[0]||x>ground.max[0]||z<ground.min[2]||z>ground.max[2])continue;
          if(!boxes.some(b=>b.max[1]>y+.001&&b.min[1]<y+1.68)&&this.accessible(road,[x,y,z]))return [x,y,z];
        }
      }
      return null;
    }
  }

  function discover(scene){
    const children=new Map(),cars=[];
    for(const entry of scene.byId.values()){
      const parent=entry.n.parent;
      if(!children.has(parent))children.set(parent,[]);
      children.get(parent).push(entry);
    }
    for(const [id,parts] of children){
      const root=scene.byId.get(id);
      if(!root||root.n.shape||root.n.visual||parts.length<6||parts.length>128)continue;
      if(parts.some(e=>children.has(e.n.id)||!e.n.shape||e.n.visual))continue;
      const named=new Map(parts.map(p=>[p.n.name,p]));
      const wheels=tires.map(t=>named.get("Rueda "+t));
      if(named.size!==parts.length || named.get("Chasis")?.n.shape!==1 ||
         named.get("Carrocería")?.n.shape!==1 || wheels.some(p=>p?.n.shape!==2))continue;
      const m=root.m;
      // Planar driving accepts upright, unsheared instances, including a rotated placement group.
      if(m[5]<=0 || Math.max(Math.abs(m[1]),Math.abs(m[4]),Math.abs(m[6]),Math.abs(m[9]))>1e-5 ||
         m[0]*m[10]-m[2]*m[8]<=0 || Math.abs(m[0]*m[8]+m[2]*m[10])>1e-4 ||
         Math.max(Math.abs(m[12]),Math.abs(m[13]),Math.abs(m[14]))>1e7)continue;
      const car=new Car(root,parts,wheels);
      if(car.width>=.4 && car.width<=4 && car.length>=1 && car.length<=8 &&
         car.top-car.base<=5 && car.wheelbase>=.6 && car.wheelbase<=12)cars.push(car);
    }
    return cars;
  }
  function roomCars(scene){
    const eligible=[];
    for(const car of discover(scene)){
      const root=scene.byId.get(car.rootId),p=scene.byId.get(root.n.parent)?.m;
      // Native clients express world yaw as a local rotation under this parent.
      if(p&&(!(p[5]>0&&Math.hypot(p[0],p[2])>1e-6)||
         Math.max(Math.abs(p[0]-p[10]),Math.abs(p[2]+p[8]),Math.abs(p[1]),Math.abs(p[4]),Math.abs(p[6]),Math.abs(p[9]))>1e-7))continue;
      if(Math.abs(root.n.q[0])+Math.abs(root.n.q[2])>1e-8||
         car.parts.some(({entry})=>entry.m.some(v=>!Number.isFinite(v)||Math.abs(v)>1e9))||
         car.axles.some(({wheel})=>Math.abs(wheel.center[1]-wheel.extent[1]-car.base)>.035))continue;
      eligible.push(car);
    }
    return eligible.sort((a,b)=>a.rootId<b.rootId?-1:a.rootId>b.rootId?1:0);
  }
  function roomCar(scene,vehicleRoot=null){
    const cars=roomCars(scene);
    if(vehicleRoot===null)return cars[0]??null;
    const chosen=cars.find(car=>String(car.rootId)===vehicleRoot);
    if(!chosen)throw new Error("El turismo elegido ya no es compatible con esta escena. Elige otro o usa Automático.");
    return chosen;
  }
  function gridSpawn(world,car,road){
    const pose=window.MundoCircuit.readGrid(world);
    if(!pose)return null;
    if(!car)throw Error("La parrilla necesita un turismo de sala.");
    const [x,y,z]=pose.point;
    if(Math.abs(y-car.base)>.035)
      throw Error("Coloca la parrilla a la altura del suelo que pisan las ruedas del turismo.");
    if(!car.allowed(road,x,z,pose.yaw))
      throw Error("El turismo necesita suelo bajo las cuatro ruedas y espacio libre en la parrilla.");
    return {x,z,yaw:pose.yaw};
  }
  function roomStart(world,scene,vehicleRoot=null){
    const car=roomCar(scene,vehicleRoot);
    const terrain=car?scene.objects.filter(obj=>!car.partIds.has(obj.n.id)):scene.objects;
    const road=new window.MundoWalk(terrain,false);
    const pose=gridSpawn(world,car,road);
    // Contact tests use chassis coordinates. Leave Studio's displayed mesh transforms intact.
    if(pose)Object.assign(car,pose);
    return {car,road,grid:pose};
  }
  return {discover,roomCars,roomCar,gridSpawn,roomStart};
})();
