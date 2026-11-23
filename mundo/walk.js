"use strict";
// Static collision proxy for local exploration. Bounds follow world transforms and keep their physical shape
// when a visual key changes. Native rigid-body simulation uses the separate Jolt adapter.
window.MundoWalk=class {
  constructor(objects,demo,pace={}) {
    this.walkSpeed=Number.isFinite(pace.walk)&&pace.walk>0?pace.walk:4.2;
    this.runSpeed=Number.isFinite(pace.run)&&pace.run>0?pace.run:7.2;
    this.grid=new Map();this.large=[];this.cell=8;
    const solid=objects.filter(o=>o.n.shape!==0);
    let inserted=0,low=Infinity;
    for(const o of solid) {
      const box={min:o.center.map((v,i)=>v-o.extent[i]),max:o.center.map((v,i)=>v+o.extent[i])};
      low=Math.min(low,box.min[1]);
      const [x0,x1,z0,z1]=this.cells(box.min[0],box.max[0],box.min[2],box.max[2]);
      const count=(x1-x0+1)*(z1-z0+1);
      if(count>64 || inserted+count>250000 || ![x0,x1,z0,z1].every(Number.isSafeInteger)){this.large.push(box);continue;}
      inserted+=count;
      for(let x=x0;x<=x1;x++) for(let z=z0;z<=z1;z++){
        const key=x+","+z;if(!this.grid.has(key))this.grid.set(key,[]);
        this.grid.get(key).push(box);
      }
    }
    this.floor=Number.isFinite(low)?low:0;
    const anchor=solid[0];
    const plazaFloor=anchor && anchor.extent[0]>=10 && anchor.extent[2]>=10 && anchor.extent[1]<1;
    const x=anchor && !demo ? anchor.center[0] : 0;
    const z=demo || !anchor ? 9 : anchor.center[2]+(plazaFloor?Math.min(9,anchor.extent[2]*.4):0);
    let ground=demo || !anchor ? Math.max(this.floor,0) : anchor.center[1]+anchor.extent[1];
    // Pick the nearest supported elevation where the avatar's full height fits.
    const column=Array.from(this.around(x,z)).filter(b=>this.overlaps(b,x,z))
      .sort((a,b)=>a.min[1]-b.min[1]);
    for(const b of column) if(b.min[1]<ground+1.68 && b.max[1]>ground) ground=b.max[1];
    this.spawn=[x,ground+.15,z];
    this.position=this.spawn.slice();this.temp=0;this.vy=0;this.grounded=false;this.jump=false;
  }
  cells(x0,x1,z0,z1){return [x0,x1,z0,z1].map(x=>Math.floor(x/this.cell));}
  around(x,z) {
    return this.region(x-.36,x+.36,z-.36,z+.36);
  }
  region(left,right,back,front) {
    const [x0,x1,z0,z1]=this.cells(left,right,back,front),result=new Set(this.large);
    if(![x0,x1,z0,z1].every(Number.isSafeInteger))return result;
    for(let i=x0;i<=x1;i++) for(let j=z0;j<=z1;j++) for(const box of this.grid.get(i+","+j)||[])result.add(box);
    return result;
  }
  clearDistance(origin,direction,length,margin){
    const end=origin.map((v,i)=>v+direction[i]*length);
    const near=this.region(Math.min(origin[0],end[0])-margin,Math.max(origin[0],end[0])+margin,
      Math.min(origin[2],end[2])-margin,Math.max(origin[2],end[2])+margin);
    let reach=length;
    for(const box of near){
      let first=0,last=reach;
      for(let i=0;i<3&&first<=last;i++){
        const low=box.min[i]-margin-origin[i],high=box.max[i]+margin-origin[i];
        if(Math.abs(direction[i])<1e-9){if(low>0||high<0)last=-1;continue;}
        const a=low/direction[i],b=high/direction[i];
        first=Math.max(first,Math.min(a,b));last=Math.min(last,Math.max(a,b));
      }
      if(first<=last)reach=Math.max(0,first-.035);
    }
    return reach;
  }
  overlaps(b,x,z){return x+.28>b.min[0] && x-.28<b.max[0] && z+.28>b.min[2] && z-.28<b.max[2];}
  moveAxis(index,change) {
    if(!change)return;
    const p=this.position, x=p[0]+(index===0?change:0), z=p[2]+(index===2?change:0);
    const near=this.around(x,z);
    let step=p[1];
    for(const b of near){
      if(!this.overlaps(b,x,z) || b.max[1]<=p[1]+.001 || b.min[1]>=p[1]+1.68)continue;
      if(!this.grounded || b.max[1]-p[1]>.26)return;
      step=Math.max(step,b.max[1]);
    }
    if(step>p[1]) for(const b of near){
      if(this.overlaps(b,x,z) && b.max[1]>step+.001 && b.min[1]<step+1.68)return;
    }
    p[index]+=change;p[1]=step;
  }
  update(elapsed,keys,yaw,cross=null,allow=null) {
    this.temp=Math.min(.22,this.temp+elapsed);
    const dt=1/60;
    while(this.temp>=dt){
      this.temp-=dt;
      const forward=Number(keys.has("KeyW")||keys.has("ArrowUp"))-Number(keys.has("KeyS")||keys.has("ArrowDown"));
      const across=Number(keys.has("KeyD")||keys.has("ArrowRight"))-Number(keys.has("KeyA")||keys.has("ArrowLeft"));
      const speed=(keys.has("ShiftLeft")||keys.has("ShiftRight")?this.runSpeed:this.walkSpeed)*dt/Math.max(1,Math.hypot(forward,across));
      const dx=(Math.sin(yaw)*forward+Math.cos(yaw)*across)*speed;
      const dz=(-Math.cos(yaw)*forward+Math.sin(yaw)*across)*speed;
      const initialX=this.position[0],initialZ=this.position[2];
      const allowX=!dx || !allow || allow(initialX+dx,initialZ);
      if(allowX)this.moveAxis(0,dx);
      const allowZ=!dz || !allow || allow(this.position[0],initialZ+dz);
      if(allowZ)this.moveAxis(2,dz);
      if(this.jump && this.grounded){this.vy=5.5;this.grounded=false;}
      this.jump=false;this.vy=Math.max(-28,this.vy-15*dt);
      const p=this.position, old=p[1];let next=old+this.vy*dt, floor=this.floor, ceiling=Infinity;
      for(const b of this.around(p[0],p[2])){
        if(!this.overlaps(b,p[0],p[2]))continue;
        if(b.max[1]<=old+.002)floor=Math.max(floor,b.max[1]);
        if(b.min[1]>=old+1.68-.002)ceiling=Math.min(ceiling,b.min[1]-1.68);
      }
      if(this.vy>0&&next>=ceiling){next=ceiling;this.vy=0;}
      this.grounded=next<=floor+.001 && this.vy<=0;
      if(this.grounded){next=floor;this.vy=0;}
      p[1]=next;
      if(cross && ((allowX && allowZ) || p[0]!==initialX || p[2]!==initialZ)){
        const target=cross(p,this.grounded);
        if(target!==null){this.temp=0;return target;}
      }
    }
    return null;
  }
};
