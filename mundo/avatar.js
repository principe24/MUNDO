"use strict";
// Local presentation only. Negative transient IDs never enter the author's scene.
window.MundoAvatar=class {
  constructor(idOffset=0, npc=false){
    this.npc=npc;
    this.idOffset=idOffset;
    this.previous=null;this.heading=0;this.phase=0;this.speed=0;this.air=0;this.upward=0;
    this.parts=[];
  }
  sit(car,passenger){
    const pivot=window.MundoBrumaLook?.seat(car,passenger);
    const [x,z]=pivot?[pivot[0],pivot[2]]:car.point((passenger?1:-1)*car.width*.36,0);
    const hip=pivot?pivot[1]:car.base+(car.top-car.base)*.48;
    this.update({position:[x,hip-.78,z]},car.yaw,0,true);
  }
  update(walk,yaw,dt,seated=false){
    const feet=walk.position,old=this.previous;
    const dx=old?feet[0]-old[0]:0,dz=old?feet[2]-old[2]:0,dy=old?feet[1]-old[1]:0;
    const distance=Math.hypot(dx,dz);
    if(seated||!old||distance>2||Math.abs(dy)>2){
      this.heading=yaw;this.phase=this.speed=this.air=this.upward=0;
    }else if(dt>0){
      const mix=-Math.expm1(-12*dt);
      this.speed+=(Math.min(8,distance/dt)-this.speed)*mix;
      if(walk.grounded)this.phase=(this.phase+distance*(this.speed>5?3.6:4.8))%(2*Math.PI);
      this.air+=((walk.grounded?0:1)-this.air)*mix;
      this.upward+=(Math.max(-1,Math.min(1,walk.vy/5.5))-this.upward)*mix;
      const target=distance>1e-7?Math.atan2(dx,-dz):yaw;
      this.heading+=Math.atan2(Math.sin(target-this.heading),Math.cos(target-this.heading))*mix;
    }
    this.previous=seated?null:feet.slice();
    this.feet=feet;this.seated=seated;
    const stride=Math.min(1,this.speed/7)*(1-this.air),swing=Math.sin(this.phase)*stride;
    const hip=[0,.78+.029*stride*Math.abs(Math.cos(this.phase)),0,0];
    const cy=Math.cos(this.heading),sy=Math.sin(this.heading);
    const joint=([px,py,pz,a],x,y,z,bend=0)=>[px+x,py+Math.cos(a)*y-Math.sin(a)*z,pz+Math.sin(a)*y+Math.cos(a)*z,a+bend];
    let index=0;
    const box=([x,y,z,a],w,h,d,color)=>{
      if(!this.parts[index]){
        this.parts[index]={actorRig:this,n:{id:-BigInt(this.idOffset+index+1),shape:1,visual:0n,color,rough:.72,metal:.02},
          center:[0,0,0],extent:[0,0,0],m:new Float64Array(16),radius:Math.hypot(w,h,d)*.5};
      }
      const o=this.parts[index++],cx=Math.cos(a),sx=Math.sin(a);
      o.center[0]=feet[0]+cy*x-sy*z;o.center[1]=feet[1]+y;o.center[2]=feet[2]+sy*x+cy*z;
      o.m.set([cy*w,0,sy*w,0,-sy*sx*h,cx*h,cy*sx*h,0,-sy*cx*d,-sx*d,cy*cx*d,0,...o.center,1]);
    };
    const jacket=this.npc?[.24,.15,.52]:this.idOffset?[.54,.18,.055]:[.035,.34,.34],pants=[.035,.07,.14],skin=[.63,.34,.18],dark=[.035,.038,.046];
    const chest=joint(hip,0,.29,0,-.10*stride),head=joint(hip,0,.70,0);
    box(chest,.42,.53,.25,jacket);box(joint(chest,0,.13,.132),.26,.052,.018,[.92,.32,.10]);
    box(head,.32,.32,.31,skin);box(joint(head,0,.15,.015),.335,.09,.33,[.072,.043,.034]);
    for(const side of [-1,1]){
      box(joint(head,.076*side,.01,-.157),.032,.033,.012,dark);
      const thigh=joint(hip,.112*side,0,0,seated?1.45:.76*swing*side+this.air*(side>0?.54:.18));
      box(joint(thigh,0,-.175,0),.18,.35,.19,pants);
      const knee=joint(thigh,0,-.35,0,seated?-1.5:-.75*Math.max(0,side*swing)-this.air*(.5+.24*this.upward));
      box(joint(knee,0,-.16,0),.155,.32,.16,pants);box(joint(knee,0,-.367,-.028),.18,.11,.245,dark);
      const arm=joint(chest,.277*side,.17,0,seated?.55:-.86*swing*side+.58*this.air);
      box(joint(arm,0,-.115,0),.138,.23,.17,jacket);
      box(joint(joint(arm,0,-.23,0,.18+.5*stride+.45*this.air),0,-.128,0),.12,.255,.14,skin);
    }
  }
  follow(walk,eye,forward,distance=3.25){
    const pivot=[eye[0],eye[1]-.31,eye[2]],aim=MundoGeometry.unit([forward[0],forward[1]-.18,forward[2]]);
    const dir=aim.map(n=>-n);
    const reach=walk.clearDistance(pivot,dir,distance,.19);
    return reach<.7?null:{eye:pivot.map((n,i)=>n+reach*dir[i]),target:pivot};
  }
};

// Server snapshots own NPC identity and movement. Rendering borrows neither player seat.
window.MundoNpcView=class {
  constructor(){this.actors=new Map();}
  clear(){this.actors.clear();}
  accept(poses,now,reset=false){
    if(reset)this.clear();
    const ids=new Set(poses.map(p=>p.id));
    for(const id of this.actors.keys())if(!ids.has(id))this.actors.delete(id);
    const used=new Set([...this.actors.values()].map(a=>a.slot));
    for(const pose of poses){
      let actor=this.actors.get(pose.id);
      if(!actor){
        let slot=0;while(used.has(slot))slot++;
        used.add(slot);
        actor={slot,rig:new MundoAvatar(128+64*slot,true)};
        this.actors.set(pose.id,actor);
      }
      const gap=now-actor.time;
      const smooth=gap>0 && gap<=.45 && Math.hypot(...pose.position.map((v,i)=>v-actor.goal[i]))<=2;
      actor.start=smooth?this.sample(actor,now):pose.position;
      actor.goal=pose.position;actor.time=now;actor.duration=smooth?Math.min(.12,gap):0;
      actor.yaw=pose.yaw;
    }
  }
  sample(actor,now){
    if(!actor.duration || now>=actor.time+actor.duration)return actor.goal;
    const t=Math.max(0,(now-actor.time)/actor.duration);
    return actor.start.map((v,i)=>v+(actor.goal[i]-v)*t);
  }
  draw(view,now,dt){
    view.npcPositions=[];
    const parts=[];
    for(const actor of this.actors.values()){
      const feet=this.sample(actor,now);
      actor.rig.update({position:feet,grounded:true,vy:0},actor.yaw,dt);
      parts.push(...actor.rig.parts);view.npcPositions.push(feet);
    }
    if(parts.length)view.actorParts=view.actorParts.concat(parts);
  }
};
